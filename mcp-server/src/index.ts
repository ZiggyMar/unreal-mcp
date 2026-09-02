#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { dedupeFixes } from "./dedupeFixes.js";
import { stripSchemaDeclaration } from "./trimSchemaDeclaration.js";
import { trimFloatPaddingIn, trimFloatPadding } from "./trimFloats.js";
import { dedupeRepeatedStructs, MARKER_PATTERN } from "./dedupeStructs.js";
import { summariseRuntime } from "./verifyRuntime.js";
import { walkChain, describeGates } from "./inputChain.js";
import { normaliseEngineType, normaliseFieldTypes, typeHint } from "./engineTypes.js";
import { findInDataTables } from "./findInDataTables.js";
import { matchSymptoms } from "./symptoms.js";
import { UnrealBridgeClient } from "./bridgeClient.js";
import { enrichSearchHits, isEnrichmentEnabled } from "./enrichment.js";
import { autoLayoutGraph } from "./autoLayout.js";
import { reviewBlueprint } from "./review.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { SessionJournal, isWrite } from "./journal.js";
import { mapSystem } from "./systemMap.js";
import { planFeature } from "./planFeature.js";
import { cleanupBlueprint } from "./cleanup.js";
import { addEventHandler } from "./eventHandler.js";
import { scaffoldBlueprint } from "./scaffold.js";
import { scaffoldWidget } from "./scaffoldWidget.js";
import { explainGraph } from "./explainGraph.js";
import { readRuntimeLogForProject } from "./runtimeLog.js";
import { logFileFor } from "./runtimeLog.js";
import {
  logSize,
  readLogFrom,
  runIsComplete,
  parseAutomationRun,
  parseAutomationList,
} from "./automation.js";
import { auditProject } from "./audit.js";
import { withDisabledToolNote } from "./disabledTools.js";
import { guardWithAuthority } from "./authorityGuard.js";
import { RepeatGuard } from "./repeatGuard.js";
import { reviewStatePlacement } from "./statePlacement.js";
import { allPolicies, resolveMode, DEFAULT_MODE } from "./mode.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSourceRoots, searchSource, modulesByName, matchesByFile } from "./nativeSource.js";
import { verifyFeature } from "./verifyFeature.js";
import { auditDataTables } from "./dataTableAudit.js";
import { findOrphans } from "./orphans.js";
import { capActorList, type ActorListLike } from "./actorList.js";
import { compactBlueprintRow, compactVariable, compactStructField, asTypeDescriptor, omitZeroDefault, omitDefault, pickFields, asCountMap, compactAssetRef, ADVISE_WHEN_ROWS_AT_LEAST, type Row } from "./compactRows.js";
import { ALL_GROUPS_TOKENS, FEATURE_SET_TOKENS, GROUP_COST_TOKENS, PRESET_COST_TOKENS } from "./groupCosts.js";
import { PRESET_NAMES, presetTools } from "./toolPresets.js";
import { compileNative } from "./nativeBuild.js";
import { hotReloadCpp } from "./liveCoding.js";
import { comparePluginSource, outOfSyncNote } from "./pluginSourceSync.js";
import { documentAsset } from "./documentAsset.js";
import { describeConsoleResult } from "./consoleCommand.js";
import { callParentFirst } from "./parentCall.js";
import { capGraphSummary } from "./graphSummary.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AddNodeResult,
  AddVariableResult,
  BuildGraphResult,
  CompileBlueprintResult,
  ConnectPinsResult,
  CreateBlueprintResult,
  CreateFunctionResult,
  FindNodeResult,
  FindReferencesResult,
  GetProjectOverviewResult,
  NodeCatalogEntry,
  OrganizeGraphResult,
  ListBlueprintGraphsResult,
  ListBlueprintsResult,
  PingResult,
  ReadBlueprintGraphSummaryResult,
  ReadBlueprintNodeDetailResult,
  RemoveNodeResult,
  SaveBlueprintResult,
  SearchProjectResult,
  SetPinDefaultValueResult,
} from "./types.js";
import {
  leafName,
  notFoundPath,
  rankCandidates,
  suggestionLine,
  notFoundGraph,
  type PathCandidate,
} from "./suggestPath.js";
import { rankNames } from "./didYouMean.js";
import { matchTerms, matchesAllTerms } from "./matchTerms.js";
import { filterReviewByCheck, type ReviewLike } from "./filterReview.js";

const BRIDGE_HOST = process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765);

// Left unset, each command gets a timeout sized to what it actually costs on the game thread
// (see COMMAND_TIMEOUTS_MS in bridgeClient.ts). Set this only to force a single flat timeout.
const TIMEOUT_OVERRIDE_MS = process.env.UNREAL_MCP_TIMEOUT_MS ? Number(process.env.UNREAL_MCP_TIMEOUT_MS) : undefined;

// Which project this session is allowed to touch. Only one editor can hold the bridge port, so
// with two open, every call silently goes to whichever won. Setting this turns "silently edited the
// wrong project" into a refusal on the first call.
const EXPECT_PROJECT = process.env.UNREAL_MCP_EXPECT_PROJECT?.trim();

/**
 * A session that may look but not touch.
 *
 * The profiles decide what a model is HANDED. This decides what it can DO, and only the first
 * question had an answer: on any profile a model can call unreal_enable_tools and turn the writes
 * back on, which is right for a session meant to build and wrong for one meant to review.
 *
 * Any of "1", "true", "yes" or "on" turns it on, because the value people type is not predictable
 * and a session that silently stayed writable because someone wrote "true" instead of "1" would be
 * the worst possible outcome for a flag whose entire job is safety.
 */
const READ_ONLY = /^(1|true|yes|on)$/i.test((process.env.UNREAL_MCP_READONLY ?? "").trim());

const rawBridge = new UnrealBridgeClient({
  host: BRIDGE_HOST,
  port: BRIDGE_PORT,
  timeoutMs: TIMEOUT_OVERRIDE_MS,
  readOnly: READ_ONLY,
});
const journal = new SessionJournal();

/**
 * Every command goes through here, so the change log cannot drift from what was actually sent.
 * Recording at each of the fifty call sites would be one forgotten line away from lying to the
 * user about what was touched, and a change log that is wrong is worse than none.
 */
/**
 * Confirm we are attached to the project the user meant, before the first write of the session.
 *
 * Checking only in unreal_doctor would not help: the failure is silent by nature, so it is found by
 * someone noticing damage rather than by anyone thinking to run a diagnosis. The check costs one
 * ping, once, and only when UNREAL_MCP_EXPECT_PROJECT is set.
 */
let projectChecked = false;
async function assertExpectedProject(cmd: string): Promise<void> {
  if (!EXPECT_PROJECT || projectChecked || !isWrite(cmd)) return;
  const ping = await rawBridge.send<{ project?: string; projectFile?: string }>("ping", {});
  if (ping.project && ping.project.toLowerCase() !== EXPECT_PROJECT.toLowerCase()) {
    throw new Error(
      `WRONG PROJECT: this bridge is attached to "${ping.project}"` +
        `${ping.projectFile ? ` (${ping.projectFile})` : ""}, but UNREAL_MCP_EXPECT_PROJECT is "${EXPECT_PROJECT}". ` +
        `Refusing to write. This normally means a second Unreal Editor is open: only one can hold port ` +
        `${BRIDGE_PORT}, so every call goes to that one. Close the other editor, or run each on its own port ` +
        `with -MCPBridgePort=<n> and UNREAL_MCP_BRIDGE_PORT. Nothing has been changed.`
    );
  }
  projectChecked = true;
}

const bridge = {
  async send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T> {
    try {
      await assertExpectedProject(cmd);
      const result = await rawBridge.send<T>(cmd, params);
      journal.record(cmd, params, true);
      // The project just changed, so the repeat guard's "you will get the same answer" claim is no
      // longer true for anything. Here rather than in the tool wrapper because this is the one
      // place that knows a write actually reached the editor and succeeded.
      if (isWrite(cmd)) repeatGuard.bump();
      return result;
    } catch (err) {
      journal.record(cmd, params, false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
};

const PROFILE = (process.env.UNREAL_MCP_PROFILE ?? "full").trim().toLowerCase();

/**
 * What the client is told about this server before the conversation starts.
 *
 * MCP has a field for exactly this and it was empty, so everything the model needed to know had to
 * arrive some other way: a prompt it had to choose to pull, or a failed call teaching it the hard
 * way. Both are worse than saying it once, up front, for a few hundred tokens.
 *
 * The content is chosen by one rule: it is here only if the model cannot derive it. Call order,
 * because tool descriptions teach a tool and not a sequence; and the exact strings, because a model
 * that knows Unreal well still cannot know that the target pin is spelled `self` - it will confidently
 * write "Target" and lose a call to it. Everything long-form stays in the prompts and is pointed at
 * rather than inlined.
 */
/**
 * The exact strings this server requires, which knowing Unreal well does not supply.
 *
 * Standing text for every profile that can author a graph on its first call, and NOT for `search`,
 * which registers four tools - ping, doctor, list_tools, enable_tools - none of which can place a
 * node. On `search` this was 284 tokens of pin names resent on every single message, describing
 * calls the model was not yet able to make. Thirty messages of orientation paid 8,500 tokens for
 * knowledge it could not use once.
 *
 * So `search` gets it from unreal_enable_tools instead, the moment authoring tools switch on. That
 * is cheaper - once rather than every turn - and lands better: it arrives in a reply the model just
 * asked for, at the point of use, rather than in a preamble read before the job was understood.
 */
const GROUND_TRUTH = [
  "GROUND TRUTH YOU CANNOT DERIVE",
  "Exact strings this server requires. Getting these wrong is the most common failed call, and",
  "knowing Unreal well does not help - they are not guessable:",
  "- The target pin is `self`, even though the editor labels it \"Target\".",
  "- Exec pins are not uniform. Ordinary nodes: `execute` in, `then` out. Branch: `then` and",
  "  `else`. Sequence: `then_0`, `then_1`. Loop macros (ForEachLoop, WhileLoop): `Exec`, capital E.",
  "- Struct pin defaults are comma triples: \"0, -90, 0\", never \"(Pitch=0,Yaw=-90)\". Rotator order",
  "  is Pitch, Yaw, Roll.",
  "- Enum pin defaults take the entry name: \"SnapToTarget\".",
  "- Static library functions need their className: PrintString is on KismetSystemLibrary.",
  "- A variable must exist before a Get or Set node can reference it.",
  "- Branch, Sequence and Cast are `nodeType` values, not functions.",
  "- Spawn Actor and Create Widget are NOT buildable here, and nothing else will tell you:",
  "  they are their own K2Node classes, not functions the catalogue can find. Say so rather",
  "  than emitting a graph that silently lacks the step.",
];

/** Tools whose arrival means the caller is about to write a graph, and needs the strings above. */
const AUTHORING_TOOLS = [
  "unreal_build_graph",
  "unreal_add_node",
  "unreal_scaffold_blueprint",
  "unreal_scaffold_widget",
  "unreal_add_event_handler",
  "unreal_connect_pins",
];

/** Sent once per session, with the first enable that switches on something able to author. */
let groundTruthDelivered = false;

/**
 * How many times this session has changed the advertised tool list.
 *
 * Each one re-reads the whole conversation at full price on the next turn, because the tool list
 * sits ahead of the system prompt and every message. One is the cost of doing business; a session
 * that keeps discovering it needs one more tool is paying that bill repeatedly without being told,
 * and the only moment the advice is useful is the moment it happens again.
 */
let toolListChanges = 0;

// These two live here, above buildInstructions, rather than beside the other profile sets.
//
// buildInstructions runs at module scope, so anything it reads must already exist. Declared in
// their natural place further down, they are in the temporal dead zone when it runs and the
// server dies on startup with a ReferenceError - which TypeScript compiles without complaint,
// because the error is in the ORDER, not the types. That is the second time this exact shape has
// bitten (GROUND_TRUTH was the first), and both times the compiler was happy and only running it
// told the truth.
/**
 * The "search" profile: everything reachable, almost nothing standing.
 *
 * The measurement is the whole argument. The tool definitions this server sends before the user has
 * said a word cost, per request: minimal 3,883 tokens, core and lazy 9,989, full 25,111. A frontier
 * model has the context to absorb `full` - that is why it is the in-process default - but "can
 * afford it" is not the same as "should pay it". It is 25k tokens of standing cost on every turn,
 * most of it describing tools the session will never call.
 *
 * Epic's own MCP plugin, shipped experimental in 5.8, hit the same wall and answered it the same
 * way: its Tool Search mode returns a few meta-tools from tools/list and lets the agent pull in the
 * rest on demand. That is a poor trade for a weak model, which struggles with the indirection -
 * which is exactly why `minimal` and `core` are untouched. It is an excellent trade for a capable
 * one, which will spend one call to buy back 24k tokens on every remaining turn.
 *
 * This comment used to end by dismissing "a generic call_tool proxy", on the grounds that enabling a
 * group hands over the REAL typed schemas while a proxy flattens everything into a stringly-typed
 * passthrough. The first half is still true and is why enable_tools remains the way to do real work.
 * The second half was wrong about the alternative rather than right about this design: Epic ships a
 * call_tool as well, and the reason is one this file had not measured. Enabling changes the
 * advertised tool list, that list sits ahead of everything else in the request, and changing it
 * invalidates the prompt cache for the whole conversation. For a tool used once, the "cheap" path
 * here was the most expensive call the server offered.
 *
 * So unreal_call_tool exists too, and it is not a flattened proxy: it validates against the same
 * strict schema the tool advertises. Both paths, honestly priced - see DEFERRAL_TOOLS below.
 */
const SEARCH_PROFILE_TOOLS = new Set([
  // Is the bridge there, and if not, why not. Both are small, and both are what you reach for first
  // when nothing works, so neither should need a round trip to switch on.
  "unreal_ping",
  "unreal_doctor",
  // The two that make everything else reachable.
  "unreal_list_tools",
  "unreal_enable_tools",
]);

/**
 * Tools that only earn their keep where OTHER tools are deferred.
 *
 * unreal_call_tool exists to run something without switching it on. On `full` everything is already
 * on, and on `core` and `minimal` the only tools it could reach are the ones already registered and
 * enabled, so in all three it is an extra hop and an extra schema for no gain. It stands on `lazy`
 * and `search`, which are the profiles that defer anything.
 */
const DEFERRAL_TOOLS = new Set(["unreal_call_tool"]);

function buildInstructions(profile: string): string {
  const lines: string[] = [];

  lines.push(
    "Unreal Engine, driven through a live editor bridge. Read this before your first call.",
    ""
  );

  if (profile === "search") {
    lines.push(
      "THE TOOL LIST IS DELIBERATELY SHORT.",
      `${SEARCH_PROFILE_TOOLS.size + DEFERRAL_TOOLS.size} tools are listed. The rest are registered and switched off, because all of them is ~${Math.round(ALL_GROUPS_TOKENS / 100) / 10}k`,
      "tokens on every turn and most goes unused. Switch on what the job needs and the real, fully",
      "typed schemas arrive - nothing is dumbed down or proxied.",
      "",
      "USING SOMETHING ONCE? unreal_call_tool({ tool, args }) runs any of them without switching it",
      "on, which matters more than it sounds: enabling changes the tool list, and that re-reads this",
      "whole conversation at full price on the next turn. Once or twice, dispatch. More, enable.",
      "unreal_list_tools({ schema: \"<name>\" }) gives one tool's parameters without switching it on either.",
      "",
      "START WITH A PRESET: the tools for one job, already chosen, each checked by a trial that runs",
      "that whole job on it. These costs are measured, not estimated:",
      `  diagnose ~${Math.round(PRESET_COST_TOKENS.diagnose / 100) / 10}k   feature ~${Math.round(PRESET_COST_TOKENS.feature / 100) / 10}k   ui ~${Math.round(PRESET_COST_TOKENS.ui / 100) / 10}k   data ~${Math.round(PRESET_COST_TOKENS.data / 100) / 10}k   cpp ~${Math.round(PRESET_COST_TOKENS.cpp / 100) / 10}k`,
      "  unreal_enable_tools({ preset: \"diagnose\" })",
      `One preset beats the core group (~${Math.round(GROUP_COST_TOKENS.core / 100) / 10}k). Two is roughly a wash; if the job genuinely spans three`,
      "or more, enable core instead. Whole groups and exact tool names also work, and unreal_list_tools",
      "prices every group without paying for its schemas.",
      "",
      // The routing exists, is measured, and was findable only by a model that already knew about
      // it: the guide had to be fetched and this text - the one thing every model reads before any
      // call - described list_tools as a way to price groups and nothing else.
      "OR JUST HAND OVER WHAT THE USER SAID, if you have their words and no plan yet:",
      "  unreal_list_tools({ match: \"upgrades aren't showing up in the shop\" })",
      "It reads the sentence when no tool name matches, tells a bug from a feature from a change, and",
      "names the words it matched so you can judge the answer. unreal_guide topic:\"workflow\" has the rest.",
      ""
    );
  }

  // `minimal` gets its own path, because the shared one is a lie there.
  //
  // Measured: the shared instructions name 18 tools and `minimal` registers 11, so 13 of them are
  // unreachable - including the first thing step 1 says to call (unreal_doctor), the tool step 5 is
  // built around (unreal_build_graph), and the one step 8 says to run before reporting anything done
  // (unreal_verify_feature). Tools left out of `minimal` are never registered at all, so
  // unreal_enable_tools cannot bring them back: enabling `core` on this profile still leaves 11.
  //
  // That failure lands on the weakest models, which are the entire reason this profile exists and
  // the least able to recover from a tool that is not there. It also cost tokens for the privilege:
  // a third of the standing text described a workflow this profile cannot perform.
  if (profile === "minimal") {
    lines.push(
      "HOW TO WORK",
      "These eleven tools are all there are. This profile is fixed - nothing else can be switched on,",
      "so do not reach for a tool that is not listed.",
      "",
      "1. Look before writing: unreal_list_blueprints to see what exists, unreal_find_node for the",
      "   exact name of a function. Never guess a name; a guess costs a failed call.",
      // Worth more here than anywhere. This profile exists for a 14B at 8k, where an unfiltered
      // list_blueprints is 2,669 tokens - a third of the whole window - and `match` or
      // fields:["path"] brings it down without giving anything up. Tuned to the tools this profile
      // actually has: no direction, no replicatedOnly, because neither tool is registered here.
      "   Narrow it: `match` finds by name and `fields: [\"path\"]` drops the rest. Unfiltered that",
      "   call is 2,669 tokens on a real project, which is a third of your whole context.",
      "2. Making something new: unreal_scaffold_blueprint builds the whole thing in one call - the",
      "   Blueprint, its variables, its components, and its event logic. Reach for it first.",
      "   unreal_scaffold_widget does the same for UI.",
      "3. Adding to something that exists: unreal_add_variable, then unreal_add_event_handler for",
      "   \"when X happens, do these in order\". That handler wires the exec pins for you.",
      "4. unreal_compile_blueprint, then unreal_review_blueprint, and act on what it says.",
      "   Compiling is not the same as being correct.",
      "5. unreal_save_blueprint. Nothing reaches disk until you do.",
      "",
      "unreal_audit_project answers \"what is wrong with my game\" across every Blueprint; pass its",
      "`check` to get one kind of finding back in full.",
      "",
      "GROUND TRUTH YOU CANNOT DERIVE",
      "The target pin is `self`, even though the editor labels it \"Target\". Struct defaults are comma",
      "triples - \"0, -90, 0\", never \"(Pitch=0,Yaw=-90)\", in Pitch, Yaw, Roll order. Enum defaults take",
      "the entry name: \"SnapToTarget\". A variable must exist before anything can Get or Set it.",
      "",
      "Set UNREAL_MCP_INSTRUCTIONS=off to suppress this text."
    );
    return lines.join("\n");
  }

  // What this profile costs, said once, to the profiles expensive enough to care.
  //
  // Measured rather than asserted, and the first version of this text was WRONG in the direction
  // that flatters the argument. It compared `full` at 37.3k against `search` at 2.3k and said
  // sixteen times - true only of a session that never switches anything on. A session that does the
  // work enables a preset, and then the honest comparison is:
  //
  //   search + cpp       6.6k     search + feature   9.8k     search + diagnose  12.4k
  //   full              38.3k
  //
  // Three to six times, not sixteen. Still the largest single lever here - it dwarfs every reply
  // compaction in this repo put together - but the number had to be the real one. An overstated
  // saving in the one text nobody can skip would undermine every other measurement beside it, which
  // is the exact failure the drift guard in measure:reads exists to catch.
  //
  // The ratio was fixed here once and the COST MODEL beside it was left wrong, which is the same
  // mistake one level down. This used to say tool definitions "are not paid once" and that "a
  // thirty-call job pays that thirty times". That is true only without prompt caching. The tool list
  // is a cacheable prefix that sits ahead of the system prompt and the messages, so a client that
  // caches - which is every client --print-config writes for - pays it in full once and a fraction
  // after. Overstating it by roughly ten times, in the paragraph whose own comment warns against
  // overstating, is worse than saying nothing.
  //
  // What genuinely re-charges the prefix at full price is CHANGING the tool list, which is why
  // unreal_enable_tools is expensive and unreal_call_tool exists. That is the sentence a model can
  // act on, so it replaced the wrong one rather than being added beside it - measure:profiles
  // enforces a ceiling on this text and a correction that costs tokens is a correction that gets
  // reverted.
  //
  // A model cannot change its own profile; it is set where this server is launched. So this ends by
  // telling it to tell the person who can.
  if (profile === "core" || profile === "lazy" || profile === "full") {
    const standing = Math.round(ALL_GROUPS_TOKENS / 100) / 10;
    const cheapest = Math.round((2292 + PRESET_COST_TOKENS.cpp) / 100) / 10;
    const dearest = Math.round((2292 + PRESET_COST_TOKENS.diagnose) / 100) / 10;
    lines.push(
      "WHAT THIS SESSION COSTS",
      `Tool definitions sit before your context and go with every message. Caching charges that prefix`,
      `in full once and a fraction after - but CHANGING the tool list re-charges it, so switch on what`,
      `a job needs in ONE unreal_enable_tools call, not several. Everything on stands at ~${standing}k.`,
      `The \`search\` profile starts with four tools and switches on the group the job needs - a working`,
      `session stands around ${cheapest}k-${dearest}k, three to six times less, with the same tools and`,
      `the same fully typed schemas. One extra call at the start.`,
      "You cannot change this yourself - it is UNREAL_MCP_PROFILE where this server is launched - so if",
      "the user is paying for tokens, tell them the option exists.",
      ""
    );
  }

  lines.push(
    "HOW TO WORK",
    "1. Anything broken: unreal_doctor. It names which half is wrong and the remedy.",
    // Named here because it was named nowhere a model on this profile reads.
    //
    // Measured from the instruction text the server actually sends, after two source greps got it
    // wrong: unreal_audit_project appeared only in the `minimal` branch, and not in search, core or
    // full - the profile --print-config emits among them. It is the entry point for the single most
    // common request this tool exists for, and nothing pointed at it.
    "   A problem with no asset named is unreal_audit_project, ranked by likely cost.",
    "2. Orient before writing. unreal_get_project_overview, then unreal_search_project and",
    "   unreal_list_blueprints to find what already exists. Assume the project is to be extended,",
    "   not rebuilt: match what is there.",
    // Twenty-five tokens a request against a saving measured in thousands on the first read that
    // would otherwise go unfiltered. Re-measured against the real project, because every one of these
    // numbers had gone stale: read_class_defaults is 1,691 tokens whole and 218 with `match`;
    // list_variables is 1,732 and 126; list_data_table_rows is 1,723 and 150 with `fields`.
    //
    // They drifted downward, which is the harmless direction and still wrong. The compaction work -
    // compact JSON, float trimming, deduplicated fix text - moved every read, and a `fields` filter
    // on a Data Table did not exist when this was written. measure:reads now checks these against
    // what it measures, so the next drift fails the run instead of quietly overstating the whole.
    // Every reply now says so after the fact, which is free but one read too late - this is the only
    // line in the standing text that pays for itself several times over on a single call.
    "   Every large read takes a filter (match, fields, replicatedOnly, direction, limit). Use it:",
    "   the difference is 1,691 tokens against 218, not a trim.",
    "   Not everything is a Blueprint. If a parentClass is not itself a Blueprint it is native C++,",
    "   and unreal_find_source locates the file and line that declares it - then read and edit it",
    "   with your own file tools. Call unreal_find_source with no symbol to see whether the project",
    "   has C++ at all and where its modules are.",
    "3. unreal_plan_feature before building anything non-trivial. It reads the real project and",
    "   returns concrete steps, so the structure is not guesswork.",
    "4. Check exact names before writing: unreal_find_node for functions, unreal_describe_class for",
    profile === "core"
      ? "   members. Never guess a function or pin name. The engine will tell you, and a guess costs a failed call."
      : "   members, unreal_list_assets for paths. Never guess a function or pin name. The engine will",
    ...(profile === "core" ? [] : ["   tell you, and a guess costs a failed call."]),
    "5. Build whole graphs with unreal_build_graph, in one call. Do not place nodes one at a time,",
    "   and do not pass x/y - it lays out what it places.",
    "6. unreal_compile_blueprint, then unreal_review_blueprint, and act on what they say.",
    "   Compiling is not the same as being correct.",
    profile === "core"
      ? "7. unreal_save_blueprint. Nothing reaches disk until you do."
      : "7. unreal_save_blueprint / unreal_save_asset. Nothing reaches disk until you do.",
    "8. unreal_verify_feature before you report anything as done. It compiles and reviews every",
    "   Blueprint you wrote this session, not just the one you touched last, and its verdict is",
    "   the answer - an earlier asset that stopped compiling is the usual way work is reported",
    "   finished when it is not.",
    "",
    // Carried by `search` in the enable_tools reply instead, at the moment it becomes usable.
    // See GROUND_TRUTH above.
    ...(profile === "search" ? [] : [...GROUND_TRUTH, ""]),
    "WHEN YOU NEED MORE",
    "The unreal_handbook prompt is the full engine guide; unreal_recipes has verified end-to-end",
    "builds of the systems people usually ask for; unreal_workflow is the long form of the order",
    "above. Pull in the handbook before your first write of a session: being confident about",
    "Unreal's exact strings and being right about them are different things.",
    "",
    "Set UNREAL_MCP_INSTRUCTIONS=off to suppress this text."
  );

  return lines.join("\n");
}

/**
 * Is this tool callable right now?
 *
 * undefined for a name this server does not have, which is deliberately different from false: a note
 * saying "switched off" about a tool that does not exist would send a caller to enable something
 * they can never get.
 */
const isToolEnabled = (name: string): boolean | undefined => toolHandles.get(name)?.enabled;

const server = new McpServer(
  {
    name: "unreal-mcp-server",
    version: "0.1.0",
  },
  {
    // Off is a supported answer: on the minimal profile the whole point is that context is
    // the scarce resource, and several hundred tokens of preamble is a real cost there.
    instructions:
      process.env.UNREAL_MCP_INSTRUCTIONS === "off" ? undefined : buildInstructions(PROFILE),
  }
);

/**
 * Tool profile: which tools this server exposes.
 *
 * Tool definitions are paid for on every single request, before the user's message is even read.
 * At 39 tools with descriptions written to actually teach a model the sequencing, that is roughly
 * 11k tokens of standing cost. On a 200k-context model that is noise. On an 8k or 32k local model
 * it is the difference between usable and unusable, and "works with any model" is the point.
 *
 * The instructive descriptions are NOT the thing to cut: they are why a weaker model succeeds at
 * all. So instead of making every user's tools worse, a user on a small-context model can opt into
 * a smaller set. "core" keeps a straight line through authoring a Blueprint feature and reviewing
 * it, and drops the single-node editing tools (unreal_build_graph does that job in one call), the
 * level/actor/component/PIE surface, and the maintenance tools.
 *
 * Set UNREAL_MCP_PROFILE=core to use it. The default is "full".
 */
const CORE_PROFILE_TOOLS = new Set([
  "unreal_ping",
  "unreal_doctor",
  // Cheap (about 150 tokens) and the only way to see what is switched off, so it belongs in every
  // profile that can defer a tool. Left out of `core`, it would be registered-but-unreachable in
  // `lazy` - which the stranded-tool test caught immediately.
  "unreal_list_tools",
  "unreal_enable_tools",
  // The docs, fetchable mid-task. A model that cannot reach them guesses instead, and a guess at a
  // pin name costs a failed call - which is more expensive than the section index it replaces.
  "unreal_guide",
  // The C++ half of the project. Without it a model can read every Blueprint and still not find a
  // bug that lives in the native parent class it can see the name of and nothing else.
  "unreal_find_source",
  "unreal_session_changes",
  "unreal_undo_history",
  "unreal_get_project_overview",
  "unreal_search_project",
  "unreal_map_system",
  "unreal_plan_feature",
  "unreal_project_health",
  "unreal_audit_project",
  "unreal_list_blueprints",
  "unreal_list_blueprint_graphs",
  "unreal_read_blueprint_summary",
  "unreal_explain_graph",
  "unreal_find_node",
  "unreal_get_node_signature",
  "unreal_describe_class",
  // unreal_create_blueprint is deliberately ABSENT, exactly as it is from `minimal`.
  //
  // It makes an EMPTY Blueprint, and it is the familiar name, so a small model reaches for it and
  // then cannot finish: add_component is not in this set either, so a Blueprint created that way
  // has no route to a component at all. Measured, not theorised - the three-part feature task went
  // from 5/5 to 0/3, and the trace shows every failing run picking create_blueprint and then
  // looping compile/save/review without ever adding the component it was asked for.
  //
  // The principle was already written down when `minimal` was built and only applied there: a
  // profile for weak models should contain the best path for each job, not every path. Offering a
  // worse-but-familiar option is offering a way to fail. It is still reachable through
  // unreal_enable_tools, and `full` still has it.
  "unreal_scaffold_blueprint",
  "unreal_create_function",
  "unreal_add_variable",
  "unreal_build_graph",
  "unreal_add_event_handler",
  "unreal_compile_blueprint",
  "unreal_save_blueprint",
  "unreal_auto_layout_graph",
  "unreal_review_blueprint",
  // The terminal step: one call that checks everything written this session rather than the one
  // asset the model happens to remember.
  "unreal_verify_feature",
  "unreal_cleanup_blueprint",
]);

/**
 * Tool groups, for the "lazy" profile.
 *
 * Trimming descriptions was measured and rejected as the answer to context bloat: tool
 * descriptions are 41% of the payload and they are the teaching a weaker model relies on, and
 * parameter prose is only another 17%, so aggressive editing buys around a tenth of the total
 * while making every model worse at sequencing. The bytes are not the problem. Sending tools the
 * caller will never touch is the problem.
 *
 * So "lazy" registers everything, with full schemas, and leaves every non-core group DISABLED.
 * A session that never builds UI never pays for the UMG tools. When the model needs a group it
 * calls unreal_enable_tools, the group switches on, and the SDK notifies the client that the tool
 * list changed. Nothing is dumbed down; it just arrives when it is wanted.
 */
const TOOL_GROUPS: Record<string, string[]> = {
  // Running the game and watching what happens - the closed loop, in one place.
  //
  // These were split across two groups: start_pie and watch_runtime sat with level authoring, while
  // press_input, pie_actors, teleport_actor and verify_runtime sat with asset maintenance. So the
  // cheapest way to hold a key and watch a value was to enable BOTH, most of which is unrelated -
  // level creation on one side, renaming assets on the other. A session that wants to prove a change
  // works should pay for proving it, not for everything filed near it.
  runtime: [
    "unreal_start_pie",
    "unreal_stop_pie",
    "unreal_pie_status",
    "unreal_watch_runtime",
    "unreal_verify_runtime",
    "unreal_press_input",
    "unreal_pie_actors",
    "unreal_teleport_actor",
    "unreal_read_runtime_errors",
    "unreal_screenshot",
    // Beside read_runtime_errors because it works the same way - run something, read what the
    // editor wrote to Saved/Logs - and answers the same question one level up: not "what went wrong
    // when I pressed Play" but "does the engine still think this project is correct".
    "unreal_run_tests",
  ],
  edit: [
    // Reachable but not offered by default. It makes an EMPTY Blueprint, and a weak model reaches
    // for the familiar name over scaffold_blueprint and then cannot finish - measured, see
    // CORE_PROFILE_TOOLS. A caller that genuinely wants an empty Blueprint can enable it.
    "unreal_create_blueprint",
    "unreal_guard_with_authority",
    "unreal_call_parent_function",
    "unreal_read_node_detail",
    "unreal_add_node",
    "unreal_connect_pins",
    "unreal_set_pin_default_value",
    "unreal_remove_node",
    "unreal_organize_graph",
    "unreal_set_variable_replication",
  ],
  ui: ["unreal_scaffold_widget", "unreal_create_widget_blueprint", "unreal_add_widget", "unreal_list_widgets", "unreal_set_widget_property"],
  materials: [
    "unreal_create_material",
    "unreal_create_material_instance",
    "unreal_set_material_parameter",
    "unreal_list_material_parameters",
  ],
  data: [
    "unreal_remove_struct_field",
    "unreal_rename_struct_field",
    "unreal_remove_enum_entry",
    "unreal_rename_enum_entry",
    "unreal_save_asset",
    "unreal_read_asset_properties",
    "unreal_set_asset_property",
    "unreal_create_data_table",
    "unreal_add_data_table_row",
    "unreal_set_data_table_row",
    "unreal_remove_data_table_row",
    "unreal_check_data_tables",
    "unreal_list_data_table_rows",
    "unreal_find_in_data_tables",
    "unreal_create_struct",
    "unreal_add_struct_field",
    "unreal_list_struct_fields",
    "unreal_create_enum",
    "unreal_add_enum_entry",
    "unreal_list_enum_entries",
    "unreal_list_assets",
  ],
  scene: ["unreal_read_class_defaults", "unreal_get_game_settings", 
    "unreal_create_level",
    "unreal_open_level",
    "unreal_spawn_actor",
    "unreal_list_actors",
    "unreal_set_actor_property",
    "unreal_delete_actor",
    "unreal_save_level",
    "unreal_add_component",
    "unreal_list_variables",
    "unreal_list_components",
    "unreal_set_component_property",
    "unreal_set_class_default",
    "unreal_set_game_settings",
    "unreal_add_input_mapping",
    "unreal_find_orphans",
    "unreal_run_console_command",
  ],
  // trace_variable sits with find_references because they are the same question asked of different
  // things - "where is this used" - and a caller reaching for one usually wants the other.
  maintenance: ["unreal_document_asset", "unreal_asset_status", "unreal_find_references", "unreal_trace_variable", "unreal_trace_function_calls", "unreal_set_variable_type", "unreal_create_asset", "unreal_delete_asset", "unreal_rename_asset", "unreal_duplicate_asset", "unreal_rename_variable", "unreal_rename_function", "unreal_remove_variable", "unreal_rename_component", "unreal_remove_component", "unreal_remove_function", "unreal_refresh_blueprint"],
  // Only compile_cpp. find_source stays in `core`, and the reason is worth writing down because the
  // obvious tidy-up is wrong: enabling "core" enables CORE_PROFILE_TOOLS, not this table's `core`
  // entry, and find_source is in that set. Moving it here would have changed what unreal_list_tools
  // CLAIMS without changing what enable_tools DOES - the group would say cpp while `core` still
  // switched it on. A listing that disagrees with the behaviour is worse than a group that is one
  // tool larger than it looks. Removing it from CORE_PROFILE_TOOLS instead would shrink the surface
  // the local-model benchmark was measured against, which is not a thing to do as a side effect.
  //
  // find_source also earns its place in the spine: called with no symbol it answers "does this
  // project have C++ at all", which is orientation, not C++ work.
  cpp: ["unreal_compile_cpp", "unreal_hot_reload_cpp"],
  // Animation is its own group: 62 of the assets on the project this was measured against, and
  // irrelevant to a project that has none.
  // Timeline reading sits with animation because that is what a Timeline is: a Blueprint animating
  // something over time. Someone asking "why does aiming feel slow" or "the door closes too fast"
  // reaches here, not for the cutscene tools. It is deliberately NOT in `core`, which has no room
  // and is the authoring spine rather than everything a Blueprint can hold.
  anim: [
    "unreal_read_anim_blueprint", "unreal_deduplicate_anim_transitions",
    "unreal_read_timeline",
    "unreal_add_montage_notify",
    "unreal_remove_montage_notify",
  ],
  // AI is its own group for the same reason animation is: a project without Behavior Trees should
  // not carry the definition, and a project built around them wants it in the diagnose set.
  ai: ["unreal_read_behavior_tree"],
  // VFX is its own group for the same reason animation and AI are: a project without Niagara should
  // not carry the definition.
  vfx: [
    "unreal_set_niagara_user_parameter","unreal_read_niagara_system"],
  // Enhanced Input is its own group for the same reason animation and AI are. A project on legacy
  // input has three tools here that answer nothing, and one on Enhanced Input - which is most of
  // them - could not answer "what is W bound to" at all before these.
  // Cinematics is its own group for the same reason animation and AI are: a project with no Level
  // Sequences should not carry the definition, and one with nine wants it in reach.
  cine: ["unreal_read_level_sequence"],
  input: [
    // All four together, including the legacy reader that used to sit in `scene`. Splitting them
    // would mean a model looking for input tools finds half of them, and enabling "input" would not
    // give you the one call that says "this project is on Enhanced Input, look elsewhere".
    "unreal_list_input_mappings",
    "unreal_read_input_context",
    "unreal_map_input_key",
    "unreal_unmap_input_key",
  ],
};

/**
 * The groups `enable_tools` accepts, derived rather than typed out again.
 *
 * This list existed in three places - TOOL_GROUPS, this enum, and measure-groups.mjs - and adding a
 * group updated one of them. The `input` group was reachable from the census and rejected by
 * enable_tools, which is a listing that disagrees with behaviour: a model reads that the group
 * exists, asks for it, and is told it is not a valid value. Two separate tests caught it, which is
 * two tests doing a job the type system should be doing.
 *
 * "core" is not a key of TOOL_GROUPS - it is the profile's own set - so it is named once, here.
 */
const ENABLEABLE_GROUPS = ["core", ...Object.keys(TOOL_GROUPS)] as [string, ...string[]];

const GROUP_SUMMARY: Record<string, string> = {
  cpp: "compile a C++ source file to see whether an edit built (find_source, which locates it, is in core)",
  anim: "Animation Blueprints: state machines, their states, and the conditions that move between them",
  ai: "Behavior Trees and their blackboards: what the AI is actually told to do, and what guards each branch",
  vfx: "Niagara systems: their emitters, and the user parameters a Blueprint is allowed to set",
  edit: "single-node graph editing: add/remove one node, wire one pin, set one default, move/comment nodes",
  ui: "UMG: create Widget Blueprints, build the widget tree, set widget and slot properties",
  materials: "Materials and Material Instances: create them, parameterise them, override them",
  data: "Structs, Enums, and asset lookup",
  scene: "Levels, actors, components, class defaults, project settings, Play In Editor",
  input: "key bindings: Enhanced Input contexts - read what is bound, bind a key, unbind one - and the legacy reader",
  cine: "Level Sequences: what a cutscene animates, and the bindings and tracks that quietly animate nothing",
  maintenance: "reference lookup, asset deletion, Refresh Nodes repair",
};

/**
 * The smallest set that can still build something, for models running on a tight GPU.
 *
 * This exists because of a measurement, not a preference. On a 12 GB card, qwen2.5-coder:14b loads
 * at 8k context and fails to load at 16k. The "lazy" profile is ~8.2k tokens of tool definitions
 * BY ITSELF, so its tool list alone consumes the entire budget a 14B has available - the payload
 * does not merely cost tokens, it decides which models you can run at all.
 *
 * So this is the authoring spine and nothing else: find the right function, create, add state,
 * attach behaviour, compile, review, save. Everything else arrives through unreal_enable_tools.
 */
const MINIMAL_PROFILE_TOOLS = new Set([
  // The one tool for "something is wrong, find it". Its reply is the largest of any tool here, so
  // it is measured rather than assumed: ~1,300 tokens by default against a 385-finding project,
  // because detail is top-weighted - the leading groups carry their explanation and the rest are a
  // name and a count. On this profile's target (a 14B at 8k) that leaves room to think.
  "unreal_audit_project",
  // unreal_doctor is deliberately ABSENT, for the same reason unreal_create_blueprint is.
  //
  // It answers "why is this not working" during setup, and a model mid-task has no use for it -
  // but it takes NO ARGUMENTS, which makes it the easiest thing in the world to emit when you have
  // finished and not realised it. Measured: a 7B completed a task in one call and then called
  // doctor nineteen more times until the step limit stopped it.
  //
  // Two attempts to fix that by explaining failed. doctor's healthy verdict was changed to say
  // outright that calling it again returns the same answer: no effect. A general repeat notice was
  // added to every tool result: no effect either, though it is verified to be delivered. Removing
  // the tool from this profile took the same tasks from 20 calls to 3-6, immediately.
  //
  // The pattern is now three for three: a weak model does not act on being told, and does act on
  // not being offered. It is still in core, lazy and full.
  //
  // That last sentence used to end "and reachable via unreal_enable_tools", which was not true and
  // is why enable_tools is no longer in this list. A tool left out of `minimal` is never REGISTERED,
  // so there is no handle for enable_tools to switch on: calling it here with groups ["core","ui"]
  // returned "Nothing new to enable", alreadyOn: true, enabledCount: 11 - which a model would
  // reasonably read as "those tools are already available". They are not. It cost ~630 tokens, an
  // eighth of this profile's entire budget, to be misleading.
  //
  // Not fixed by making it work, deliberately. `core` is ~12,800 tokens and this profile's target is
  // a 14B at 8k, so a successful enable would destroy the context it was protecting. The profile
  // being fixed is the design; the instructions now say so outright.
  "unreal_list_blueprints",
  "unreal_find_node",
  // Deliberately NOT unreal_create_blueprint. It makes an EMPTY Blueprint, and the measured
  // failure of a small model is exactly that: it creates the empty asset, declares the task done,
  // and never adds anything. scaffold_blueprint does everything create does and more, so offering
  // both here only offers a way to fail. A profile built for weak models should contain the best
  // path for each job, not every path.
  "unreal_scaffold_blueprint",
  // Without this, the smallest and most reliable profile cannot build a user interface at all.
  "unreal_scaffold_widget",
  "unreal_add_variable",
  "unreal_add_event_handler",
  "unreal_compile_blueprint",
  "unreal_review_blueprint",
  "unreal_save_blueprint",
]);


// PROFILE is resolved above, next to the server it configures.

// How much to spend per build. The floor never moves: every mode still builds atomically, lays the
// graph out, and compiles. Modes trade polish and paperwork, never correctness.
const { policy: MODE, warning: MODE_WARNING } = resolveMode(process.env.UNREAL_MCP_MODE);
/**
 * A value being written into the engine, accepted as a string, a number or a boolean.
 *
 * Everything Unreal writes goes through ImportText, which takes a string, so every write parameter
 * here was `z.string()`. That is faithful to the engine and wrong for the caller: the natural way to
 * say "make it cost 500" is `{ Cost: 500 }`, and it was answered with
 *
 *   Expected string, received number at values.Cost
 *
 * on the single commonest change request there is. The round trip was never broken - a read returns
 * `"300"` and a write takes `"300"` - so this is not a mismatch between two tools, it is a mismatch
 * between the tool and the person using it, which is the harder one to notice from inside.
 *
 * Coercion is safe because the target is a string either way: 500 becomes "500", 1.5 becomes "1.5",
 * true becomes "true", which is exactly what ImportText wants for an int, a float and a bool.
 * Anything with real structure - a vector, a colour, an asset path - still has to be spelled the way
 * Unreal spells it, and no coercion could guess that.
 */
const engineValue = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((v) => String(v));

const registeredToolNames: string[] = [];
/** name -> the group that switches it on. Built from TOOL_GROUPS; anything absent is core. */
const GROUP_OF_TOOL = new Map<string, string>(
  Object.entries(TOOL_GROUPS).flatMap(([group, names]) => names.map((n) => [n, group] as [string, string]))
);
/** name -> what unreal_list_tools says about it, captured at registration so it cannot drift. */
const toolCatalog = new Map<string, { title: string; summary: string; group: string }>();
const toolHandles = new Map<string, { enable(): void; disable(): void; enabled: boolean }>();

/**
 * name -> the handler and its parameter shape, so a tool can be CALLED without being ENABLED.
 *
 * Enabling a tool changes the advertised tool list. That list is the first thing in the request,
 * ahead of the system prompt and every message, so changing it invalidates the prompt cache for the
 * whole conversation - the entire history is re-read at full price on the next turn. Every
 * measurement in this file counted standing tokens and none of them counted that, which made
 * `enable_tools` look free when it is the most expensive call the server offers.
 *
 * It is still the right call for a tool used repeatedly: one invalidation, then a typed schema the
 * model can see for the rest of the session. It is the wrong call for a tool used once. This map is
 * the other path - unreal_call_tool dispatches straight to the handler, the tool list never moves,
 * and the cache survives.
 *
 * Registration, not enablement, is the permission boundary: `core` and `minimal` never register the
 * tools they exclude, so those stay unreachable here too and the profiles keep their promise.
 */
const toolImpls = new Map<
  string,
  { handler: (args: never, extra: never) => Promise<unknown>; shape: Record<string, unknown> }
>();

/**
 * registerTool, gated by the active profile.
 *
 * Typed as the SDK's own registerTool so every call site keeps full inference on its zod schema
 * and handler arguments; a skipped tool returns an inert handle rather than being special-cased
 * at each of the 39 call sites.
 */
const repeatGuard = new RepeatGuard();

/**
 * Append the repeat notice to a tool result, without disturbing its shape.
 *
 * The notice goes on the END of the existing text rather than replacing it, because the result is
 * still the real result - the caller may well be reading it correctly and simply be stuck on what
 * to do next.
 */
function withRepeatNotice(result: unknown, notice: string | null): unknown {
  if (!notice || typeof result !== "object" || result === null) return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...(result as object),
    content: [...content, { type: "text", text: notice }],
  };
}

/**
 * Reject a parameter this tool does not have, instead of ignoring it.
 *
 * zod strips unknown keys by default, so a plausible-but-wrong parameter name was accepted in
 * silence and the tool ran unfiltered. Measured on the real project:
 *
 *   unreal_list_blueprints { match: "ServerList" }          75 tokens, one Blueprint
 *   unreal_list_blueprints { nameContains: "ServerList" }  4014 tokens, all 339
 *
 * 53x the cost for one wrong word, with nothing in the reply to say the filter did nothing - so the
 * caller may also go on to reason about "the Blueprints matching ServerList" and be wrong about all
 * 339 of them. Both halves of that are bad, and the second is worse.
 *
 * The names are not guessable and there is no reason they should be: `match`, `nameContains`,
 * `filter`, `contains` and `query` are all equally reasonable things to try. So the answer is the
 * one this repo already gives for a wrong pin name - refuse it, and say what does exist. The list is
 * captured at registration, so it cannot drift from the schema it came from.
 */
function strictSchema(toolName: string, shape: Record<string, unknown>): z.ZodTypeAny {
  const accepted = Object.keys(shape);
  const named = accepted.length === 0 ? "" : ` It accepts: ${accepted.join(", ")}.`;

  // The same help for a parameter left out as for one spelled wrong.
  //
  // `.strict()` below only covers unknown keys, so misspelling a name produced "not a parameter of
  // unreal_map_system. It accepts: query, maxAssets, depth, detail" while OMITTING a required one
  // produced zod's bare "Required at of" - the caller told least at the moment they know least.
  // unreal_find_orphans called with no arguments answered "Required at of / Required at pairedWith"
  // and nothing else: two names, no types, no list, no example.
  //
  // Two error paths describing the same problem differently is the defect this project keeps
  // finding, and it is the same repair every time: make the two agree.
  //
  // The field is cloned rather than annotated in place. Attaching the message to the schema instance
  // would name whichever tool registered first if two tools ever share one, and that is a wrong
  // answer that reads exactly like a right one.
  const shapeWithRequiredHints = Object.fromEntries(
    Object.entries(shape).map(([key, field]) => {
      const zodField = field as z.ZodTypeAny & { _def: Record<string, unknown> };
      const message =
        `${toolName} requires "${key}".${named} ` +
        `Nothing ran - call again with "${key}" set.`;
      const Ctor = zodField.constructor as new (def: unknown) => z.ZodTypeAny;
      return [
        key,
        new Ctor({
          ...zodField._def,
          errorMap: (issue: z.ZodIssueOptionalMessage, ctx: { defaultError: string }) =>
            issue.code === "invalid_type" && issue.received === "undefined"
              ? { message }
              : { message: ctx.defaultError },
        }),
      ];
    })
  );

  return z.object(shapeWithRequiredHints as z.ZodRawShape).strict(
    accepted.length === 0
      ? `${toolName} takes no parameters.`
      : `not a parameter of ${toolName}.${named} ` +
          `Nothing was filtered or changed by the unrecognised one - call again with the right name.`
  );
}

const register: typeof server.registerTool = ((name: string, config: never, handler: never) => {
  if (PROFILE === "core" && !CORE_PROFILE_TOOLS.has(name)) {
    return { enable() {}, disable() {}, remove() {}, update() {}, enabled: false } as never;
  }
  if (PROFILE === "minimal" && !MINIMAL_PROFILE_TOOLS.has(name)) {
    return { enable() {}, disable() {}, remove() {}, update() {}, enabled: false } as never;
  }
  registeredToolNames.push(name);
  // Captured here rather than maintained by hand, so unreal_list_tools can never fall out of step
  // with what is actually registered. The summary is the first sentence of the description: enough
  // to choose a tool, at a fraction of the cost of its schema.
  {
    const cfg = config as unknown as { title?: string; description?: string };
    const first = (cfg.description ?? "").split(". ")[0].trim();
    toolCatalog.set(name, {
      title: cfg.title ?? name,
      summary: first.length > 0 ? (first.endsWith(".") ? first : first + ".") : cfg.title ?? name,
      group: GROUP_OF_TOOL.get(name) ?? "core",
    });
  }
  // Wrap every handler so an identical repeated call is answered differently from the first. This
  // sits here rather than in each tool because the looping failure has appeared in three unrelated
  // tools already; fixing it per-tool fixed three symptoms and no causes.
  const guarded = (async (args: never, extra: never) => {
    const verdict = repeatGuard.record(name, args);
    const result = await (handler as unknown as (a: never, b: never) => Promise<unknown>)(args, extra);
    return withRepeatNotice(await withPathSuggestion(result, args), verdict.notice);
  }) as never;
  // Swap the raw shape for a strict object of the same shape. It stays a ZodObject, so the SDK
  // still derives the advertised JSON schema from it exactly as before.
  {
    const cfg = config as unknown as { inputSchema?: Record<string, unknown> };
    const shape = cfg.inputSchema;
    if (shape && typeof shape === "object" && !("_def" in shape) && !("_zod" in shape)) {
      cfg.inputSchema = strictSchema(name, shape) as never;
    }
  }
  const handle = server.registerTool(name, config, guarded);
  toolHandles.set(name, handle as unknown as { enable(): void; disable(): void; enabled: boolean });
  // The same handler the SDK will call, kept where unreal_call_tool can reach it. Captured AFTER the
  // strict-schema swap above so the dispatcher validates against exactly the schema the tool
  // advertises - two ways to call one tool that disagree about its arguments is the defect class
  // this project keeps finding, and it is not going to be introduced deliberately here.
  {
    const cfg = config as unknown as { inputSchema?: Record<string, unknown> };
    toolImpls.set(name, { handler: guarded as never, shape: cfg.inputSchema ?? {} });
  }
  return handle;
}) as typeof server.registerTool;

/** Switch a group on. Returns the tool names that became available. */
function enableGroup(group: string): string[] {
  // "core" is not in TOOL_GROUPS - it is the set the other profiles leave on permanently. In the
  // "search" profile it is switched off like everything else, so it needs a name to ask for.
  const names = group === "core" ? [...CORE_PROFILE_TOOLS] : TOOL_GROUPS[group] ?? [];
  const turnedOn: string[] = [];
  for (const name of names) {
    const handle = toolHandles.get(name);
    if (handle && !handle.enabled) {
      handle.enable();
      turnedOn.push(name);
    }
  }
  return turnedOn;
}

/**
 * Replies are compact JSON, not pretty-printed.
 *
 * Every reply used `JSON.stringify(value, null, 2)`, and the indentation is the single largest
 * remaining cost on this surface. Measured across eight reads on the real project:
 *
 *   list_blueprints         3,328 -> 2,669   -20%
 *   review_blueprint        4,235 -> 2,726   -36%
 *   read_class_defaults     4,688 -> 3,237   -31%
 *   read_blueprint_summary  3,110 -> 2,121   -32%
 *   list_variables          2,449 -> 1,732   -29%
 *   audit_project           3,442 -> 2,856   -17%
 *   project_health          1,617 -> 1,267   -22%
 *   list_data_table_rows    5,695 -> 5,458    -4%
 *   ------------------------------------------------
 *   total                  28,563 -> 22,066  -23%
 *
 * The spread is the shape of the data rather than anything else: a long list of small objects is
 * mostly indentation, and a short list of enormous struct literals is mostly the literals.
 *
 * ## Why this loses nothing
 *
 * It is the same JSON. Any parser produces exactly the same object, no field changes, no field is
 * dropped, and every newline that carries meaning - the paragraph breaks inside `next` and `fix`
 * text - lives inside a string and is untouched by the indent setting. This is the purest form of
 * the trade this project is trying to make: fewer tokens, nothing given up.
 *
 * The one thing it costs is a person eyeballing a raw reply, which is not who reads these. The CLI
 * paths that a human does read - the doctor report, the audit written to a file, the measurement
 * scripts - still pretty-print, because there the indentation is the product.
 */
function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value),
      },
    ],
  };
}

/**
 * `hint` is for what the tool layer knows and the bridge cannot.
 *
 * The bridge's type error already lists every supported form, which is the right answer to a typo.
 * It is not the right answer to "StaticMesh", where the caller is one prefix away and the list does
 * not say which prefix - and the tool layer is the only place that can tell those two cases apart.
 */
/**
 * `unknown_cmd` is the one bridge error the tool layer understands better than the bridge does.
 *
 * The plugin answers `unknown_cmd: run_console_command` and stops there, which is all it can say: it
 * has never heard of the command. But this server only sends commands it was built against, so the
 * pair of facts - the server sends it, the plugin does not know it - can only mean the plugin binary
 * is older than the server.
 *
 * It says "sends" rather than "has a tool for" on purpose. Three bridge commands are deliberately
 * internal - find_broken_names, live_coding_compile, live_coding_status - reached only through a
 * composite, and hot_reload_cpp hits exactly this error on a stale plugin. Claiming a tool exists
 * for one of those would be a confident falsehood inside a message whose whole job is to correct a
 * wrong conclusion.
 *
 * Measured on this project right now: nine of twelve probed commands are missing, and a model
 * calling one gets six words with no way to tell whether the feature does not exist, the call was
 * wrong, or a rebuild is needed. It would reasonably conclude the first and stop asking.
 *
 * unreal_doctor already diagnoses this properly - "At least 9 of the 12 probed commands are missing
 * from this plugin" and "the C++ source on disk is newer" - but a model in the middle of a task hits
 * the error, not the diagnosis. This is the sentence that points from one to the other.
 */
function explainUnknownCommand(message: string): string | undefined {
  const match = /unknown_cmd:\s*([a-z0-9_]+)/i.exec(message);
  if (!match) return undefined;
  return (
    `This server sends "${match[1]}" and the UnrealMCPBridge plugin running in your editor has never ` +
    `heard of it, which means the plugin binary is older than this server - not that the feature is ` +
    `missing or the call was wrong. Everything the older plugin does know still works, so this is ` +
    `not a reason to stop. unreal_doctor lists every command affected and how out of date the build ` +
    `is; the cure is to close the editor, run \`npm run build:engines\`, and reopen.`
  );
}

/**
 * Attach "Did you mean ...?" to a not-found error, by looking the name up instead of describing how.
 *
 * Runs ONLY on a reply that is already an error and already names a missing path, so the happy path
 * pays nothing - no extra bridge call, no extra token, byte-identical replies. The lookup it does
 * make is internal: `list_blueprints` unfiltered is ~2,669 tokens, and none of them reach the model.
 * What reaches the model is one line naming a real path.
 *
 * A non-Blueprint asset - a Data Table, a texture - will not be in that list, so no match is found
 * and the original error stands unchanged. That is the intended outcome rather than a gap to
 * apologise for: a wrong suggestion is worse than none, and the error already teaches the fix.
 */
/**
 * The "did you mean" line for an error, or undefined when nothing certain can be said.
 *
 * Kept separate from the wrapper that attaches it so the lookup can be read and tested on its own -
 * it is the part with the bridge call in it, and the wrapper is the part with the result shape.
 *
 * 129 of 134 handlers catch their errors and return them through errorResult. The five that do not
 * are local composites - list_tools, enable_tools, find_source, guide, session_changes - none of
 * which can produce a not-found error, because none of them look an asset up. So every error this
 * can say anything about arrives as a RETURNED result, and there is no second path to handle.
 */
async function suggestionFor(text: string, args?: unknown): Promise<string | undefined> {
  // A wrong graph name, which the bridge answers with an ALPHABETICAL slice of what exists. On a
  // real Blueprint that was twelve of fifty-eight graphs, cut off one entry before `EventGraph` -
  // the obvious answer, absent from a list whose whole job was to contain it. Ranking by similarity
  // to what was asked is the same fix as the didYouMean re-ranking, and reuses its scoring.
  const missingGraph = notFoundGraph(text);
  if (missingGraph) {
    const path = (args as { path?: string } | undefined)?.path;
    if (typeof path !== "string" || path.length === 0) return undefined;
    try {
      const listed = await bridge.send<{ graphs?: Array<{ name?: string }> }>("list_blueprint_graphs", { path });
      const names = (listed.graphs ?? []).map((g) => g?.name).filter((n): n is string => typeof n === "string");
      return suggestionLine(rankNames(missingGraph, names));
    } catch {
      return undefined;
    }
  }

  const missing = notFoundPath(text);
  if (!missing) return undefined;
  const needle = leafName(missing);
  if (needle.length === 0) return undefined;
  try {
    const listed = await bridge.send<{ blueprints?: PathCandidate[] }>("list_blueprints", {});
    return suggestionLine(rankCandidates(needle, listed.blueprints ?? []));
  } catch {
    // A courtesy on a call that has already failed. If the bridge cannot answer the lookup, the
    // original error is still the right answer and must not be replaced by a lookup failure.
    return undefined;
  }
}

/** Append the suggestion to an error a tool RETURNED. */
async function withPathSuggestion(result: unknown, args?: unknown): Promise<unknown> {
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (r?.isError !== true || !Array.isArray(r.content)) return result;

  const block = r.content.find((c) => c?.type === "text" && typeof c.text === "string");
  if (!block?.text) return result;

  const line = await suggestionFor(block.text, args);
  if (!line) return result;
  return {
    ...r,
    content: r.content.map((c) => (c === block ? { ...c, text: `${c.text}\n\n${line}` } : c)),
  };
}



function errorResult(err: unknown, hint?: string) {
  const message = err instanceof Error ? err.message : String(err);
  hint = hint ?? explainUnknownCommand(message);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `UnrealMCPBridge error: ${message}${hint ? "\n\n" + hint : ""}`,
      },
    ],
  };
}

register(
  "unreal_ping",
  {
    title: "Ping Unreal MCP Bridge",
    description:
      "Checks whether the UnrealMCPBridge plugin is running inside the Unreal Editor and reachable over TCP. " +
      "Use this first to confirm the editor bridge is up before calling other unreal_* tools.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send<PingResult>("ping");
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_runtime_errors",
  {
    title: "Read what went wrong when you pressed Play",
    description:
      "Reads the Unreal Editor's own log and reports what actually failed during the last Play In Editor session, " +
      "grouped and ranked. **This is the only tool here that sees runtime problems** - everything else reads the " +
      "graph, and the most common Unreal bug of all does not exist until the game runs: " +
      "\"Accessed None trying to read property X\". Those lines name the exact Blueprint, graph and node, and this " +
      "returns them as fields rather than as text. One null reference on Tick writes the same line thousands of " +
      "times, so identical messages are grouped: a session with 2,000 error lines is usually a dozen real problems. " +
      "Engine noise (callstack dumps, Steam not running) is counted separately rather than mixed in. Use it after " +
      "unreal_start_pie, or when someone says the game printed errors - it reads the session that already happened.",
    inputSchema: {
      wholeLog: z
        .boolean()
        .optional()
        .describe("Read the entire log instead of only the most recent Play In Editor session. Defaults to false."),
      includeWarnings: z
        .boolean()
        .optional()
        .describe("Include warnings as well as errors. Defaults to false - there are usually thousands."),
      limit: z.number().int().optional().describe("How many distinct problems to detail. Defaults to 15."),
      logFile: z
        .string()
        .optional()
        .describe("Read a specific log file instead of the open project's. Rarely needed."),
    },
  },
  async ({ wholeLog, includeWarnings, limit, logFile }) => {
    try {
      // Asked of the editor rather than configured, so this cannot read one project's log while
      // editing another - which is exactly the confusion that wastes an afternoon.
      const ping = await bridge.send<PingResult & { projectFile?: string }>("ping");
      if (!ping.projectFile && !logFile) {
        throw new Error(
          "no_project_file: the plugin did not report which project is open, so the log cannot be located. " +
            "Update the plugin, or pass logFile."
        );
      }
      const result = await readRuntimeLogForProject(ping.projectFile ?? "", {
        wholeLog,
        includeWarnings,
        limit,
        logFile,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_blueprints",
  {
    title: "List Unreal Blueprints",
    description:
      "Blueprint assets in the open project: path and parent class, not graph contents; the name is the last " +
      "segment of `path`. Drill in by listing that Blueprint's graphs.",
    inputSchema: {
      pathPrefix: z
        .string()
        .optional()
        .describe('Scope to a content path, e.g. "/Game/Blueprints". Defaults to "/Game".'),
      match: z
        .string()
        .optional()
        .describe('Filter by name, path or parent class, e.g. "Enemy".'),
      maxResults: z.number().optional().describe("Cap on results. Default 100."),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          'Return only these fields on each row, e.g. ["path"]. A view, not a filter - it changes what ' +
            "each row carries, not which rows come back. Names that match nothing are reported rather than " +
            "silently dropped."
        ),
    },
  },
  async ({ pathPrefix, match, maxResults, fields }) => {
    try {
      const result = await bridge.send<ListBlueprintsResult>("list_blueprints", { pathPrefix });
      const all = result.blueprints ?? [];
      // Every term, in any order, rather than one literal substring. "shop upgrade" found
      // nothing here and "ShopUpgrade" found seven, which is the trap matchTerms.ts documents.
      const terms = matchTerms(match);
      const needle = (match ?? "").trim().toLowerCase();
      const filtered =
        terms.length > 0
          ? all.filter((b) =>
              matchesAllTerms(`${b.name ?? ""} ${b.path ?? ""} ${b.parentClass ?? ""}`, terms)
            )
          : all;
      const limit = Math.max(1, Math.min(maxResults ?? 100, 5000));

      // Compact AFTER filtering: `match` reads the name that compaction removes. The field view is
      // applied last, for the same reason - it is what the caller SEES, not what the tool searches.
      let unknownFields: string[] = [];
      const compact = (rows: typeof all) => {
        const compacted = rows.map((r) => compactBlueprintRow({ ...r }));
        if (!fields || fields.length === 0) return compacted;
        const picked = pickFields(compacted, fields);
        unknownFields = picked.unknown;
        return picked.rows;
      };
      /**
       * Mention the cheaper form, but only after an expensive reply has already been paid for.
       *
       * `fields: ["path"]` returns the same rows without `parentClass` and cuts a 100-row reply from
       * 2,562 tokens to 1,858 - 27%, measured on a real project. It has existed all along and the
       * description never mentioned it, so nothing told a model the lever was there.
       *
       * Putting it in the description was considered and the arithmetic says no: ~25 tokens on every
       * request against ~700 saved per call means break-even at about fifty requests, which is inside
       * the range of a normal session. Here it is free - it appears only when the reply was big
       * enough for the advice to be worth anything, which is exactly when a model is looking at the
       * cost it just paid.
       */
      const withCheaperForm = (payload: Record<string, unknown>, rowCount: number) =>
        rowCount >= ADVISE_WHEN_ROWS_AT_LEAST && (!fields || fields.length === 0)
          ? {
              ...payload,
              cheaper:
                `Only need the paths? \`fields: ["path"]\` returns the same rows without parentClass, ` +
                `about 27% smaller on a list this size.`,
            }
          : payload;

      const withFieldNote = (payload: Record<string, unknown>) =>
        unknownFields.length > 0
          ? { ...payload, unknownFields, note: `No row has ${unknownFields.join(", ")}; those were ignored.` }
          : payload;

      if (filtered.length <= limit) {
        // The same hint on this path, and it matters more here: this is the branch a caller reaches
        // by raising maxResults, so the reply is the biggest one the tool ever sends and nothing was
        // truncated to warn them.
        const rows = needle ? filtered : all;
        // `count` is how many are in THIS reply, and nothing else.
        //
        // The bridge sets count to the number it sent, then this server filters by `match` and left
        // the field alone - so unreal_list_blueprints({match:"Player"}) returned 19 Blueprints and
        // reported count: 355. A model asking how many Player Blueprints exist read 355, and no
        // field anywhere said 19. Found by pointing the tools at a real project instead of a
        // scratch one, where the filter matches everything and the bug cannot show.
        //
        // Three sibling tools had three meanings for the same field name: list_assets used it for
        // rows returned, list_actors omitted it, this one used it for the project total. `count` is
        // the rows in front of you in all of them now; `totalBlueprints` is how many exist, and
        // `matched` is how many the filter found when a filter was used.
        return jsonResult(
          withCheaperForm(
            withFieldNote(
              needle
                ? {
                    ...result,
                    blueprints: compact(filtered),
                    count: filtered.length,
                    // No `matched` here: nothing was cut, so it would equal `count` in every reply
                    // this branch sends - which is the duplication the line above removes. It
                    // appears only where it says something count does not, in the truncated branch.
                    totalBlueprints: all.length,
                  }
                : { ...result, blueprints: compact(all), count: all.length }
            ),
            rows.length
          )
        );
      }
      // 339 Blueprints came to 15,149 tokens on a real project. Enumerating a whole project is
      // rarely the question; finding something in it usually is, and search_project answers that
      // for a sixth of the cost.
      return jsonResult(
        withCheaperForm(withFieldNote({
        ...result,
        blueprints: compact(filtered.slice(0, limit)),
        // `shown` used to sit here saying exactly what `count` now says. Two names for one number is
        // the thing this project keeps having to undo, so there is one: count.
        count: limit,
        ...(needle ? { matched: filtered.length } : {}),
        totalBlueprints: all.length,
        omitted: filtered.length - limit,
        truncated: true,
        next:
          `${all.length} Blueprints in this project; ${limit} listed. Narrow with \`match\` (name, path ` +
          `or parent class) or \`pathPrefix\`, use unreal_search_project to find one by what it contains, ` +
          `or raise \`maxResults\`.`,
        }), limit)
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_blueprint_graphs",
  {
    title: "List a Blueprint's graphs",
    description:
      "Lists the graphs (event graphs, functions, macros) inside one Blueprint, with just names and node counts. " +
      "This is the first tier of the tiered-read strategy: call this before unreal_read_blueprint_summary to decide " +
      "which graph is worth reading in full.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send<ListBlueprintGraphsResult>("list_blueprint_graphs", { path });
      // NOT turned into a {name: nodeCount} map, although it is the same shape as the parent-class
      // census and would save about 250 tokens of 643.
      //
      // The difference is what the reply is FOR. A census is terminal - you read it and you are
      // done. This is NAVIGATION: every name in it gets fed straight back into
      // read_blueprint_summary or explain_graph, and callers iterate it as a list. Changing it to a
      // map broke measure-reads on the first run, which picks the largest graph from this array to
      // measure the reads that follow. That is a consumer inside this repo; the ones outside it
      // cannot be fixed by finding out.
      //
      // A saving that changes a navigation contract costs more than 250 tokens.
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_explain_graph",
  {
    title: "What does this graph actually do?",
    description:
      "**Read this before reading a graph node by node.** Every entry point and the ordered chain of what it does, " +
      "with each Branch labelled by what it tests - `Branch (Has Authority)`, `Branch (Get Health < Get MaxHealth)`. " +
      "So it is also the first call for \"why did nothing happen\": the first gate that is false is the answer. " +
      "A 56-node EventGraph costs 1,996 tokens as a node-and-pin structure and 337 here, a sixth; " +
      "unreal_read_blueprint_summary caps at 60 nodes, this explains all 809. " +
      "Deliberately lossy - no exact pins or node ids. For those, call " +
      "unreal_read_blueprint_summary on the one chain you are changing.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().optional().describe('Graph to explain. Defaults to "EventGraph".'),
      match: z
        .string()
        .optional()
        .describe(
          "Only chains mentioning this, in their entry name or any step. The header says how many were " +
            "left out."
        ),
      maxChains: z
        .number()
        .optional()
        .describe("Entry-point chains listed in the structured result. Defaults to 25; the prose always covers every one."),
    },
  },
  async ({ path, graphName, maxChains, match }) => {
    try {
      const summary = await bridge.send("read_blueprint_graph_summary", {
        path,
        graphName: graphName ?? "EventGraph",
      });
      const explained = explainGraph(summary as never, { match });

      // Measured on a real Blueprint: 13,294 tokens, of which the `chains` array was 7,296 across
      // 89 chains and the prose - the thing this tool exists to produce - was 2,043. The array
      // largely restates the prose and carries every visited node id, which the caller of THIS tool
      // does not need: audit and review use explainGraph() directly and still get all of it.
      // The chains and the unreachable list were both sent TWICE.
      //
      // `text` is 92 lines and 2,030 tokens of "- FireWeapon -> Can Shoot -> Branch -> ...", one per
      // entry point, for all 89 of them, and it ends with the unreachable nodes and their counts.
      // The `chains` array then restated the first 25 of those same chains as JSON (872 tokens) and
      // `unreachable` restated the same list again (110). The old reply even said so out loud - its
      // own chainsNote read "The prose above covers all of them" - and capped the array instead of
      // removing it.
      //
      // The array had exactly one thing the prose does not: the entry node's id, which is what lets a
      // caller jump straight to a node instead of searching for it. That is 69 tokens of the 872, so
      // it is what survives. The steps are stated once, in the prose, where they were already
      // complete rather than capped.
      //
      // What a caller loses is `steps` as an array instead of a line to split on " -> ". Measured at
      // roughly 880 tokens, about a quarter of this reply, for a string split against text that was
      // being sent regardless.
      const limit = Math.max(1, Math.min(maxChains ?? 25, 500));
      // Ids for the chains actually written out, not for every chain in the graph.
      //
      // This was built from `explained.chains` while `text` showed a filtered subset, so
      // match: "vacuum" returned fifteen chains and twenty-five ids - ten of them pointing at entry
      // points the same reply had withheld. Filtering half a reply is worse than not filtering it:
      // the caller cannot tell which half they are holding.
      const shown = new Set(explained.shownEntries);
      const entryIds: Record<string, string> = {};
      for (const chain of explained.chains.slice(0, limit)) {
        if (!shown.has(chain.entry)) continue;
        // First one wins. Two chains can share an entry name, and overwriting would leave an id
        // pointing at a node the caller did not mean.
        if (chain.entryId && !(chain.entry in entryIds)) entryIds[chain.entry] = chain.entryId;
      }

      return jsonResult({
        path: explained.path,
        graphName: explained.graphName,
        nodeCount: explained.nodeCount,
        text: explained.text,
        // Named for what it is rather than what it replaced: the ids, so a chain in the prose can be
        // acted on. The steps themselves are in `text`, and all of them are, not the first 25.
        entryIds,
        ...(shown.size > Object.keys(entryIds).length
          ? {
              entryIdsNote:
                `${shown.size} entry points shown; ids given for ${Object.keys(entryIds).length}. ` +
                `Every chain is written out in \`text\` regardless - raise maxChains only if you need ` +
                `an id for one further down.`,
            }
          : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_blueprint_summary",
  {
    title: "Read a Blueprint graph summary",
    description:
      "Reads a compact summary of one graph: each node's id, type, title, and its wiring as one line per " +
      "connected pin, e.g. \"out then -> 3C03B7C2.execute\" (direction, pin name, then the nodes it reaches). " +
      "Node ids are abbreviated to the shortest prefix unique in this graph, and every tool that takes a node " +
      "id accepts that prefix. Type names have their K2Node_ prefix stripped. Positions, cosmetic metadata and " +
      "unconnected pins are omitted. " +
      "Pass withPinValues for the literals on many nodes at once; one node's full pin and property detail is a " +
      "read of that node id.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe('Graph name as returned by unreal_list_blueprint_graphs, e.g. "EventGraph".'),
      match: z
        .string()
        .optional()
        .describe(
          'Only nodes whose title or type contains this, e.g. "Cast" or "Health". The cheapest way to read a ' +
            "large graph: 809 nodes and 52k tokens down to 23 nodes and 700. Matches arrive with the nodes they " +
            "are wired to, marked `neighbour` and carrying a title, so every link in the reply resolves inside " +
            "the reply and the node you actually wanted is usually already named."
        ),
      maxNodes: z
        .number()
        .optional()
        .describe("Cap on nodes returned. Defaults to 150. Entry points are always kept. Raise it only when you genuinely need the whole graph."),
      withPinValues: z
        .boolean()
        .optional()
        .describe(
          "What each node's unwired input pins are SET to, as `values`. With `match`, reads a literal off many " +
            "nodes in one call instead of a read_node_detail each."
        ),
    },
  },
  async ({ path, graphName, match, maxNodes, withPinValues }) => {
    try {
      const result = await bridge.send<ReadBlueprintGraphSummaryResult>("read_blueprint_graph_summary", {
        path,
        graphName,
        withPinValues,
      });

      // Bounded in the TOOL, not in the bridge: review, audit and explain_graph call the bridge
      // command directly and still get every node, so the analysis stays correct while the model
      // gets a view it can afford. See src/graphSummary.ts for the measurement behind the cap.
      return jsonResult(capGraphSummary(result as never, { match, maxNodes }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_node_detail",
  {
    title: "Read full detail for one Blueprint node",
    description:
      "Reads full pin and property detail (categories, default values, array-ness, links) for exactly one node, " +
      "identified by the node id returned from unreal_read_blueprint_summary. Use sparingly: this is the most " +
      "verbose tier of the tiered-read strategy and should follow a summary read, not replace it.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe("Graph name containing the node."),
      nodeId: z.string().describe('Node id as returned by unreal_read_blueprint_summary, e.g. "n12".'),
    },
  },
  async ({ path, graphName, nodeId }) => {
    try {
      const result = await bridge.send<ReadBlueprintNodeDetailResult>("read_blueprint_node_detail", {
        path,
        graphName,
        nodeId,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =============================== Milestone 2: write/edit tools ===============================
// Same thin-translator pattern as the M1 read tools above: each tool is just a param reshape
// plus a call to the bridge. All the actual Blueprint-editing logic lives in the C++ plugin
// (MCPCommandHandler.cpp). This file never touches engine state directly.

register(
  "unreal_create_blueprint",
  {
    title: "Create a new Blueprint asset",
    description:
      "**If you also need variables, components, or event logic, use unreal_scaffold_blueprint instead** - it does all " +
      "of that in one call, in the right order. " +
      "Creates a new EMPTY Blueprint asset at a given content path with a given parent class, and saves it to disk " +
      "by default. Use this before unreal_add_node/unreal_add_variable to start building a new Blueprint from scratch. " +
      "Fails if an asset already exists at packagePath.",
    inputSchema: {
      packagePath: z
        .string()
        .describe('Full content path for the new asset, e.g. "/Game/_MCPTest/BP_MyActor" (no extension, no _C suffix).'),
      parentClass: z
        .string()
        .describe(
          'Parent class: a short native name ("Actor", "Pawn", "ActorComponent"), or a full path ' +
            '("/Script/Engine.Actor", or another Blueprint\'s generated class "/Game/BP_Base.BP_Base_C").'
        ),
      save: z
        .boolean()
        .optional()
        .describe("Whether to save the new asset to disk immediately. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, save }) => {
    try {
      const result = await bridge.send<CreateBlueprintResult>("create_blueprint", { packagePath, parentClass, save });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_node",
  {
    title: "Add a node to a Blueprint graph",
    description:
      "Adds one node to a graph and returns its new node id immediately so you can reference it in the same " +
      "conversation (via unreal_connect_pins, unreal_set_pin_default_value, etc) without re-reading the whole graph. " +
      "Node ids are the node's persistent GUID: stable across editor restarts and unaffected by removing other nodes.\n\n" +
      "nodeType determines which other params are required:\n" +
      '  - "Event": eventName = a function on the Blueprint\'s parent class to override (e.g. "ReceiveBeginPlay", "ReceiveTick").\n' +
      '  - "CustomEvent": eventName = name for the new custom event (auto-uniquified if it collides).\n' +
      '  - "EnhancedInputAction": inputAction = an InputAction asset ("IA_Jump" or a full path). How a UE5 project ' +
      "reacts to input, and what you want unless the project predates Enhanced Input. Its exec pins are the trigger " +
      'events: "Triggered" (the one you almost always want), "Started", "Ongoing", "Canceled", "Completed"; it ' +
      'also outputs "ActionValue", "ElapsedSeconds" and "TriggeredSeconds". Make the asset with ' +
      "unreal_create_asset assetClass=InputAction and bind it to a key with unreal_map_input_key.\n" +
      '  - "InputKey" (key) / "InputAxis" (axisName): the LEGACY input events, from before Enhanced Input. Use ' +
      "them only on a project with no InputMappingContext assets - check with unreal_list_assets " +
      "className=InputMappingContext. On a project that uses Enhanced Input these compile perfectly and then never " +
      "fire, which is the worst way to be wrong: nothing reports an error and the key simply does nothing.\n" +
      '  - "Self": a reference to the owning instance, for passing "this" into a call or comparing against it. ' +
      "No other params.\n" +
      '  - "CallFunction": functionName required; className optional (short name or full path); defaults to searching ' +
      "the Blueprint's own generated class, then its parent class. If the name is close but wrong, the error includes " +
      "a didYouMean list of near-misses.\n" +
      '  - "VariableGet" / "VariableSet": variableName = an existing member variable on this Blueprint (added via ' +
      "unreal_add_variable). Inherited variables from a parent class are not yet supported.\n" +
      '  - "Branch": an if/else on a bool. Pins: execute, Condition, then, else. No other params.\n' +
      '  - "Sequence": executes its output pins in order (then_0, then_1). No other params.\n' +
      '  - "GetArrayItem": the "Get (a copy)" node - one element out of an array. No other params. It is pure, so it has no execution pins: wire the array into "Array", the index into "Dimension 1", and read the element from "Output".\n' +
      '  - "CallParent": the "Parent: BeginPlay" node - right-click an overridden event in the editor and ' +
      'choose "Add call to parent function". functionName required, written as the editor shows it on the ' +
      'event node ("BeginPlay", "Tick", "EndPlay") - the Receive- prefix is added for you. Adding an event to ' +
      "a child Blueprint REPLACES the parent's rather than extending it, and nothing warns, so whatever the " +
      "parent set up simply never happens. This is the fix for the parent-event-not-called finding: wire it " +
      "FIRST in that chain.\n" +
      '  - "Cast": targetClass required (short name or full path); pure optional (default false = has exec pins). ' +
      "Pins: execute, Object, then, CastFailed, As<Class>.\n" +
      '  - "Macro": macroName required, from the engine\'s standard macro library: ForEachLoop, ForLoop, WhileLoop, ' +
      "DoOnce, DoN, Gate, FlipFlop, IsValid, etc. A wrong name returns the full list of available macros. NOTE: macro " +
      'nodes name their input exec pin "Exec" (capital E), unlike regular nodes\' "execute".\n\n' +
      "x/y are optional graph-editor position hints (cosmetic only, for the human opening the graph later). Set them " +
      "roughly left-to-right in execution order so the graph stays readable to a human. comment is an optional " +
      "annotation shown on the node; use it to explain WHY a node exists, as you place it.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe('Graph name to add the node to, e.g. "EventGraph".'),
      nodeType: z.enum(["Event", "CustomEvent", "EnhancedInputAction", "InputKey", "InputAxis", "CallFunction", "VariableGet", "VariableSet", "Branch", "Sequence", "GetArrayItem", "Cast", "Macro", "CallParent", "Self"]),
      eventName: z.string().optional().describe("Required for nodeType Event or CustomEvent."),
      inputAction: z
        .string()
        .optional()
        .describe('Required for nodeType EnhancedInputAction: the InputAction asset, e.g. "IA_Jump" or "/Game/Input/IA_Jump".'),
      key: z.string().optional().describe('Required for nodeType InputKey, e.g. "F", "SpaceBar", "LeftMouseButton".'),
      axisName: z
        .string()
        .optional()
        .describe('Required for nodeType InputAxis: an axis mapping name, added first with unreal_add_input_mapping.'),
      // These three were implemented in the bridge and reachable from no tool, so a Server RPC -
      // the thing every piece of multiplayer logic is built from - could not be authored at all.
      netMode: z
        .enum(["Server", "Multicast", "Client"])
        .optional()
        .describe(
          'For CustomEvent: makes it an RPC. "Server" runs it on the server when a client calls it (the only ' +
            'way a client can change authoritative state), "Multicast" runs it on everyone, "Client" on the owner.'
        ),
      reliable: z
        .boolean()
        .optional()
        .describe("For an RPC: guarantee delivery. Default false. Use true for anything that must not be dropped."),
      inputs: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe('Parameters for a CustomEvent, e.g. [{"name":"SkinId","type":"int"}]. An RPC that carries no data is rarely what you want.'),
      functionName: z.string().optional().describe("Required for nodeType CallFunction."),
      className: z.string().optional().describe("Optional owning class for nodeType CallFunction."),
      variableName: z.string().optional().describe("Required for nodeType VariableGet or VariableSet."),
      ownerClass: z
        .string()
        .optional()
        .describe(
          "For VariableGet/VariableSet: the class that DECLARES the variable, when it lives on another object " +
            'rather than this Blueprint - e.g. "AVS_GameInstance_C" for a variable read off a cast result. Wire ' +
            "the node's `self` pin to that object. Omit for this Blueprint's own or inherited variables."
        ),
      targetClass: z.string().optional().describe("Required for nodeType Cast: the class to cast to."),
      pure: z.boolean().optional().describe("Cast only: true for the pure (no exec pins) form. Defaults to false."),
      macroName: z.string().optional().describe('Required for nodeType Macro, e.g. "ForEachLoop", "WhileLoop", "DoOnce".'),
      x: z.number().optional().describe("Cosmetic graph-editor X position. Defaults to 0."),
      y: z.number().optional().describe("Cosmetic graph-editor Y position. Defaults to 0."),
      comment: z.string().optional().describe("Optional node comment explaining why this node exists."),
    },
  },
  async ({ path, graphName, nodeType, eventName, inputAction, key, axisName, netMode, reliable, inputs, functionName, className, variableName, ownerClass, targetClass, pure, macroName, x, y, comment }) => {
    try {
      const result = await bridge.send<AddNodeResult>("add_node", {
        path,
        graphName,
        nodeType,
        eventName,
        inputAction,
        key,
        axisName,
        netMode,
        reliable,
        inputs,
        functionName,
        className,
        variableName,
        ownerClass,
        targetClass,
        pure,
        macroName,
        x,
        y,
        comment,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_connect_pins",
  {
    title: "Connect two Blueprint node pins",
    description:
      "Connects an output pin on one node to an input pin on another (works for both exec and data pins). Source/target " +
      "node ids come from unreal_read_blueprint_summary or unreal_add_node. `fromNode`/`fromPin`/`toNode`/`toPin` are " +
      "accepted as aliases for the source/target four. Fails with incompatible_pins if the schema " +
      "rejects the connection (e.g. mismatched data types). The error message explains why.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe("Graph name containing both nodes."),
      // `source`/`target` is the only place on this surface that spells a node id this way: twelve
      // other tools call it `nodeId`, and nothing else takes a `sourceNodeId` at all. This is the
      // tool every graph edit goes through, so the one odd spelling is also the most-typed one, and
      // `fromNode`/`toNode` is what a caller reaches for when wiring A to B.
      //
      // Measured on this server's own sessions rather than assumed: four parameter-name misses in
      // one working session, and this tool accounted for one of them - a call that named all four
      // pins correctly and still ran nothing. The existing check:params guard was built for exactly
      // this and its synonym table did not cover it, so the table grew too.
      //
      // The published names stay primary; renaming them would break callers. They just are not the
      // only way in any more.
      sourceNodeId: z.string().optional().describe("Node id (GUID) owning the OUTPUT pin."),
      sourcePin: z.string().optional().describe('Output pin name on the source node, e.g. "then" or "ReturnValue".'),
      targetNodeId: z.string().optional().describe("Node id (GUID) owning the INPUT pin."),
      targetPin: z.string().optional().describe('Input pin name on the target node, e.g. "execute" or "Target".'),
      fromNode: z.string().optional(),
      fromPin: z.string().optional(),
      toNode: z.string().optional(),
      toPin: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const sourceNodeId = args.sourceNodeId ?? args.fromNode;
      const sourcePin = args.sourcePin ?? args.fromPin;
      const targetNodeId = args.targetNodeId ?? args.toNode;
      const targetPin = args.targetPin ?? args.toPin;
      const missing = [
        !sourceNodeId && "sourceNodeId (or fromNode)",
        !sourcePin && "sourcePin (or fromPin)",
        !targetNodeId && "targetNodeId (or toNode)",
        !targetPin && "targetPin (or toPin)",
      ].filter(Boolean);
      if (missing.length > 0) {
        return errorResult(
          new Error(`unreal_connect_pins needs ${missing.join(", ")}. Nothing ran.`)
        );
      }
      const result = await bridge.send<ConnectPinsResult>("connect_pins", {
        path: args.path,
        graphName: args.graphName,
        sourceNodeId,
        sourcePin,
        targetNodeId,
        targetPin,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_pin_default_value",
  {
    title: "Set a literal default value on an unconnected input pin",
    description:
      "Sets a literal (string-serialized) default value on an input pin, e.g. setting a float literal to \"1.5\" or a " +
      "bool literal to \"true\". Fails with pin_is_connected if the pin already has a link: disconnect it first.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe("Graph name containing the node."),
      nodeId: z.string().describe("Node id (GUID) of the node owning the pin."),
      pinName: z.string().describe("Input pin name."),
      value: engineValue.describe("The literal. A number or boolean is accepted; structured values are spelled the way Blueprint pin defaults are stored."),
    },
  },
  async ({ path, graphName, nodeId, pinName, value }) => {
    try {
      const result = await bridge.send<SetPinDefaultValueResult>("set_pin_default_value", {
        path,
        graphName,
        nodeId,
        pinName,
        value,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_node",
  {
    title: "Remove a node from a Blueprint graph",
    description: "Removes a node by id and breaks all of its pin links first. Does not recompile. Call unreal_compile_blueprint afterward.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe("Graph name containing the node."),
      nodeId: z.string().describe('Node id, e.g. "n5".'),
    },
  },
  async ({ path, graphName, nodeId }) => {
    try {
      const result = await bridge.send<RemoveNodeResult>("remove_node", { path, graphName, nodeId });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_variable",
  {
    title: "Add a member variable to a Blueprint",
    description:
      "Adds a new member variable to a Blueprint. type is a compact type descriptor: bool, byte, int, int64, float, " +
      "double, string, name, text, vector, rotator, transform; object:<ClassName> or class:<ClassName> for object " +
      "and class references; struct:<Name> and enum:<Name> for your own types.\n\n" +
      "Containers, which most real Blueprint state is: append \"[]\" for an array (\"name[]\", \"object:Actor[]\"), " +
      "append \"<set>\" for a set of unique values (\"name<set>\"), or write map<key,value> for a keyed table " +
      "(\"map<name,int>\" for a score per player, \"map<name,object:Actor>\"). Two parallel arrays is the shape " +
      "this replaces. A map key must be hashable - int, name, string, enum and object references are; vector, text " +
      "and hashless structs are refused with the reason.\n\n" +
      "Fails if a variable with that name already exists on this Blueprint.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      variableName: z.string().describe("New variable name."),
      type: z
        .string()
        .describe(
          'Compact type descriptor, e.g. "bool", "float", "string", "vector", "object:StaticMeshComponent". ' +
            'Append "[]" for an array - "name[]", "object:Actor[]" - which is what most real Blueprint state is.'
        ),
      category: z.string().optional().describe("Optional category for grouping in the editor's My Blueprint panel."),
      defaultValue: z.string().optional().describe("Optional literal default value, string-serialized."),
    },
  },
  async ({ path, variableName, type, category, defaultValue }) => {
    try {
      // Translate the C++ spelling before sending. A model that has just read a header via
      // unreal_find_source writes FVector, and the bridge takes "vector"; see engineTypes.ts.
      const result = await bridge.send<AddVariableResult>("add_variable", {
        path,
        variableName,
        type: normaliseEngineType(type),
        category,
        defaultValue,
      });

      // Say it here, where the decision was just made.
      //
      // unreal_review_blueprint checks this too, but review only speaks when it is called, and a
      // model that does not know it should call it never hears any of this. Putting state in the
      // wrong place is also the most expensive thing in a Blueprint to retrofit, so the moment to
      // mention it is the moment it happens - not whenever somebody later thinks to ask.
      //
      // Free: the parent class comes back with the write, so there is no extra round trip, and
      // nothing is added at all when there is nothing to say.
      const misplaced = reviewStatePlacement(result.parentClass ?? "", [{ name: variableName }]);
      if (misplaced.length > 0) {
        return jsonResult({ ...result, warning: misplaced[0].message, fix: misplaced[0].fix });
      }
      return jsonResult(result);
    } catch (err) {
      return errorResult(err, typeHint(type));
    }
  }
);

register(
  "unreal_set_variable_replication",
  {
    title: "Change an existing variable's replication",
    description:
      "Sets a Blueprint variable to none, replicated, or repnotify. This is the fix for the audit's most " +
      "expensive finding: a server writing state that never reaches clients reads as \"it works for the host\" and " +
      "cannot be reproduced by one person. Choosing repnotify also creates the OnRep_<Name> graph if it does not " +
      "already exist, reusing it if it does. Only variables the Blueprint declares itself can change; an inherited " +
      "one is reported with the class that actually owns it.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      variableName: z.string().describe("Variable to change. unreal_list_variables names the ones this Blueprint has."),
      mode: z
        .enum(["none", "replicated", "repnotify"])
        .describe(
          '"replicated" sends the value to clients. "repnotify" also calls OnRep_<Name> on them when it changes, ' +
            'which is what you want when clients must react rather than just read. "none" turns it off.'
        ),
    },
  },
  async ({ path, variableName, mode }) => {
    try {
      return jsonResult(await bridge.send("set_variable_replication", { path, variableName, mode }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_compile_blueprint",
  {
    title: "Compile a Blueprint and report errors/warnings",
    description:
      "Compiles the Blueprint and returns structured errors/warnings (severity + message text), plus an overall " +
      "success flag and status. This is the safety net for every unreal_add_node / unreal_connect_pins / " +
      "unreal_add_variable call: always run this after a batch of edits to confirm the graph is actually valid " +
      "before telling the user it's done, since a graph can look structurally fine (nodes added, pins connected) " +
      "and still fail to compile (type mismatches, missing pins, unresolved variables, etc).",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send<CompileBlueprintResult>("compile_blueprint", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_save_blueprint",
  {
    title: "Save a Blueprint's package to disk",
    description:
      "Saves the Blueprint's package to disk in place. Edits made via unreal_add_node/unreal_connect_pins/etc exist " +
      "only in the running editor's memory until this is called (or unreal_create_blueprint's default save=true ran).",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send<SaveBlueprintResult>("save_blueprint", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =============================== Milestone 3: project-wide index tools ===============================
// These exist to solve the actual pain point that motivated this whole project: finding
// things across a large project without either re-enumerating everything every time, or
// the model losing track of what's connected to what. They're backed by a persistent,
// incrementally-updated index on the C++ side (FMCPProjectIndex), not a live re-scan per
// call. See ../ARCHITECTURE.md and docs/M3_STATUS.md.

register(
  "unreal_get_project_overview",
  {
    title: "Get a cheap project-wide overview",
    description:
      "**To find actual problems rather than shape, use unreal_audit_project.** Returns a cheap top-level summary of the whole project's Blueprint structure: total counts (blueprints, " +
      "functions, variables, graphs, nodes), a breakdown by top-level content folder, and a breakdown by parent " +
      "class. Call this FIRST (before unreal_search_project or unreal_list_blueprints) to orient yourself in an " +
      "unfamiliar project. It costs one cheap index lookup instead of enumerating everything, and on a fresh editor " +
      "session may trigger the one-time index build (subsequent calls are fast).",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send<GetProjectOverviewResult>("get_project_overview");
      // The census as a map rather than a list of two-key objects. Same information, and the words
      // "parentClass" and "count" stop being sent 79 times. planFeature and everything else internal
      // read the bridge's own shape, which is untouched.
      const parents = asCountMap(result.byParentClass as never, "parentClass", "count") as Record<string, number>;

      /**
       * The long tail of parent classes is an inventory, not an orientation.
       *
       * Measured on this project: 79 parent classes, 43 of them with exactly one Blueprint, and
       * everything below the top eight costs 452 of the reply's 702 tokens - 64% of the call the
       * instructions tell every model to make FIRST, to get its bearings.
       *
       * "One Blueprint inherits from BP_BillboardVariant_C" orients nobody. What orients is that
       * this project is 88 widgets and 71 actors. And the question the tail could answer - which
       * Blueprints are under class X - is answered properly by unreal_list_blueprints, which reads
       * the editor rather than a cached index.
       *
       * The cut is by COUNT, not by rank, so it does not lie about shape: every class with three or
       * more Blueprints survives whatever the project looks like, and a project of forty evenly
       * sized hierarchies keeps all forty. planFeature already took only the top six from the
       * bridge's own copy, which is the same judgement made independently.
       */
      const KEEP_AT_LEAST = 3;
      const kept: Record<string, number> = {};
      let tailClasses = 0;
      let tailBlueprints = 0;
      for (const [name, count] of Object.entries(parents)) {
        if (count >= KEEP_AT_LEAST) kept[name] = count;
        else {
          tailClasses += 1;
          tailBlueprints += count;
        }
      }

      /**
       * The drift warning, sized to the drift.
       *
       * The bridge notices when its cached index and the editor disagree and says so in 68 tokens:
       * "built from a cached index holding N Blueprints, and the editor currently has M ... treat
       * them as approximate ... list_blueprints and list_assets read the editor directly and are
       * authoritative."
       *
       * Every word of that is true and it is the right warning when the cache is badly out of date.
       * On this project the disagreement is 341 against 339 - two Blueprints, 0.6% - and it has been
       * there all session. Nothing anyone reads off this reply changes because of two: not the folder
       * census, not the parent-class breakdown, not "is this project mostly widgets". So the full
       * paragraph is paid on the first call of every session to report a rounding error.
       *
       * Under 2% it becomes one clause carrying the same two numbers, so a reader who cares can still
       * see the exact disagreement. At or above 2% the bridge's own wording stands, because then the
       * totals really might mislead and the advice about which tools are authoritative is worth its
       * tokens.
       *
       * Sized here rather than in the C++ that writes it, for the usual reason: that would need a
       * plugin rebuild before anyone benefits, and this is the layer that already trims this reply.
       */
      const overview = result as GetProjectOverviewResult & {
        indexDrift?: string;
        blueprintCountInEditor?: number;
      };
      const drift = typeof overview.indexDrift === "string" ? overview.indexDrift : undefined;
      const cached = Number(result.blueprintCount ?? 0);
      const inEditor = Number(overview.blueprintCountInEditor ?? cached);
      const smallDrift =
        drift !== undefined && cached > 0 && Math.abs(cached - inEditor) / cached < 0.02;

      return jsonResult({
        ...result,
        ...(smallDrift
          ? {
              indexDrift:
                `Cached index has ${cached} Blueprints, the editor has ${inEditor}; totals below are ` +
                `the cache's. list_blueprints reads the editor.`,
            }
          : {}),
        byParentClass: kept,
        ...(tailClasses > 0
          ? {
              otherParentClasses:
                `${tailClasses} more parent class(es) account for ${tailBlueprints} Blueprint(s), ` +
                `fewer than ${KEEP_AT_LEAST} each. unreal_list_blueprints with \`match\` set to a class ` +
                `name lists the Blueprints under it, from the editor rather than this cached index.`,
            }
          : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_search_project",
  {
    title: "Search the project-wide Blueprint index",
    description:
      "Keyword/substring search (case-insensitive) across every indexed Blueprint's name, parent class, function " +
      "names, and variable names. A space matches nothing: search \"ShopUpgrade\", not \"shop upgrade\". Returns compact hits (kind, path, name, one-line context), capped at maxResults " +
      "and marked `truncated: true` if the cap was hit. Narrow your query rather than assuming you saw every match. " +
      "This is the main way to find something without enumerating the whole project, and is backed by a persistent " +
      "index kept fresh as the project changes, not a live rescan. If UNREAL_MCP_LOCAL_LLM_URL is configured server-" +
      "side, up to a handful of top hits are best-effort enriched with a one-line natural-language `summary` field " +
      "generated by a local model, at no cost to your own context. Check the response's `enrichment` field to see " +
      'whether that ran ("local-llm" or "none").',
    inputSchema: {
      /**
       * Ten tools call this `match`; four called it `query`.
       *
       * Found by using this server for a real feature and getting the name wrong here after having
       * just read three tools that spell it `match`. That is not carelessness, it is what a surface
       * teaches: the majority spelling is the one a caller types next.
       */
      query: z.string().optional().describe('Case-insensitive substring to search for, e.g. "health" or "BP_Enemy".'),
      match: z.string().optional().describe("Same as `query`."),
      maxResults: z.number().optional().describe("Cap on returned hits. Defaults to 50, clamped to [1, 500]."),
    },
  },
  async ({ query: queryRaw, match, maxResults }) => {
    const query = queryRaw ?? match;
    if (!query) {
      return errorResult(new Error("unreal_search_project needs something to search for: pass `query` (or `match`). Nothing ran."));
    }
    try {
      const result = await bridge.send<SearchProjectResult>("search_project", { query, maxResults });
      const enrichedHits = await enrichSearchHits(result.hits);

      // A zero here means "not in the Blueprints", which is narrower than the tool's name.
      //
      // This searches the Blueprint index: asset names, parent classes, function and custom event
      // names, variable names. It does not search Data Table rows, the names of non-Blueprint assets,
      // C++ symbols or actors placed in a level - and it is called search_project, so a bare
      // `hitCount: 0` reads as "the project does not contain this".
      //
      // Traced on a real report. "The machine gun upgrade does nothing" is true, and the cause is a
      // Data Table row - DT_Upgrades, Weapon_MachineGun, with an empty UpgradeClass. search_project
      // returns nothing for "machine gun", for "MachineGun", and for every other spelling, because
      // the answer is not in a Blueprint at all. unreal_find_in_data_tables finds it on the first
      // call. The route existed; nothing pointed down it.
      //
      // Only on a zero, so a search that worked pays nothing for advice it does not need.
      const nothingFound = (result.hitCount ?? enrichedHits.length) === 0;

      // A DECLARATION is almost never the question.
      //
      // The zero-hit note below exists because a search that found nothing dead-ended. A search that
      // FOUND something dead-ends in exactly the same way, and that case had no note at all.
      //
      // Traced on a real session. Diagnosing why a vacuum drag rubber-banded on clients needed to
      // know where `LocationDragged` is written. search_project answered:
      //
      //   {"kind":"variable","path":".../BP_BaseCharacter","context":"struct:Vector variable"}
      //
      // True, complete for what it searches, and not the thing anybody typed the name for - this
      // index holds declarations, so "where is it declared" is the one question it can answer and
      // "where is it used" is the one that was being asked. Recovering that took ten more calls and
      // ended in grepping .uasset binaries from a shell, which a model using this server does not
      // have. unreal_trace_variable answers it whole, in 89 tokens: declaredIn, writes, reads, each
      // with blueprint, graph and node id.
      //
      // Only when a hit is of a kind a tracer covers, and it names only the tracer for that kind, so
      // a search for an asset name pays nothing.
      const hitKinds = new Set(enrichedHits.map((h) => (h as { kind?: string }).kind));
      const traceHint = hitKinds.has("variable")
        ? "unreal_trace_variable"
        : hitKinds.has("function") || hitKinds.has("event")
          ? "unreal_trace_function_calls"
          : undefined;
      // Wrapped, because the note above names four tools and on `search` none of them are listed.
      // withDisabledToolNote says how to reach an unlisted tool - through unreal_call_tool, without
      // changing the tool list - so advice that would otherwise dead-end stays followable.
      return jsonResult(withDisabledToolNote({
        ...result,
        hits: enrichedHits,
        ...(!nothingFound && traceHint
          ? {
              next:
                `These are DECLARATIONS - this index records where things are declared, not where ` +
                `they are used. If the question is where a hit is read or written, ${traceHint} ` +
                `answers it directly, with the blueprint, graph and node id of every site.`,
            }
          : {}),
        ...(nothingFound
          ? {
              next:
                `Searched Blueprint names, parents, functions, custom events and variables - not Data Table ` +
                `rows, non-Blueprint asset names, C++ or placed actors. If the thing you are looking for lives ` +
                `in one of those: unreal_find_in_data_tables for row and cell contents, unreal_list_assets ` +
                `with \`match\` for assets by name, unreal_find_source for C++, unreal_list_actors for a level. ` +
                `Names in this project are usually run together, so try "MachineGun" as well as "machine gun".`,
            }
          : {}),
        enrichment: isEnrichmentEnabled() ? "local-llm" : "none",
      }, isToolEnabled));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_references",
  {
    title: "Find what references, and is referenced by, an asset",
    description:
      "Given an asset path (typically a Blueprint), returns what other assets reference it (referencedBy) and what " +
      "it depends on (dependsOn), via the AssetRegistry's dependency graph. Engine/script-internal references are " +
      'filtered out to keep this focused on project content. This is the direct answer to "what uses this Blueprint" ' +
      'or "what does this Blueprint depend on" without opening each candidate manually, which is usually the single ' +
      "most useful tool for understanding how a change might ripple across a large project.",
    inputSchema: {
      path: z
        .string()
        .describe('Asset path, e.g. "/Game/Blueprints/BP_Foo.BP_Foo" or just the package "/Game/Blueprints/BP_Foo".'),
      maxResults: z.number().optional().describe("Cap per list (referencedBy / dependsOn). Defaults to 200."),
      direction: z
        .enum(["referencedBy", "dependsOn", "both"])
        .optional()
        .describe(
          'Which half you actually want. "referencedBy" is what breaks if you change this; "dependsOn" is ' +
            'what this needs to exist. Defaults to "both", which is twice the reply for a question that is ' +
            "almost always one of the two."
        ),
    },
  },
  async ({ path, maxResults, direction }) => {
    try {
      const result = await bridge.send<FindReferencesResult>("find_references", { path, maxResults });
      // Both lists are rows of {package, assetName, assetClass} where two fields are derivable or
      // constant. Compacted here, in the tool, so anything internal that reads references keeps the
      // full shape.
      const referencedBy = (result.referencedBy ?? []).map((r) => compactAssetRef(r as never));
      const dependsOn = (result.dependsOn ?? []).map((r) => compactAssetRef(r as never));

      // The counts always survive, whichever half is dropped. "49 things reference this, here are
      // none of them" is a worse answer than either list, and a caller who asked for one direction
      // still needs to know the other exists before concluding an asset is unused.
      const want = direction ?? "both";
      // Destructured OUT of `result`, not merely left unassigned below.
      //
      // The first version spread `...result` and then conditionally re-added the compacted lists.
      // Skipping one did not remove it - the RAW, uncompacted list from the bridge was still there
      // from the spread, so asking for one direction returned MORE than asking for both: 3,751
      // tokens against 2,859. Measuring the change is what caught it; the code read as correct.
      const { referencedBy: _rawRefBy, dependsOn: _rawDependsOn, ...rest } = result;
      return jsonResult({
        ...rest,
        ...(want === "dependsOn" ? {} : { referencedBy }),
        ...(want === "referencedBy" ? {} : { dependsOn }),
        // Measured on BP_Player: both lists are 2,806 tokens and either one alone is roughly half.
        // The question is almost always one of them - "what breaks if I change this" or "what does
        // this need" - and nothing said the choice existed.
        ...(want === "both" && referencedBy.length + dependsOn.length >= ADVISE_WHEN_ROWS_AT_LEAST
          ? {
              cheaper:
                `Both directions returned (${referencedBy.length} referencedBy, ${dependsOn.length} dependsOn). ` +
                `\`direction: "referencedBy"\` is what breaks if you change this; \`"dependsOn"\` is what this ` +
                `needs - either is about half of this reply.`,
            }
          : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_node",
  {
    title: "Find the exact Blueprint node/function for an intent",
    description:
      "Searches the running editor's real catalog of Blueprint-callable functions, built from live C++ reflection " +
      "on the exact engine version that is open, so the names and signatures it returns are correct by construction " +
      "rather than recalled. Search by intent or partial name (e.g. \"spawn actor\", \"line trace\", \"print\") and get " +
      "back exact functionName and className values a node will accept. **Call this before " +
      "you place a node whenever you are not certain a function name and its owning class are exactly right**, which " +
      "is most of the time: guessing Unreal's API surface from memory is the single most common cause of a failed " +
      "edit. Returns compact entries without full pin lists; read a function's signature for exact " +
      "pins. Matched on WORDS, so type what the editor shows: \"Array Length\", \"array_length\" and " +
      "\"ArrayLength\" all find Array_Length.\n\n" +
      "Searches macros and node kinds too. A hit under `macros` or `nodeTypes` is placed by " +
      "placed with that nodeType (macros also need macroName), not called as a function.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe('What you are looking for, e.g. "spawn actor", "PrintString", "get player controller".'),
      /** Ten tools spell this `match`. See the note on unreal_search_project. */
      match: z.string().optional().describe("Same as `query`."),
      maxResults: z.number().optional().describe("Cap on hits returned. Defaults to 20, max 100."),
    },
  },
  async ({ query: queryRaw, match, maxResults }) => {
    const query = queryRaw ?? match;
    if (!query) {
      return errorResult(new Error("unreal_find_node needs something to look for: pass `query` (or `match`). Nothing ran."));
    }
    try {
      const result = await bridge.send<FindNodeResult>("find_node", { query, maxResults });

      /**
       * `hitCount` is how many came BACK, not how many matched, and nothing said so.
       *
       *   find_node "get" maxResults 2   ->  hits 2,  hitCount 2
       *   find_node "get" maxResults 50  ->  hits 50, hitCount 50
       *
       * Both replies claim to have counted, in a catalog of 15,234 functions. This is the tool the
       * standing instructions point every model at before it writes a node - "never guess a function
       * name" - so a caller told there are two matches for "get" may reasonably pick the better of
       * two and never learn there were hundreds.
       *
       * search_project, which does the same job over Blueprints, has always sent
       * `truncated: Hits.Num() >= MaxResults`. find_node was never given it. The cap is the same
       * arithmetic on this side of the wire, so it needs no plugin rebuild.
       *
       * Emitted only when true, like the other flags in this file - absence is the common case and
       * costs nothing to leave out.
       */
      const cap = Math.max(1, Math.min(maxResults ?? 20, 100));
      const hits = (result as { hits?: unknown[] }).hits ?? [];
      if (hits.length < cap) return jsonResult(result);
      return jsonResult({
        ...result,
        truncated: true,
        cappedNote:
          `hitCount is what came back, not what matched - this reply hit the ${cap}-result cap. ` +
          `Narrow the query or raise maxResults before concluding how many there are.`,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_get_node_signature",
  {
    title: "Get a Blueprint function's exact pins and parameter types",
    description:
      "Given an exact function name (and optionally its owning class, to disambiguate), returns that function's real " +
      "parameter list from engine reflection: each parameter's name, C++ type, direction (in/out/return), and default " +
      "value where one exists. Use this to get pin names exactly right before you wire a pin or set its " +
      "default, instead of guessing what a pin is called. If the name does not resolve, the error " +
      "includes a didYouMean list of near-misses. Find the function name first with unreal_find_node if you do not " +
      "already know it.",
    inputSchema: {
      // `name` is the single most common parameter on this surface - 34 tools take it - and this one
      // did not. A caller who has typed `name` thirty-four times types it here too, and pays a
      // failed round trip to be told the word is `functionName`. Primary spelling unchanged.
      functionName: z.string().optional().describe('Exact function name, e.g. "PrintString".'),
      name: z.string().optional(),
      className: z
        .string()
        .optional()
        .describe(
          'Optional owning class to disambiguate, short name or full path, e.g. "KismetSystemLibrary" or ' +
            '"/Script/Engine.KismetSystemLibrary". Omit to take the first exact name match.'
        ),
    },
  },
  async ({ functionName, name, className }) => {
    try {
      const wanted = functionName ?? name;
      if (!wanted) {
        return errorResult(
          new Error("unreal_get_node_signature needs a function name: pass `functionName` (or `name`).")
        );
      }
      const result = await bridge.send<NodeCatalogEntry>("get_node_signature", {
        functionName: wanted,
        className,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_build_graph",
  {
    title: "Build a piece of graph in one atomic call",
    description:
      "For a plain \"when X happens, do these in order\" chain, use unreal_add_event_handler instead: it wires the " +
      "exec pins for you. Use this for branches, loops, and data wiring. " +
      "The general way to author Blueprint logic: many nodes, connections, and pin defaults in ONE call, inside one " +
      "editor transaction. If any step fails, the entire batch rolls back and the graph is exactly as it was, so you " +
      "retry the whole call with the fix instead of reasoning about partial state. The response maps each of your " +
      "refs to its created node id, and the Blueprint is compiled at the end by default (compile: false to skip).\n\n" +
      "nodes: same fields as unreal_add_node plus a required short 'ref' you choose (no dots). " +
      'connections: {from, to} strings as "ref.pinName", e.g. {"from":"ev.then","to":"branch.execute"}. You can also ' +
      "use an existing node's id in place of a ref to extend a graph you read earlier. " +
      "pinDefaults: {node, pin, value}.\n\n" +
      "Prefer this over individual unreal_add_node/unreal_connect_pins calls whenever placing more than one node: a " +
      "10-node graph costs 1 round trip instead of ~25, and a human can undo the whole feature with one Ctrl+Z. " +
      "Errors name the failing ref or index and include available pin names or didYouMean suggestions.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe('Graph to build in, e.g. "EventGraph" or a function graph name.'),
      nodes: z
        .array(
          z.object({
            ref: z.string().describe("Your short handle for this node, unique in the batch, no dots."),
            nodeType: z.enum(["Event", "CustomEvent", "EnhancedInputAction", "InputKey", "InputAxis", "CallFunction", "VariableGet", "VariableSet", "Branch", "Sequence", "GetArrayItem", "Cast", "Macro", "CallParent", "Self"]),
            eventName: z.string().optional(),
            // The four that were missing.
            //
            // This tool's own description says "Same per-type params as unreal_add_node", and the
            // standing instructions tell every model to prefer it - "build whole graphs in one call,
            // do not place nodes one at a time". It could not declare a custom event's inputs or
            // make one a Server RPC, so the recommended way to author a graph could not express the
            // thing all multiplayer logic is built from, and the only way to find that out was to
            // try. Found by needing ownerClass and being told the variable did not exist.
            netMode: z.string().optional(),
            reliable: z.boolean().optional(),
            inputs: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
            ownerClass: z.string().optional(),
            inputAction: z.string().optional(),
            key: z.string().optional(),
            axisName: z.string().optional(),
            functionName: z.string().optional(),
            className: z.string().optional(),
            variableName: z.string().optional(),
            targetClass: z.string().optional(),
            pure: z.boolean().optional(),
            macroName: z.string().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            comment: z.string().optional(),
          })
        )
        .optional()
        .describe(
          "Nodes to create, in order. Which fields a node needs depends on its nodeType; unreal_guide topic " +
            "\"handbook\" lists them with the exact pin names."
        ),
      connections: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .optional()
        .describe('Wires, each "ref.pinName" -> "ref.pinName". Existing node ids also work as the ref part.'),
      pinDefaults: z
        .array(z.object({ node: z.string(), pin: z.string(), value: engineValue }))
        .optional()
        .describe("Literal defaults to set on unconnected input pins."),
      compile: z.boolean().optional().describe("Compile the Blueprint after building. Defaults to true."),
      autoLayout: z
        .boolean()
        .optional()
        .describe(
          "Tidy the whole graph's node positions after building, so it reads left to right with straight exec " +
            "chains and no overlaps. Defaults to TRUE, and you should almost always leave it on: you do not need to " +
            "supply x/y at all. Pass false only if you set every x/y deliberately and want them preserved exactly."
        ),
    },
  },
  async ({ path, graphName, nodes, connections, pinDefaults, compile, autoLayout }) => {
    try {
      const result = await bridge.send<BuildGraphResult>("build_graph", {
        path,
        graphName,
        nodes,
        connections,
        pinDefaults,
        compile,
      });

      // Trim the per-node echo unless asked for: the caller already knows what it sent, and the
      // ref-to-id map is the only part it cannot reconstruct.
      //
      // Declared here, above every return, because it was not: three of this tool's five reply paths
      // returned the UNtrimmed result, so `nodes.ref` was an object on a big graph and a bare id
      // string on a small one. Code reading `nodes.ref.id` worked until the day it did not, which is
      // how a script of mine crashed mid-session. The big graph also got the LARGER reply, which is
      // backwards: that is the case where context is already scarce.
      const buildPart = MODE.verboseBuildResult
        ? result
        : {
            nodes: Object.fromEntries(Object.entries(result.nodes ?? {}).map(([ref, n]) => [ref, n.id])),
            connectionsMade: result.connectionsMade,
            pinDefaultsSet: result.pinDefaultsSet,
            compile: result.compile,
          };

      // Layout is cosmetic and must never turn a successful build into a failed tool call, so a
      // layout error is reported alongside the build result rather than thrown over it.
      if (autoLayout === false) {
        return jsonResult(buildPart);
      }
      try {
        // Layout happens in every mode, because a graph nobody can read is not a cheaper graph - but
        // only when this call BUILT the graph, not when it added to somebody else's.
        //
        // Measured on a real project: adding four nodes to an existing EventGraph relaid out 209 of
        // them. Nothing broke, and it was still wrong. That graph is a thing its author navigates by
        // shape and muscle memory, and rearranging all of it to place four nodes is a far larger
        // change than the one that was asked for. "Adapts to the current work" has to mean leaving
        // the current work where it is.
        // Ask the bridge how big the graph is now. This is a local socket call, so it costs the
        // caller nothing in tokens - only what this tool returns is paid for.
        let totalNodes = 0;
        try {
          const summary = await bridge.send<{ nodes?: unknown[] }>("read_blueprint_graph_summary", {
            path,
            graphName,
          });
          totalNodes = (summary.nodes ?? []).length;
        } catch {
          // If the graph cannot be read, fall through to laying it out as before rather than
          // silently skipping something the caller expects.
        }
        const priorNodes = Math.max(0, totalNodes - Object.keys(result.nodes ?? {}).length);
        if (priorNodes > 6) {
          return jsonResult({
            ...buildPart,
            layout: {
              nodesMoved: 0,
              skipped: true,
              why:
                `This graph already had ${priorNodes} nodes before the build, so it was left where it is. ` +
                `Call unreal_auto_layout_graph explicitly if you do want the whole graph rearranged.`,
            },
            mode: MODE.mode,
          });
        }
        const layout = await autoLayoutGraph(bridge, path, graphName, {
          addCommentBoxes: MODE.commentBoxes,
        });

        if (MODE.attachReview === "none") {
          return jsonResult({ ...buildPart, layout: { nodesMoved: layout.nodesMoved }, mode: MODE.mode });
        }

        // Review the graph we just built and hand the findings back unasked. A model that never
        // calls unreal_review_blueprint is exactly the model that most needs to hear this.
        const review = await reviewBlueprint(bridge, path, graphName);
        const reviewPart =
          MODE.attachReview === "summary"
            ? { score: review.score, nextAction: review.nextAction }
            : (() => {
                // Sorted before it is capped, and the cap is reported.
                //
                // Two defects lived in the one line this replaces. The flatMap was sliced in graph
                // order, so a Blueprint with twenty info-level notes in its first graph pushed every
                // error out of the response - the cap silently kept the least important findings.
                // And review.blueprint was dropped entirely: the state-placement and replication
                // findings are deliberately held separate from any graph (review.ts:132-151, because
                // filing them under one graph would be a lie), which meant they reached no build
                // response in any mode at all. They are the findings most likely to describe a real
                // design problem rather than a tidiness one.
                const rank = { error: 0, warning: 1, info: 2 } as const;
                const severityOf = (f: { severity: string }) => rank[f.severity as keyof typeof rank] ?? 3;
                const all = [
                  ...review.graphs.flatMap((graph) => graph.findings),
                  ...review.blueprint,
                ].sort((a, b) => severityOf(a) - severityOf(b));
                const kept = all.slice(0, MODE.maxFindings);
                return {
                  score: review.score,
                  summary: review.summary,
                  nextAction: review.nextAction,
                  findings: kept,
                  // A truncated list that does not say it was truncated reads as "that is all of
                  // them", which is the one thing it must not do.
                  ...(all.length > kept.length
                    ? {
                        findingsOmitted: all.length - kept.length,
                        findingsNote: `${all.length - kept.length} lower-severity finding(s) not shown; call unreal_review_blueprint for all of them.`,
                      }
                    : {}),
                };
              })();

        return jsonResult({
          ...buildPart,
          layout: { nodesMoved: layout.nodesMoved, columns: layout.columns },
          review: reviewPart,
          mode: MODE.mode,
        });
      } catch (layoutErr) {
        // Same shape here too. A layout failure is the least useful moment to also change the shape
        // of the reply out from under the caller.
        return jsonResult({
          ...buildPart,
          layoutError: layoutErr instanceof Error ? layoutErr.message : String(layoutErr),
        });
      }
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_delete_asset",
  {
    title: "Delete one or more assets, with reference safety",
    description:
      "Deletes assets by path. Pass a single path, or paths[] to delete a whole cluster at once (members that " +
      "reference each other delete cleanly together). By default, if any asset OUTSIDE the delete set still " +
      "references what you're deleting, the call is BLOCKED and returns the blocking referencers, so you never " +
      "silently orphan live content. Pass force:true to delete anyway (breaks those outside references to None). " +
      "Use this to remove dead template debris after confirming it is unreferenced by live content.",
    inputSchema: {
      path: z.string().optional().describe("Single asset object path to delete."),
      paths: z.array(z.string()).optional().describe("Multiple asset object paths to delete together."),
      force: z.boolean().optional().describe("Delete even if outside-set references exist. Defaults to false (blocks and reports)."),
    },
  },
  async ({ path, paths, force }) => {
    try {
      const result = await bridge.send<{ requested?: number; deleted?: number; forced?: boolean }>(
        "delete_asset",
        { path, paths, force }
      );

      // A delete that deleted nothing is not a successful delete.
      //
      // The bridge is honest - it returns {requested: 1, deleted: 0, forced: true} - but it wraps
      // that in an OK response, so every caller that checks for an error sees success. Found when a
      // trial's cleanup reported "cleaned up 2 assets" seven runs in a row while the assets piled
      // up in /Game/MCPTrial, and again when a later script crashed reading one of them.
      //
      // ObjectTools::DeleteAssets returns a count and no reason, and the reason cannot be recovered
      // from here. So this says exactly what is known - the count did not match - and points at the
      // two reads that can narrow it down, rather than inventing a cause.
      //
      // The first version of this message did invent one. It advised saving the asset and deleting
      // again; that was tested on the real leftovers and made no difference, on an asset that
      // find_references reports nothing referencing and asset_status reports on disk, writable and
      // not read-only. Shipping advice I had just watched fail would have been worse than the
      // silence it replaced, because a caller would have followed it.
      //
      // The cause is established now, by bisection against the editor rather than by reading engine
      // source. Each of these was run and the result recorded:
      //
      //   parent alone, saved                                    deletes
      //   parent + graph + compile, no child                     deletes
      //   parent + saved child, NO graphs                        deletes
      //   parent + saved child, graphs on both  -> child deletes, PARENT REFUSES
      //   the same pair in one paths[] call     -> both delete
      //
      // So it is the combination: a saved parent, a saved child deriving from it, and built graphs.
      // Delete the child on its own and the parent is left holding a reference that nothing in the
      // session releases - eleven such Blueprints accumulated here, and a batch delete of all eleven
      // still removes none, because the thing holding them is already gone.
      //
      // The bridge already knew: paths[] exists because "its members reference each other, and
      // force-delete breaks those intra-set links". The tool just never said so on the failure.
      const requested = result.requested ?? 0;
      const deleted = result.deleted ?? 0;
      if (requested > 0 && deleted < requested) {
        return jsonResult({
          ...result,
          warning:
            `${requested} asset(s) were requested and ${deleted} were deleted. The rest are still there: ` +
            `list_assets and list_blueprints will still show them and they still open, so do not treat ` +
            `this call as done. The engine refuses a delete without reporting why. ` +
            `The commonest cause is now known: a saved Blueprint that a saved CHILD derives from, ` +
            `where both have graphs, cannot be deleted on its own once the child has been deleted ` +
            `separately - the parent is left holding a reference nothing can now release. Delete the ` +
            `whole family in ONE call instead: unreal_delete_asset({ paths: [child, parent], force: true }) ` +
            `succeeds where two single calls leave the parent behind, which is what the paths[] form ` +
            `is for. If the child is already gone, an editor restart is the only thing known to ` +
            `release it. Otherwise unreal_find_references says whether anything still points at it and ` +
            `unreal_asset_status says whether it is on disk or read-only.`,
        });
      }
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_refresh_blueprint",
  {
    title: "Refresh a Blueprint's nodes after a C++ change",
    description:
      "The 'right-click > Refresh Nodes' repair. Every node re-reads its backing function/struct/pin signature, " +
      "dropping pins that no longer exist and picking up renamed ones. This is the fix for the whole family of errors " +
      "a C++ signature change leaves behind ('in use pin X no longer exists, please refresh node', 'break <unknown " +
      "struct>', missing-function-from-known-class). It does NOT fix genuinely-deleted classes (NULL parent class, " +
      "invalid cast target) which need a CoreRedirect or deletion instead. Recompiles by default and reports the " +
      "before/after error count so you can see what cleared.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      compile: z.boolean().optional().describe("Recompile after refreshing. Defaults to true."),
    },
  },
  async ({ path, compile }) => {
    try {
      const result = await bridge.send("refresh_blueprint", { path, compile });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_function",
  {
    title: "Create a function in a Blueprint",
    description:
      "Creates a new function graph on a Blueprint with typed inputs and outputs, and returns the graph name plus " +
      "the entry (and result, if outputs exist) node ids so you can immediately add nodes inside it with " +
      "unreal_build_graph targeting the new graphName. Wire logic from the entry node's output pins to the result " +
      "node's input pins. Call the function from other graphs with a CallFunction node, functionName " +
      "set to this name and no className. Type strings are the same compact descriptors unreal_add_variable uses " +
      '("bool", "int", "float", "string", "vector", "object:<Class>", "struct:<Struct>", "enum:<Enum>", ...).',
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      functionName: z
        .string()
        .optional()
        .describe('Name for the new function, e.g. "HandleDamage". Fails if a graph with this name exists.'),
      /**
       * Fifteen tools call the thing they act on `name`, and this one names exactly one thing.
       *
       * add_node, call_parent_function and rename_function deliberately do NOT take it: each
       * declares two or more `*Name` parameters, and a generic word standing among six of them adds
       * a guess rather than removing one. check:params derives that distinction rather than keeping
       * a list of exceptions.
       */
      name: z.string().optional().describe("Same as `functionName`."),
      inputs: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe('Function input parameters, e.g. [{"name":"Amount","type":"float"}].'),
      outputs: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe('Function return values, e.g. [{"name":"bDied","type":"bool"}].'),
    },
  },
  async ({ path, functionName: functionNameRaw, name, inputs, outputs }) => {
    const functionName = functionNameRaw ?? name;
    if (!functionName) {
      return errorResult(
        new Error("unreal_create_function needs a function name: pass `functionName` (or `name`). Nothing ran.")
      );
    }
    try {
      // Same translation as add_variable. A function signature is where a model is MOST likely to
      // write the C++ spelling, because it usually has the native declaration in front of it.
      const result = await bridge.send<CreateFunctionResult>("create_function", {
        path,
        functionName,
        inputs: normaliseFieldTypes(inputs),
        outputs: normaliseFieldTypes(outputs),
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_organize_graph",
  {
    title: "Organize a Blueprint graph: comments and layout",
    description:
      "Graph-organization actions, so generated graphs read like a careful human built them:\n" +
      '  - "set_node_comment": nodeId + comment. Sets/clears the comment bubble on one node.\n' +
      '  - "add_comment_box": text + x/y/width/height. Adds a comment box; place it so it visually groups related ' +
      "nodes (boxes render behind nodes covering their area).\n" +
      '  - "move_node": nodeId + x/y. Repositions a node.\n' +
      "Use comment boxes to group each logical section of a graph and node comments to explain non-obvious choices. " +
      "Positions are cosmetic to the compiler but matter to the human who opens the graph next.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe("Graph to organize."),
      action: z.enum(["set_node_comment", "add_comment_box", "move_node"]),
      nodeId: z.string().optional().describe("Required for set_node_comment and move_node."),
      comment: z.string().optional().describe("set_node_comment: the comment text (empty string clears it)."),
      text: z.string().optional().describe("add_comment_box: the box's title text."),
      x: z.number().optional().describe("Position X (add_comment_box, move_node)."),
      y: z.number().optional().describe("Position Y (add_comment_box, move_node)."),
      width: z.number().optional().describe("add_comment_box: box width. Defaults to 400."),
      height: z.number().optional().describe("add_comment_box: box height. Defaults to 300."),
    },
  },
  async ({ path, graphName, action, nodeId, comment, text, x, y, width, height }) => {
    try {
      const result = await bridge.send<OrganizeGraphResult>("organize_graph", {
        path,
        graphName,
        action,
        nodeId,
        comment,
        text,
        x,
        y,
        width,
        height,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_assets",
  {
    title: "List project assets of a class",
    description:
      "AssetRegistry query for real asset paths by class, so you never guess or invent a content path. " +
      "Pass the class name without its U/A prefix (StaticMesh, SkeletalMesh, Material, AnimBlueprint, " +
      "AnimSequence, Texture2D, SoundWave, NiagaraSystem, World, ...). " +
      "**Call this before any tool that takes an asset path** (unreal_spawn_actor's staticMesh, " +
      "unreal_set_component_property with an asset value, unreal_set_class_default): a path that does not " +
      "resolve is the single most common way an agent-authored Blueprint silently ends up broken.",
    inputSchema: {
      className: z.string().describe('Asset class name, e.g. "StaticMesh", "SkeletalMesh", "AnimBlueprint", "Material".'),
      pathPrefix: z.string().optional().describe('Restrict to a content path, e.g. "/Game/Meshes". Defaults to the whole project, including engine content.'),
      maxResults: z.number().optional().describe("Cap the number of results returned. Keep this small; the response is token-billed."),
    },
  },
  async ({ className, pathPrefix, maxResults }) => {
    try {
      const result = await bridge.send<{ count?: number; truncated?: boolean; assets?: unknown[] }>(
        "list_assets",
        { className, pathPrefix, maxResults }
      );

      // A truncated list that does not say how to see the rest.
      //
      // list_blueprints and list_actors both answer a cap with `truncated: true`, the real total,
      // and a `next` sentence naming the parameters that narrow the search. list_assets answered
      // `{count: 3, truncated: true}` - no total, so the caller cannot tell whether four assets were
      // hidden or four thousand, and no route forward. Three tools describing the same situation,
      // one of them differently, which is this project's most-repeated defect.
      //
      // The bridge does not return a grand total for this query, so this does not invent one. It
      // says what is known and what to do, which is the part that was missing.
      if (result.truncated) {
        return jsonResult({
          ...result,
          next:
            `More assets match than were returned${maxResults ? ` (maxResults was ${maxResults})` : ""}. ` +
            `Narrow with \`className\` or \`pathPrefix\`, or raise \`maxResults\`. ` +
            `unreal_search_project finds an asset by what it contains rather than by where it is.`,
        });
      }
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_level",
  {
    title: "Create a new Level (World) asset",
    description:
      "Creates and saves a new empty Level asset, optionally assigning its GameMode override. A brand new level is " +
      "unplayable until it has at least a PlayerStart and a floor, so the normal sequence is: unreal_create_level, " +
      "unreal_open_level, unreal_spawn_actor for a PlayerStart plus a StaticMeshActor floor plus a light, " +
      "unreal_save_level, then unreal_set_game_settings to make it the startup and default map.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Maps/L_Arena".'),
      gameModeClass: z.string().optional().describe("Optional GameMode class or Blueprint path to set as this level's GameMode override."),
    },
  },
  async ({ packagePath, gameModeClass }) => {
    try {
      const result = await bridge.send("create_level", { packagePath, gameModeClass });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_open_level",
  {
    title: "Open a Level in the editor",
    description:
      "Loads a Level asset into the editor world. Every actor tool (unreal_spawn_actor, unreal_save_level) operates " +
      "on the currently open level, so call this first to choose which level you are editing. Opening a level " +
      "discards unsaved changes in the current one, so call unreal_save_level before switching.",
    inputSchema: {
      path: z.string().describe('Level asset path, e.g. "/Game/Maps/L_Arena".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("open_level", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_spawn_actor",
  {
    title: "Spawn an actor into the open level",
    description:
      "Places an actor in the currently open level with a transform and an optional label. Accepts any actor class " +
      "by name (PlayerStart, DirectionalLight, SkyLight, PointLight, StaticMeshActor, ...) or a Blueprint asset " +
      "path for your own actors. For blocking out geometry, pass actorClass StaticMeshActor plus staticMesh to " +
      "spawn and assign a mesh in one call. Changes live in memory until unreal_save_level. Requires an open " +
      "level: call unreal_open_level first if this returns no_editor_world.",
    inputSchema: {
      actorClass: z.string().describe('Actor class name ("PlayerStart", "DirectionalLight", "StaticMeshActor") or a Blueprint asset path.'),
      label: z.string().optional().describe("Human-readable label shown in the World Outliner. Name things meaningfully; a human reads this list."),
      locX: z.number().optional().describe("World location X. Defaults to 0."),
      locY: z.number().optional().describe("World location Y. Defaults to 0."),
      locZ: z.number().optional().describe("World location Z. Defaults to 0."),
      pitch: z.number().optional().describe("Rotation pitch in degrees. Defaults to 0."),
      yaw: z.number().optional().describe("Rotation yaw in degrees. Defaults to 0."),
      roll: z.number().optional().describe("Rotation roll in degrees. Defaults to 0."),
      scaleX: z.number().optional().describe("Scale X. Defaults to 1."),
      scaleY: z.number().optional().describe("Scale Y. Defaults to 1."),
      scaleZ: z.number().optional().describe("Scale Z. Defaults to 1."),
      staticMesh: z.string().optional().describe('StaticMeshActor only: mesh asset path to assign, e.g. "/Engine/BasicShapes/Cube.Cube". Verify it with unreal_list_assets first.'),
    },
  },
  async (args) => {
    try {
      const result = await bridge.send("spawn_actor", args);
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_save_level",
  {
    title: "Save the open Level to disk",
    description:
      "Saves the currently open Level. Actors placed with unreal_spawn_actor exist only in the running editor's " +
      "memory until this is called, exactly like unreal_save_blueprint for Blueprint edits.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send("save_level", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_component",
  {
    title: "Add a component to a Blueprint",
    description:
      "Adds a component to a Blueprint's component hierarchy (the Components panel), which is how an actor gets a " +
      "mesh, collision, camera, movement, audio, or particle behavior. Pass parent to attach beneath an existing " +
      "component instead of at the root; call unreal_list_components first to see the current hierarchy and the " +
      "exact parent name. Configure the new component with unreal_set_component_property, then " +
      "unreal_compile_blueprint and unreal_save_blueprint.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      componentClass: z.string().describe('Component class, e.g. "StaticMeshComponent", "SphereComponent", "CameraComponent", "SpringArmComponent", "AudioComponent".'),
      name: z.string().describe('Name for the component as it appears in the Components panel, e.g. "PickupCollision".'),
      parent: z.string().optional().describe("Existing component name to attach under. Defaults to the Blueprint's root component."),
    },
  },
  async ({ path, componentClass, name, parent }) => {
    try {
      const result = await bridge.send("add_component", { path, componentClass, name, parent });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_variables",
  {
    title: "Read a Blueprint's variables",
    description:
      "Lists the variables a Blueprint declares, with type, default, category and whether a designer can set each " +
      "one per instance. **Use this to see what state a Blueprint holds** - it is usually the first question worth " +
      "asking about an unfamiliar one. " +
      "This is a direct read, so unlike unreal_search_project it cannot lag behind a write you just made." +
      "\n\n" +
      "`type` is the same compact descriptor unreal_add_variable accepts - \"int\", \"object:SkeletalMesh[]\", " +
      "\"struct:TimerHandle\" - so a type read here can be pasted straight into a call that creates one.\n\n" +
      "Absent means the ordinary value, never unknown: `instanceEditable`, `blueprintReadOnly` and `replicated` " +
      "appear only when true, `category` only when it is not the default one, and **`defaultValue` appears only " +
      "when it is not the type's zero** - no `defaultValue` means 0, False, \"\", None or () as the type dictates. On a real " +
      "86-variable Blueprint that is 53 of the defaults and 44% of what the flags used to cost.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      match: z
        .string()
        .optional()
        .describe('Only variables whose name, type or category contains this, e.g. "Health".'),
      replicatedOnly: z
        .boolean()
        .optional()
        .describe("Only replicated variables. The fastest way to reason about what a client can actually see."),
    },
  },
  async ({ path, match, replicatedOnly }) => {
    try {
      const result = await bridge.send<{ variables?: Array<Record<string, unknown>> }>("list_variables", { path });
      const all = result.variables ?? [];
      const needle = (match ?? "").trim().toLowerCase();

      // Filtering rather than truncating. A cap would hide state at random, and what a caller wants
      // is not "fewer variables" but "the ones about health" or "the ones a client can see" - cheap
      // to ask for, expensive to guess at from a truncated list.
      //
      // This once said there was "no fat to cut" here. That was wrong, and measuring said so: of
      // 4,084 tokens, 65% was structure, and four boolean flags were most of it - blueprintReadOnly
      // was emitted 84 times and was false every time. compactVariable drops them when false, which
      // is 44% of the reply for no lost fact. Filtering happens FIRST, because replicatedOnly reads
      // the very flag that compaction removes.
      let filtered = all;
      if (needle) {
        // The descriptor is in the haystack as well as the raw fields, so a string this tool PRINTED
        // is a string it accepts. Without it the reply says "object:SkeletalMesh[]" and a caller who
        // pastes that back as `match` gets nothing, because the raw row spells it "Object" plus a
        // separate subType. A filter that cannot find what the tool just showed you is the same
        // quiet mismatch as a read and a write disagreeing about type names.
        filtered = filtered.filter((v) =>
          matchesAllTerms(
            `${v.name ?? ""} ${v.type ?? ""} ${v.subType ?? ""} ${asTypeDescriptor(v).type ?? ""} ${v.category ?? ""}`,
            matchTerms(match)
          )
        );
      }
      if (replicatedOnly === true) {
        filtered = filtered.filter((v) => v.replicated === true);
      }

      // Same rule as read_class_defaults: a zero default is dropped in bulk and kept for a targeted
      // question. `match: "Health"` is asked by somebody about to change Health, and answering
      // "it is a float" without saying what it currently is answers a question nobody asked.
      const targeted = needle.length > 0 || replicatedOnly === true;
      const compacted = filtered.map((v) => {
        const row = compactVariable(v);
        if (!targeted) return row;
        // Put the raw default back when compaction removed it. Everything else compactVariable does
        // - the type descriptor, the false flags - stays, because none of that is the answer.
        return "defaultValue" in row || v.defaultValue === undefined
          ? row
          : { ...row, defaultValue: v.defaultValue };
      });

      if (filtered.length === all.length) {
        // Nothing was filtered, so this is the whole list - the most expensive form of this call, and
        // the reply said nothing about the two cheaper ones. Measured on BP_Player's 86 variables:
        // 1,732 tokens whole, 508 with replicatedOnly, 126 with a match. A model asking "what can a
        // client see" was paying four times over for an answer it then had to find by reading.
        //
        // Only on a list long enough for the advice to be worth anything, so a small Blueprint pays
        // nothing. Same shape as the hints on list_blueprints and read_class_defaults.
        return jsonResult({
          ...result,
          variables: compacted,
          ...(compacted.length >= ADVISE_WHEN_ROWS_AT_LEAST
            ? {
                cheaper:
                  `${compacted.length} variables. \`match\` narrows by name, type or category ` +
                  `("Health", "object:", "Combat"), and \`replicatedOnly\` answers "what can a client ` +
                  `see" directly - either is a fraction of this.`,
              }
            : {}),
        });
      }
      return jsonResult({
        ...result,
        variables: compacted,
        totalVariables: all.length,
        matched: filtered.length,
        ...(filtered.length === 0
          ? { note: `None of the ${all.length} variables match. Call again without a filter to see them all.` }
          : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_components",
  {
    title: "List a Blueprint's components",
    description:
      "Reads a Blueprint's component hierarchy: each component's name, class, and parent, including components " +
      "inherited from a C++ or Blueprint parent class. Call this before unreal_add_component to pick a valid " +
      "parent, or before unreal_set_component_property to get the exact component name, rather than guessing " +
      'names like "Mesh" or "Root".',
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_components", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_component_property",
  {
    title: "Set a property on a Blueprint component",
    description:
      "Sets one property on a component's template (its defaults): a StaticMeshComponent's StaticMesh, a " +
      "SphereComponent's SphereRadius, a CameraComponent's FieldOfView, a collision setting, and so on. Values are " +
      "written as strings and coerced to the property's real type; struct values use UE's literal syntax such as " +
      '"(X=0,Y=0,Z=100)". If the value names an asset that does not resolve, the call FAILS rather than silently ' +
      "setting None, so a bad path is reported instead of shipping a broken Blueprint. Get exact component names " +
      "from unreal_list_components and verify asset paths with unreal_list_assets.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      component: z.string().describe("Component name, exactly as returned by unreal_list_components."),
      property: z.string().describe('Property name, e.g. "StaticMesh", "SphereRadius", "FieldOfView", "bGenerateOverlapEvents".'),
      value: engineValue.describe('The value. A number or boolean is accepted and stringified; anything structured is spelled the Unreal way: an asset path, or "(X=0,Y=0,Z=100)".'),
    },
  },
  async ({ path, component, property, value }) => {
    try {
      const result = await bridge.send("set_component_property", { path, component, property, value });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_trace_function_calls",
  {
    title: "Find every call to a function, and whether it can run",
    description:
      "**Use this to find the system that is actually live.** Names are the weakest thing to search on: a system " +
      "can be called anything, and two systems doing the same job have similar names with only one of them " +
      "connected. What cannot be renamed is the ENGINE function it must eventually call - whatever changes a " +
      "character's appearance ends up at SetSkeletalMeshAsset.\n\n" +
      "So ask this, not \"where is the skin system\": **what calls SetSkeletalMeshAsset, and which of those can be " +
      "reached?** Every hit comes back as `reachable` or `unreachable`, decided by walking exec wires back to an " +
      "event or function entry.\n\n" +
      "That split is the point. **A call nothing can reach is the signature of a replaced system** - somebody " +
      "unplugged the front of the old one and left the rest on the canvas, where it reads exactly like working " +
      "code. It is not a bug to fix; it means look elsewhere for what took over.",
    inputSchema: {
      function: z
        .string()
        .optional()
        .describe('Function name, or part of one, e.g. "SetSkeletalMeshAsset". Substring match.'),
      // The spelling six other tools use, accepted here so the seventh does not cost a failed call.
      // Six tools take `functionName` and this one took `function`; a model primed by the six types
      // `functionName` here, gets a validation error, and pays a round trip to learn a synonym. The
      // error message was good and the call was still wasted - and this server's own instructions
      // tell models not to guess, which only works if the names do not need guessing at.
      functionName: z.string().optional().describe("Same as `function`."),
      // And `name`, which 18 tools use for the thing they act on. The note above stopped at the six
      // that say `functionName`; the surface-wide count says `name` is the commonest spelling here
      // by a wide margin, so it is the one a model reaches for first.
      name: z.string().optional(),
      pathPrefix: z.string().optional().describe('Scope the scan, e.g. "/Game/MyGame". Defaults to "/Game".'),
    },
  },
  async ({ function: fnRaw, functionName, name, pathPrefix }) => {
    const fn = fnRaw ?? functionName ?? name;
    if (!fn) {
      return errorResult(new Error("unreal_trace_function_calls needs a function name: pass `function` (or `functionName`, or `name`)."));
    }
    try {
      return jsonResult(await bridge.send("trace_function_calls", { function: fn, pathPrefix }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_trace_variable",
  {
    title: "Find everywhere a variable is read or written",
    description:
      "**Start here when a value is not what it should be.** Every Get and Set of a variable across the whole " +
      "project, with the Blueprint and graph each sits in, and where it is declared. Project-wide because a " +
      "variable is routinely reached from another Blueprint through a cast, so scanning the asset that declares " +
      "it - or the one showing the symptom - misses the answer silently.\n\n" +
      "It names three shapes that are bugs in themselves: **read but never written** (every reader sees the " +
      "default forever - the half-built feature, which compiles and takes the fallback branch every time), " +
      "**written but never read**, and **declared but never used**. A few seconds, against opening every " +
      "Blueprint one at a time.",
    inputSchema: {
      variable: z.string().optional().describe('Exact variable name, e.g. "ServerSkinMemory". Case-insensitive.'),
      /** The spelling six other tools use. See the note on unreal_trace_function_calls. */
      variableName: z.string().optional().describe("Same as `variable`."),
      pathPrefix: z.string().optional().describe('Scope the scan, e.g. "/Game/AntiVirusSquad". Defaults to "/Game".'),
    },
  },
  async ({ variable: variableRaw, variableName, pathPrefix }) => {
    const variable = variableRaw ?? variableName;
    if (!variable) {
      return errorResult(new Error("unreal_trace_variable needs a variable name: pass `variable` (or `variableName`)."));
    }
    try {
      return jsonResult(await bridge.send("trace_variable", { variable, pathPrefix }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_niagara_system",
  {
    title: "Read a Niagara system's emitters and user parameters",
    description:
      "**The tool for \"the effect does not play\", or plays and never changes.** Returns the system's emitters " +
      "and the user parameters a Blueprint is allowed to set on it.\n\n" +
      "The parameters are the point. Set Niagara Variable takes the parameter name as a **string**, so a name the " +
      "system does not expose is not an error - it is a silent no-op. The node sits there wired and compiling, " +
      "addressing nothing, and nothing about the Blueprint shows it.\n\n" +
      "Names come back as a Blueprint must spell them, with Niagara's internal `User.` prefix removed - reporting " +
      "the internal form would hand you a string that silently does nothing.\n\n" +
      "A **disabled emitter** is called out, because that is a part of the effect that never runs in a system that " +
      "otherwise looks entirely correct. A system with no emitters at all, or with every emitter disabled, is " +
      "named outright: both spawn silently and look like valid assets.",
    inputSchema: {
      path: z.string().describe('Niagara system path, e.g. "/Game/VFX/NS_Explosion.NS_Explosion".'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("read_niagara_system", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_behavior_tree",
  {
    title: "Read a Behavior Tree and its blackboard",
    description:
      "**The tool for \"the enemies are not doing anything\".** A Behavior Tree is not a Blueprint, so " +
      "unreal_list_blueprints never returns one and the whole AI subsystem sits outside every other tool here. " +
      "This reads the tree and the blackboard it runs on.\n\n" +
      "The reply is indented, and the indentation IS the behaviour: a Selector runs its children until one " +
      "succeeds, so the second branch only ever runs when the first fails. Decorators are listed against the " +
      "child they guard, because a decorator is usually why a branch does or does not run - \"they stop chasing " +
      "at the firewall\" is a decorator on the chase branch far more often than it is anything in the task.\n\n" +
      "Blackboard keys come back with it. A task reads `TargetActor`; whether anything ever WRITES it is the other " +
      "half of the question, and the key list is where to start looking.",
    inputSchema: {
      path: z.string().describe('Behavior Tree path, e.g. "/Game/AI/BT_Enemy.BT_Enemy".'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("read_behavior_tree", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_deduplicate_anim_transitions",
  {
    title: "Remove state-machine transitions that duplicate another exactly",
    description:
      "The fix for the anim-duplicate-transition finding. Two transitions out of one state, to the same state, " +
      "on the same rule: only the first can ever fire, and the second is almost always a copy whose condition was " +
      "meant to be edited and never was.\n\n" +
      "**It cannot leave a state stranded.** Only a transition that has an identical twin is removed, so every " +
      "(from, to, rule) that existed before still exists after - the machine does strictly less in the one way " +
      "that changes nothing it could actually do. That is why this exists instead of a general delete-a-transition, " +
      "which is the more capable tool and the one that turns a tidy-up into a state with no way out.\n\n" +
      "Rules are compared with the same description unreal_read_anim_blueprint reports, so what you see there is " +
      "what is compared here. Two transitions to one state on DIFFERENT rules are ordinary and are left alone. " +
      "Pass dryRun to see what would go without changing anything.",
    inputSchema: {
      path: z.string().describe('The Anim Blueprint, e.g. "/Game/Characters/ABP_Player".'),
      stateMachine: z
        .string()
        .optional()
        .describe("Only this state machine, by name. Defaults to every state machine in the Blueprint."),
      dryRun: z.boolean().optional().describe("Report what would be removed and change nothing."),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true."),
    },
  },
  async ({ path, stateMachine, dryRun, save }) => {
    try {
      const result = await bridge.send<Record<string, unknown>>("deduplicate_anim_transitions", {
        path,
        stateMachine,
        dryRun,
      });
      if (dryRun) return jsonResult(result);
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_anim_blueprint",
  {
    title: "Read an Animation Blueprint's state machines",
    description:
      "**The tool for \"the character is not animating\".** Returns each state machine, its states, and what moves " +
      "between them - the transition and the CONDITION that fires it, which is the part that decides whether an " +
      "animation ever plays.\n\n" +
      "Blueprints and Anim Blueprints answer different halves of that question. A Blueprint sets a Speed variable; " +
      "the state machine decides that Speed > 10 means Run. Reading only the first half is how a model concludes " +
      "the logic is fine while the character stands still.\n\n" +
      "It names two things that are invisible until you look: a state **nothing leaves**, and a transition whose " +
      "rule graph is **empty**, which looks wired and behaves like a wall. An Anim Blueprint with no state " +
      "machines is normal rather than a fault, and the reply says so.",
    inputSchema: {
      path: z.string().describe('Anim Blueprint path, e.g. "/Game/Characters/ABP_Player.ABP_Player".'),
      match: z.string().optional().describe("Only states or machines whose name contains this."),
    },
  },
  async ({ path, match }) => {
    try {
      return jsonResult(await bridge.send("read_anim_blueprint", { path, match }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_class_defaults",
  {
    title: "Read a Blueprint's class defaults",
    description:
      "What a Blueprint's Class Defaults panel holds, with each property's type and value. Pair it with " +
      "unreal_set_class_default, which can change one but needs the name and current value first.\n\n" +
      "**Only the properties this Blueprint actually changed are listed** - that is what the question almost always " +
      "means, and a real class inherits most of its 167 editable properties untouched. What was left out is counted; " +
      "`match` overrides it, so asking about a property by name answers whether or not it was overridden.\n\n" +
      "**`value` appears only when it is not the type's zero** - no `value` means 0, False, \"\", None or () as the " +
      "type dictates. On a real Blueprint that is most of the reply, and without this sentence each of those reads " +
      "as \"changed to something unknown\" rather than \"changed to zero\" - different facts, only one of them true.\n\n" +
      "**For an Actor it also hoists `replicates` and `replicatesMovement` to the top level**, because those two " +
      "decide whether a multiplayer finding is a real bug. A server writing an unreplicated variable is only broken " +
      "if the thing it holds does not replicate by itself: a reference to an Actor that replicates is ordinary " +
      "server-side bookkeeping, and \"fixing\" it changes nothing but bandwidth.",
    inputSchema: {
      path: z.string().describe('Blueprint path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      match: z
        .string()
        .optional()
        .describe('Only properties whose name contains this, e.g. "Replicat". Implies `all` - a named property answers whether or not it was overridden.'),
      all: z
        .boolean()
        .optional()
        .describe("Include properties identical to the parent class default. Off by default; they are most of a real class."),
    },
  },
  async ({ path, match, all }) => {
    try {
      const result = (await bridge.send("read_class_defaults", { path, match, all })) as {
        properties?: Record<string, unknown>[];
      };
      // Same treatment the variable list gets, for the same reasons: "Default" is what UE calls a
      // property nobody filed anywhere, and a value that is the type's zero is what the type already
      // said. Measured on BP_Player: 74 of 167 categories were "Default" and 95 of the values zero.
      // Zero values are dropped in bulk and KEPT for a targeted question.
      //
      // "Absent means the type's zero" is a fine contract across 167 properties, where the omission
      // is most of the saving. It is the wrong answer to `match: "CountdownTime"` - somebody asking
      // about one property by name is usually about to change it, and needs to see what it is now,
      // not infer it from a convention. A change request that starts by reading the current value
      // and gets `{"name":"CountdownTime","type":"int32"}` has been told nothing it asked for.
      //
      // Found by running a change request end to end rather than by measuring the reply.
      const targeted = (match ?? "").trim().length > 0;
      const properties = Array.isArray(result.properties)
        ? result.properties.map((row) => {
            const withoutCategory = omitDefault(row, "category", "Default");
            // A class default is as full of exported struct literals as a Data Table row - a single
            // FSlateBrush or FVector prints every member with six decimal places - so the same float
            // trim applies. Done for the targeted case too: somebody reading one property to change
            // it wants 0.5, not 0.500000.
            const trimmed: Row =
              "value" in withoutCategory
                ? { ...withoutCategory, value: trimFloatPadding(withoutCategory.value) }
                : withoutCategory;
            return targeted ? trimmed : omitZeroDefault(trimmed, "value");
          })
        : undefined;
      return jsonResult({
        ...result,
        // Safe form of the spread that bit find_references: when `properties` is undefined there was
        // nothing to compact, and the raw value from `...result` is exactly the right answer. The
        // harmful version is a condition that means "should the caller SEE this", where falling
        // through leaves the uncompacted original in place.
        ...(properties ? { properties } : {}),
        // The largest saving in the whole surface, and the reply never mentioned it. Measured on
        // BP_Player: the full read is 1,691 tokens and `match` answers a specific question for 218 -
        // 87% less. A model asking "does this replicate movement" was paying for 167 properties.
        //
        // Only the WHOLE figure moved, from 3,237. The filtered one did not shift by a token, which
        // is what a compaction across 167 properties does and is a useful check that the drift was
        // real rather than a measurement taken differently.
        //
        // Only when the reply is actually large and no filter was given, so a targeted call and a
        // small class pay nothing. Same shape as the hint on list_blueprints.
        ...(properties && properties.length >= ADVISE_WHEN_ROWS_AT_LEAST && !(match ?? "").trim()
          ? {
              cheaper:
                `Asking about one setting? \`match\` filters by name - "${properties[0]?.name ?? "Speed"}" or ` +
                `"Replicat" - and answers in a fraction of this. This reply is ${properties.length} properties.`,
            }
          : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_class_default",
  {
    title: "Set a Blueprint class default (CDO property)",
    description:
      "Sets a property on the Blueprint's Class Default Object: the values shown in the Class Defaults panel. This " +
      "is how you configure inherited settings without touching a graph, and it is the correct way to turn on " +
      'replication for an actor ("bReplicates", "bAlwaysRelevant", "NetUpdateFrequency"), set a Character\'s ' +
      "movement defaults, or set the default value of any inherited variable. Same string coercion and same " +
      "fail-loudly-on-unresolved-asset behavior as unreal_set_component_property.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      property: z.string().describe('Property name on the class, e.g. "bReplicates", "NetUpdateFrequency", "InitialLifeSpan".'),
      value: engineValue.describe('The value. A number or boolean is accepted and stringified; anything structured is spelled the Unreal way: an asset path or a struct literal.'),
    },
  },
  async ({ path, property, value }) => {
    try {
      const result = await bridge.send("set_class_default", { path, property, value });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_game_settings",
  {
    title: "Set project GameMode and startup maps",
    description:
      "Writes the project's UGameMapsSettings: the default GameMode, the map the editor opens on, and the map the " +
      "packaged game launches into, persisted to the project's config. Without this, a level you just built is " +
      "never actually the one that runs. Pass any combination of the three; at least one is required.",
    inputSchema: {
      defaultGameMode: z.string().optional().describe('GameMode class or Blueprint path, e.g. "/Game/BP/BP_MyGameMode.BP_MyGameMode".'),
      editorStartupMap: z.string().optional().describe('Level path the editor opens on startup, e.g. "/Game/Maps/L_Arena".'),
      gameDefaultMap: z.string().optional().describe('Level path the packaged game loads first, e.g. "/Game/Maps/L_Arena".'),
    },
  },
  async ({ defaultGameMode, editorStartupMap, gameDefaultMap }) => {
    try {
      const result = await bridge.send("set_game_settings", { defaultGameMode, editorStartupMap, gameDefaultMap });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_describe_class",
  {
    title: "What is this class, really",
    description:
      "Reads a class's real ancestry from the running engine, plus the three facts that decide where its logic may " +
      "live: whether it is server-only, an Actor, or a widget. " +
      "**Ask before casting to something in a networked game.** A GameMode exists only on the server, so a cast to " +
      "one from a PlayerController, Pawn, GameState or widget fails on every client - silently, with every node " +
      "after the cast never running. " +
      "Answering this by name would be a guess: a project's GameModes are often called things like AVSBaseGameMode " +
      "or GM_Gameplay, and something called GameModeHelperWidget is not a GameMode at all.",
    inputSchema: {
      className: z
        .string()
        .describe('Short name, native path, or Blueprint asset path, e.g. "Character", "/Script/Engine.Actor", "/Game/BP_X.BP_X".'),
    },
  },
  async ({ className }) => {
    try {
      try {
        return jsonResult(await bridge.send("describe_class", { className }));
      } catch (err) {
        // The C++ spelling, against a plugin that does not know it yet.
        //
        // UClass::GetName() carries no prefix, so `ACharacter` and `AAVSGameState` fail while
        // `Character` and `AVSGameState` work. The bridge strips prefixes now, but the plugin inside
        // a running editor is routinely older than this server - and find_source hands back exactly
        // those prefixed names, so the two tools would disagree about the same class until a rebuild.
        //
        // Transitional, like reading both `container` and the older `isArray`. It fires only on
        // class_not_found, so once the plugin catches up this costs one comparison and never runs.
        const message = err instanceof Error ? err.message : String(err);
        const prefixed = /^[AUFEIST][A-Z]/.test(className) && className.length >= 3;
        if (!/class_not_found/.test(message) || !prefixed) throw err;
        const stripped = className.slice(1);
        const result = await bridge.send("describe_class", { className: stripped });
        return jsonResult({
          ...(result as Record<string, unknown>),
          foundAs: stripped,
          note:
            `Nothing is registered as "${className}"; this is "${stripped}". Unreal's C++ prefixes ` +
            `(A, U, F, E, I) are not part of the name reflection knows, so a class read out of a ` +
            `header needs its prefix dropped here.`,
        });
      }
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_input_mappings",
  {
    title: "What input is bound, and to which key",
    description:
      "Reads the project's input mappings. **Start here when something will not respond to a key or a button** - " +
      "the most common cause is that the binding simply is not there, and that is one call to rule out. " +
      "Reports the legacy (project settings) mappings. A project on Enhanced Input keeps its bindings in " +
      "InputMappingContext assets instead, and the result says so rather than letting an empty list read as " +
      "'this project has no input'.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridge.send("list_input_mappings", {}));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_get_game_settings",
  {
    title: "Which GameMode, which map",
    description:
      "Reads the project's default GameMode and default map, plus the level currently open and any GameMode " +
      "override that level sets. " +
      "**Reach for this when the wrong thing spawns, or nothing does.** A level's World Settings can override the " +
      "project GameMode, so the answer in project settings is not always the one that applies - both are reported.",
    inputSchema: {},
  },
  async () => {
    try {
      return jsonResult(await bridge.send("get_game_settings", {}));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_input_mapping",
  {
    title: "Add a project input mapping",
    description:
      "Adds an action or axis mapping to the project's input settings and saves them to config, so InputAction and " +
      'InputAxis event nodes have something real behind them. kind "action" is a press/release binding (Jump, ' +
      'Fire); kind "axis" is a continuous value (MoveForward) and takes scale, so a W/S pair is two calls with ' +
      "scale 1 and -1. Key names are UE's own: W, A, S, D, SpaceBar, LeftMouseButton, Gamepad_LeftX. Add the " +
      "mapping before adding the matching input event node to a graph.",
    inputSchema: {
      kind: z.enum(["action", "axis"]).describe('"action" for press/release, "axis" for a continuous value.'),
      name: z.string().describe('Mapping name the Blueprint event node will use, e.g. "Jump" or "MoveForward".'),
      key: z.string().describe('UE key name, e.g. "SpaceBar", "W", "LeftMouseButton", "Gamepad_LeftX".'),
      scale: z.number().optional().describe("Axis only: the value this key contributes, typically 1 or -1. Defaults to 1."),
    },
  },
  async ({ kind, name, key, scale }) => {
    try {
      const result = await bridge.send("add_input_mapping", { kind, name, key, scale });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_start_pie",
  {
    title: "Start Play In Editor",
    description:
      "Starts a PIE session so runtime behavior can actually be verified instead of assumed, including multiplayer: " +
      "pass numPlayers greater than 1 (and listenServer) to launch multiple clients and exercise replication. PIE " +
      "starts on the next editor tick, so poll unreal_pie_status rather than assuming it is already running, and " +
      "call unreal_stop_pie when finished. Compiling a Blueprint proves it is valid; running it is the only thing " +
      "that proves it works.",
    inputSchema: {
      numPlayers: z.number().optional().describe("Number of PIE clients. Defaults to 1. Use 2 or more to test replication."),
      ignoreCompileErrors: z
        .boolean()
        .optional()
        .describe(
          "Start even though some Blueprints fail to compile. Without it this refuses and names them, because " +
            "the editor stops on a modal nothing here can dismiss - so PIE would silently never start. Pass true " +
            "when the broken ones are unrelated to what you are testing; the reply then names them, since " +
            "anything they own will not work in that session."
        ),
      listenServer: z.boolean().optional().describe("Run the first client as a listen server, the usual multiplayer setup. Defaults to false."),
    },
  },
  async ({ numPlayers, listenServer, ignoreCompileErrors }) => {
    try {
      const result = await bridge.send("start_pie", { numPlayers, listenServer, ignoreCompileErrors });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_stop_pie",
  {
    title: "Stop Play In Editor",
    description:
      "Ends the running PIE session and reports whether one was running. Always stop PIE before further editing: " +
      "Blueprint writes made while PIE is running act on the editor world, not the running one, and are easy to " +
      "misread as having had no effect.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send("stop_pie", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_pie_status",
  {
    title: "Check whether PIE is running",
    description:
      "Reports whether a PIE session is active, and which worlds are up - Authority, Client0, Standalone. " +
      "start_pie defaults to two players on a listen server, and that pairing is the only way to see a value the " +
      "server has and a client never receives. Poll this after unreal_start_pie, which takes effect on the next " +
      "editor tick, before concluding anything about runtime behaviour.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send("pie_status", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_watch_runtime",
  {
    title: "Watch values change while the game runs",
    description:
      "Samples variables on live actors during Play-In-Editor, in every running world, labelled by net role. " +
      "Every other read here answers what a Blueprint SAYS it does; this answers what it DID. " +
      "\"Authority: 0 -> 47, Client0: 0 -> 0\" is a replication bug observed rather than argued, which is the one " +
      "class of bug that cannot be reproduced by one person. " +
      "Call with action \"start\", let real time pass (do other work, or make another call), then \"read\". " +
      "Sampling runs on the editor tick, so a read issued immediately after a start has nothing to report.",
    inputSchema: {
      action: z
        .enum(["start", "read", "stop"])
        .describe('"start" begins sampling, "read" returns what changed so far, "stop" ends it.'),
      watch: z
        .array(z.string())
        .optional()
        .describe(
          'For "start": what to sample, as "ClassName.PropertyName" - e.g. ["BP_DummyTurret.CurrentHeadYaw"]. ' +
            "The class is the Blueprint's name without _C, and derived classes match too."
        ),
      intervalMs: z.number().optional().describe("Sampling interval. Default 250, minimum 30."),
      maxSamples: z.number().optional().describe("Stop after this many samples. Default 40, so a forgotten watch costs nothing."),
    },
  },
  async ({ action, watch, intervalMs, maxSamples }) => {
    try {
      return jsonResult(await bridge.send("watch_runtime", { action, watch, intervalMs, maxSamples }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_call_parent_function",
  {
    title: "Call the parent's version of an overridden event, first",
    description:
      "Fixes the `parent-event-not-called` finding in one call - the second most expensive thing this project " +
      "knows how to find. Adding an event to a child Blueprint REPLACES the parent's rather than extending it, and " +
      "nothing warns: the parent's BeginPlay simply never happens, the Blueprint compiles clean, and the symptom " +
      "turns up somewhere else entirely.\n\n" +
      "Doing it by hand is add_node plus connect_pins, and the wiring is where it goes wrong. **\"First\" is not " +
      "\"append\"**: an exec output holds exactly one link, so connecting the parent call to the event displaces " +
      "whatever was already there - leaving a graph that runs ONLY the parent call, which is a worse bug than the " +
      "one being fixed and looks like a successful edit. This preserves the chain and reports what it moved.\n\n" +
      "Safe to run twice: a graph that already calls the parent is reported as `alreadyPresent` and left alone. " +
      "Compiles before and after, so \"did I break it\" is a comparison rather than a guess.",
    inputSchema: {
      path: z.string().describe('Blueprint that overrides the event, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      graphName: z.string().describe('Graph the override lives in - usually "EventGraph".'),
      functionName: z
        .string()
        .describe('The event as the editor labels it: "BeginPlay", "Tick", "EndPlay". The Receive- prefix is added for you.'),
      dryRun: z.boolean().optional().describe("Report the exact edit, including what it would displace, without making it."),
    },
  },
  async ({ path, graphName, functionName, dryRun }) => {
    try {
      return jsonResult(await callParentFirst(bridge, path, graphName, functionName, { dryRun }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_niagara_user_parameter",
  {
    title: "Set a Niagara system's exposed parameter",
    description:
      "The write half of unreal_read_niagara_system's `userParameters`, which reports each parameter's name, type " +
      "and now its VALUE - it listed what a system exposes and never what any of it was set to, which tells you " +
      "\"OverlaySpawnProbability\" exists and nothing about whether it is wrong.\n\n" +
      "This sets the system's DEFAULT: what every component placed from it starts with. It does not change a " +
      "component already sitting in a level - that is what the Set Niagara Variable nodes do at runtime, to one " +
      "component.\n\n" +
      "Float, int and bool only. A struct, an object or a data interface each need a different kind of argument, " +
      "and a number accepted for one of them would write something you did not mean into an asset that will not " +
      "complain - so those are refused by name and type. Parameter names are the bare ones the read reports, not " +
      "the internal \"User.\" spelling. Changes memory, not disk - unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The Niagara system, e.g. "/Game/VFX/NS_Firewall".'),
      parameter: z
        .string()
        .describe('Parameter name as unreal_read_niagara_system reports it, e.g. "OverlaySpawnProbability".'),
      value: z
        .union([z.number(), z.boolean()])
        .describe("A number for a float or int parameter, true/false for a bool."),
    },
  },
  async ({ path, parameter, value }) => {
    try {
      return jsonResult(await bridge.send("set_niagara_user_parameter", { path, parameter, value }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_struct_field",
  {
    title: "Take a field off a struct",
    description:
      "The other half of unreal_add_struct_field, which existed on its own: a struct could gain fields and never " +
      "lose one, so \"drop that column\" had no answer here.\n\n" +
      "**Refuses while a Data Table is typed by the struct**, unless `force` is passed, and names the tables and " +
      "the row count at stake first. That is not a formality - removing a field takes its column and every value " +
      "in it out of every table built on the struct, and the tables do not warn. Read what is there with " +
      "unreal_list_data_table_rows and `fields` before forcing.\n\n" +
      "Names are the ones unreal_list_struct_fields reports, and a name that does not match is refused with the " +
      "list of the ones that do. Changes memory, not disk - unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The struct, e.g. "/Game/Data/S_Upgrade".'),
      name: z.string().describe("Field to remove, as unreal_list_struct_fields spells it. Case-sensitive."),
      force: z
        .boolean()
        .optional()
        .describe("Remove it even though Data Tables are typed by this struct, losing that column's data."),
    },
  },
  async ({ path, name, force }) => {
    try {
      return jsonResult(await bridge.send("remove_struct_field", { path, name, ...(force ? { force } : {}) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_rename_struct_field",
  {
    title: "Rename a struct field, keeping the data",
    description:
      "What a caller usually wants when they reach for remove: the column keeps its values and every Data Table " +
      "typed by the struct follows. Worth having beside remove precisely so the destructive one is not the only " +
      "option on the shelf.\n\n" +
      "Refuses a name another field already uses, and a field name that does not exist, listing the ones that do. " +
      "Changes memory, not disk - unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The struct, e.g. "/Game/Data/S_Upgrade".'),
      name: z.string().describe("Field to rename, as unreal_list_struct_fields spells it."),
      newName: z.string().describe("The new name."),
    },
  },
  async ({ path, name, newName }) => {
    try {
      return jsonResult(await bridge.send("rename_struct_field", { path, name, newName }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_enum_entry",
  {
    title: "Take an entry off an enum",
    description:
      "The other half of unreal_add_enum_entry. Matched on the DISPLAY name - what unreal_list_enum_entries " +
      "reports and what a person sees in the editor - because the internal spelling is NewEnumerator0, " +
      "NewEnumerator1 and so on, which identifies nothing to a reader.\n\n" +
      "**Anything storing this enum by value keeps its number**, so a variable or Data Table cell holding the " +
      "removed entry afterwards reads as whichever entry took its index. The reply says so. Refuses to remove the " +
      "last entry. Changes memory, not disk - unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The enum, e.g. "/Game/Data/E_UpgradeKind".'),
      name: z.string().describe("Entry to remove, by display name as unreal_list_enum_entries reports it."),
    },
  },
  async ({ path, name }) => {
    try {
      return jsonResult(await bridge.send("remove_enum_entry", { path, name }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_rename_enum_entry",
  {
    title: "Rename an enum entry",
    description:
      "Changes the display name, which is what Blueprints and Data Tables show. The stored value is unchanged, so " +
      "nothing using the enum breaks - which makes this the safe half of the pair and usually the one you want. " +
      "Refuses a name another entry already uses. Changes memory, not disk - unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The enum, e.g. "/Game/Data/E_UpgradeKind".'),
      name: z.string().describe("Entry to rename, by display name."),
      newName: z.string().describe("The new display name."),
    },
  },
  async ({ path, name, newName }) => {
    try {
      return jsonResult(await bridge.send("rename_enum_entry", { path, name, newName }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_montage_notify",
  {
    title: "Put a notify on a montage",
    description:
      "The write half of a read that already existed. unreal_read_asset_properties reports a montage's notifies as " +
      "`{name, at, kind}` and nothing here could put one there - so a model could SEE that a montage has no notify " +
      "to drive a footstep, a hit window or a sound, and had no way to add one. Animation was three tools and all " +
      "three were read-only.\n\n" +
      "Instant notifies only. A notify STATE has a duration and needs a UAnimNotifyState class to give it " +
      "behaviour; asking for one is refused by name rather than quietly producing an instant notify, because a " +
      "duration that vanishes is worse than a call that did not run.\n\n" +
      "Refused rather than accepted: a time outside the montage (it would never fire), and a notify with the same " +
      "name already at that time (it would fire twice, which reads as a doubled sound). Changes memory, not disk - " +
      "unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The montage, e.g. "/Game/Anim/ILY_Attack2_Montage".'),
      name: z
        .string()
        .describe(
          'Notify name, the same string unreal_read_asset_properties reports. In a Blueprint this arrives on Play ' +
            'Montage\'s OnNotifyBegin, or as an AnimNotify_<name> event in the Animation Blueprint.'
        ),
      at: z.number().describe("Seconds from the start of the montage. Must be within its lengthSeconds."),
    },
  },
  async ({ path, name, at }) => {
    try {
      return jsonResult(await bridge.send("add_montage_notify", { path, name, at }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_montage_notify",
  {
    title: "Take a notify off a montage",
    description:
      "Removes every notify with this name, or only the one at a given time when a montage carries the same name " +
      "twice on purpose. Reports how many went and lists what is left, so a caller can see the result rather than " +
      "assume it.\n\n" +
      "Removing nothing is not reported as success: if no notify by that name exists, the reply says so and lists " +
      "the names that do. Changes memory, not disk - unreal_save_asset writes it.",
    inputSchema: {
      path: z.string().describe('The montage, e.g. "/Game/Anim/ILY_Attack2_Montage".'),
      name: z.string().describe("Notify name to remove. Case-sensitive."),
      at: z
        .number()
        .optional()
        .describe("Only the notify at this time, for a montage carrying the same name more than once."),
    },
  },
  async ({ path, name, at }) => {
    try {
      return jsonResult(await bridge.send("remove_montage_notify", { path, name, ...(at === undefined ? {} : { at }) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_timeline",
  {
    title: "Read what a Blueprint Timeline animates",
    description:
      "A Timeline is how a Blueprint animates anything over time without an animation asset - aim-down-sights, a " +
      "door swinging, a fade, a charge meter filling - and nothing else here could see one. Returns each timeline's " +
      "length, whether it loops, auto-plays and REPLICATES, and every track: float, vector, linear colour and event.\n\n" +
      "Curves are described rather than dumped: key count, the value range, and where the last key sits. That " +
      "answers \"what is this and what would I change\" without paying for hundreds of key/value pairs. A track " +
      "using a shared curve ASSET is named as such, because editing that changes every timeline using it.\n\n" +
      "`replicated` is reported even when false on purpose: a timeline driving visible movement that does not " +
      "replicate is a multiplayer bug waiting to happen, and this is the only place that fact is visible.\n\n" +
      "Timelines are also indexed now, so unreal_search_project finds one by name.",
    inputSchema: {
      path: z
        .string()
        .describe('Blueprint holding the timeline, e.g. "/Game/Player/BP_Player".'),
      timelineName: z
        .string()
        .optional()
        .describe('One timeline by name, e.g. "TL_Aim". Omit for all of them, which is how you learn the names.'),
    },
  },
  async ({ path, timelineName }) => {
    try {
      return jsonResult(await bridge.send("read_timeline", { path, timelineName }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_level_sequence",
  {
    title: "Read what a Level Sequence animates",
    description:
      "What a cutscene actually drives: the actors it binds, the tracks on each, and the tracks the sequence " +
      "itself owns (camera cuts, fades, events).\n\n" +
      "Shaped around the three ways a sequence looks correct and does nothing, because none of them is an error " +
      "and each is visible in the editor only by scrolling to it and noticing an absence: **a binding with no " +
      "tracks** (the actor is in the sequence and nothing animates it), **a track with no sections** (it is in the " +
      "outliner with no keys, so it never evaluates), and **a muted track** (identical to working in every static " +
      "read). Each is counted, and the counts are absent when zero.\n\n" +
      "Reading the asset with unreal_read_asset_properties instead returns the raw export text of the MovieScene - " +
      "a wall of GUIDs with the one interesting fact buried in it.",
    inputSchema: {
      path: z
        .string()
        .describe('Level Sequence path, e.g. "/Game/Cinematics/LS_Intro". Find them with unreal_list_assets className=LevelSequence.'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("read_level_sequence", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_input_context",
  {
    title: "Read what an Input Mapping Context binds",
    description:
      "Answers \"what is W bound to\" for Enhanced Input, which is where every modern Unreal project keeps its " +
      "bindings. Returns the keys grouped under the action they fire, with modifiers and triggers named: " +
      "`{\"IA_Move\": [\"W\", \"S (Negate)\"], \"IA_Jump\": [\"SpaceBar\"]}`.\n\n" +
      "unreal_list_input_mappings reads the LEGACY project-settings bindings and returns nothing on a project that " +
      "uses Enhanced Input. Reading the context asset with unreal_read_asset_properties works but hands back the raw " +
      "export string - kilobytes of package paths per binding, with the one interesting word buried in it.",
    inputSchema: {
      path: z
        .string()
        .describe('An InputMappingContext: short name like "IMC_Default", or a full path. Find them with unreal_list_assets className=InputMappingContext.'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("read_input_context", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_map_input_key",
  {
    title: "Bind a key to an Input Action",
    description:
      "Adds a key binding to an Input Mapping Context - the Enhanced Input equivalent of \"bind Q to interact\". " +
      "Refuses a key the engine does not know, because FKey accepts any name without complaint and a binding to a " +
      "misspelled key saves happily, shows in the editor, and never fires. Refuses to add a duplicate too: two " +
      "identical mappings both fire, which reads as the action triggering twice for no reason.\n\n" +
      "The asset is left dirty, not saved - follow with unreal_save_asset.",
    inputSchema: {
      path: z.string().describe('The InputMappingContext, e.g. "IMC_Default".'),
      action: z.string().describe('The InputAction, e.g. "IA_Interact". Find them with unreal_list_assets className=InputAction.'),
      key: z
        .string()
        .describe('Key name as the editor spells it: "Q", "SpaceBar", "LeftMouseButton", "Gamepad_FaceButton_Bottom".'),
      modifiers: z
        .array(z.string())
        .optional()
        .describe('Input modifiers, in the short form this server prints: ["Negate"], ["SwizzleAxis", "Negate"]. Common ones are Negate, SwizzleAxis, DeadZone, Scalar, SmoothDelta.'),
    },
  },
  async ({ path, action, key, modifiers }) => {
    try {
      return jsonResult(await bridge.send("map_input_key", { path, action, key, modifiers }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_unmap_input_key",
  {
    title: "Remove a key binding from an Input Mapping Context",
    description:
      "Removes one key binding. Reports `changed: false` when that key was not bound to that action rather than " +
      "claiming success, because the engine's own UnmapKey does nothing and says nothing for a mapping that is not " +
      "there - so a misspelled key would otherwise look like a successful unbinding.",
    inputSchema: {
      path: z.string().describe('The InputMappingContext, e.g. "IMC_Default".'),
      action: z.string().describe('The InputAction, e.g. "IA_Interact".'),
      key: z.string().describe('The key to unbind, e.g. "Q".'),
    },
  },
  async ({ path, action, key }) => {
    try {
      return jsonResult(await bridge.send("unmap_input_key", { path, action, key }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_run_tests",
  {
    title: "Run the engine's automation tests and report what failed",
    description:
      "Runs Unreal's own automation tests - the ones in Session Frontend - and returns what failed. " +
      "Pass `match` to run a subset by name prefix (\"System.Mass\", \"MyGame.Inventory\"); pass `list: true` " +
      "to see what tests exist without running anything. Passing tests are counted, not listed: a real " +
      "project has ~5,000 and naming them all answers a question nobody asked. Failures come back with the " +
      "engine's own messages attached. Running everything takes many minutes, so `match` is required unless " +
      "you explicitly ask to list.",
    inputSchema: {
      match: z
        .string()
        .optional()
        .describe('Test name or prefix, e.g. "System.Mass" or "MyGame". Required to run; optional to filter a list.'),
      list: z
        .boolean()
        .optional()
        .describe("List matching test names instead of running them. Cheap, and the way to find the right `match`."),
      timeoutSeconds: z
        .number()
        .optional()
        .describe("How long to wait for the run to finish. Defaults to 120. A partial result says so rather than pretending."),
    },
  },
  async ({ match, list, timeoutSeconds }) => {
    try {
      const ping = await bridge.send<{ projectFile?: string }>("ping", {});
      if (!ping?.projectFile) {
        return errorResult(
          new Error(
            "The editor did not report which project it has open, so there is no log to read the results from. " +
              "unreal_doctor diagnoses a bridge that answers but cannot say where it is."
          )
        );
      }
      const logPath = logFileFor(ping.projectFile);

      // Refusing rather than defaulting to everything. "Automation RunAll" on a real project runs
      // ~5,000 tests, takes many minutes, and holds the editor while it does - not something to
      // start because a parameter was left out.
      if (!list && !(match ?? "").trim()) {
        return errorResult(
          new Error(
            "unreal_run_tests needs a `match` to run, because running everything takes many minutes and holds the " +
              "editor. Call with `list: true` (optionally with a `match`) to see what exists first."
          )
        );
      }

      // Where the log ends BEFORE the command, so the parse sees this run and not the session
      // before it. The editor appends, so this is a stable point to read from.
      const start = await logSize(logPath);
      const command = list ? "Automation List" : `Automation RunTests ${(match ?? "").trim()}`;
      await bridge.send("run_console_command", { command });

      const budgetMs = Math.max(5, Math.min(timeoutSeconds ?? 120, 900)) * 1000;
      const deadline = Date.now() + budgetMs;
      let text = "";
      // Polling, because the engine runs these asynchronously and the console call returns as soon
      // as the queue accepts the request. The terminal line is the only reliable "finished".
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        text = await readLogFrom(logPath, start);
        if (runIsComplete(text)) break;
      }

      if (list) {
        const listed = parseAutomationList(text, match);
        return jsonResult({
          ...listed,
          note: listed.omitted > 0 ? `${listed.omitted} more match; narrow \`match\` to see them.` : undefined,
          incomplete: runIsComplete(text) ? undefined : "The engine did not finish listing within the timeout.",
        });
      }

      const run = parseAutomationRun(text);
      return jsonResult({
        ...run,
        // Said outright rather than left to be inferred from a zero. A timed-out run and a clean run
        // both show no failures, and reporting the first as the second is the one way this tool
        // could do real harm - somebody shipping on "0 failed" that never finished.
        incomplete: run.complete
          ? undefined
          : `The engine did not print its finished line within ${Math.round(budgetMs / 1000)}s, so these counts are ` +
            `partial. Raise timeoutSeconds or narrow the match.`,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_run_console_command",
  {
    title: "Run a console command",
    description:
      "The tilde key. One command covering the enormous surface that has no tool of its own: " +
      "\"ce StartWave\" to fire an event nothing is calling yet, \"Ke * ResetHealth\" to call a function on every " +
      "instance of a class, \"stat unit\" to see whether a frame is CPU or GPU bound, \"slomo 0.1\" to watch " +
      "something too fast to see, cvars, showdebug, and every cheat the project defines.\n\n" +
      "Reach for it when you need the game to DO something to test a fix, and no specific tool exists.\n\n" +
      "Read `recognised` before believing anything. A misspelled command does nothing, prints nothing, and " +
      "looks exactly like a correct command with no visible effect - `recognised: false` is the engine saying it " +
      "never ran. Most commands answer through the log rather than to the caller, so `log` is usually where the " +
      "answer is. While a game is running the command goes through the player controller, which is the only path " +
      "`ce` and cheats exist on; otherwise it goes to the editor.",
    inputSchema: {
      command: z.string().describe('The console line, e.g. "stat fps" or "ce StartWave".'),
      world: z
        .enum(["auto", "pie", "editor"])
        .optional()
        .describe(
          'Where to run it. Default "auto": the running game if there is one, otherwise the editor. ' +
            '"pie" fails plainly rather than quietly running against the editor when no game is up.'
        ),
    },
  },
  async ({ command, world }) => {
    try {
      const reply = await bridge.send("run_console_command", { command, world });
      return jsonResult(describeConsoleResult(command, reply as never));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_hot_reload_cpp",
  {
    title: "Apply C++ changes to the running editor",
    description:
      "Compiles the C++ you just changed and patches it into the editor that is already open - the Ctrl+Alt+F11 " +
      "a human presses, without closing anything. This is the step that makes a native fix real: unreal_compile_cpp " +
      "proves code builds, this makes the running editor actually run it, so you can then test the fix in the same " +
      "session you wrote it in.\n\n" +
      "Save your edits first, then call this once and wait - it returns when the compile is done, however long that " +
      "takes. It reports which of six things happened, and they are not interchangeable: \"no-changes\" means nothing " +
      "was rebuilt (usually an unsaved file, or one in a module this editor never loaded), and \"patched-but-unsafe\" " +
      "means it worked but you changed data types - adding a UPROPERTY, typically - which live coding patches without " +
      "guaranteeing. Only \"patched\" means test it and move on.\n\n" +
      "Live coding is Windows-only and can be switched off per project; when it is unavailable the reply says so and " +
      "names the rebuild that does work.\n\n" +
      "One more outcome sits above all of these: \"patched-wrong-tree\". A project installs this plugin by COPYING " +
      "its source in, and live coding compiles the project's copy - so if the repo you are editing and the copy the " +
      "editor compiles have drifted apart, a compile can succeed and still not contain your change. That reply names " +
      "the differing files and the command that syncs them.",
    inputSchema: {
      timeoutSeconds: z
        .number()
        .optional()
        .describe(
          "How long to wait before returning while the compile continues. Default 300. The first compile of a " +
            "session is far slower than later ones."
        ),
    },
  },
  async ({ timeoutSeconds }) => {
    try {
      // Checked BEFORE the compile, not after, because a compile of the wrong tree takes just as
      // long as a compile of the right one and tells the caller nothing either way.
      //
      // The plugin is installed into a project by copying it, so there are two source trees and
      // live coding compiles the project's. An edit here reaches the editor only once it is copied
      // across - and until then this tool answers "patched: running in the editor now", which is
      // true about what it did and false about what the caller will conclude. That reply cost a
      // real detour: a fix was made, reloaded, measured, found unchanged, and the search went to
      // the one place the reply had ruled out.
      let outOfSync: string | undefined;
      try {
        const ping = await bridge.send<{ projectFile?: string }>("ping", {});
        const repoSourceDir = fileURLToPath(new URL("../../UnrealMCPBridge/Source", import.meta.url));
        const compared = comparePluginSource(repoSourceDir, ping?.projectFile ?? "");
        if (compared && compared.differing.length > 0) {
          outOfSync = outOfSyncNote(compared, repoSourceDir);
        }
      } catch {
        // Never let the advisory break the thing it advises on. A failed comparison means no note,
        // not a failed reload.
      }

      const report = await hotReloadCpp(
        {
          send: (cmd, params) => bridge.send(cmd, params),
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
        },
        { timeoutSeconds }
      );

      // Overrides the outcome rather than sitting beside it. "patched" is the one word that tells a
      // caller to stop checking and move on, and it must not be the word for a run that compiled
      // somebody else's copy of the file.
      if (outOfSync) {
        return jsonResult({
          ...report,
          outcome: "patched-wrong-tree",
          meaning:
            `Live coding reported "${report.outcome}", and it did not compile your edits. ` + outOfSync,
        });
      }
      return jsonResult(report);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_auto_layout_graph",
  {
    title: "Auto-layout a graph and label its sections",
    description:
      "Makes an existing graph read like a careful human built it, in one call, without you working out a single " +
      "coordinate. Nodes are ranked into left-to-right columns so every wire points forward, ordered to minimise " +
      "crossings, straightened so execution chains run along one row, and spaced so nothing overlaps. By default it " +
      "then wraps each execution chain in a comment box titled after the event that starts it, so a reader sees " +
      '"Event BeginPlay" as a labelled region instead of a float of nodes.\n\n' +
      "Run this whenever you have finished a piece of work in a graph, including graphs you did not author: it is " +
      "purely cosmetic, safe to run repeatedly (it will not stack duplicate comment boxes), and it is the difference " +
      "between output that compiles and output someone is happy to inherit. unreal_build_graph already applies the " +
      "positioning half automatically; call this to also get the comment boxes, or to tidy a graph built any other way.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe('Graph to lay out, e.g. "EventGraph" or a function graph name.'),
      addCommentBoxes: z
        .boolean()
        .optional()
        .describe(
          "Wrap each execution chain in a comment box titled after its event. Defaults to true. A chain of fewer " +
            "than two nodes is never boxed, and a box whose title already exists is skipped."
        ),
      columnGap: z.number().optional().describe("Horizontal gap between columns. Defaults to 120."),
      rowGap: z.number().optional().describe("Vertical gap between nodes in a column. Defaults to 56."),
      originX: z.number().optional().describe("X of the leftmost column. Defaults to 0."),
      originY: z.number().optional().describe("Y of the top of the layout. Defaults to 0."),
    },
  },
  async ({ path, graphName, addCommentBoxes, columnGap, rowGap, originX, originY }) => {
    try {
      const report = await autoLayoutGraph(bridge, path, graphName, {
        addCommentBoxes,
        columnGap,
        rowGap,
        originX,
        originY,
      });
      return jsonResult(report);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_review_blueprint",
  {
    title: "Review a Blueprint for the things a senior developer would flag",
    description:
      "The quality gate. Compiling only proves a graph is valid: a Blueprint full of dead nodes, unhandled cast " +
      "failures, leftover Print String debug, placeholder variable names, and per-frame work in Event Tick compiles " +
      "perfectly and is still not finished work. This reads the graphs and reports exactly those things, each with " +
      "the concrete fix and the node ids to fix it on, plus a 0-100 score and a single `nextAction` naming the one " +
      "thing most worth doing next.\n\n" +
      "**Call this before you tell the user a feature is done, and act on what it says.** It costs one cheap read " +
      "per graph, changes nothing, and it is the only feedback available on whether the work is actually good " +
      "rather than merely valid. If you skip it you are grading your own homework.\n\n" +
      "**The fix for each finding is in the top-level `fixes` map, keyed by the finding's `check`.** The advice " +
      "for a check does not vary by where it fired, and repeating it on all thirty findings of a real Blueprint " +
      "costs about a fifth of the reply. `cleanGraphs` lists the graphs that were read and had nothing wrong, so " +
      "\"checked and clean\" stays distinguishable from \"never looked at\".",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().optional().describe("Review only this graph. Omit to review every graph in the Blueprint."),
      check: z
        .string()
        .optional()
        .describe('One kind only, e.g. "server-writes-unreplicated". Score and counts still cover the whole review.'),
    },
  },
  async ({ path, graphName, check }) => {
    try {
      // Compile first, and lead with it if it fails.
      //
      // Measured on a deliberately half-wired Blueprint: it did not compile, and the review returned
      // score 95 with "errors": 0, because a review reads graph STRUCTURE and a compile error is not
      // a structural finding. The workflow this server prints tells a model to review before claiming
      // a feature is done - so the one call standing between "built it" and "said it works" was
      // answering 95/100 about something the engine had rejected. That is the exact failure this
      // project exists to prevent, produced by its own quality gate.
      //
      // The review still runs and is still returned: it is not useless, it is subordinate. What
      // changes is that the caller cannot read a score without seeing that the thing does not build.
      const compile = await bridge
        .send<CompileBlueprintResult>("compile_blueprint", { path })
        .catch(() => null);
      // Deduped here, where the review is SERIALISED, not where it is produced: audit.ts reads
      // finding.fix in twelve places off the same function. See dedupeFixes.ts.
      // Filtered here, where the review is SERIALISED, for the same reason dedupeFixes runs here:
      // audit.ts reads the unfiltered review off the same function in twelve places.
      const result = withDisabledToolNote(
        filterReviewByCheck(
          dedupeFixes(await reviewBlueprint(bridge, path, graphName)) as unknown as ReviewLike,
          check
        ) as unknown as Record<string, unknown>,
        isToolEnabled
      );

      if (compile && compile.success === false) {
        return jsonResult({
          compiles: false,
          compileErrors: compile.errorCount ?? 0,
          compileMessages: compile.messages ?? [],
          verdict: "does not compile",
          next:
            "This Blueprint does not compile, so fix that before anything below. A review reads graph " +
            "structure and cannot see a compile error; the score is about a graph the engine has " +
            "rejected. Each message names the node and pin it is about.",
          review: result,
        });
      }
      return jsonResult(compile ? { compiles: true, ...result } : result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_doctor",
  {
    title: "Diagnose the whole setup in one call",
    description:
      "Run this the moment anything is not working, and run it first in a new session before concluding a tool is " +
      "broken. It checks, in order: the editor bridge is reachable; the loaded plugin's protocol matches this " +
      "server; the editor is responsive rather than grinding on a compile or a modal dialog; the project index is " +
      "built and not still scanning (a still-scanning index reports that things do not exist when they do); the " +
      "engine's live node catalog is readable; and whether a PIE session is running (Blueprint writes during PIE " +
      "apply to the editor world, not the running one, so they look like they did nothing).\n\n" +
      "Every check reports a status and, when it is not ok, the concrete remedy. The report ends with a single " +
      "`nextAction`. It never throws: if the editor cannot be reached at all, that IS the answer, and the remedy " +
      "is the ordered checklist for fixing it. Relay the remedy to the user in plain language; most of these are " +
      "things only they can fix, in the editor.",
    inputSchema: {
      verbose: z
        .boolean()
        .optional()
        .describe("Every check in full even when nothing is wrong. A degraded report is always full."),
    },
  },
  async ({ verbose }) => {
    try {
      const report = await runDoctor(rawBridge, { host: BRIDGE_HOST, port: BRIDGE_PORT, expectedProject: EXPECT_PROJECT });
      // Which mode is active changes what every build costs and how much feedback comes back
      // unasked, so it belongs in the one call people run when something seems off.
      const full = { ...report, mode: MODE.mode, modeMeans: MODE.description };

      /**
       * A healthy report says the same thing eleven times.
       *
       * The standing instructions make this step 1 - "anything broken: unreal_doctor" - so nearly
       * every session pays for it, and on a working setup 413 of those tokens are prose confirming
       * that a thing which is fine is fine: "protocol 1", "27 probed commands are all implemented",
       * "source control not enabled", "ping round trip 9ms".
       *
       * Three of the eleven carry facts worth keeping even when nothing is wrong - WHICH editor
       * this is talking to, and how much of it is indexed - because those orient a caller rather
       * than reassure it. The rest becomes a count.
       *
       * A degraded report is never compacted. The whole value of this tool is the detail on the
       * check that failed, and a diagnostic that gets terser when things go wrong would be worse
       * than useless. `verbose` is there for the case where someone wants the passing detail too.
       */
      if (verbose === true || report.verdict !== "ready") return jsonResult(full);

      const detailOf = (name: string) => report.checks.find((c) => c.name === name)?.detail;
      return jsonResult({
        verdict: report.verdict,
        host: report.host,
        port: report.port,
        // The engine version lives in the "bridge reachable" detail, which is otherwise dropped.
        // Worth carrying: it decides whether an engine feature is even available to this project,
        // and looking it up separately means reading a .uproject off disk.
        editing: [
          detailOf("which project")?.replace(/\.\s*$/, ""),
          /UE [0-9][^.\s]*(\.[0-9]+)*/.exec(detailOf("bridge reachable") ?? "")?.[0],
        ]
          .filter(Boolean)
          .join(" on "),
        indexed: detailOf("project index"),
        catalog: detailOf("node catalog"),
        checksPassed: report.checks.length,
        nextAction: report.nextAction,
        mode: MODE.mode,
        modeMeans: MODE.description,
        detail: "All checks passed; pass verbose:true for the per-check detail.",
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_scaffold_widget",
  {
    title: "Build a whole UI screen in one call",
    description:
      "**Build the entire widget in one call: the Widget Blueprint and every element inside it.** " +
      "Reach for this first whenever you are creating UI. " +
      "Widgets are added in the order given, so declare a panel before the things inside it. " +
      "A step that fails is reported in `failures` and the rest still proceeds.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/UI/W_HUD". Prefix widget assets with W_ by convention.'),
      parentClass: z.string().optional().describe("Parent class. Defaults to UserWidget."),
      rootWidget: z.string().optional().describe('Root panel, e.g. "CanvasPanel" or "VerticalBox".'),
      widgets: z
        .array(
          z.object({
            widgetClass: z.string().describe('e.g. "TextBlock", "Button", "ProgressBar", "Image", "VerticalBox".'),
            name: z.string(),
            parent: z.string().optional().describe("Nest inside this panel instead of the root."),
            properties: z.record(engineValue).optional().describe('Properties to set, e.g. {"Text":"Score"}.'),
          })
        )
        .optional()
        .describe("Everything on the screen, with its properties set for you."),
      save: z.boolean().optional().describe("Save at the end. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, rootWidget, widgets, save }) => {
    try {
      return jsonResult(await scaffoldWidget(bridge, { packagePath, parentClass, rootWidget, widgets, save }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_widget_blueprint",
  {
    title: "Create a UMG Widget Blueprint",
    description:
      "Creates a Widget Blueprint: the asset behind every health bar, menu, HUD, and inventory screen. It is given " +
      "a CanvasPanel root by default, which is the only root that supports free positioning of children. Choose a " +
      "different root when the layout is inherently stacked (VerticalBox, HorizontalBox) or layered (Overlay), " +
      "because a box that lays itself out is far easier to keep tidy than absolute coordinates.\n\n" +
      "Then: unreal_add_widget to build the tree, unreal_set_widget_property to style it, and " +
      "unreal_compile_blueprint. To actually show it on screen, build a CallFunction on " +
      "WidgetBlueprintLibrary::Create followed by AddToViewport, in a " +
      "gameplay Blueprint with unreal_build_graph. A Widget Blueprint that is never added to the viewport is " +
      "invisible, which is the most common reason UI work appears to have done nothing.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/UI/W_HealthBar". Prefix widget assets with W_ by convention.'),
      parentClass: z.string().optional().describe('Parent class. Defaults to UserWidget. Pass your own UserWidget-derived class or Blueprint path to inherit from it.'),
      rootWidget: z
        .string()
        .optional()
        .describe('Root panel class: "CanvasPanel" (default, free positioning), "VerticalBox", "HorizontalBox", "Overlay", "SizeBox". Must be a panel.'),
      save: z.boolean().optional().describe("Save to disk immediately. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, rootWidget, save }) => {
    try {
      const result = await bridge.send("create_widget_blueprint", { packagePath, parentClass, rootWidget, save });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_widget",
  {
    title: "Add a widget to a Widget Blueprint",
    description:
      "Adds one widget to a Widget Blueprint's tree, under the root or under a named panel. Common classes: " +
      "TextBlock, Button, Image, ProgressBar (health/mana bars), Border, SizeBox, Spacer, EditableTextBox, " +
      "CheckBox, Slider, ScrollBox, and the panels CanvasPanel, VerticalBox, HorizontalBox, Overlay, GridPanel.\n\n" +
      "Two things about UMG that are worth knowing before you start guessing:\n" +
      "  - A Button holds exactly ONE child. To put a label on a button, add the Button, then add a TextBlock with " +
      "parent set to the button. Adding a second child to a Button fails with parent_full.\n" +
      "  - Layout (position, size, alignment, padding, anchors) lives on the SLOT, not the widget. Set it with " +
      "unreal_set_widget_property and onSlot: true. The response tells you the slot class you got, which is what " +
      "determines the available layout properties.\n" +
      "Call unreal_list_widgets first if you need the exact name of an existing parent.",
    inputSchema: {
      path: z.string().describe('Widget Blueprint path, e.g. "/Game/UI/W_HealthBar.W_HealthBar".'),
      widgetClass: z.string().describe('Widget class, e.g. "TextBlock", "Button", "ProgressBar", "Image", "VerticalBox".'),
      name: z.string().describe('Name for this widget, e.g. "HealthText". This is how you reference it in every other call, and how a human finds it in the Designer.'),
      parent: z.string().optional().describe("Name of an existing panel widget to add this under. Defaults to the root."),
    },
  },
  async ({ path, widgetClass, name, parent }) => {
    try {
      const result = await bridge.send("add_widget", { path, widgetClass, name, parent });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_widgets",
  {
    title: "Read a Widget Blueprint's widget tree and animations",
    description:
      "Returns the whole widget hierarchy in depth-first order: each widget's name, class, parent, depth, slot " +
      "class, and whether it can hold children. Call this before unreal_add_widget (to pick a valid parent) or " +
      "unreal_set_widget_property (to get an exact name), instead of guessing. The slot class on each entry tells " +
      "you which layout properties that widget actually has, which differs per parent panel type.\n\n" +
      "Also lists the widget's ANIMATIONS with their duration and how many widgets each one drives - the fades, " +
      "pulses and slides that make a menu move, which nothing could see before. An animation bound to no widgets " +
      "is called out: it plays perfectly and animates nothing, and that is invisible in the editor without opening " +
      "it. The field is absent when the widget has no animations.",
    inputSchema: {
      path: z.string().describe('Widget Blueprint path, e.g. "/Game/UI/W_HealthBar.W_HealthBar".'),
      match: z
        .string()
        .optional()
        .describe('Only widgets whose name or class contains every term, e.g. "button" or "text block".'),
    },
  },
  async ({ path, match }) => {
    try {
      const result = (await bridge.send("list_widgets", { path })) as {
        widgets?: Array<{ name?: string; class?: string }>;
        count?: number;
        [key: string]: unknown;
      };

      /**
       * A widget tree is one of the biggest replies here and was the only list with no way to narrow.
       *
       * Measured on this project: WBP_MorrisPopUp is 87 widgets and 2,654 tokens, WBP_HUD 1,343.
       * Every other list tool takes a `match`; this one did not, so "which buttons does this screen
       * have" cost the whole tree.
       *
       * The count is left describing the WHOLE tree and a `showing` line says what was withheld,
       * for the reason the review filter records two commits ago: a filtered reply that looks like a
       * complete one is worse than no filter.
       *
       * Honest limit, stated rather than discovered: this filters a flat list, so a match's parent
       * may not be in it. Each entry still names its parent, which is what add_widget and
       * set_widget_property need.
       */
      const terms = matchTerms(match);
      if (terms.length === 0) return jsonResult(result);

      const all = result.widgets ?? [];
      const kept = all.filter((w) => matchesAllTerms(`${w.name ?? ""} ${w.class ?? ""}`, terms));
      return jsonResult({
        ...result,
        widgets: kept,
        showing:
          `${kept.length} of ${all.length} widget(s) match "${match}"; the rest are still there, ` +
          `and each entry names its parent even when the parent is not in this list.`,
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_widget_property",
  {
    title: "Set a property on a widget or its layout slot",
    description:
      "Sets one property on a widget, or on its layout slot when onSlot is true. This is where UI stops looking " +
      "programmer-art and starts looking designed, so it is worth spending calls on.\n\n" +
      "On the widget: TextBlock Text and ColorAndOpacity, ProgressBar Percent and FillColorAndOpacity, Image " +
      "Brush, Button BackgroundColor, any widget's Visibility, RenderTransform, or ToolTipText.\n" +
      "On the slot (onSlot: true): CanvasPanelSlot has LayoutData (offsets plus anchors), ZOrder, and " +
      "bAutoSize; box slots have Padding, HorizontalAlignment, VerticalAlignment, and Size. Anchors are what make " +
      "UI survive a different screen resolution, so a HUD element pinned to a corner should be anchored to that " +
      "corner rather than placed at fixed coordinates.\n\n" +
      "Values are strings coerced to the property's real type; structs use UE literal syntax such as " +
      '"(R=1,G=0,B=0,A=1)". An asset path that does not resolve fails loudly instead of silently setting None. ' +
      "Get exact widget names from unreal_list_widgets.",
    inputSchema: {
      path: z.string().describe('Widget Blueprint path, e.g. "/Game/UI/W_HealthBar.W_HealthBar".'),
      widget: z.string().describe("Widget name, exactly as returned by unreal_list_widgets."),
      property: z.string().describe('Property name, e.g. "Text", "Percent", "ColorAndOpacity", "Padding", "ZOrder".'),
      value: engineValue.describe('The value. A number or boolean is accepted; structured values are spelled the Unreal way: "(R=1,G=0,B=0,A=1)".'),
      onSlot: z
        .boolean()
        .optional()
        .describe("Set the property on the widget's layout slot instead of the widget itself. Use for position, size, padding, alignment, anchors, ZOrder. Defaults to false."),
    },
  },
  async ({ path, widget, property, value, onSlot }) => {
    try {
      const result = await bridge.send("set_widget_property", { path, widget, property, value, onSlot });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_asset_properties",
  {
    title: "Read the settings inside a plain asset",
    description:
      "**The tool for Data Assets, and for any asset that is a bag of settings** - Curves, Sound Classes, Material " +
      "Parameter Collections, Data Assets of every custom class. A Data Asset is how a great many teams store the " +
      "numbers a designer tunes; it is the typed sibling of a Data Table, and nothing else here can see inside one.\n\n" +
      "Returns each editable property with its type, current value and details-panel category, so \"what does this " +
      "thing actually hold\" is one call. Engine bookkeeping is left out - only what a human could edit is returned, " +
      "which is also exactly the set unreal_set_asset_property can write.\n\n" +
      "**`value` appears only when it is not the type's zero** - no `value` means 0, False, \"\", None or () as " +
      "the type dictates, the same contract unreal_list_variables and unreal_read_class_defaults use. `match` " +
      "overrides it and also narrows a big asset to one setting, because someone asking about a property by " +
      "name is usually about to change it and needs its current value.\n\n" +
      'Find paths with unreal_list_assets({ className: "DataAsset" }) or by the asset\'s own class name.',
    inputSchema: {
      path: z.string().describe('Asset path, e.g. "/Game/Data/DA_EnemyTuning.DA_EnemyTuning".'),
      match: z.string().optional().describe('Only properties whose name contains this, e.g. "Damage".'),
    },
  },
  async ({ path, match }) => {
    try {
      const result = (await bridge.send("read_asset_properties", { path, match })) as {
        properties?: Row[];
      };

      // The same compaction read_class_defaults has had all along, and for the same reasons.
      //
      // These two tools read the editable properties of an object and returned them in two different
      // shapes: one dropped a category of "Default" and a value that is the type's zero, the other
      // sent both verbatim. Measured across this project's 41 Data Assets: 263 of 413 properties -
      // 64% - carry a zero value, 22,676 characters, about 5,669 tokens spent repeating what the
      // type already says.
      //
      // The targeted exception is copied deliberately too. Somebody who asks for one property by
      // name is usually about to change it and needs to see what it is now; `match: "Damage"`
      // answering {"name":"Damage","type":"float"} has told them nothing they asked for.
      const targeted = (match ?? "").trim().length > 0;
      const properties = Array.isArray(result.properties)
        ? result.properties.map((row) => {
            const withoutCategory = omitDefault(row, "category", "Default");
            const trimmed: Row =
              "value" in withoutCategory
                ? { ...withoutCategory, value: trimFloatPadding(withoutCategory.value) }
                : withoutCategory;
            return targeted ? trimmed : omitZeroDefault(trimmed, "value");
          })
        : undefined;
      return jsonResult({ ...result, ...(properties ? { properties } : {}) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_asset_property",
  {
    title: "Change one setting inside a plain asset",
    description:
      "Writes one property on a Data Asset, Curve, Sound Class or any other asset that carries settings. This is the " +
      "change-request path for configuration that does not live in a Blueprint or a Data Table.\n\n" +
      "**Read it first with unreal_read_asset_properties.** That gives you the exact property name and the exact " +
      "spelling of its current value, and matching that spelling is the whole game: struct values are comma triples " +
      'like "0, -90, 0", enums take the entry name, and an object reference takes a full asset path. A value the ' +
      "engine cannot parse is rejected rather than silently written as None.\n\n" +
      "Nothing reaches disk until unreal_save_asset.",
    inputSchema: {
      path: z.string().describe('Asset path, e.g. "/Game/Data/DA_EnemyTuning.DA_EnemyTuning".'),
      property: z.string().describe("Exact property name, as unreal_read_asset_properties spells it."),
      value: engineValue.describe("The new value, spelled the way the current one is spelled."),
    },
  },
  async ({ path, property, value }) => {
    try {
      return jsonResult(await bridge.send("set_asset_property", { path, property, value }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_save_asset",
  {
    title: "Save any asset to disk",
    description:
      "Writes an asset to disk. Works on anything - Blueprints, structs, enums, materials, Data Tables. " +
      "**Call this after creating or editing a non-Blueprint asset.** Everything this server creates is live in " +
      "the editor immediately but stays unsaved until something writes it, and unsaved work is lost if the editor " +
      "crashes. Blueprint tools save for you; the rest do not, because saving after every field would be a disk " +
      "write per edit. " +
      "Checks the file out first if the project is under source control, and explains rather than failing with " +
      "'save_failed' if it cannot.",
    inputSchema: {
      path: z.string().describe('Full asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("save_asset", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_data_table",
  {
    title: "Create a Data Table",
    description:
      "Creates a Data Table backed by a struct. **This is how you make gameplay data-driven:** items, weapons, " +
      "enemy stats, dialogue lines and loot tables belong in rows, not in graph nodes. Adding item number two " +
      "hundred then becomes one row, and the Blueprint that reads the table never changes. " +
      "Make the row struct first with unreal_create_struct, then pass it here. " +
      "Returns the row's field names, so you can add rows immediately without looking them up.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Data/DT_Items".'),
      rowStruct: z
        .string()
        .describe('The struct that defines a row, e.g. "/Game/Data/S_Item" or a native row struct name.'),
    },
  },
  async ({ packagePath, rowStruct }) => {
    try {
      return jsonResult(await bridge.send("create_data_table", { packagePath, rowStruct }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_data_table_row",
  {
    title: "Add a row to a Data Table",
    description:
      "Adds one named row and sets its values by field name. " +
      "Every field name is checked before anything is written, so a typo refuses the row rather than leaving it " +
      "half filled - a half-filled row looks correct in the editor until the wrong value shows up in play. " +
      "The stored row is read back and returned, so you see what the engine actually kept rather than what you sent.",
    inputSchema: {
      path: z.string().describe('Data Table asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
      rowName: z.string().describe('The row key, e.g. "Potion". This is what Blueprints look up.'),
      values: z
        .record(engineValue)
        .optional()
        .describe('Field values by name, e.g. {"DisplayName":"Health Potion","Value":25}. Numbers and booleans are accepted.'),
    },
  },
  async ({ path, rowName, values }) => {
    try {
      return jsonResult(await bridge.send("add_data_table_row", { path, rowName, values }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_screenshot",
  {
    title: "Look at the viewport",
    description:
      "Captures whatever the editor's active viewport is showing and returns it as an image you can " +
      "actually see. Every other tool here answers in text, and there is a class of question text " +
      "cannot settle: did that enemy walk toward the player, did the widget land where it should, is " +
      "this material black. The logic can read correctly, the variables can hold the right defaults, " +
      "the graph can compile and review clean, and the only way to know is to look. " +
      "Works on the level editor viewport, and on a running Play In Editor session - start one with " +
      "unreal_start_pie first if you want to see the game rather than the editor. The reply says which " +
      "you got. " +
      "Downscaled to a 1280px long edge by default, because an image costs tokens by area and a native " +
      "frame would cost more context than every tool definition on this server combined. That is enough " +
      "to see whether something moved or where it is; it is not enough to judge a texture.",
    inputSchema: {
      maxLongEdge: z
        .number()
        .optional()
        .describe("Longest edge in pixels, clamped to [160, 2048]. Defaults to 1280. Raise it only when detail matters."),
    },
  },
  async ({ maxLongEdge }) => {
    try {
      const shot = await bridge.send<{
        path: string;
        width: number;
        height: number;
        sourceWidth: number;
        sourceHeight: number;
        bytes: number;
        isPlayInEditor: boolean;
      }>("take_screenshot", { maxLongEdge });

      let base64: string;
      try {
        base64 = readFileSync(shot.path).toString("base64");
      } catch (err) {
        // The bridge wrote it and this process cannot read it, which on a normal setup means the
        // editor is on another machine. Worth saying so plainly rather than failing as "ENOENT".
        return errorResult(
          new Error(
            `The bridge captured the viewport to ${shot.path}, but this server could not read that ` +
              `file (${err instanceof Error ? err.message : String(err)}). That happens when the editor ` +
              `and this server are not on the same filesystem; the capture itself succeeded.`
          )
        );
      }

      return {
        content: [
          { type: "image" as const, data: base64, mimeType: "image/png" },
          {
            type: "text" as const,
            text: JSON.stringify({
              showing: shot.isPlayInEditor ? "a running Play In Editor session" : "the level editor viewport",
              size: `${shot.width}x${shot.height}`,
              capturedFrom: `${shot.sourceWidth}x${shot.sourceHeight}`,
              bytes: shot.bytes,
              path: shot.path,
            }),
          },
        ],
      };
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_orphans",
  {
    title: "Find actors that lost the partner they depend on",
    description:
      "Levels are full of actors that only work in pairs: a nav link and the door it belongs to, a " +
      "trigger and the thing it triggers, a spawn point and its volume. Delete one half and the other " +
      "stays behind, still ticking, still handling events, pointing at nothing - and nothing warns, " +
      "because an actor with a null reference is a perfectly legal actor. " +
      "Pass two class-name fragments and it pairs each actor of the first to its nearest of the second " +
      "and reports the ones standing on their own, plus any partner nothing paired to, which is the " +
      "same mistake seen from the other side. " +
      "It pairs by POSITION rather than by reading the reference property, because the reference is " +
      "the thing that is broken: a null says nothing about what it should have pointed at. Two actors " +
      "placed together are still where they were placed. " +
      "The distance threshold is inferred from the level by looking for the gap between the cluster of " +
      "real pairs and anything standing clear of it, so it adapts to a level's own scale instead of " +
      "using a constant that is wrong everywhere. Pass maxDistance to override it.",
    inputSchema: {
      of: z.string().describe('Class-name fragment of the actor that may be orphaned, e.g. "BP_NavLink".'),
      pairedWith: z.string().describe('Class-name fragment of the partner it belongs to, e.g. "BP_Door".'),
      maxDistance: z
        .number()
        .optional()
        .describe("Units beyond which an actor counts as orphaned. Omit to infer it from the level."),
    },
  },
  async ({ of, pairedWith, maxDistance }) => {
    try {
      return jsonResult(withDisabledToolNote(await findOrphans(bridge, { of, pairedWith, maxDistance }), isToolEnabled));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_in_data_tables",
  {
    title: "Find a value in the project's Data Tables",
    description:
      "Search every Data Table's row names and cell values for a substring. Returns table, row and field " +
      "for each match - not the rows.\n\n" +
      "**The only tool that looks inside Data Table contents.** unreal_search_project indexes Blueprint " +
      "names, parents, functions and variables; rows and cell values are not in that index, so it returns " +
      "zero hits for a row name and does not say why. Use this when a change request names a thing rather " +
      "than an asset (\"the machine gun should cost 500\"). One read per table, so call it deliberately.",
    inputSchema: {
      /**
       * Ten tools call this `match`; four called it `query`.
       *
       * Found by using this server for a real feature and getting the name wrong here after having
       * just read three tools that spell it `match`. That is not carelessness, it is what a surface
       * teaches: the majority spelling is the one a caller types next.
       */
      query: z.string().optional().describe('Case-insensitive substring, matched against row names and cell values, e.g. "MachineGun".'),
      match: z.string().optional().describe("Same as `query`."),
      pathPrefix: z.string().optional().describe("Only search tables under this content path."),
      maxResults: z.number().optional().describe("Cap on hits. Defaults to 50, clamped to [1, 500]."),
    },
  },
  async ({ query: queryRaw, match, pathPrefix, maxResults }) => {
    const query = queryRaw ?? match;
    if (!query) {
      return errorResult(new Error("unreal_find_in_data_tables needs something to look for: pass `query` (or `match`). Nothing ran."));
    }
    try {
      return jsonResult(await findInDataTables(bridge, query, { pathPrefix, maxResults }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

/**
 * Save after a bridge write, and say whether it happened.
 *
 * The bridge commands added here deliberately do not save: SaveAssetPackage is file-local to
 * MCPCommandHandler.cpp and sharing it means prying a function out of a five-thousand-line file. The
 * composite belongs in this layer anyway - it keeps each bridge command doing one thing, and it makes
 * the save a visible field rather than an implied side effect.
 *
 * An unsaved rename looks correct for the rest of the session and reverts on the next editor restart,
 * which is the worst kind of failure: invisible now, total later.
 */
async function savedAfter<T extends object>(result: T, path: string, save?: boolean): Promise<T & { saved: boolean }> {
  if (save === false) return { ...result, saved: false };
  try {
    await bridge.send("save_asset", { path });
    return { ...result, saved: true };
  } catch (err) {
    return {
      ...result,
      saved: false,
      saveError: err instanceof Error ? err.message : String(err),
      warning:
        "The change was made but not written to disk, so it will revert when the editor restarts. " +
        "Call unreal_save_asset on this path.",
    } as T & { saved: boolean };
  }
}

register(
  "unreal_rename_component",
  {
    title: "Rename a component and the graph nodes that use it",
    description:
      "Renames a component a Blueprint declares. A component is reached from a graph through a member variable " +
      "of the same name, so this rebinds that variable too - setting the name any other way leaves every node " +
      "that used the component pointing at a name that is gone.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      component: z.string().describe('Current component name, e.g. "Sphere".'),
      newName: z.string().describe('New name, e.g. "InteractionRange".'),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true."),
    },
  },
  async ({ path, component, newName, save }) => {
    try {
      const result = await bridge.send<Record<string, unknown>>("rename_component", { path, component, newName });
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_component",
  {
    title: "Remove a component from a Blueprint",
    description:
      "Deletes a component a Blueprint declares. Any components attached under it are promoted to its parent " +
      "rather than deleted, and the number is reported - the editor does the same thing silently, which is how " +
      "a subtree disappears without anyone noticing.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      component: z.string().describe("The component to remove."),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true."),
    },
  },
  async ({ path, component, save }) => {
    try {
      const result = await bridge.send<Record<string, unknown>>("remove_component", { path, component });
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_function",
  {
    title: "Remove a Blueprint function",
    description:
      "Deletes a function graph. **Refuses while anything still calls it**, naming the graphs and the call " +
      "count, because removing it leaves those calls broken - the same rule unreal_remove_variable and " +
      "unreal_delete_asset apply. Pass force:true when that is what you mean.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      functionName: z.string().optional().describe("The function to remove. An event is not a function; use unreal_remove_node for those."),
      name: z.string().optional(),
      force: z.boolean().optional().describe("Remove it even though calls remain, leaving them broken. Off by default."),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true."),
    },
  },
  async ({ path, functionName, name, force, save }) => {
    try {
      const wanted = functionName ?? name;
      if (!wanted) {
        return errorResult(
          new Error("unreal_remove_function needs a function name: pass `functionName` (or `name`).")
        );
      }
      const result = await bridge.send<Record<string, unknown>>("remove_function", {
        path,
        functionName: wanted,
        force,
      });
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_rename_function",
  {
    title: "Rename a function or macro, and keep its RepNotify binding",
    description:
      "Renames a function or macro graph. Callers are rebound by the editor, and - the part that matters - any " +
      "variable whose RepNotify handler was this function is rebound too.\n\n" +
      "**A RepNotify handler is bound by NAME.** The variable stores the handler as a string with no link to the " +
      "graph, so renaming the graph alone leaves it pointing at a function that no longer exists. Nothing errors; " +
      "the handler just stops firing, on clients only - the most expensive shape of bug there is, and an easy one " +
      "to create while tidying a name. This does both halves and reports how many bindings moved.\n\n" +
      "Names are matched EXACTLY, including whitespace, because the names this is most often needed for are the " +
      "ones with a stray space (see the name-has-stray-whitespace finding) - pass the space if it has one. Event " +
      "graphs are refused: \"EventGraph\" is not a function.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      functionName: z
        .string()
        .describe('Current name, exactly as it is - e.g. "OnRep_VacuumDragged " with its trailing space.'),
      newName: z.string().describe('New name, e.g. "OnRep_VacuumDragged".'),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true; an unsaved rename reverts on restart."),
    },
  },
  async ({ path, functionName, newName, save }) => {
    try {
      const result = await bridge.send<Record<string, unknown>>("rename_function", { path, functionName, newName });
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_rename_variable",
  {
    title: "Rename a Blueprint variable everywhere it is used",
    description:
      "Renames a variable a Blueprint declares, rebinding every GET and SET node that reads it, in every graph.\n\n" +
      "**This is the only safe way to rename one.** Editing the descriptor by hand leaves every node bound to a " +
      "name that no longer exists: the Blueprint stops compiling and the damage is spread across graphs nobody " +
      "was looking at. Reports how many nodes were updated and which graphs they were in.\n\n" +
      "Only variables the Blueprint itself declares. One inherited from a C++ parent has to change in the parent.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      variableName: z.string().describe('Current name, e.g. "FireRate".'),
      newName: z.string().describe('New name, e.g. "RateOfFire".'),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true; an unsaved rename reverts on restart."),
    },
  },
  async ({ path, variableName, newName, save }) => {
    try {
      const result = await bridge.send<Record<string, unknown>>("rename_variable", { path, variableName, newName });
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_variable",
  {
    title: "Remove a Blueprint variable",
    description:
      "Deletes a variable a Blueprint declares. **Refuses while any graph node still reads or writes it**, " +
      "naming the graphs and the node count, because removing it takes those nodes with it - the same rule " +
      "unreal_delete_asset applies to an asset something still references, and for the same reason: the damage " +
      "lands in graphs you are not looking at.\n\n" +
      "Pass force:true when deleting the nodes is what you actually mean. Only variables the Blueprint itself " +
      "declares; an inherited one has to change in the parent class.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      variableName: z.string().describe("The variable to remove."),
      force: z.boolean().optional().describe("Remove it even though nodes still use it, deleting those nodes. Off by default."),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true."),
    },
  },
  async ({ path, variableName, force, save }) => {
    try {
      const result = await bridge.send<Record<string, unknown>>("remove_variable", { path, variableName, force });
      return jsonResult(await savedAfter(result, path, save));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_rename_asset",
  {
    title: "Rename or move an asset, fixing every reference to it",
    description:
      "Renames an asset, moves it to another folder, or both - through the editor's asset tools, so every " +
      "Blueprint, Data Table and level that referred to the old path is updated to the new one.\n\n" +
      "**Do not rename by any other means.** Moving the .uasset yourself leaves every reference pointing at a " +
      "path that no longer exists, which looks like it worked until the next time anything loads. This is also " +
      "how you move an asset: give `newFolder` alone to move without renaming.\n\n" +
      "Saves afterwards, because a rename that fixed every reference and was never written to disk reverts on " +
      "the next editor restart. Refuses if the destination name is already taken rather than silently suffixing it.",
    inputSchema: {
      path: z.string().describe('The asset to rename, e.g. "/Game/Upgrades/BP_DamageUpgrade".'),
      newName: z.string().optional().describe('New asset name without any path, e.g. "BP_FireRateUpgrade". Omit to keep the name and only move.'),
      newFolder: z.string().optional().describe('New folder, e.g. "/Game/Upgrades/Weapons". Omit to keep it where it is.'),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true; an unsaved rename reverts on restart."),
    },
  },
  async ({ path, newName, newFolder, save }) => {
    try {
      const result = (await bridge.send("rename_asset", { path, newName, newFolder })) as { path?: string };
      // Composed here rather than in the bridge: see the note in MCPAssetOps.cpp. It keeps the bridge
      // command doing one thing and makes the save visible in the reply instead of implied.
      let saved = false;
      let saveError: string | undefined;
      if (save !== false && typeof result.path === "string") {
        try {
          await bridge.send("save_asset", { path: result.path });
          saved = true;
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
        }
      }
      return jsonResult({
        ...result,
        saved,
        ...(saveError ? { saveError, warning: "The rename happened but the save did not, so it will revert on restart. Call unreal_save_asset on the new path." } : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_duplicate_asset",
  {
    title: "Copy an asset",
    description:
      "Copies an asset to a new name, in the same folder unless you name another. This is how you start " +
      "\"one more like that one\" - a second upgrade from the one that works, a variant enemy, a Data Table " +
      "shaped like an existing one.\n\n" +
      "Prefer it to building a near-identical asset from scratch: the copy inherits the parent class, the " +
      "components, the variables and their defaults, so what is left is the part that actually differs. " +
      "unreal_plan_feature will tell you which existing asset is the one to copy.\n\n" +
      "Saves afterwards. Refuses if the name is already taken rather than silently suffixing it.",
    inputSchema: {
      path: z.string().describe('The asset to copy, e.g. "/Game/Upgrades/BP_DamageUpgrade".'),
      newName: z.string().describe('Name for the copy, without any path, e.g. "BP_FireRateUpgrade".'),
      newFolder: z.string().optional().describe("Folder for the copy. Defaults to the original's folder."),
      save: z.boolean().optional().describe("Save afterwards. Defaults to true."),
    },
  },
  async ({ path, newName, newFolder, save }) => {
    try {
      const result = (await bridge.send("duplicate_asset", { path, newName, newFolder })) as { path?: string };
      let saved = false;
      let saveError: string | undefined;
      if (save !== false && typeof result.path === "string") {
        try {
          await bridge.send("save_asset", { path: result.path });
          saved = true;
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
        }
      }
      return jsonResult({
        ...result,
        saved,
        ...(saveError ? { saveError, warning: "The copy exists but was not saved, so it will be gone on restart. Call unreal_save_asset on it." } : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_check_data_tables",
  {
    title: "Find Data Table rows that point at nothing",
    description:
      "Scans Data Tables for asset-reference fields that are empty in some rows and filled in others. " +
      "This is a silent, expensive class of bug and no other check here can see it: every other audit in " +
      "this server reads Blueprint graphs, and a cleared reference is not in a graph, it is in data. " +
      "The engine resolves an empty reference to null, whatever consumes it does nothing, and no error " +
      "is raised anywhere - a spawner fed a null class simply spawns no actor. The row looks correct in " +
      "the editor too, because it has a name and its other fields, with one empty box among them. " +
      "Written after a shipped build lost most of its enemy spawns to exactly this. " +
      "A field is judged to be a reference when some row fills it with an asset path, so a table with " +
      "one broken row carries the evidence to convict itself; ordinary text that happens to read " +
      "\"None\" is never flagged, because nothing in that field ever looks like a path. Fields empty in " +
      "every row are reported as undecidable rather than passed, since there is no filled row to prove " +
      "what they should hold.",
    inputSchema: {
      paths: z
        .array(z.string())
        .optional()
        .describe("Specific Data Tables to check. Defaults to every Data Table under pathPrefix."),
      pathPrefix: z.string().optional().describe('Restrict the search, e.g. "/Game/Data". Defaults to /Game.'),
      limit: z.number().optional().describe("Maximum tables to scan. Defaults to 200."),
    },
  },
  async ({ paths, pathPrefix, limit }) => {
    try {
      return jsonResult(withDisabledToolNote(await auditDataTables(bridge, { paths, pathPrefix, limit }), isToolEnabled));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_data_table_row",
  {
    title: "Delete a Data Table row",
    description:
      "Removes one row by name and hands back everything it contained, so the delete can be undone. " +
      "Reach for this when something should stop existing rather than stop appearing. " +
      "The workaround people use instead - clearing the row's asset reference - is not a removal: the " +
      "row survives, still passes whatever gate the consumer applies, and now contributes a null. That " +
      "exact mistake put a shipped build in front of players with most of its enemy spawns silently " +
      "failing, so if the intent is only to disable something temporarily, change the field that gates " +
      "it (a minimum level, a ratio, an enabled flag) and leave its references intact. " +
      "The `was` field in the reply holds every value the row had, so unreal_add_data_table_row can " +
      "restore it exactly. Anything that looked the row up by name will find nothing afterwards - " +
      "unreal_find_references on the table before saving is the cheap way to be sure.",
    inputSchema: {
      path: z.string().describe('Data Table asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
      rowName: z.string().describe('The row key to delete, e.g. "Potion".'),
    },
  },
  async ({ path, rowName }) => {
    try {
      return jsonResult(await bridge.send("remove_data_table_row", { path, rowName }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_data_table_row",
  {
    title: "Change fields on a Data Table row that already exists",
    description:
      "Edits a row in place. `unreal_add_data_table_row` deliberately refuses when the row is already " +
      "there, which is right for creation and left no way to CHANGE one - so a table could be read " +
      "through this server and not repaired through it.\n\n" +
      "Partial by design: only the fields you name are touched. The common case is exactly one wrong " +
      "field in an otherwise correct row, and resending every field to fix one is an opportunity to get " +
      "the other five wrong.\n\n" +
      "The reply reports `before` and `after` for each field it changed, so the edit can be checked " +
      "rather than taken on trust, and a value the engine coerced or rejected is visible instead of " +
      "being echoed back as though it had been stored. The row is left dirty in memory - call " +
      "unreal_save_asset, or nothing reaches a packaged build.",
    inputSchema: {
      path: z.string().describe('Data Table asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
      rowName: z.string().describe('The existing row key to change, e.g. "Potion".'),
      values: z
        .record(engineValue)
        .describe('Only the fields to change, by name, e.g. {"Value":"30"}. Others are left alone.'),
    },
  },
  async ({ path, rowName, values }) => {
    try {
      // Refuse a marker rather than writing it into the table.
      //
      // unreal_list_data_table_rows replaces struct values that repeat across a reply with markers
      // like `@1@` and gives the text in a `repeated` legend. That is lossless to READ and a trap to
      // copy: a model that pastes a row back would write the two characters "@1@" into an
      // FSlateBrush column, and the engine would take it. Cheaper to refuse here, once, and say
      // exactly what to do, than to leave a corrupted table behind a successful-looking call.
      const withMarkers = Object.entries(values ?? {}).filter(
        ([, v]) => typeof v === "string" && MARKER_PATTERN.test(v)
      );
      if (withMarkers.length > 0) {
        throw new Error(
          `Refusing to write ${withMarkers.length} value(s) containing a placeholder from a ` +
            `unreal_list_data_table_rows reply: ${withMarkers.map(([k]) => k).join(", ")}. ` +
            `Markers like @1@ stand for a repeated struct that was written once in that reply's ` +
            `\`repeated\` legend, to keep the read cheap. Substitute the legend text for the marker ` +
            `and call again - writing the marker itself would put "@1@" in the column.`
        );
      }
      return jsonResult(await bridge.send("set_data_table_row", { path, rowName, values }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_data_table_rows",
  {
    title: "Read the rows of a Data Table",
    description:
      "Lists rows with their values. Paged deliberately: a Data Table is the one asset designed to get large, and " +
      "returning nine hundred rows of item data would cost more context than the question that needed them. " +
      "Defaults to 25 rows and tells you the total and the next offset.\n\n" +
      "**A field that is absent is at the row struct's default**, the same convention unreal_list_variables uses. " +
      "Unreal exports a row in full - one untouched FSlateBrush column is 900 characters of ImageSize, Margin and " +
      "OutlineSettings - so on a real nine-row table that was 26,993 characters, of which 20,000 were fields nobody " +
      "had set. Pass `full: true` when you need to see an empty field rather than infer it, and read the columns " +
      "themselves with unreal_list_struct_fields on the row struct.",
    inputSchema: {
      path: z.string().describe('Data Table asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
      limit: z.number().optional().describe("Rows to return. Defaults to 25, capped at 500."),
      offset: z.number().optional().describe("Rows to skip, for paging through a large table."),
      rowName: z
        .string()
        .optional()
        .describe(
          'One row, by name - e.g. "WeaponDmg". The row comes back in full, including fields at their ' +
            "default, because somebody asking for one row by name is usually about to change it. Case " +
            "insensitive, and a name that matches nothing lists the ones that exist."
        ),
      fields: z
        .array(z.string())
        .optional()
        .describe(
          'Return only these columns from each row, e.g. ["Cost"]. A view, not a filter - it changes what ' +
            "each row carries, not which rows come back. Names that match nothing are reported rather than " +
            "silently dropped. This is how you ask a question about one column across a whole table without " +
            "paying for every other column."
        ),
      full: z
        .boolean()
        .optional()
        .describe(
          "Return every field of every row, including the ones still at the row struct's default. Off by " +
            "default: on a real table those are most of the reply, and a field that is absent is at its default. " +
            "Turn it on when you need to see a field that is empty rather than infer it."
        ),
    },
  },
  async ({ path, limit, offset, full, rowName, fields }) => {
    try {
      // Asking for one row by name is a different job from listing a table, and it was not possible:
      // the only read was paged, so "what is WeaponDmg's price" meant 7,040 tokens of paging to find
      // one row. There is no bridge command for it, and there does not need to be - the filter is
      // free here, and this works against a plugin that predates this change.
      //
      // Two things follow from it being a TARGETED read, both the rule established for
      // read_class_defaults: fetch past the default page so the row cannot be missed by paging, and
      // return it in full, because whoever asked by name is usually about to change it and a field
      // omitted for being at its default is the field they are asking about.
      const wantedRow = (rowName ?? "").trim();
      const table = (await bridge.send("list_data_table_rows", {
        path,
        limit: wantedRow ? 5000 : limit,
        offset: wantedRow ? 0 : offset,
        omitDefaults: wantedRow ? false : full !== true,
      })) as { rows?: Array<{ rowName?: string; values?: Record<string, unknown> }>; rowCount?: number };

      // Unreal writes every float with six decimal places, and a Data Table is where that costs
      // most: DT_UniversalActions is nine rows of nested CommonUI structs, and the padding alone is
      // 20% of the reply. Trimmed here rather than in the bridge, because the bridge stays faithful
      // and the tool layer is where compaction belongs - and because a trimmed value still parses,
      // so it can be handed straight back to set_data_table_row.
      if (Array.isArray(table.rows)) {
        table.rows = table.rows.map((row) =>
          row && typeof row === "object" && row.values ? { ...row, values: trimFloatPaddingIn(row.values) } : row
        );
      }

      // One column across the whole table, rather than every column.
      //
      // The change-request question is usually about a single field - "what does everything cost",
      // "which rows have no UpgradeClass" - and answering it meant pulling every field of every row.
      // On DT_UniversalActions that is 5,458 tokens to read nine rows, almost all of it four nested
      // CommonUI struct literals nobody asked about.
      //
      // Same semantics and the same words as list_blueprints' `fields`, because two tools with a
      // parameter of the same name that behaved differently would be worse than one tool not having
      // it: a view rather than a filter, and a name matching nothing is reported rather than
      // silently dropped.
      let unknownFields: string[] = [];
      if (Array.isArray(fields) && fields.length > 0 && Array.isArray(table.rows)) {
        const picked = pickFields(
          table.rows.map((row) => (row && typeof row === "object" ? (row.values ?? {}) : {})),
          fields
        );
        unknownFields = picked.unknown;
        table.rows = table.rows.map((row, i) => ({ ...row, values: picked.rows[i] }));
      }

      if (wantedRow) {
        const rows = Array.isArray(table.rows) ? table.rows : [];
        const found = rows.filter((r) => String(r.rowName ?? "").toLowerCase() === wantedRow.toLowerCase());
        if (found.length === 0) {
          const names = rows.map((r) => String(r.rowName ?? "")).filter(Boolean);
          return jsonResult({
            path,
            error: "row_not_found",
            detail:
              `No row called "${wantedRow}" in this table. Row names are case insensitive here but exact ` +
              `otherwise - no partial matching.`,
            // The names, not a count. "12 rows exist" tells a caller nothing they can act on, and the
            // whole reason they are here is that they do not know what the row is called.
            ...(names.length > 0 && names.length <= 60 ? { rowNames: names } : {}),
            ...(names.length > 60 ? { rowCount: names.length, next: "Too many rows to list; page with limit and offset." } : {}),
          });
        }
        return jsonResult({ ...table, rows: found, rowCount: table.rowCount ?? rows.length, matched: wantedRow });
      }

      // The read where row COUNT says nothing about cost, which is why this hint is keyed on the
      // size of the reply rather than on how many rows came back like every other hint here.
      // Otherwise it stays silent on exactly the table that needed it: DT_UniversalActions is nine
      // rows, and it was the most expensive read in the whole surface at 5,472 tokens because a
      // single untouched FSlateBrush column exports as 900 characters. It is 1,723 now - the same
      // brush appeared 28 times and is written once - so it is no longer the largest, but the shape
      // of the problem has not changed and a table with 900 unique rows would still find it.
      //
      // `limit: 1` is the lever that works today: one row shows every column and its shape for a
      // fraction of the whole table, which is what "what is in this table" usually means.
      const rowCount = Array.isArray(table.rows) ? table.rows.length : 0;

      // Collapse struct values that repeat across the reply. Lossless: each one is written out once
      // in `repeated` and replaced by a marker, so substituting the legend gives exactly what the
      // engine exported. On DT_UniversalActions a single empty FSlateBrush appears 28 times and is
      // 67% of the reply. See dedupeStructs.ts for the marker-collision and round-trip handling.
      const deduped = dedupeRepeatedStructs(
        table,
        (t) =>
          (t.rows ?? []).flatMap((row) =>
            Object.values(row.values ?? {}).map((v) => (typeof v === "string" ? v : ""))
          ),
        (t, cells) => {
          let at = 0;
          const rows = (t.rows ?? []).map((row) => ({
            ...row,
            values: Object.fromEntries(
              Object.entries(row.values ?? {}).map(([k, v]) => [k, typeof v === "string" ? cells[at++] : (at++, v)])
            ),
          }));
          return { ...t, rows };
        }
      );
      Object.assign(table, deduped.rows);
      const repeatedNote = deduped.repeated
        ? { repeated: deduped.repeated, repeatedNote: deduped.repeatedNote }
        : {};

      const size = JSON.stringify(table).length;
      const HEAVY_REPLY_CHARS = 8000;
      // A requested column that does not exist must not come back as empty rows. Asking for "Cost" on
      // a table whose column is "Price" would otherwise answer with every row present and nothing in
      // any of them, which reads as "no row has a cost" rather than "there is no such column".
      const unknownNote =
        unknownFields.length > 0
          ? {
              unknownFields,
              unknownFieldsNote:
                `${unknownFields.length} requested column(s) do not exist on this row struct: ` +
                `${unknownFields.join(", ")}. The rows below are missing them because there is nothing ` +
                `to show, not because the values are empty. unreal_list_struct_fields on the row struct ` +
                `lists the real column names.`,
            }
          : {};

      return jsonResult(
        size >= HEAVY_REPLY_CHARS && rowCount > 1
          ? {
              ...table,
              ...unknownNote,
              ...repeatedNote,
              cheaper:
                `These rows are large (~${Math.round(size / 4)} tokens for ${rowCount} rows). ` +
                `\`fields: ["ColumnName"]\` answers a question about one column across every row, ` +
                `\`limit: 1\` shows every column and its shape, and unreal_list_struct_fields on the ` +
                `row struct lists the columns without any row data.`,
            }
          : { ...table, ...unknownNote, ...repeatedNote }
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_struct",
  {
    title: "Create a Blueprint Struct",
    description:
      "Creates a user-defined Struct with typed fields in one call. This is the refactor that stops a project " +
      "accreting loose variables: six variables called ItemName, ItemIcon, ItemCount, ItemWeight, ItemStackable, " +
      "ItemRarity are one S_ItemData struct, and every function that passes them around gets one pin instead of " +
      "six.\n\n" +
      "Use the struct afterwards by passing type \"struct:<Name>\" to unreal_add_variable, unreal_create_function's " +
      "inputs/outputs, or unreal_create_struct's own fields (structs can nest). Break it apart in a graph with a " +
      "Break node, found via unreal_find_node.\n\n" +
      "Every field type is validated BEFORE the asset is created, so a typo in the fifth field fails the call " +
      "cleanly instead of leaving a half-built struct in the project.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Data/S_ItemData". Prefix struct assets with S_ by convention.'),
      fields: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe(
          'Fields in order, e.g. [{"name":"DisplayName","type":"text"},{"name":"Icon","type":"object:Texture2D"},' +
            '{"name":"Rarity","type":"enum:E_Rarity"}]. Same type descriptors as unreal_add_variable.'
        ),
    },
  },
  async ({ packagePath, fields }) => {
    try {
      const result = await bridge.send("create_struct", { packagePath, fields: normaliseFieldTypes(fields) });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_struct_field",
  {
    title: "Add a field to an existing Struct",
    description:
      "Appends one typed field to a user-defined Struct and returns the full field list afterwards. Adding a field " +
      "to a struct already in use is safe: existing pins keep their values and gain the new one at its default. " +
      "Native engine structs (Vector, Transform, HitResult) are defined in C++ and cannot be edited; the error " +
      "says so rather than failing obscurely.",
    inputSchema: {
      path: z.string().describe('Struct asset: a short name like "S_ItemData" or a full path like "/Game/Data/S_ItemData".'),
      name: z.string().describe('Field name, e.g. "MaxStackSize".'),
      type: z.string().describe('Field type, e.g. "int", "text", "object:Texture2D", "struct:S_Other", "enum:E_Rarity".'),
    },
  },
  async ({ path, name, type }) => {
    try {
      const result = await bridge.send("add_struct_field", { path, name, type: normaliseEngineType(type) });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err, typeHint(type));
    }
  }
);

register(
  "unreal_list_struct_fields",
  {
    title: "Read a Struct's fields",
    description:
      "Returns a struct's fields in order with each one's name, type, sub-type, array-ness, and default value. " +
      "Call this before writing graph logic that breaks a struct apart, so pin names are read rather than guessed.",
    inputSchema: {
      path: z.string().describe('Struct asset: short name or full path.'),
    },
  },
  async ({ path }) => {
    try {
      const result = (await bridge.send("list_struct_fields", { path })) as { fields?: Record<string, unknown>[] };
      // Same compaction as a variable list, and for the same reason: a field read here should be a
      // field add_struct_field accepts. This reply was going out completely raw.
      return jsonResult({
        ...result,
        // Same safe form: not an array means nothing to compact, and passing the bridge's own value
        // through is correct. See the note on read_class_defaults.
        ...(Array.isArray(result.fields) ? { fields: result.fields.map(compactStructField) } : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_variable_type",
  {
    title: "Change a variable's type",
    description:
      "Retypes an existing member variable, rebinding it through the engine so every Get and Set node moves with " +
      "it. Something a person does constantly in the editor and this server could not do at all: the only way to " +
      "change a type was to remove the variable and add it back, which breaks every node that read it.\n\n" +
      "Reach for it when a variable is the wrong type rather than the wrong name - a map with no value type, an " +
      "int that should be a float, a string that should be an enum. Takes the same type descriptors as " +
      "unreal_add_variable, containers included.\n\n" +
      "A retype BREAKS connections that no longer typecheck, and the engine reports those from the compiler " +
      "rather than from this call, so it compiles for you and returns what the compiler said. Inherited variables " +
      "are refused: retype them where they are declared.\n\n" +
      "SLOW, and occasionally worse, on a variable a FUNCTION SIGNATURE uses. Retyping one that a function takes " +
      "as a parameter made an editor stop answering entirely - every later call timed out, including ping - and it " +
      "had to be closed and reopened. Nothing was lost, because nothing had been saved. Save first, expect this " +
      "one to take a while, and if the bridge goes quiet afterwards that is what happened.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      variableName: z.string().describe("The variable to retype. Must be declared on this Blueprint, not inherited."),
      type: z
        .string()
        .describe('The new type, same descriptors as unreal_add_variable: "float", "object:Actor", "name[]", "map<string,int>".'),
      compile: z.boolean().optional().describe("Compile afterwards and report what broke. Default true."),
    },
  },
  async ({ path, variableName, type, compile }) => {
    try {
      const result = (await bridge.send("set_variable_type", {
        path,
        variableName,
        type: normaliseEngineType(type),
      })) as Record<string, unknown>;
      // Compiled here rather than left to the caller, because a retype's damage shows up only at
      // compile time: pins that no longer typecheck are silently broken until something asks.
      if (compile === false) return jsonResult(result);
      const compiled = (await bridge.send("compile_blueprint", { path })) as Record<string, unknown>;
      return jsonResult({ ...result, compiled });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_pie_actors",
  {
    title: "Where things are in the running game",
    description:
      "Lists matching actors in every running Play-In-Editor world with their position and net role, and whether " +
      "each is locally controlled. The editor-world reads answer what a level contains; this answers where things " +
      "actually are right now, which is what you need before moving anything or working out why an ability found " +
      "no target.",
    inputSchema: {
      actorClass: z.string().describe('Blueprint name without _C, e.g. "BP_Player". Derived classes match. Use "Actor" to list everything.'),
      world: z.string().optional().describe('Narrow to one world - "Authority" or "Client0", as unreal_watch_runtime labels them.'),
    },
  },
  async ({ actorClass, world }) => {
    try {
      return jsonResult(await bridge.send("pie_actors", { actorClass, world }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_teleport_actor",
  {
    title: "Move something in the running game",
    description:
      "Teleports matching actors to a position while the game is running. This is what makes a two-player " +
      "interaction testable at all: players spawn at different PlayerStarts, so an ability that needs a target in " +
      "range finds none, and every value stays at its default while proving nothing.\n\n" +
      "Read positions with unreal_pie_actors first and offset from one - teleporting somewhere unseen is how an " +
      "actor ends up inside geometry. It uses TeleportTo, which refuses a destination the actor cannot fit in and " +
      "says so rather than wedging it in a wall.\n\n" +
      "It moves the actor in EVERY world it exists in unless you narrow it. A pawn has a copy per world, and " +
      "moving only the server's leaves the client's behind - which looks exactly like the desync you were probably " +
      "investigating.",
    inputSchema: {
      actorClass: z.string().describe('Blueprint name without _C, e.g. "BP_Player".'),
      x: z.number().describe("Destination X."),
      y: z.number().describe("Destination Y."),
      z: z.number().describe("Destination Z. Give it some height - arriving inside the floor is a refused teleport."),
      world: z.string().optional().describe('Only move the copy in this world - "Authority" or "Client0".'),
      name: z.string().optional().describe('Only move the actor with this exact instance name, e.g. "BP_Player_C_1", from unreal_pie_actors.'),
      yaw: z
        .number()
        .optional()
        .describe(
          "Which way to face, in degrees. Sets the CONTROL rotation on a possessed pawn, not just the mesh - " +
            "an aimed ability tests the camera, so turning the body alone still misses. Aim at something with " +
            "atan2(targetY - y, targetX - x) in degrees."
        ),
      pitch: z.number().optional().describe("Look up or down, in degrees. Negative looks down."),
    },
  },
  async ({ actorClass, x, y, z: zPos, world, name, yaw, pitch }) => {
    try {
      return jsonResult(await bridge.send("teleport_actor", { actorClass, x, y, z: zPos, world, name, yaw, pitch }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_press_input",
  {
    title: "Press something in the running game",
    description:
      "Injects an Enhanced Input action into a running Play-In-Editor session, optionally held for a number of " +
      "seconds. This is how a change to gameplay gets EXERCISED rather than reasoned about: read a variable while " +
      "nothing is happening and every value agrees, because nothing is happening.\n\n" +
      "The action passes the modifiers and triggers a real key " +
      "press would - what the game sees is what a player would produce, not a synthetic key that skips the " +
      "mapping context.\n\n" +
      "Pair it with unreal_watch_runtime: start watching, press, read.\n\n" +
      "**Holds STACK.** A second action joins the first rather than replacing it, which is what a second finger " +
      "does - so aim-then-fire, sprint-then-jump and aim-then-vacuum are testable. That matters more than it " +
      "sounds: an ability gated on another input being down could not be exercised at all while one hold " +
      "replaced the last, and it failed silently, looking exactly like an ability that does not work. Each hold " +
      "is capped at 30 seconds, so nothing can be left down forever.\n\n" +
      "`release` with an inputAction lets go of that one; `release` without one lets go of everything.",
    inputSchema: {
      inputAction: z.string().describe('The InputAction, e.g. "IA_Vacuum" or a full path. Find them with unreal_list_assets className=InputAction.'),
      seconds: z.number().optional().describe("Hold it this long. Omit for a single frame - a tap. Capped at 30."),
      value: z.number().optional().describe("Magnitude. Default 1. For an Axis action this is how far; for a Boolean anything non-zero is pressed."),
      world: z.string().optional().describe('Which running world to press in - "Authority" or "Client0", as unreal_watch_runtime labels them. Omit for all of them.'),
      release: z
        .boolean()
        .optional()
        .describe(
          "Let go instead of pressing. With inputAction, releases just that one and leaves the rest held; " +
            "without it, releases everything."
        ),
    },
  },
  async ({ inputAction, seconds, value, world, release }) => {
    try {
      // With an action named, "stop" means that one; without, it means all of them. The bridge
      // reads the same two shapes, so the distinction is made once, here.
      if (release) return jsonResult(await bridge.send("press_input", { action: "stop", inputAction }));
      return jsonResult(await bridge.send("press_input", { inputAction, seconds, value, world }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_verify_runtime",
  {
    title: "Prove it works by running it",
    description:
      "Runs the game, samples the values you name while it plays, and says whether every running world agrees. " +
      "One call instead of the five it takes to do this by hand - start PIE, start watching, let real time pass, " +
      "read, stop - which is a sequence easy to skip, and skipping it is how a change gets reported as fixed " +
      "when it only compiled.\n\n" +
      "Reach for it after any change to logic that runs: compiling proves the graph is well-formed and nothing " +
      "else. The verdict names the failure shapes worth knowing - a value that DIFFERS between Authority and a " +
      "client is a replication bug, and one that NEVER CHANGED for the whole session usually means nothing wrote " +
      "it, which is what an orphaned event looks like from the outside.\n\n" +
      "Leaves the editor as it found it: a PIE session you already had open is left running, one this started is " +
      "stopped again.\n\n" +
      "When a press moves NOTHING it also names the gates between that input and the effect " +
      "(`whyNothingHappened`): the first one that is false is what stopped it.",
    inputSchema: {
      watch: z
        .array(z.string())
        .describe('Values to sample, as "ClassName.PropertyName" - e.g. ["BP_Player.PlayerName"]. The class is the Blueprint name without _C, and derived classes match too.'),
      seconds: z
        .number()
        .optional()
        .describe("How long to let the game run while sampling. Default 20. Sampling happens on the editor tick, so this has to be real time."),
      press: z
        .object({
          inputAction: z.string().describe('The InputAction to hold, e.g. "IA_Vacuum".'),
          seconds: z.number().optional().describe("How long to hold it. Default 5."),
          world: z.string().optional().describe('Which world to press in - "Authority" or "Client0". Omit for all.'),
        })
        .optional()
        .describe(
          "Hold an input while sampling. Without this the game runs untouched, and a value that only " +
            "moves while an ability is in use will read as unchanged - which is exactly how a fix gets " +
            "reported as working when it is not."
        ),
    },
  },
  async ({ watch, seconds, press }) => {
    try {
      const runFor = Math.max(3, Math.min(120, seconds ?? 20));
      const before = (await bridge.send("pie_status", {})) as { running?: boolean };
      const startedItHere = before.running !== true;
      if (startedItHere) {
        await bridge.send("start_pie", {});
        // PIE begins on the next editor tick and a big map takes longer than that to be worth
        // sampling. Waiting here rather than making the caller guess.
        await new Promise((resolve) => setTimeout(resolve, 12_000));
      }
      await bridge.send("watch_runtime", { action: "start", watch, intervalMs: 500, maxSamples: 200 });
      // Sampling starts before the press, so the reply contains the value both before and during -
      // which is what makes "changed" mean anything.
      if (press) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await bridge
          .send("press_input", { inputAction: press.inputAction, seconds: press.seconds ?? 5, world: press.world })
          .catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, runFor * 1000));
      const sampled = (await bridge.send("watch_runtime", { action: "read" })) as { watched?: unknown[] };
      await bridge.send("watch_runtime", { action: "stop" }).catch(() => {});
      if (startedItHere) await bridge.send("stop_pie", {}).catch(() => {});

      const rows = Array.isArray(sampled.watched) ? (sampled.watched as never[]) : [];
      const summary = summariseRuntime(rows, press?.inputAction);

      // If a press moved nothing, say WHERE it stopped instead of shrugging.
      //
      // The old verdict ended at "either it is not reaching the game, or the thing it triggers
      // needs something that is not there" - true, and it leaves the caller to open the graph and
      // walk branches by hand. That hand-walk happened three times in one session on one ability.
      // Every step of it is mechanical, so it is done here, and only here: on the failure path,
      // where the caller is otherwise stuck. A run where everything moved pays nothing for this.
      let gateNote: string | undefined;
      const nothingMoved = press && (summary.agreement ?? []).length > 0 && (summary.agreement ?? []).every((a) => !a.moved);
      if (nothingMoved) {
        try {
          // The Blueprint to look in comes from what was being watched: "BP_Player.Energy" is a
          // statement about where the caller expected the effect, which is where the chain runs.
          const owner = (watch[0] ?? "").split(".")[0];
          const found = (await bridge.send<{ hits?: Array<{ path: string; kind: string; name: string }> }>(
            "search_project",
            { query: owner }
          )).hits?.find((h) => h.kind === "blueprint" && h.name === owner);
          if (found) {
            // read_blueprint_graph_summary and read_blueprint_node_detail: the BRIDGE commands.
            // explain_graph and read_node_detail are composed here in the server, so sending those
            // names to the bridge throws unknown_cmd - which the catch below swallowed, leaving the
            // diagnostic silently absent. The failure looked exactly like "no gates found".
            const summary = await bridge.send("read_blueprint_graph_summary", {
              path: found.path,
              graphName: "EventGraph",
            });
            const explained = explainGraph(summary as never);
            const entry = explained.chains
              .map((chain) => [chain.entry, chain.entryId] as const)
              .find(([name]) => name.includes(press.inputAction));
            if (entry && entry[1]) {
              // Read outward from the input node, following exec links, until the walk runs out.
              // Capped: this is a diagnostic on a failure, not a licence to read a whole graph.
              const nodes = new Map<string, { id: string; type: string; title?: string; pins?: never }>();
              const queue = [entry[1]];
              // Read the input chain first. The walk then says where it ran out, and that is read
              // next - so the reads follow the CHAIN rather than the graph.
              //
              // Reading a large arbitrary slice was tried first and still stopped one node short,
              // reporting ONE gate on a chain with two. That is worse than reporting none: the gate
              // it named was true, so the answer exonerated the thing that was actually stopping it.
              for (let i = 0; i < 120 && queue.length > 0; i++) {
                const id = queue.shift() as string;
                if (nodes.has(id)) continue;
                const detail = await bridge.send<{ id: string; type: string; title?: string; pins?: Array<{ linkedTo?: Array<{ node: string }> }> }>(
                  "read_blueprint_node_detail",
                  { path: found.path, graphName: "EventGraph", nodeId: id }
                );
                nodes.set(id, detail as never);
                for (const pin of detail.pins ?? []) {
                  for (const link of pin.linkedTo ?? []) queue.push(link.node);
                }
              }
              // Every entry point in the graph by name, so a CALL to a custom event can be
              // followed into the event's body. Ability gates live inside the server RPC, not in
              // the input chain that asks for it, and calling an event does not link to its body.
              const eventEntries = new Map<string, string>();
              for (const chain of explained.chains) {
                if (chain.entryId && !eventEntries.has(chain.entry)) {
                  eventEntries.set(chain.entry, chain.entryId);
                }
              }
// Walk, and wherever it ran out, read from there and walk again. Ability gates sit
              // inside a server RPC, so the chain nearly always leaves the input's own subtree.
              let walk = walkChain(entry[1] as string, nodes as never, 40, eventEntries);
              for (let pass = 0; pass < 6 && walk.needs; pass++) {
                const frontier = [walk.needs];
                for (let i = 0; i < 60 && frontier.length > 0; i++) {
                  const id = frontier.shift() as string;
                  if (nodes.has(id)) continue;
                  const detail = await bridge.send<{ id: string; type: string; title?: string; pins?: Array<{ linkedTo?: Array<{ node: string }> }> }>(
                    "read_blueprint_node_detail",
                    { path: found.path, graphName: "EventGraph", nodeId: id }
                  );
                  nodes.set(id, detail as never);
                  for (const pin of detail.pins ?? []) {
                    for (const link of pin.linkedTo ?? []) frontier.push(link.node);
                  }
                }
                const next = walkChain(entry[1] as string, nodes as never, 40, eventEntries);
                // No progress means that read did not unblock it; stop rather than loop.
                if (next.needs === walk.needs && next.gates.length === walk.gates.length) break;
                walk = next;
              }
              gateNote = describeGates(press.inputAction, walk.gates);
            }
          }
        } catch (err) {
          // A diagnostic that fails must not fail the measurement it was explaining - but it must
          // not vanish either. Swallowing this silently hid a wrong bridge command name for a whole
          // debugging session: the field was simply absent, which reads as "no gates found" rather
          // than "the lookup broke". Absent and broken are different answers.
          gateNote =
            "could not work out why nothing happened: " +
            (err instanceof Error ? err.message : String(err)).slice(0, 200);
        }
      }

      return jsonResult({
        ranForSeconds: runFor,
        startedPie: startedItHere,
        ...(press ? { pressed: press.inputAction } : {}),
        ...summary,
        ...(gateNote ? { whyNothingHappened: gateNote } : {}),
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_asset",
  {
    title: "Create any other kind of asset",
    description:
      "Creates an asset of any type the editor's own New Asset menu can create - InputAction, InputMappingContext, " +
      "Blackboard, BehaviorTree, SoundCue, CurveFloat, LevelSequence, NiagaraSystem, DataAsset, and the rest. It " +
      "finds the same factory the menu would and uses it, so what the editor can make, this can make.\n\n" +
      "Reach for it when a feature needs an asset that does not exist yet. The common case on UE5 is input: " +
      "unreal_map_input_key binds an InputAction to a key, but something has to make the InputAction first, and " +
      '"add a dash on Left Shift" starts here with assetClass "InputAction".\n\n' +
      "It REFUSES the eight types that have their own tool - Blueprint, Widget Blueprint, Data Table, Enum, Struct, " +
      "Material, Material Instance, Level - and names the one to use instead. Those need a parent class, a row " +
      "struct or a parent material, and making one without that produces an asset that exists and is broken, which " +
      "is worse than an error. It also refuses to overwrite an asset that already exists.",
    inputSchema: {
      path: z.string().describe('Where to create it, folder and name together, e.g. "/Game/Input/IA_Dash".'),
      assetClass: z
        .string()
        .describe(
          'The C++ type without the U prefix, e.g. "InputAction", "InputMappingContext", "BehaviorTree", ' +
            '"SoundCue", "CurveFloat".'
        ),
      save: z.boolean().optional().describe("Write it to disk. Default true; an unsaved asset reverts on restart."),
    },
  },
  async ({ path, assetClass, save }) => {
    try {
      const result = (await bridge.send("create_asset", { path, assetClass })) as { path?: string };
      // Composed here rather than in the bridge, for the reason in MCPAssetOps.cpp: the bridge command
      // does one thing and the save is visible in the reply instead of implied.
      let saved = false;
      let saveError: string | undefined;
      if (save !== false && typeof result.path === "string") {
        try {
          await bridge.send("save_asset", { path: result.path });
          saved = true;
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
        }
      }
      return jsonResult({ ...result, saved, ...(saveError ? { saveError } : {}) });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_enum_entry",
  {
    title: "Add one entry to an existing enum",
    description:
      "Adds a single entry to a user-defined enum, in place. Structs could already gain a field with " +
      "unreal_add_struct_field and enums could only be created whole, so \"add a new upgrade type\" - one entry " +
      "on an existing enum, then a Data Table row - could not be done at all: the only route was recreating the " +
      "enum, which breaks every asset already referring to it.\n\n" +
      "Refuses a duplicate label. Unreal permits two entries showing the same name, and the result is a dropdown " +
      "with two options nobody can tell apart, forever, with nothing reporting a problem.\n\n" +
      "Leaves the asset dirty - unreal_save_asset writes it. Anything switching on the enum keeps compiling, so " +
      "check Switch nodes that now need a case: a new entry is UNHANDLED rather than broken, which is quieter.",
    inputSchema: {
      path: z.string().describe('Enum asset, e.g. "/Game/Data/E_UpgradeType". List them with unreal_list_assets className=UserDefinedEnum.'),
      name: z.string().describe('The new entry as a person reads it, e.g. "Shield".'),
    },
  },
  async ({ path, name }) => {
    try {
      return jsonResult(await bridge.send("add_enum_entry", { path, name }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_enum",
  {
    title: "Create a Blueprint Enum",
    description:
      "Creates a user-defined Enum with named entries. Reach for this the moment a variable is a state or a kind: " +
      'an integer 0/1/2 for "Idle/Chasing/Attacking", or a string compared against "Fire"/"Ice", is a bug waiting ' +
      "to happen and unreadable in a graph. An enum gives a Switch node one clearly-labelled pin per case, and " +
      "makes an invalid value unrepresentable.\n\n" +
      'Use it afterwards with type "enum:<Name>" on unreal_add_variable or a struct field, and switch on it with a ' +
      "Switch on <Enum> node found via unreal_find_node.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Data/E_EnemyState". Prefix enum assets with E_ by convention.'),
      entries: z
        .array(z.string())
        .optional()
        .describe('Entry display names in order, e.g. ["Idle","Chasing","Attacking","Dead"]. These are what a designer sees on the pins.'),
    },
  },
  async ({ packagePath, entries }) => {
    try {
      const result = await bridge.send("create_enum", { packagePath, entries });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_enum_entries",
  {
    title: "Read an Enum's entries",
    description:
      "Returns an enum's entries with index, internal name, display name, and value, plus whether the enum is " +
      "editable (user-defined) or native C++. Works on engine enums too, so it doubles as a way to look up the " +
      "exact spelling of a built-in enum value before setting it as a pin default.",
    inputSchema: {
      path: z.string().describe('Enum asset: short name like "E_EnemyState", or a full path.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_enum_entries", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_tools",
  {
    title: "List every Unreal tool, without paying for its schema",
    description:
      "Every tool this server has, each with a one-line summary and the group that switches it on - and none of " +
      "the parameter schemas, which is the whole point: the summaries cost a fraction of what the definitions do. " +
      "Use this to find the right tool, then call unreal_enable_tools for the group it names to get the real, " +
      "fully typed definition. Nothing here is a substitute for the schema; it is how you decide which schemas " +
      "are worth loading. Filter with match or group when you already know roughly what you are after.",
    inputSchema: {
      match: z
        .string()
        .optional()
        .describe('Case-insensitive substring, matched against tool names and summaries, e.g. "widget" or "data table".'),
      group: z
        .string()
        .optional()
        .describe(
          // Derived, because this was a FOURTH hand-written copy of the group list and the stalest of
          // them: it offered seven of the twelve, so a model reading it learned that filtering by
          // "input", "anim", "ai", "vfx" or "cpp" was not possible. It is. A listing that disagrees
          // with the behaviour sends a caller looking somewhere else for something that was here.
          `Only tools in this group: ${ENABLEABLE_GROUPS.join(", ")}.`
        ),
      all: z
        .boolean()
        .optional()
        .describe("Every tool at once (~5.5k tokens). Without a filter you get a group census instead, which is cheaper and usually enough."),
      schema: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          'Tool name(s) to get the FULL parameter schema for, e.g. "unreal_save_asset". Returned as a reply, ' +
            "not as a definition, so the tool list does not change. Pair with unreal_call_tool."
        ),
    },
  },
  async ({ match, group, all, schema }) => {
    // The full schema for a named tool, without switching it on.
    //
    // Until this existed the only way to see a tool's parameters was to enable it, which changes the
    // tool list and re-reads the whole conversation at full price. So "what arguments does this
    // take" - the cheapest question in the catalogue - was priced like a commitment. It is a reply
    // now, which is what it always should have been.
    if (schema !== undefined) {
      const wantedNames = Array.isArray(schema) ? schema : [schema];
      const found: Record<string, unknown> = {};
      const missing: string[] = [];
      for (const name of wantedNames) {
        const impl = toolImpls.get(name);
        const meta = toolCatalog.get(name);
        if (!impl || !meta) {
          missing.push(name);
          continue;
        }
        found[name] = {
          title: meta.title,
          group: meta.group,
          on: toolHandles.get(name)?.enabled ?? false,
          // The advertised JSON Schema, derived from the same zod object the tool validates with,
          // so what is read here and what is enforced there cannot drift apart.
          parameters: zodToJsonSchema(impl.shape as never),
        };
      }
      return jsonResult({
        tools: found,
        ...(missing.length > 0
          ? { unknown: missing, unknownNote: "No tool by that name. Call unreal_list_tools with `match` to find it." }
          : {}),
        note:
          Object.keys(found).length > 0
            ? "Call these with unreal_call_tool({ tool, args }) - no tool-list change, so the cache survives. " +
              "Switch them on with unreal_enable_tools only if you will use them repeatedly."
            : "Nothing matched.",
      });
    }

    const needle = (match ?? "").trim().toLowerCase();
    const wanted = (group ?? "").trim().toLowerCase();

    // With no filter, answer with the GROUPS rather than all 88 tools.
    //
    // Measured, and it was embarrassing: listing everything cost 5,523 tokens - more than four times
    // the entire `search` profile this tool exists to protect. A discovery mechanism that costs more
    // than the thing it is discovering defeats its own purpose, and a model on `search` would have
    // paid it on the first call every session. The census is about 250 tokens and says where to look
    // next, which is what "what exists here" actually needs to answer.
    if (needle.length === 0 && wanted.length === 0 && all !== true) {
      const byGroup = new Map<string, number>();
      for (const [, meta] of toolCatalog) {
        byGroup.set(meta.group, (byGroup.get(meta.group) ?? 0) + 1);
      }
      const enabledNow = [...toolHandles.values()].filter((h) => h.enabled).length;
      return jsonResult({
        totalTools: toolCatalog.size,
        enabled: enabledNow,
        // A map from group name to one line about it, rather than rows of
        // {group, count, costTokens, what}. Those four keys were spelled once per group and were
        // 146 tokens of a 716-token reply - on the first call of every `search` session, which is
        // the one reply whose whole job is to cost less than the profile it protects.
        //
        // The price stays visible in the line, because choosing a group without it is choosing
        // blind. Measured and generated by `npm run measure:groups`, which fails when these drift.
        groups: Object.fromEntries(
          [...byGroup.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, count]) => [
              name,
              `${count} tools, ~${GROUP_COST_TOKENS[name] ?? "?"} tok - ${
                GROUP_SUMMARY[name] ??
                "the authoring spine: read a project, find a function, scaffold, build a graph, compile, review, save"
              }`,
            ])
        ),
        next:
          "Call again with a `group` to list the tools in it, or `match` to search names and summaries " +
          '(e.g. {"match":"data table"}). Listing every tool costs about 5.5k tokens and is rarely ' +
          "what you want - pass all:true if it genuinely is.\n\n" +
          `costTokens is what enabling that group adds to every later request. Everything is ` +
          `~${ALL_GROUPS_TOKENS}; \`core\` alone is ~${GROUP_COST_TOKENS.core}, most of it - "just enable core" ` +
          `is not the cheap option it sounds like. Re-calling is harmless, so turn on what the job needs.\n\n` +
          // A model that reaches list_tools rather than reading the instructions still has to learn
          // that presets exist, or it will hand-pick from this catalogue and pay for the privilege.
          `If the job has a name, a preset beats any group and needs no picking from this list: ` +
          PRESET_NAMES.map((n) => `${n} ~${PRESET_COST_TOKENS[n]}`).join(", ") + `.`,
      });
    }
    const rows = [...toolCatalog.entries()]
      .filter(([, meta]) => wanted.length === 0 || meta.group === wanted)
      .filter(
        ([name, meta]) =>
          needle.length === 0 ||
          name.toLowerCase().includes(needle) ||
          meta.summary.toLowerCase().includes(needle)
      )
      .map(([name, meta]) => ({
        name,
        group: meta.group,
        on: toolHandles.get(name)?.enabled ?? false,
        summary: meta.summary,
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

    const off = [...new Set(rows.filter((r) => !r.on).map((r) => r.group))].sort();

    // Nothing matched is not the same as everything matched being ready.
    //
    // The old reply to a search that found nothing was
    // `{matched: 0, tools: [], next: "Every matching tool is already enabled; call it directly."}` -
    // the identical sentence used when every match IS enabled. A model reading that proceeds as
    // though it is equipped, having been handed no tools at all.
    //
    // And zero is the normal outcome for the sentence this project is built around. `match` searches
    // tool names and summaries, so "upgrade", "shop", "missing", "not showing" and "bug" all return
    // nothing, while "upgrades aren't showing up in the shop" is a real bug here that
    // check_data_tables reports in one call. So a failed search falls back to a second index keyed
    // on failure vocabulary rather than tool vocabulary.
    if (rows.length === 0) {
      const symptom = matchSymptoms(needle);
      const known = (symptom?.tools ?? []).filter((name) => toolCatalog.has(name));
      const groupsFor = [...new Set(known.map((name) => toolCatalog.get(name)!.group))].sort();
      // How much the lazy answer would cost.
      //
      // This reply used to end by recommending enable_tools({groups}) - the groups CONTAINING the
      // tools it had just named one by one. Measured on "the tutorial level doesn't spawn a player":
      // naming the three suggested tools costs +1,008 standing tokens, asking for their two groups
      // costs +16,381, and both answer the same question. Sixteen times the price, offered first,
      // for the sentence this whole project exists to serve.
      //
      // Counted with estimateTokens, the counter the rest of this repo measures with. An earlier
      // draft of this comment used an ad-hoc len/3.6 and ran about 10% high. The 16x ratio held and
      // the absolutes did not, which is the argument for quoting the ratio.
      //
      // Counted rather than hardcoded, because it depends entirely on which groups got matched.
      const groupSize = [...toolCatalog.values()].filter((t) => groupsFor.includes(t.group)).length;
      return jsonResult({
        matched: 0,
        of: toolCatalog.size,
        searched: needle,
        ...(known.length > 0
          ? {
              // Named for what it is. A caller that thinks it was understood will trust a wrong
              // suggestion; one that knows it matched the words below can judge for itself.
              matchedSymptomWords: symptom!.matched,
              suggested: known.map((name) => ({
                name,
                group: toolCatalog.get(name)!.group,
                on: toolHandles.get(name)?.enabled ?? false,
                summary: toolCatalog.get(name)!.summary,
              })),
              why: symptom!.because,
              intent: symptom!.intent,
              next:
                (symptom!.intent === "building"
                  ? `No tool name or summary contains "${needle}", but it reads like a request to BUILD ` +
                    `something rather than a report of something broken, so these are the tools for that: ` +
                    `plan first against what the project already has, then the tools for the part of the ` +
                    `engine the request names.`
                  : symptom!.intent === "changing"
                    ? `No tool name or summary contains "${needle}", but it reads like a request to CHANGE ` +
                      `something that already exists rather than to build or to diagnose. The work is ` +
                      `finding the value before editing it, and it could be in a Data Table row, a ` +
                      `Blueprint class default, a literal wired into a graph, or a C++ default - so these ` +
                      `tools search all of those rather than assuming one.`
                    : `No tool name or summary contains "${needle}", but it reads like a description of a ` +
                      `symptom, so these are the tools that find that class of problem.`) +
                ` This is a keyword match on the words listed in matchedSymptomWords, not an ` +
                `understanding of the sentence - check the suggestions against what you actually want.` +
                (known.length > 0
                  ? ` unreal_call_tool({ tool, args }) runs one of these now without changing the ` +
                    `tool list at all. If you expect several calls, ` +
                    `unreal_enable_tools({ tools: ${JSON.stringify(known)} }) adds exactly these ` +
                    `${known.length}. Prefer that to groups: these ${known.length} sit in groups ` +
                    `holding ${groupSize} tools between them, so asking by group buys the same answer ` +
                    `plus ${groupSize - known.length} tools you did not ask for, and every one of them ` +
                    `stays in the prompt for the rest of the session.`
                  : ""),
            }
          : {
              next:
                `No tool name or summary contains "${needle}", and it does not match any known symptom ` +
                `wording either. \`match\` searches what tools are CALLED, so plain-language words rarely ` +
                `land - call unreal_list_tools with no arguments for the group census, or start with ` +
                `unreal_audit_project (finds problems project-wide), unreal_project_health (what does not ` +
                `compile) or unreal_search_project (finds an asset by what it contains).`,
            }),
      });
    }

    // Say the things every row agrees on once.
    //
    // A narrow search returns rows that usually share both their group and their on/off state - ask
    // for "data table" and all seven are group "data", and on `search` all seven are off. Repeated
    // per row that is `"group":"data","on":false` seven times over, which was 189 of 1,991
    // characters and put this reply two tokens under a 500-token ceiling it is meant to sit well
    // inside. The ceiling is not the problem; the repetition is, and it grows with every tool added.
    //
    // Only hoisted when it is actually uniform, so a mixed result still says which is which per row.
    // Same shape as `class` on unreal_list_actors and blueprintByClass beside it.
    const groups = new Set(rows.map((r) => r.group));
    const states = new Set(rows.map((r) => r.on));
    const sharedGroup = rows.length > 1 && groups.size === 1 ? [...groups][0] : undefined;
    const sharedOn = rows.length > 1 && states.size === 1 ? [...states][0] : undefined;
    const compactRows =
      sharedGroup === undefined && sharedOn === undefined
        ? rows
        : rows.map((r) => {
            const { group, on, ...rest } = r;
            return {
              ...rest,
              ...(sharedGroup === undefined ? { group } : {}),
              ...(sharedOn === undefined ? { on } : {}),
            };
          });

    return jsonResult({
      matched: rows.length,
      of: toolCatalog.size,
      ...(sharedGroup === undefined ? {} : { group: sharedGroup }),
      ...(sharedOn === undefined ? {} : { on: sharedOn }),
      tools: compactRows,
      groupsNotYetOn: off,
      next:
        off.length > 0
          ? `Using one of these once? unreal_call_tool({ tool, args }) runs it now without changing the tool ` +
            `list. Using it repeatedly, or need to see its parameters first? unreal_enable_tools with ` +
            `${JSON.stringify(off)} for the real schemas, or unreal_list_tools({ schema: "<name>" }) for one.`
          : "Every matching tool is already enabled; call it directly.",
    });
  }
);


register(
  "unreal_enable_tools",
  {
    title: "Turn on a group of Unreal tools",
    description:
      "Most tools stay off until asked, so a session that never builds UI never pays for the UI tools. Call this " +
      "the moment you need one from a group, then use it normally.\n\n" +
      "**unreal_list_tools names every group, what it is for, and what enabling it costs** - measured, not " +
      "estimated - in about 540 tokens, once. The two you will reach for most often: \"core\" is the authoring " +
      "spine (read a project, scaffold, build a graph, compile, save) and is much the largest, so enable it to " +
      "author rather than to look around; \"edit\" is single-node surgery you usually do NOT need, because " +
      "unreal_build_graph places whole graphs in one call.\n\n" +
      "Better still, if the job has a name, `preset` beats picking groups by hand - see below.\n\n" +
      "Immediate, lasts the session, and re-calling is harmless. Ask for everything the job needs in one call.",
    inputSchema: {
      groups: z
        .array(z.enum(ENABLEABLE_GROUPS))
        .optional()
        .describe('Whole groups to turn on, e.g. ["core","ui"].'),
      tools: z
        .array(z.string())
        .optional()
        .describe('Exact tool names, instead of whole groups. unreal_list_tools has the names.'),
      preset: z
        .enum(["diagnose", "feature", "ui", "data", "cpp"])
        .optional()
        .describe(
          'The tools for one job, already chosen: "diagnose" (find and fix a reported bug), "feature" ' +
            '(build a new Blueprint feature), "ui" (UMG), "data" (Data Tables, structs, enums), "cpp". ' +
            "Cheaper than a group and needs no catalogue lookup. Combine with `groups` if the job spills over."
        ),
    },
  },
  async ({ groups, tools, preset }) => {
    const enabled: string[] = [];
    for (const group of groups ?? []) {
      enabled.push(...enableGroup(group));
    }

    // A preset is the cheap path made reachable. Naming tools is measured at 61% less than enabling
    // `core`, but a model on the search profile has four tools and no idea which to name, so the
    // saving was only available to someone who already knew the catalogue. Presets are resolved to
    // exact names here and then take the same path as `tools` below.
    const fromPreset = preset ? presetTools(preset) : undefined;
    if (preset && !fromPreset) {
      return errorResult(
        new Error(
          `unknown_preset: "${preset}". Available: ${PRESET_NAMES.join(", ")}. ` +
            `Or pass \`groups\` / \`tools\` directly.`
        )
      );
    }

    // Individual tools, so a session can pay for the six it needs instead of the thirty-two in the
    // group that contains them. On a capable model this is the whole saving: `core` is 11.5k tokens
    // of definitions and a session that reads a project and builds one graph touches a fraction of
    // it, every turn, for the rest of the conversation.
    const unknown: string[] = [];
    for (const name of [...(fromPreset ?? []), ...(tools ?? [])]) {
      const handle = toolHandles.get(name);
      if (!handle) {
        unknown.push(name);
        continue;
      }
      if (!handle.enabled) {
        handle.enable();
        enabled.push(name);
      }
    }

    const enabledCount = [...toolHandles.values()].filter((h) => h.enabled).length;
    // Only a call that switched something on moves the list. Re-enabling what is already on is a
    // no-op, and counting it would make the warning cry wolf.
    if (enabled.length > 0) {
      toolListChanges += 1;
    }
    return jsonResult({
      requested: { groups: groups ?? [], tools: tools ?? [] },
      newlyEnabled: enabled,
      alreadyOn: enabled.length === 0 && unknown.length === 0,
      // A count, not the list. Echoing every enabled tool name cost about 700 tokens and grew with
      // the tool count - so enabling ONE tool cost the same as enabling thirty-two, and the reply
      // was mostly a repeat of the tools/list the client had just been notified about. What the
      // caller cannot get elsewhere is which names were newly switched on, and that is above.
      enabledCount,
      // Named rather than ignored: a typo that silently enables nothing is a tool call spent for no
      // effect, and the caller has no way to tell that from "it was already on".
      ...(unknown.length > 0
        ? {
            unknownTools: unknown,
            unknownNote: "No tool by that name is registered. Call unreal_list_tools to see the exact names.",
          }
        : {}),
      // The exact strings, delivered the moment they become usable rather than on every turn
      // before then. See GROUND_TRUTH: on `search` this text was standing context describing calls
      // the caller could not yet make. It is sent once, and only when something able to author a
      // graph has just switched on - enabling the C++ or data tools alone does not need pin names.
      ...(PROFILE === "search" && !groundTruthDelivered && enabled.some((name) => AUTHORING_TOOLS.includes(name))
        ? ((groundTruthDelivered = true), { groundTruth: GROUND_TRUTH.join("\n") })
        : {}),
      note:
        enabled.length > 0
          ? "These tools are now available. Your client has been notified that the tool list changed."
          : "Nothing new to enable.",
      // Said at the moment it becomes true, not in standing context where it would be paid for on
      // every turn to teach something most sessions never need.
      ...(enabled.length > 0 && toolListChanges >= 2
        ? {
            costNote:
              `This is tool-list change ${toolListChanges} this session. Each one re-reads the whole ` +
              `conversation at full price on the next turn, because the tool list sits ahead of everything ` +
              `else in the request. If the remaining tools are for one or two calls each, ` +
              `unreal_call_tool({ tool, args }) runs them with no change at all - and ` +
              `unreal_list_tools({ schema: "<name>" }) gives you their parameters the same way.`,
          }
        : {}),
    });
  }
);

/**
 * Calling a tool without switching it on.
 *
 * Epic's own MCP plugin ships exactly this shape - list_toolsets, describe_toolset, call_tool - and
 * reading their docs is what exposed the hole here. This server had the listing and the enabling
 * and no way to just USE something, so every one-off tool call cost a tool-list change, and a
 * tool-list change costs the whole prompt cache. That is the opposite of the goal.
 *
 * The two paths are not redundant and neither replaces the other:
 *
 *   enable_tools  - one cache invalidation, then the schema is visible for the rest of the session.
 *                   Right for a tool used repeatedly, and right when the model needs the schema in
 *                   front of it to sequence a job correctly.
 *   call_tool     - no tool-list change at all, so the cache survives. Right for the long tail: the
 *                   single save, the one compile, the status check at the end of a job in a group
 *                   nothing else needs.
 *
 * The trap to avoid is a dispatcher that guesses. It validates against the SAME strict schema the
 * tool advertises, so a bad argument is refused here exactly as it would be if the tool were on -
 * two ways to call one thing that disagree about its arguments is the defect class this project
 * keeps finding, and it will not be introduced on purpose.
 */
register(
  "unreal_call_tool",
  {
    title: "Call a tool once, without switching it on",
    description:
      "Runs any tool by name and returns its result, without adding it to the tool list. " +
      "unreal_enable_tools changes that list, which re-reads the whole conversation at full price on the next " +
      "turn - a bargain for a tool you use ten times, the most expensive way to make one call.\n\n" +
      "**Measured, three real journeys both ways: dispatching took 11 calls and left standing context at " +
      "1,458 tokens; enabling took 14 and left it at 17,302 tokens, paid on every later request. Same outcomes.** " +
      "Prefer this unless you need the schema visible, or will call one tool many times.\n\n" +
      "Arguments come from unreal_list_tools({ schema: \"unreal_save_asset\" }) and are checked against the " +
      "identical schema the tool itself uses, so nothing is looser here.",
    inputSchema: {
      tool: z.string().describe('Exact tool name, e.g. "unreal_save_asset".'),
      args: z
        .record(z.unknown())
        .optional()
        .describe("The tool's own arguments. Omit for a tool that takes none."),
    },
  },
  async ({ tool, args }, extra) => {
    // Dispatching to itself would recurse until the stack gives out, and there is no reading of
    // that call which means anything useful.
    if (tool === "unreal_call_tool") {
      return errorResult(
        new Error("bad_param: unreal_call_tool cannot call itself. Name the tool you actually want to run.")
      );
    }

    const impl = toolImpls.get(tool);
    if (!impl) {
      // A near-miss is far more likely than a genuinely unknown tool, and the caller who guessed
      // a half-remembered name wants the tool it is one word away from, rather than a lecture about the catalogue.
      const needle = tool.toLowerCase().replace(/^unreal_/, "");
      const near = [...toolImpls.keys()]
        .filter((name) => name.includes(needle) || needle.includes(name.replace(/^unreal_/, "")))
        .slice(0, 5);
      return errorResult(
        new Error(
          `unknown_tool: no tool named "${tool}"${near.length > 0 ? `. Did you mean: ${near.join(", ")}?` : ""}` +
            (near.length > 0 ? "" : ". Call unreal_list_tools to see the exact names.") +
            (PROFILE === "core" || PROFILE === "minimal"
              ? ` This is the "${PROFILE}" profile, which does not carry every tool - the fuller profiles do.`
              : "")
        )
      );
    }

    // The exact pin names, attached to the first attempt to author anything - whether it worked.
    //
    // This was a hole the dispatcher opened. On `search`, GROUND_TRUTH is kept out of standing
    // context and handed over by unreal_enable_tools the moment an authoring tool switches on. A
    // caller that dispatches instead never switches anything on, so it would never receive it and
    // would guess pin names - which costs a failed call each time, the exact expense this tool
    // exists to avoid.
    //
    // Attached on failure too, deliberately: a caller who just got the arguments wrong is precisely
    // the one who needs the real names, and that is the moment they are worth the most.
    //
    // Appended as a SECOND content block rather than merged into the first, because callers parse
    // content[0] as the tool's own JSON and quietly changing that shape would break them for a
    // reason they could not see.
    const withGroundTruth = <T>(result: T): T => {
      if (PROFILE !== "search" || groundTruthDelivered || !AUTHORING_TOOLS.includes(tool)) {
        return result;
      }
      const shaped = result as { content?: Array<{ type: string; text: string }> };
      if (!Array.isArray(shaped?.content)) {
        return result;
      }
      groundTruthDelivered = true;
      shaped.content = [
        ...shaped.content,
        { type: "text", text: `Exact names, sent once:\n${GROUND_TRUTH.join("\n")}` },
      ];
      return result;
    };

    // The tool's own schema, not a looser copy. `shape` is whatever register() ended up advertising,
    // which for every tool here is the strict object built by strictSchema - so an unknown key or a
    // missing required one produces the same guidance it would through the normal path.
    let parsed: unknown = args ?? {};
    const schema = impl.shape as unknown as { parse?: (value: unknown) => unknown };
    if (typeof schema.parse === "function") {
      try {
        parsed = schema.parse(args ?? {});
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return withGroundTruth(errorResult(new Error(`bad_args for ${tool}: ${detail}`)));
      }
    }

    return withGroundTruth(await impl.handler(parsed as never, extra as never)) as never;
  }
);

/**
 * The workflow guide, served as an MCP prompt.
 *
 * docs/AGENT_WORKFLOW.md is the single highest-leverage thing in this repo for a weaker model:
 * the difference between a smooth run and a flailing one is almost never model quality, it is
 * tool-call order. But it only helps if the model actually receives it, and "paste this into your
 * system prompt" is a step a person with zero coding experience will not take.
 *
 * So the server offers it directly. Any MCP client can pull it in without the user configuring
 * anything, and it costs nothing until asked for.
 */
const WORKFLOW_FALLBACK =
  "The workflow guide was not found next to this server. The short version: unreal_doctor if " +
  "anything is broken; unreal_get_project_overview to orient; unreal_search_project to find; " +
  "unreal_find_node and unreal_list_assets to check exact names before writing; unreal_build_graph " +
  "to author whole graphs in one call without passing x/y; unreal_review_blueprint before claiming " +
  "anything is done, and act on what it says; unreal_auto_layout_graph to make it readable; then " +
  "save. Full text: docs/AGENT_WORKFLOW.md in the unreal-mcp repository.";

function loadDoc(fileName: string, fallback: string): string {
  // dist/index.js -> mcp-server/dist -> mcp-server -> repo root
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", fileName),
    join(dirname(fileURLToPath(import.meta.url)), "..", "docs", fileName),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      /* try the next one */
    }
  }
  return fallback;
}

function loadWorkflowGuide(): string {
  return loadDoc("AGENT_WORKFLOW.md", WORKFLOW_FALLBACK);
}

/**
 * The documentation, fetchable by the model at the moment it needs it.
 *
 * The three prompts already carry this text, but a prompt has to be pulled in by the CLIENT, and
 * most clients surface prompts as something the human picks from a menu. So the model could not
 * reach any of it on its own initiative - which is precisely when it is worth having, at the moment
 * a pin name comes back wrong and the answer is one paragraph away.
 *
 * Returning the section index by default rather than the whole document is the difference between
 * this being a token saving and a token cost: the index for all three guides is a few hundred
 * tokens, and a single section is usually under a thousand, against the several thousand a whole
 * handbook costs to inline.
 */
const GUIDE_DOCS: Record<string, { file: string; fallback: string; what: string }> = {
  workflow: {
    file: "AGENT_WORKFLOW.md",
    fallback: WORKFLOW_FALLBACK,
    what: "the call order that makes a session go smoothly",
  },
  handbook: {
    file: "BLUEPRINT_HANDBOOK.md",
    fallback: "See docs/BLUEPRINT_HANDBOOK.md in the unreal-mcp repository.",
    what: "Unreal ground truth: exact pin names, type descriptors, the Blueprint mental model",
  },
  recipes: {
    file: "RECIPES.md",
    fallback: "See docs/RECIPES.md in the unreal-mcp repository.",
    what: "verified end-to-end builds of the systems people ask for",
  },
};

/** Split a markdown document into (heading, body) sections on ## and ### lines. */
function guideSections(text: string): { heading: string; body: string }[] {
  const lines = text.split("\n");
  const out: { heading: string; body: string }[] = [];
  let heading = "(preamble)";
  let body: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      if (body.join("").trim().length > 0 || out.length === 0) {
        out.push({ heading, body: body.join("\n").trim() });
      }
      heading = line.replace(/^#+\s+/, "").trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  out.push({ heading, body: body.join("\n").trim() });
  return out.filter((s) => s.body.length > 0);
}

register(
  "unreal_verify_feature",
  {
    title: "Is the thing I just built actually finished?",
    description:
      "**The last call before you tell the user a feature is done.** Compiles and reviews every " +
      "Blueprint this session actually wrote to - taken from the change journal, not from memory - " +
      "and reduces it to one verdict plus an ordered list of what is still wrong.\n\n" +
      "The failure it exists for: you build a feature across four Blueprints, compile the one you " +
      "touched last, see success, and report the work as done - while an asset you edited twenty " +
      "calls ago no longer compiles. Asking the whole question by hand means remembering every asset " +
      "and making two calls per asset, and the model that forgets to check is the one that has " +
      "already forgotten what it touched.\n\n" +
      "Compile failures are listed before review findings, because a Blueprint that does not build " +
      "has no graph worth reviewing. `verdict: \"pass\"` means every asset compiles and carries no error " +
      "or warning findings; anything else means it is not done yet, whatever the last individual call " +
      "said. Info-level findings - naming, comment boxes, layout - are reported on each asset but do " +
      "not fail the verdict: they are worth knowing and they are not \"not finished\".",
    inputSchema: {
      paths: z
        .array(z.string())
        .optional()
        .describe("Blueprints to check. Defaults to every Blueprint written this session, which is usually what you want."),
    },
  },
  async ({ paths }) => {
    try {
      // The journal is the only record that cannot drift from what actually happened: it is written
      // by the same wrapper every bridge command passes through.
      const touched = journal
        .summary()
        .byAsset.map((entry) => entry.asset);
      // The graphs this session created, so verification can ask whether anything calls them. Only
      // successful writes: a create_function that failed produced nothing to be reached.
      const touchedGraphs = journal
        .all()
        .filter((r) => r.ok && r.target && r.graph)
        .map((r) => ({ asset: r.target as string, graph: r.graph as string }));
      return jsonResult(withDisabledToolNote(await verifyFeature(bridge, { paths, touched, touchedGraphs }), isToolEnabled));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_source",
  {
    title: "Find the project's C++ and which file defines a symbol",
    description:
      "Real projects keep their base classes, damage maths and replicated state in C++, so a question " +
      'like "the health bar does not update when I take damage" is often a question about a .cpp file ' +
      "that no Blueprint tool can see. This is how you reach that half of the project.\n\n" +
      "Call it with no `symbol` to get the project root and every C++ module in it, including plugin " +
      "modules - which is also how you find out whether the project has any C++ at all, and where new " +
      "code would belong. Call it with a `symbol` (a class, function or property name, matched " +
      "whole-word) to get the exact files and line numbers that declare or define it, ranked so the " +
      "class declaration comes first and passing mentions come last.\n\n" +
      "It deliberately returns locations rather than file contents: you already have file tools that " +
      "read and edit far better than this could, and what you were missing was where to point them. " +
      "A `parentClass` from unreal_read_blueprint_summary that is not a Blueprint is a native class, " +
      "and this is how you find it.",
    inputSchema: {
      symbol: z
        .string()
        .optional()
        .describe('A class, function or property name, e.g. "AMyCharacter" or "ApplyDamage". Omit to map the modules.'),
      fileFilter: z
        .string()
        .optional()
        .describe('Only search files whose name contains this, e.g. "Character".'),
      limit: z.number().int().positive().optional().describe("Maximum matches to return. Default 40."),
    },
  },
  async ({ symbol, fileFilter, limit }) => {
    const ping = await bridge.send<{ project?: string; projectFile?: string }>("ping", {});
    const projectFile = ping.projectFile;
    if (!projectFile) {
      return errorResult(
        new Error(
          "The bridge did not report a project file path, so the C++ tree cannot be located. This " +
            "usually means the loaded plugin binary predates the field; rebuild the plugin and restart " +
            "the editor, then run unreal_doctor."
        )
      );
    }

    const roots = findSourceRoots(projectFile);

    if (roots.length === 0) {
      return jsonResult({
        project: ping.project,
        projectFile,
        modules: [],
        note:
          "This project has no C++ modules: there is no Source directory, and no plugin under " +
          "Plugins/ has one. It is Blueprint-only, so every answer is in the Blueprint tools.",
      });
    }

    if (symbol === undefined || symbol.trim().length === 0) {
      return jsonResult({
        project: ping.project,
        projectFile,
        root: dirname(projectFile),
        modules: modulesByName(roots, dirname(projectFile)),
        next:
          "Call again with `symbol` to find where a class, function or property is declared. New " +
          "gameplay code normally belongs in the project module rather than a plugin one.",
      });
    }

    const { matches, filesScanned, totalMatches, truncated, foundAs } = searchSource(projectFile, roots, symbol, {
      limit,
      fileFilter,
    });

    if (matches.length === 0) {
      return jsonResult({
        project: ping.project,
        projectFile,
        symbol,
        matches: [],
        filesScanned,
        note:
          `Nothing in this project's C++ declares or mentions "${symbol}". If it is a Blueprint ` +
          "concept rather than a native one, use unreal_search_project instead; if it is an engine " +
          "symbol, it lives in the engine source, which is not part of this project.",
      });
    }

    return jsonResult({
      project: ping.project,
      projectFile,
      symbol,
      // Say WHICH name this was found under when it was not the one asked for. The whole reason the
      // retry exists is that the caller did not know the C++ spelling - the editor and every
      // Blueprint's parentClass call it AVSGameState, and the class is AAVSGameState - so finding
      // the file without handing back the real name only half solves it.
      ...(foundAs
        ? {
            foundAs,
            note:
              `Nothing declares "${symbol}"; this is "${foundAs}". Unreal prefixes its classes - A for ` +
              `Actor, U for UObject, F for struct, E for enum, I for interface - and the editor drops ` +
              `the prefix, so a Blueprint's parentClass never matches the C++ name exactly.`,
          }
        : {}),
      // Grouped by file, which is both the cheaper shape and the one that matches what happens next:
      // the reader opens a file. "<file>:<line>" is still quotable, which is what editors linkify.
      matches: matchesByFile(matches),
      filesScanned,
      // One field for the prefix every path here is relative to, rather than repeating it on each and
      // rather than sending projectFile as well - projectFile IS this path plus a filename.
      root: dirname(projectFile),
      ...(truncated
        ? {
            omitted: totalMatches - matches.length,
            note: `${totalMatches - matches.length} further match(es) not shown, all lower-ranked than these. Narrow with \`fileFilter\` or raise \`limit\`.`,
          }
        : {}),
    });
  }
);

register(
  "unreal_compile_cpp",
  {
    title: "Compile the project's C++ and get the errors",
    description:
      "**Call this after editing a .cpp or .h.** find_source shows where the C++ is; this says whether your " +
      "change built. Without it a model edits a file and guesses - and in a client with no shell there is no " +
      "other way to find out.\n\n" +
      "Pass a `file` to compile that one translation unit without linking: seconds rather than minutes, and it " +
      "works while the editor runs. **A full build (omit `file`) fails while the editor is open** - it holds the " +
      "module DLL, so the link cannot replace it, and the bridge lives inside that editor so it cannot close it. " +
      "A failure with no diagnostics is almost always that.\n\n" +
      "Errors come back structured - file, line, code, message, project-relative, duplicates removed - because a " +
      "UnrealBuildTool run emits megabytes and the answer is usually one line of it.\n\n" +
      "**A clean single-file compile is not a clean build.** It proves this file\u2019s syntax against the engine " +
      "you are on; it does not prove the module links, and it does not prove a different engine version accepts it - " +
      "types move between versions, and unity builds hide a missing include until the file is compiled alone. Treat " +
      "it as fast feedback, not as the verdict.",
    inputSchema: {
      file: z
        .string()
        .optional()
        .describe(
          "Absolute path to one .cpp to compile without linking. Strongly preferred: seconds instead of minutes, " +
            "and it works with the editor running. Omit for a full editor build."
        ),
    },
  },
  async ({ file }) => {
    try {
      // The engine and project locations come from the editor itself rather than from configuration,
      // because they are the two things a client cannot know and the editor always can.
      const info = await bridge.send<{ projectFile?: string; engineDir?: string }>("ping", {});
      if (!info.projectFile || !info.engineDir) {
        throw new Error(
          "missing_engine_paths: this plugin build does not report engineDir. Rebuild the bridge plugin " +
            "(npm run build:engines) - unreal_ping's pluginBuiltAt will tell you how old the running one is."
        );
      }
      return jsonResult(
        await compileNative({ projectFile: info.projectFile, engineDir: info.engineDir, file })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);


register(
  "unreal_guide",
  {
    title: "Fetch a section of the Unreal guides, without loading the whole document",
    description:
      "The project's own documentation, readable on demand. Call it the moment something is not " +
      "obvious - a pin name that will not connect, a type descriptor the server rejects, which node " +
      "type a Branch actually is - rather than guessing and spending a failed call to find out. " +
      "With no `section` it returns just the list of section headings, which is cheap; pass one of " +
      "those headings (or any distinctive part of it) to get that section's text. `full: true` " +
      'returns the whole document. Topics: "handbook" (exact pin names, type descriptors, the ' +
      'Blueprint mental model), "recipes" (verified end-to-end builds of common systems), ' +
      '"workflow" (the call order that makes a session go smoothly).',
    inputSchema: {
      topic: z.enum(["handbook", "recipes", "workflow"]).describe("Which guide to read."),
      section: z
        .string()
        .optional()
        .describe('A section heading, or any distinctive part of one, e.g. "pin" or "multiplayer".'),
      full: z.boolean().optional().describe("Return the entire document rather than an index or one section."),
    },
  },
  async ({ topic, section, full }) => {
    const doc = GUIDE_DOCS[topic];
    const text = loadDoc(doc.file, doc.fallback);

    if (full === true) {
      return jsonResult({ topic, source: `docs/${doc.file}`, text });
    }

    const sections = guideSections(text);

    if (section === undefined || section.trim().length === 0) {
      return jsonResult({
        topic,
        source: `docs/${doc.file}`,
        what: doc.what,
        sections: sections.map((s) => s.heading),
        next:
          "Call again with `section` set to one of these headings to read it, or `full: true` for " +
          "the whole document.",
      });
    }

    const needle = section.trim().toLowerCase();
    let hits = sections.filter((s) => s.heading.toLowerCase().includes(needle));
    let matchedOn = "heading";

    if (hits.length === 0) {
      // Fall back to the body text, because the useful headings are rarely the searchable ones. The
      // exact pin names - the single most looked-up fact in the handbook - live under "9. The traps
      // that cost one failed call each", so a model sensibly searching for "pin" would otherwise be
      // told there is nothing, about the one document that has the answer.
      hits = sections.filter((s) => s.body.toLowerCase().includes(needle));
      matchedOn = "body";
    }

    if (hits.length === 0) {
      return jsonResult({
        topic,
        source: `docs/${doc.file}`,
        error: `Nothing in ${doc.file} mentions "${section}".`,
        sections: sections.map((s) => s.heading),
        next: "Pick one of the headings above, or pass `full: true`.",
      });
    }

    // Several body matches usually means the word is common rather than that every section is
    // wanted, so hand back the headings and let the caller choose instead of returning the document
    // a section at a time.
    if (matchedOn === "body" && hits.length > 3) {
      return jsonResult({
        topic,
        source: `docs/${doc.file}`,
        matchedOn,
        matchingSections: hits.map((s) => s.heading),
        next: `"${section}" appears in ${hits.length} sections. Call again with one of these headings.`,
      });
    }

    return jsonResult({
      topic,
      source: `docs/${doc.file}`,
      matchedOn,
      sections: hits.map((s) => ({ heading: s.heading, text: s.body })),
    });
  }
);

/**
 * Handbooks, for a model that can program but was never trained on Unreal.
 *
 * This is the difference between a local model being unusable and being useful. Qwen, DeepSeek and
 * friends can write logic perfectly well; what they lack is Unreal's vocabulary, its class
 * hierarchy, and the dozen traps that each cost a failed call to discover. That is a gap a document
 * can close, and it costs nothing until asked for.
 *
 * Every function name in the recipes is machine-checked against the running engine by
 * `npm run verify:handbook`, because a handbook of plausible-looking node names is worse than none:
 * the models least able to spot an invented name are exactly the ones relying on this.
 */
server.registerPrompt(
  "unreal_handbook",
  {
    title: "Unreal ground truth and this server's exact wire format",
    description:
      "The engine facts and exact strings that cannot be recalled reliably from training, whatever model you are: " +
      "the target pin is named `self`, exec pin names differ per node kind (`execute`/`then`, Branch's `then`/`else`, " +
      "Sequence's `then_0`, and `Exec` with a capital E on loop macros), struct pin defaults are comma triples, enum " +
      "defaults take the entry name, static library functions need their className, and Branch/Cast/Sequence/Create " +
      "Spawn Actor and Create Widget are their own node classes, not functions. Also the Blueprint mental " +
      "model, choosing a parent class, cross-actor references, interfaces, multiplayer in one page, and where state " +
      "belongs. Pull this in before the first write of any session. Being confident about Unreal's exact strings and " +
      "being right about them are different things, and every one of these costs a failed call to learn the hard way.",
  },
  () => ({
    messages: [{ role: "user", content: { type: "text", text: loadDoc("BLUEPRINT_HANDBOOK.md", "See docs/BLUEPRINT_HANDBOOK.md in the unreal-mcp repository.") } }],
  })
);

server.registerPrompt(
  "unreal_recipes",
  {
    title: "Verified builds of the systems people ask for",
    description:
      "Complete, step-by-step builds for health and damage via an interface, interaction by line trace, pickups, a " +
      "HUD bound to a value, timers instead of Tick, spawning, and save/load - each with the exact tool call order " +
      "and the exact node names. Every function name is verified against the running engine, and the guide names " +
      "the nodes that are NOT functions (Branch, Cast) which no amount of searching the " +
      "function catalog will ever find. Pull this in before building any common system.",
  },
  () => ({
    messages: [{ role: "user", content: { type: "text", text: loadDoc("RECIPES.md", "See docs/RECIPES.md in the unreal-mcp repository.") } }],
  })
);

server.registerPrompt(
  "unreal_workflow",
  {
    title: "How to drive these Unreal tools well",
    description:
      "The recommended tool-call order for building Blueprint features through this server, plus the sharp edges " +
      "that cost a failed call each to discover: exec pin naming, cast pin spacing, struct default formats, the two " +
      "UMG traps, multiplayer and performance judgment, and the rule that compiling is not the same as done. Pull " +
      "this in at the start of any session that will edit an Unreal project.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: loadWorkflowGuide() },
      },
    ],
  })
);

register(
  "unreal_session_changes",
  {
    title: "What has been changed in this project so far",
    description:
      "Reports every change this server has made to the project during this session, grouped by asset and written " +
      "in plain language rather than command names, plus anything that failed and anything that was deleted. " +
      "Handing an AI direct control of a game engine introduces a failure mode that does not exist when a human is " +
      "clicking the buttons: the human always knows what they touched. Use this to close that gap. Show it to the " +
      "user before they save, when they ask what you did, when they seem unsure about letting you edit their " +
      "project, or before doing anything you cannot easily reverse. It reads the server's own log, costs nothing, " +
      "and touches the editor not at all.",
    inputSchema: {
      detailed: z.boolean().optional().describe("Include the full command-by-command list as well as the summary. Defaults to false."),
    },
  },
  async ({ detailed }) => {
    const summary = journal.summary();
    return jsonResult(detailed ? { ...summary, log: journal.all() } : summary);
  }
);

register(
  "unreal_create_material",
  {
    title: "Create a Material",
    description:
      "Creates a master Material with BaseColor, Metallic and Roughness (and optionally EmissiveColor, a base colour " +
      "texture and a normal map) exposed as " +
      "PARAMETERS rather than baked-in constants. That matters: a parameterised master material can be instanced, " +
      "which is how a real project gets fifty variations without fifty material graphs, and it is what lets the " +
      "look be adjusted later without rebuilding anything.\n\n" +
      "Materials are most of what a player actually sees, so this is usually worth doing before fussing over " +
      "geometry. Make the master once, then make cheap variations with unreal_create_material_instance and " +
      "unreal_set_material_parameter. Assign a material to a mesh with unreal_set_component_property, or to a " +
      "level actor via unreal_spawn_actor's mesh.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Materials/M_Metal". Prefix material assets with M_ by convention.'),
      baseColor: z.string().optional().describe('Base colour as "R,G,B" or "R,G,B,A", each 0-1. Defaults to mid grey. Example: "1,0,0" for red.'),
      metallic: z.number().optional().describe("0 for non-metal (plastic, wood, stone), 1 for bare metal. Values in between are rarely physically correct. Defaults to 0."),
      roughness: z.number().optional().describe("0 is a mirror, 1 is completely matte. Most real surfaces sit between 0.2 and 0.8. Defaults to 0.5."),
      emissiveColor: z.string().optional().describe('Optional glow colour as "R,G,B". Values above 1 glow brighter, e.g. "0,5,10" for a bright blue glow. Omit for non-glowing surfaces.'),
      baseColorTexture: z
        .string()
        .optional()
        .describe(
          'Optional texture asset path for the surface colour. When given, the material becomes texture x tint: ' +
            'baseColor acts as a colour multiplier over the texture rather than replacing it, which is how a master ' +
            'material stays recolourable per instance. Verify the path with unreal_list_assets className=Texture2D.'
        ),
      normalTexture: z
        .string()
        .optional()
        .describe(
          "Optional normal map asset path, sampled as a normal map and wired to the Normal input. This is what gives " +
            "a flat surface visible bumps and detail under lighting, and is most of the difference between a surface " +
            "that reads as a real material and one that reads as coloured plastic."
        ),
    },
  },
  async ({ packagePath, baseColor, metallic, roughness, emissiveColor }) => {
    try {
      const result = await bridge.send("create_material", { packagePath, baseColor, metallic, roughness, emissiveColor });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_material_instance",
  {
    title: "Create a Material Instance from a parent material",
    description:
      "Creates a Material Instance: a cheap variation of a parent material that overrides some of its parameters " +
      "and shares everything else. Making ten coloured variants of one master material is ten instances, not ten " +
      "materials, and they cost almost nothing to add.\n\n" +
      "Override parameters afterwards with unreal_set_material_parameter. If the parent has no parameters, the " +
      "instance has nothing to override, which usually means the parent was built with constants instead of " +
      "parameters.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Materials/MI_RedMetal". Prefix instances with MI_ by convention.'),
      parentMaterial: z.string().describe('Full path of the parent, e.g. "/Game/Materials/M_Metal.M_Metal". A Material or another Material Instance.'),
    },
  },
  async ({ packagePath, parentMaterial }) => {
    try {
      const result = await bridge.send("create_material_instance", { packagePath, parentMaterial });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_material_parameter",
  {
    title: "Override a parameter on a Material Instance",
    description:
      "Sets one parameter on a Material Instance. Pass exactly one of scalar, color, or texture, matching the " +
      "parameter's kind. Parameters are overridden on an INSTANCE, never on the master material: that is the whole " +
      "point of the split, and setting it on the master would change every instance at once.\n\n" +
      "Call unreal_list_material_parameters first if you are unsure what a material exposes, rather than guessing " +
      "names.",
    inputSchema: {
      path: z.string().describe('Material Instance path, e.g. "/Game/Materials/MI_RedMetal.MI_RedMetal".'),
      parameter: z.string().describe('Parameter name, e.g. "BaseColor", "Roughness".'),
      scalar: z.number().optional().describe("Value for a scalar parameter, e.g. 0.2 for Roughness."),
      color: z.string().optional().describe('Value for a vector/colour parameter, as "R,G,B" or "R,G,B,A", each 0-1.'),
      texture: z.string().optional().describe('Full path of a texture asset for a texture parameter. Verify it with unreal_list_assets className=Texture2D.'),
    },
  },
  async ({ path, parameter, scalar, color, texture }) => {
    try {
      const result = await bridge.send("set_material_parameter", { path, parameter, scalar, color, texture });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_material_parameters",
  {
    title: "List a material's parameters",
    description:
      "Returns every scalar, colour, and texture parameter a Material or Material Instance exposes, with its kind, " +
      "and whether the asset is an instance. Use it before unreal_set_material_parameter to get names and kinds " +
      "right, and to check whether a material someone else authored is instanceable at all.",
    inputSchema: {
      path: z.string().describe('Material or Material Instance path, e.g. "/Game/Materials/M_Metal.M_Metal".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_material_parameters", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_document_asset",
  {
    title: "Document one asset and everything connected to it",
    description:
      "**The answer to \"tell me everything about X\" and \"what would break if I changed X\".** One call returns " +
      "what a Blueprint inherits, what it owns, what it does, and what it reaches: ancestry and interfaces, " +
      "components, variables with which of them replicate, each event graph's entry points with where each one RUNS " +
      "(server / multicast / owning client), and both directions of reference - what uses it, and what it uses.\n\n" +
      "Assembling this by hand is eight calls (describe_class, list_components, list_variables, " +
      "list_blueprint_graphs, read_blueprint_summary, explain_graph, find_references), and the cost is not the " +
      "point - the point is that all eight have to be remembered. This returns the same structure every time, so " +
      "nothing is dropped because it did not occur to anyone to ask.\n\n" +
      "Use unreal_map_system instead when you have a CONCEPT and no asset (\"the health system\"); use this when you " +
      "have the asset. They pair: map_system finds the pieces, this documents one of them.",
    inputSchema: {
      path: z.string().describe('The asset, e.g. "/Game/Characters/BP_Player". Both /Game/X and /Game/X.X work.'),
      graphDetail: z
        .enum(["none", "entries", "all"])
        .optional()
        .describe(
          'How much graph to expand. "entries" (default) explains the event graphs and names the rest - an event ' +
            'graph is where behaviour is triggered from, so it is the map and the functions are the streets. "all" ' +
            'explains every graph and is the expensive one on a large Blueprint. "none" just lists their names.'
        ),
      maxReferences: z
        .number()
        .optional()
        .describe("Cap on each reference list. Defaults to 40. Truncation is always stated, never silent."),
    },
  },
  async ({ path, graphDetail, maxReferences }) => {
    try {
      return jsonResult(await documentAsset(bridge, path, { graphDetail, maxReferences }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_map_system",
  {
    title: "Map an existing system across the Blueprints it spans",
    description:
      "**Call this FIRST on any request that touches an existing project, before reading a single graph.**\n\n" +
      "Give it a `query` (\"health\", \"inventory\", \"door\", \"save\") and it returns the assets that make up that " +
      "system, how they reference each other, which ones are risky to change, and the order to read them in. It is " +
      "built entirely from the project index and the asset dependency graph, so mapping a twenty-asset system costs " +
      "a fraction of reading one large Blueprint.\n\n" +
      "This exists because of the single hardest thing about working on a real project: one Blueprint is wired to " +
      "five others, and no amount of describing it in prose conveys that. Without the map, the usual failure is to " +
      "read the first matching asset, assume it is the whole system, and edit it - which is how a working project " +
      "gets broken.\n\n" +
      "Use it for three things:\n" +
      "  1. **Before building anything**, to find out whether the system already exists. If it does, extend it " +
      "instead of adding a second one, and tell the user what you found.\n" +
      "  2. **Before editing**, to see what else depends on what you are about to change. `highRisk` lists assets " +
      "with referencers outside the system: changing those is a project-wide event.\n" +
      "  3. **To decide what to read**, using `readingOrder`, which puts the most depended-on assets first because " +
      "they define the contracts the rest obey.\n\n" +
      "An empty result is informative: it means the system genuinely is not there, or is named something else.",
    inputSchema: {
      query: z.string().optional().describe('The concept, in the project\'s own words, e.g. "health", "inventory", "vacuum". Try one word first; narrow only if the map is truncated.'),
      /** Ten tools spell this `match`. See the note on unreal_search_project. */
      match: z.string().optional().describe("Same as `query`."),
      maxAssets: z.number().optional().describe("Cap on assets in the map. Defaults to 25. Raise it if the map reports being truncated."),
      depth: z.number().optional().describe("How many reference hops to follow out from the matches. Defaults to 2, which is usually the whole system. 1 is tighter, 3 tends to pull in the entire project."),
      detail: z
        .boolean()
        .optional()
        .describe("Return the full per-asset structure and edge list as well. Roughly 8x the tokens; only worth it if you need exact paths or the reference graph."),
    },
  },
  async ({ query: queryRaw, match, maxAssets, depth, detail }) => {
    const query = queryRaw ?? match;
    if (!query) {
      return errorResult(new Error("unreal_map_system needs a concept to map: pass `query` (or `match`). Nothing ran."));
    }
    try {
      const result = withDisabledToolNote(await mapSystem(bridge, query, { maxAssets, depth }), isToolEnabled);

      // The prose form is the answer by default, and the structure is opt-in.
      //
      // Measured on a real project: mapping its vacuum system is 4,370 tokens as structure and 523
      // as prose - the same 8x that made `explain_graph` worth having. The structured form is not
      // more accurate, it is the same facts with the field names repeated once per asset, and a
      // caller that needs exact paths can ask for it.
      if (detail) return jsonResult(result);

      // An empty map is the one case where the notes ARE the answer.
      //
      // mapSystem explains a zero properly: "Nothing in the project has X as a word. 3 name(s)
      // contain it inside a longer one - the way bar sits inside TurretBarrelLoc - and none of those
      // is this system." That sentence is the difference between "rename your search" and "this
      // system does not exist", and the compact reply dropped it, answering with `assetCount: 0` and
      // "Pass detail:true for exact asset paths".
      //
      // Which is advice a caller has no reason to take: they have no assets, so a flag promising
      // asset paths sounds irrelevant. The explanation was reachable only by asking for more of the
      // thing that was empty. Found by trial:diagnose failing on it.
      const empty = result.assets.length === 0;
      return jsonResult({
        query: result.query,
        assetCount: result.assets.length,
        ...(empty && result.notes?.length ? { notes: result.notes } : {}),
        text: result.text,
        readingOrder: result.readingOrder,
        highRisk: result.highRisk,
        truncated: result.truncated,
        note: empty
          ? "Pass detail:true only if you want the reference graph; the notes above are the whole answer."
          : "Pass detail:true for exact asset paths and the reference graph.",
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_plan_feature",
  {
    title: "Check a feature request against the project before building it",
    description:
      "**Call this the moment the user asks for a feature, before anything else.** Give it their request in their " +
      "own words. It checks every concept in the request against the project and reports what already exists, what " +
      "a change would affect, what is genuinely new, and the project's own naming and folder conventions.\n\n" +
      "This is the difference between a code generator and a colleague. A colleague asked for a stamina system " +
      "does not immediately start typing: they say \"you already have a stamina variable on BP_Player and a HUD bar " +
      "reading it - do you want me to extend that, or did you mean something else?\" That one sentence is worth more " +
      "than any graph you could build instead, because the alternative is a second system quietly competing with " +
      "the first, and the user will not find out for weeks.\n\n" +
      "**Relay `raiseWithUser` to the user in plain language and wait for an answer** when it says something already " +
      "exists or that a change reaches outside the system. Do not treat it as advisory and proceed anyway; that is " +
      "the exact behaviour that makes people distrust these tools.\n\n" +
      "Read-only, index-backed, and costs a fraction of one Blueprint read, so there is no budget excuse to skip it. " +
      "Follow `conventions` when naming new assets: work that looks like the rest of the project is work someone " +
      "will keep.",
    inputSchema: {
      request: z.string().describe("The user's request, in their own words. Do not rewrite or summarise it first; the wording carries the concepts."),
      concepts: z
        .array(z.string())
        .optional()
        .describe("Override the concepts to check, if you already know the project's vocabulary better than the request does (e.g. the user says \"energy\" but the project calls it Stamina)."),
    },
  },
  async ({ request, concepts }) => {
    try {
      const plan = withDisabledToolNote(await planFeature(bridge, request, { concepts }), isToolEnabled);
      return jsonResult(plan);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_actors",
  {
    title: "Read what is already in the open level",
    description:
      "**Call this before changing anything in a level.** Returns a per-class census of the whole level, plus the " +
      "actors themselves with label, name, class, rounded location, and the Blueprint behind them where there is " +
      "one.\n\n" +
      "Unfiltered, this is the show-me-around reply: the census covers everything, and the actors listed are the " +
      "ones carrying logic plus one of each remaining class. A 900-actor level is mostly meshes and lights, and " +
      "listing them costs thousands of tokens to say the level has scenery in it. Pass `classFilter` and you get " +
      "the actual actors, because at that point you have asked something specific.\n\n" +
      "Spawning into a level you have not read is how an agent ends up with two PlayerStarts, a second directional " +
      "light fighting the first, or a duplicate of something that was already there under a different name. On a " +
      "level someone has spent months dressing, that is worse than doing nothing.\n\n" +
      "The `blueprint` field on an entry tells you which actors have logic behind them, and therefore which are " +
      "worth reading with unreal_read_blueprint_summary next. Use classFilter to narrow a big level (it matches on " +
      "the class name), and remember that this reads the OPEN level: call unreal_open_level first if you mean a " +
      "different one.",
    inputSchema: {
      /**
       * Four tools call this `className`; this was the only one calling it `classFilter`.
       *
       * The spelling stays because renaming a published parameter breaks callers, but it can no
       * longer be the only way in.
       */
      classFilter: z.string().optional().describe('Only return actors whose class name contains this, e.g. "Light", "PlayerStart", "BP_".'),
      className: z.string().optional().describe("Same as `classFilter`."),
      maxResults: z.number().optional().describe("Cap on actors returned. Defaults to 40 unfiltered, 200 with a classFilter. The per-class census always covers the whole level regardless."),
    },
  },
  async ({ classFilter: classFilterRaw, className, maxResults }) => {
    const classFilter = classFilterRaw ?? className;
    try {
      // Ask the bridge for the whole level and choose in the tool layer. Which 40 actors are worth
      // showing cannot be decided by a LIMIT the engine applies in level order, and the actors the
      // bridge sends over a loopback socket cost nothing - only what this returns is paid for.
      const result = await bridge.send("list_actors", { classFilter, maxResults: 100000 });
      return jsonResult(capActorList(result as ActorListLike, { classFilter, maxResults }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_actor_property",
  {
    title: "Set a property on one placed actor",
    description:
      "Overrides a property on a single actor instance in the open level, by its World Outliner label or its name. " +
      "This is how a specific door gets a different open angle, one light gets a different colour, or one spawner " +
      "gets a different enemy class, without touching the Blueprint they all come from.\n\n" +
      "**This changes only that one instance.** To change every instance, use unreal_set_class_default on the " +
      "Blueprint instead. Getting this backwards is the classic level-editing mistake, so the response states which " +
      "one happened. Values follow the same string coercion as the other property tools, and an asset path that " +
      "does not resolve fails rather than silently setting None.\n\n" +
      "Changes live in memory until unreal_save_level.",
    inputSchema: {
      actor: z.string().describe("The actor's World Outliner label, or its internal name. Get exact values from unreal_list_actors."),
      property: z.string().describe('Property name, e.g. "LightColor", "Intensity", "bHidden".'),
      value: engineValue.describe('The value. A number or boolean is accepted and stringified; structured values are spelled the Unreal way: an asset path or "(R=1,G=0,B=0,A=1)".'),
    },
  },
  async ({ actor, property, value }) => {
    try {
      const result = await bridge.send("set_actor_property", { actor, property, value });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_delete_actor",
  {
    title: "Remove one actor from the open level",
    description:
      "Deletes a single placed actor from the currently open level, by label or name. Use it to remove template " +
      "debris, a duplicate that should not have been spawned, or something the user has asked to take out.\n\n" +
      "Read the level with unreal_list_actors first and be certain of the label: unlike unreal_delete_asset, which " +
      "refuses when something still references the target, an actor in a level can be referenced by other actors " +
      "in ways that are not checkable here. The removal is undoable in the editor and lives in memory until " +
      "unreal_save_level, so a mistake is recoverable - but only if it is noticed.",
    inputSchema: {
      actor: z.string().describe("The actor's World Outliner label, or its internal name, exactly as unreal_list_actors reports it."),
    },
  },
  async ({ actor }) => {
    try {
      const result = await bridge.send("delete_actor", { actor });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_undo_history",
  {
    title: "What the editor can currently undo",
    description:
      "Reads the editor's real undo stack, newest first. Position 1 is what the next Ctrl+Z will reverse, and every " +
      'entry says whether this bridge made it (they are titled "MCP: ..."). ' +
      "Pair it with unreal_session_changes: that reports what this server believes it changed, this reports what the " +
      "editor will actually give back. Show it to a user who is nervous about letting an agent edit their project, " +
      "or before doing something you would want reversed. Being able to say \"the last four entries are mine and " +
      "Ctrl+Z takes them back in order\" is worth more than any reassurance. " +
      "This is a read. Undo itself is performed by a human in the editor, deliberately: an agent that can silently " +
      "undo its own work can also silently undo yours.",
    inputSchema: {
      maxResults: z.number().optional().describe("How many entries to return, newest first. Defaults to 20."),
    },
  },
  async ({ maxResults }) => {
    try {
      const result = await bridge.send("undo_history", { maxResults });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_audit_project",
  {
    title: "My game has bugs. Where do I look?",
    description:
      "**Audits every Blueprint and ranks what is worth fixing, by what it is likely to cost.** " +
      "Reach for this when the request is about the project rather than about one asset - \"something is broken\", " +
      "\"clean this up before we ship\", \"what is wrong with my game\". " +
      "Ordered by cost rather than severity, because those differ: a dead event is cosmetic until somebody wires " +
      "it, while a cast that fails on every client but the host is a bug nobody can reproduce alone. " +
      "Findings are grouped: seventeen Blueprints with the same problem is one decision, not seventeen, and the " +
      "result names which to open first. " +
      "Bounded on purpose: the reply is a ranked summary, not every finding. Raise `limit` to sweep wider, or " +
      "`detailedGroups` to get more kinds back in full.",
    inputSchema: {
      pathPrefix: z.string().optional().describe('Restrict to a folder, e.g. "/Game/Player". Defaults to /Game.'),
      limit: z
        .number()
        .optional()
        .describe("How many Blueprints to examine. Defaults to 150. A large project takes about a fifth of a second each."),
      examplesPerGroup: z
        .number()
        .optional()
        .describe("Examples reported per finding kind. Defaults to 3."),
      detailedGroups: z
        .number()
        .optional()
        .describe("Finding kinds returned in full, not just counted. Default 4, max 30."),
      check: z
        .string()
        .optional()
        // Deliberately terse. This tool is in `minimal`, whose ceiling exists so the profile fits a
        // 14B model at 8k context with room left to think, and the first draft of this sentence put
        // it 73 tokens over. The reasoning lives in the README; the schema carries what is needed to
        // call it correctly and nothing else.
        .describe('One finding kind from an earlier audit, in full - e.g. "repnotify-does-nothing". The rest stay counts.'),
    },
  },
  async ({ pathPrefix, limit, examplesPerGroup, detailedGroups, check }) => {
    try {
      const audit = await auditProject(bridge, { pathPrefix, limit, examplesPerGroup, detailedGroups, check });

      // Name the fix tools this session cannot currently call.
      //
      // Found by extracting every `unreal_*` mentioned in a `fix` string and holding it against the
      // diagnose preset: a preset whose stated job is "find and fix a reported bug" was telling
      // callers to use tools it does not switch on - call_parent_function among them, which is the
      // whole remedy for a cost-95 finding.
      //
      // The obvious repair is to put them in the preset, and the arithmetic says no: three tools cost
      // 870 tokens of standing context, on every request, to save one enable_tools call of about a
      // hundred and fifty that most sessions never need. The same sum that removed the group bullets
      // from enable_tools' own description.
      //
      // So it is said here, where the server knows what is actually enabled, only about tools that
      // are actually off, and only when a finding actually named one. A complete answer pays nothing.

      // The explanation of the cap lives in the reply rather than in the schema, so it is paid for
      // only when it actually applies. In the schema it was ~350 characters on every request of
      // every session, which pushed the `minimal` profile past the ceiling that exists to keep it
      // loadable on a 14B at 8k - a good sentence in the wrong place.
      const elided = audit.groups.filter((g) => g.detailElided).length;
      const withFixTools = withDisabledToolNote(audit, isToolEnabled);
      return jsonResult(
        elided > 0
          ? {
              ...withFixTools,
              detailNote:
                `${elided} further finding kind(s) are listed with counts only and marked ` +
                `detailElided. They have no \`fix\` field because the remedy was dropped to keep this ` +
                `reply small, NOT because there is no remedy. Re-run with detailedGroups: ${Math.min(
                  audit.groups.length,
                  30
                )} to see them.`,
            }
          : withFixTools
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_project_health",
  {
    title: "Find where the project needs attention, without reading it",
    description:
      "**To find actual problems rather than shape, use unreal_audit_project.** Scans the whole project for the Blueprints most worth looking at: graphs too large to read at a glance, " +
      "Blueprints that have grown into systems rather than classes, and cast-heavy Blueprints where an interface " +
      "should have replaced the chain. " +
      "unreal_review_blueprint answers \"is this one Blueprint good?\". Nobody asks that first. On a project someone " +
      "has been building for months the real question is \"where is the damage?\", and answering it by reviewing " +
      "every Blueprint in turn costs a read per asset. This costs none: it is computed from node-type histograms " +
      "the project index already keeps. " +
      "Use it to orient at the start of work on an unfamiliar project, or when a user asks what needs cleaning up. " +
      "Then run unreal_review_blueprint on the specific Blueprints it names. " +
      "Every finding says what it measured and every threshold explains itself, because these are places worth " +
      "LOOKING at rather than defects. A large graph can be perfectly fine. Deliberately absent: per-frame Tick " +
      "work, because the index stores node classes and cannot tell an Event Tick from an Event BeginPlay - " +
      "guessing would produce confident false positives on the measure people most want to trust. " +
      "unreal_review_blueprint reads real titles and reports that properly.",
    inputSchema: {
      maxPerCategory: z.number().optional().describe("How many offenders to list per category, worst first. Defaults to 10."),
    },
  },
  async ({ maxPerCategory }) => {
    try {
      const result = await bridge.send("project_health", { maxPerCategory });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_guard_with_authority",
  {
    title: "Make this part run only on the server",
    description:
      "Puts a node behind a Branch on HasAuthority, keeping the chain it is already in. " +
      "**This is the fix for a cast to a GameMode from anything that also runs on a client** - the most expensive " +
      "thing unreal_audit_project reports, because it fails silently on every client and takes every node after it " +
      "with it. " +
      "It reroutes whatever currently runs into the node so it goes through the guard instead, then re-reads the " +
      "graph to confirm the node is no longer reachable directly. " +
      "Use `dryRun` to see the exact edit first. It refuses if the node has no incoming execution, because then " +
      "there is no chain to guard and it would have to invent one. " +
      "It is not a design decision: moving the state onto the GameState is often the better answer, and this cannot " +
      "know that.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().describe('Graph containing the node, e.g. "EventGraph".'),
      nodeId: z.string().describe("Node id from unreal_read_blueprint_summary. A leading prefix is enough."),
      dryRun: z.boolean().optional().describe("Report the edit without making it."),
      compile: z.boolean().optional().describe("Compile afterwards. Defaults to true."),
    },
  },
  async ({ path, graphName, nodeId, dryRun, compile }) => {
    try {
      return jsonResult(await guardWithAuthority(bridge, path, graphName, nodeId, { dryRun, compile }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_cleanup_blueprint",
  {
    title: "Act on the review findings that are safe to fix automatically",
    description:
      "Runs the quality review and applies the fixes that cannot change what the Blueprint does: removing nodes " +
      "wired to nothing, and laying the graph out with each execution chain in a labelled comment box. Then it " +
      "re-reviews and reports the score before and after, because a cleanup that claims success without checking is " +
      "the same failure as a model that reads findings and declares victory. " +
      "What it deliberately does NOT touch is listed in `leftForYou`, each with the reason. Removing a leftover " +
      "Print String means healing the execution chain around it; renaming a placeholder variable needs a name; an " +
      "unhandled cast failure needs a decision about what should happen. Those are yours, and the tool says so " +
      "rather than silently leaving them. " +
      "The narrowness is the design. A cleanup tool that quietly changes behaviour is far more damaging than one " +
      "that leaves work on the table, because whoever runs it is least able to notice. Pass dryRun to see what " +
      "would change first.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      removeDeadNodes: z.boolean().optional().describe("Remove nodes connected to nothing. Defaults to true; they cannot affect behaviour."),
      labelSections: z.boolean().optional().describe("Lay out the graph and wrap each execution chain in a titled comment box. Defaults to true; purely cosmetic."),
      dryRun: z.boolean().optional().describe("Report what would change without changing anything. Defaults to false."),
    },
  },
  async ({ path, removeDeadNodes, labelSections, dryRun }) => {
    try {
      const report = await cleanupBlueprint(bridge, path, { removeDeadNodes, labelSections, dryRun });
      return jsonResult(report);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_event_handler",
  {
    title: "When this happens, do these things",
    description:
      "**The easiest way to make something happen, and the first thing to reach for.** Give an event and the calls " +
      "that should follow, in order; the execution chain is wired for you, so you name no pins, refs, or " +
      'connections. Events: "BeginPlay", "Tick", "ActorBeginOverlap" map to the engine ones; any other name makes a ' +
      "Custom Event. A function's class is looked up in the live engine if you omit it, and one this engine does " +
      "not have is refused before anything is built. Everything lands in one atomic call. " +
      "For branches, loops, or wiring one node's output into another's input, build the graph in one call.",
    inputSchema: {
      path: z.string().describe('Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.'),
      graphName: z.string().optional().describe('Graph to build in. Defaults to "EventGraph".'),
      event: z
        .string()
        .describe('The trigger: "BeginPlay", "Tick", "ActorBeginOverlap", or any other name to make a Custom Event.'),
      actions: z
        .array(
          z.object({
            function: z.string().optional().describe('Function to call, e.g. "PrintString".'),
            // Six tools spell this `functionName`, so it is accepted here too - see
            // scripts/check-param-names.mjs. A model that has read those six types `functionName`
            // in this array and pays a failed call to learn a synonym.
            functionName: z.string().optional().describe("Same as `function`."),
            className: z.string().optional().describe('Owning class, e.g. "KismetSystemLibrary". Looked up if omitted.'),
            params: z
              .record(engineValue)
              .optional()
              .describe('Input values by pin name, e.g. {"In String":"hello"}. Near-miss pin names are resolved for you.'),
          })
        )
        .describe("What happens, in order. They are chained together for you."),
      compile: z.boolean().optional().describe("Compile afterwards. Defaults to true."),
    },
  },
  async ({ path, graphName, event, actions, compile }) => {
    // One shape reaches the builder, whichever spelling arrived. Refused here rather than deeper,
    // so the caller is told which entry is missing a name instead of the builder failing on it.
    const normalisedActions = (actions ?? []).map((a, i) => {
      const fn = a.function ?? a.functionName;
      if (!fn) {
        throw new Error(`action ${i + 1} has no function name: give it \`function\` (or \`functionName\`).`);
      }
      return { ...a, function: fn };
    });
    try {
      const result = await addEventHandler(bridge, path, graphName ?? "EventGraph", event, normalisedActions, { compile });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_scaffold_blueprint",
  {
    title: "Build a whole Blueprint in one call",
    // The rationale for this tool - the measured four-step failure of small models - lives in
    // src/scaffold.ts and docs/LOCAL_MODEL_BENCHMARK.md, deliberately not here. A description is
    // paid on every request by every client; the reasoning behind it is paid once by a reader.
    // This project measured ~600 extra characters pushing a 7B into truncating its output
    // mid-JSON, so the budget is spent on what a caller needs in order to act.
    description:
      "**Build the entire thing in one call: the Blueprint, its variables, its components, and its event logic.** " +
      "Reach for this first whenever you are creating something new. " +
      "The order is handled for you: variables and components exist before any graph references them, and the " +
      "Blueprint is compiled once at the end, then laid out, reviewed and saved. " +
      "A step that fails is reported in `failures` and the rest still proceeds. " +
      "Everything here is also available as separate tools if you need finer control.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Blueprints/BP_Pickup".'),
      parentClass: z.string().describe('Parent class: "Actor", "Pawn", "Character", "ActorComponent", or a Blueprint path.'),
      variables: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().describe('Compact type: "float", "int", "bool", "text", "object:Texture2D", "struct:S_Item", "enum:E_State".'),
            defaultValue: z.string().optional(),
          })
        )
        .optional()
        .describe("Member variables. Added before any graph logic that might reference them."),
      components: z
        .array(
          z.object({
            componentClass: z.string().describe('e.g. "StaticMeshComponent", "SphereComponent", "AudioComponent", "NiagaraComponent".'),
            name: z.string(),
            parent: z.string().optional().describe("Attach under this component instead of the root."),
            properties: z.record(engineValue).optional().describe('Properties to set, e.g. {"SphereRadius":"120"}.'),
          })
        )
        .optional()
        .describe("Components, with their properties set for you."),
      handlers: z
        .array(
          z.object({
            event: z.string().describe('"BeginPlay", "Tick", "ActorBeginOverlap", or any name for a Custom Event.'),
            actions: z
              .array(
                z.object({
                  function: z.string().optional(),
                  functionName: z.string().optional(),
                  className: z.string().optional().describe("Looked up in the live engine when omitted."),
                  params: z.record(engineValue).optional(),
                })
              )
              .describe("What happens, in order. The execution chain is wired for you."),
          })
        )
        .optional()
        .describe("Event logic. No pin names, refs, or connections needed."),
      save: z.boolean().optional().describe("Save at the end. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, variables, components, handlers, save }) => {
    try {
      const result = await scaffoldBlueprint(bridge, {
        packagePath,
        parentClass,
        // Normalised here too, or scaffold and add_variable would take different vocabularies for
        // the same thing - two tools disagreeing about one concept, which is the defect this repo
        // keeps finding and would have introduced by fixing only half the surface.
        variables: normaliseFieldTypes(variables),
        components,
        // Same normalisation as unreal_add_event_handler: whichever spelling arrived, one shape
        // reaches the builder.
        handlers: (handlers ?? []).map((h) => ({
          ...h,
          actions: (h.actions ?? []).map((a, i) => {
            const fn = a.function ?? a.functionName;
            if (!fn) {
              throw new Error(`handler "${h.event}" action ${i + 1} has no function name: give it \`function\` (or \`functionName\`).`);
            }
            return { ...a, function: fn };
          }),
        })),
        save,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_asset_status",
  {
    title: "Can this asset actually be written?",
    description:
      "Reports whether an asset can be saved, and if not, why - **before** you spend a sequence of edits on it. " +
      "On a team project a Blueprint is a binary asset that cannot be merged, so it is locked by whoever checked it " +
      "out, and without this the failure only surfaces at save time, after the work is done. " +
      "**Check this before editing anything in a project that uses source control.** If it comes back not writable, " +
      "say so to the user and offer to work on something else: \"BP_Door is checked out by alice, so I cannot save " +
      "changes to it\" is a far better answer than a pile of edits that cannot be written. " +
      "Deliberately a separate call rather than a check inside every write, because querying source control can hit " +
      "the network and paying that per node placement would slow the common case to protect the rare one.",
    inputSchema: {
      path: z.string().describe('Asset path, e.g. "/Game/Blueprints/BP_Door.BP_Door".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("asset_status", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  // `unreal-mcp-server --doctor` runs the same diagnosis from a terminal, with no MCP client
  // involved. When the complaint is "my AI tool cannot see Unreal", removing the AI tool from the
  // picture is the fastest way to find out which half is broken.
  // "lazy": everything is registered with full schemas, but only the core group is switched on.
  // The rest arrive when unreal_enable_tools asks for them.
  if (PROFILE === "lazy") {
    for (const [name, handle] of toolHandles) {
      if (!CORE_PROFILE_TOOLS.has(name) && !DEFERRAL_TOOLS.has(name)) handle.disable();
    }
  }

  // "search": only ping, doctor, and the two meta-tools stand. Everything else is registered with
  // its full schema and switched off, so tools/list costs about a thousand tokens instead of 25k,
  // and one unreal_enable_tools call brings back whatever the job actually needs - fully typed.
  if (PROFILE === "search") {
    for (const [name, handle] of toolHandles) {
      if (!SEARCH_PROFILE_TOOLS.has(name) && !DEFERRAL_TOOLS.has(name)) handle.disable();
    }
  }

  // `full` switches everything on, so dispatching through unreal_call_tool would add a hop and its
  // own schema to the one profile that already pays for every tool directly. Off.
  if (PROFILE === "full") {
    for (const name of DEFERRAL_TOOLS) toolHandles.get(name)?.disable();
  }

  // `--print-config` emits the exact JSON to paste into a client, with absolute paths already
  // resolved.
  //
  // Client setup is its own category of failure, and it is entirely self-inflicted: a missing comma
  // breaks the whole file, a relative path silently does not resolve, and on Windows a bare "node"
  // may not be on the PATH the client uses. Every one of those produces the same symptom - the
  // server never starts and the user has no idea why. None of it is interesting, and none of it
  // should be typed by hand by someone whose actual goal is to make a game.
  if (process.argv.includes("--print-config")) {
    const entry = fileURLToPath(import.meta.url);
    const clientIndex = process.argv.indexOf("--client");
    const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : "claude-desktop";
    const isWindows = process.platform === "win32";
    // Built from a char code: a literal backslash in a path string is the single most common
    // thing to lose to an editor, a shell, or a copy-paste on the way here.
    const BACKSLASH = String.fromCharCode(92);

    // process.execPath is the node that is running THIS, so it is guaranteed to exist and to be
    // the right one. "node" would depend on the client's PATH, which is the usual cause of a
    // server that never starts.
    const server = {
      command: process.execPath,
      args: [entry],
      env: {
        // "search", not "lazy". Every client this prints for - Claude Desktop, Claude Code, Cursor -
        // drives a frontier model, and "lazy" was chosen for the opposite case: it still stands 28
        // tools up front at 12,629 tokens a turn. "search" stands four, and a capable model buys the
        // rest back in one call with the real schemas intact. Local-model users set the profile
        // explicitly; they are the ones the smaller profiles were measured for.
        UNREAL_MCP_PROFILE: process.env.UNREAL_MCP_PROFILE ?? "search",
        // DEFAULT_MODE, not a literal. The profile line above had exactly this bug - it said "lazy"
        // while the in-process default was "full", so the documented install path and the code
        // disagreed for months and nothing noticed. Reading the constant makes that impossible.
        UNREAL_MCP_MODE: process.env.UNREAL_MCP_MODE ?? DEFAULT_MODE,
      },
    };

    /**
     * Claude Code takes the SERVER object; the file-editing clients take the wrapper.
     *
     * This printed `{ "mcpServers": { "unreal": ... } }` for all three while telling Claude Code
     * users to run `claude mcp add-json unreal '<the JSON below>'`. That command takes the server
     * object on its own, so following the instruction literally registers a server whose config is
     * another config - and the failure arrives later, as a server that will not start, with nothing
     * pointing back here.
     *
     * It is the first thing anyone does with this project, and it was the one instruction that did
     * not match its own payload.
     */
    const configs: Record<string, unknown> = {
      "claude-desktop": { mcpServers: { unreal: server } },
      cursor: { mcpServers: { unreal: server } },
      "claude-code": server,
    };
    const chosen = configs[client] ?? configs["claude-desktop"];

    const where: Record<string, string> = {
      "claude-desktop": isWindows
        ? `%APPDATA%${BACKSLASH}Claude${BACKSLASH}claude_desktop_config.json`
        : "~/Library/Application Support/Claude/claude_desktop_config.json",
      cursor: isWindows ? `%USERPROFILE%${BACKSLASH}.cursor${BACKSLASH}mcp.json` : "~/.cursor/mcp.json",
      "claude-code": "claude mcp add-json unreal '<the JSON below>'",
    };

    if (client === "claude-code") {
      console.log(`# Run: ${where["claude-code"]}`);
      console.log("#");
      console.log("# The JSON below is the server object that command expects - not a file to edit,");
      console.log('# and not wrapped in "mcpServers". Paths are absolute and correct for this machine.');
      console.log("#");
      console.log("# On Windows PowerShell the single quotes above are not string delimiters: use");
      console.log("#   claude mcp add-json unreal '<json>'   in Git Bash, or double the inner quotes");
      console.log("#   in PowerShell. `claude mcp list` afterwards should show unreal.");
      console.log("#");
      console.log("# Start a NEW session to pick it up - an open one keeps the tool list it started with.");
    } else {
      console.log(`# Paste this into: ${where[client] ?? where["claude-desktop"]}`);
      console.log("#");
      console.log("# Paths are absolute and already correct for this machine. If the file already has");
      console.log('# an "mcpServers" block, add the "unreal" entry inside it rather than replacing it.');
      console.log("# Then FULLY QUIT the client and reopen it - closing the window is not enough.");
    }
    console.log("");
    console.log(JSON.stringify(chosen, null, 2));
    process.exit(0);
  }

  if (process.argv.includes("--doctor")) {
    const report = await runDoctor(rawBridge, { host: BRIDGE_HOST, port: BRIDGE_PORT, expectedProject: EXPECT_PROJECT });
    console.log(formatDoctorReport(report));
    process.exit(report.verdict === "not_connected" ? 1 : 0);
  }

  const transport = new StdioServerTransport();
  // The one place that sees the finished payload. See trimSchemaDeclaration.ts: the $schema line is
  // 50 characters repeated once per tool, about 1,338 tokens on every request, declaring a dialect
  // that changes nothing about what these schemas accept.
  const sendUnmodified = transport.send.bind(transport);
  transport.send = (message) => sendUnmodified(stripSchemaDeclaration(message));
  await server.connect(transport);
  console.error(
    `unreal-mcp-server: connected via stdio; bridge target ${BRIDGE_HOST}:${BRIDGE_PORT}; ` +
      `profile "${PROFILE}" with ${[...toolHandles.values()].filter((h) => h.enabled).length}/${registeredToolNames.length} tools enabled; ` +
      `mode "${MODE.mode}"${READ_ONLY ? "; READ-ONLY: every command that changes anything is refused" : ""}`
  );
  if (MODE_WARNING) {
    console.error(`unreal-mcp-server: ${MODE_WARNING}`);
  }
  const KNOWN_PROFILES = ["minimal", "core", "lazy", "search", "full"];
  if (!KNOWN_PROFILES.includes(PROFILE)) {
    console.error(
      `unreal-mcp-server: unknown UNREAL_MCP_PROFILE "${PROFILE}", treated as "full". ` +
        `Valid: ${KNOWN_PROFILES.join(", ")}.`
    );
  }
}

main().catch((err) => {
  console.error("unreal-mcp-server: fatal error", err);
  process.exit(1);
});

