#!/usr/bin/env node
// Measure the tool-definition payload of every profile, and refuse to let it creep.
//
// This project has a measured finding that makes profile size a correctness concern rather than a
// tidiness one: a 14B on a 12 GB card loads at 8k context and fails outright at 16k, so a tool list
// that is itself ~9k tokens consumes the entire budget such a model has. **Tool payload size does
// not merely cost tokens; it decides which models can be driven at all.**
//
// The sizes were measured once by hand and written into the docs, where they promptly began to rot
// — four tools were added to `lazy` without anyone re-measuring. A number in a document that
// nothing checks is a number that is eventually wrong, so this measures them and fails when a
// profile crosses the ceiling its intended model can hold.
//
// Usage: node scripts/measure-profiles.mjs [--json]
//
// Needs no editor: tool definitions are static, which is exactly why this can run in the normal
// test suite while live-verify cannot.

import { startAndInitialize, listTools, estimateTokens } from "./lib/mcpStdio.mjs";
import { pathToFileURL } from "node:url";

const NEWLINE = String.fromCharCode(10);

// Ceilings, with the reason each one is where it is. These are budgets, not observations: raising
// one should be a decision someone argues for, not something that happens by adding a tool.
//
// All five were restated once, when this script started counting the `instructions` field. That
// field is standing context - a client sends it to the model every turn, exactly as it sends tool
// definitions - and counting only tools/list understated `search`, the frontier default, by 44%.
//
// The restatement is a CORRECTION, not a relaxation. Every ceiling encoded an intent about what a
// model has to hold before it can work; that intent always applied to the whole payload, and the
// old numbers simply measured part of it. Nothing got bigger on the day these changed. The new
// numbers keep the same intent against the quantity that was meant all along, and each is written
// as a fraction of the context it has to fit inside so the next person can check the arithmetic
// rather than trust the number.
export const PROFILES = [
  {
    name: "minimal",
    // The profile that exists for the 14B-at-8k case. Half its context on tool definitions is
    // already generous; more than that and there is no room left to work in.
    // 5,000 of 8,192 is 61%, leaving ~3.2k to think and work in. Was 4,000 when only tools were
    // counted, which meant the real figure was ~4,800 all along and nobody was looking at it.
    ceilingTokens: 5_000,
    why: "must fit a 14B capped at 8k context with room left to think",
  },
  {
    name: "search",
    // Four tools: ping, doctor, list_tools, enable_tools. This is the frontier default, and the
    // ceiling is low on purpose - the moment anything else is standing here, the profile has
    // stopped being what it claims to be and the saving it exists for is gone.
    // Of this, 990 is instructions and only ~1,240 is tools. The instructions are what make four
    // tools usable at all, so they are the last thing to cut; 2,500 is still ~1% of a 200k window.
    ceilingTokens: 2_500,
    why: "the frontier default: everything reachable, almost nothing standing",
  },
  {
    name: "core",
    // Deliberately the same ceiling as `lazy`, because they expose the same tools: `core` registers
    // only this set, while `lazy` registers everything and disables all but this set so it can grow
    // at runtime. Identical tools/list output is the correct result, not a bug - which this script
    // established the hard way by asserting otherwise first.
    ceilingTokens: 13_000,
    why: "exposes the same surface as lazy, which a small model must hold before it can work",
  },
  {
    name: "lazy",
    // The recommended default, and the one the 5/5 local-model result was measured with.
    ceilingTokens: 13_000,
    why: "the recommended default; the local-model benchmark result is measured with this",
  },
  {
    name: "full",
    // Raised from 32,000 once, loudly, with the argument the header asks for.
    //
    // That number was set when `full` exposed 80 tools. It now exposes 95, and the growth is
    // capability rather than prose: C++ compilation, Data Asset properties, class defaults, Anim
    // Blueprints, Behavior Trees, project-wide variable tracing. The number that says whether
    // descriptions are bloating is the per-tool average, and it is flat - about 320 tokens a tool
    // then, about 330 now, after trimming the three newest descriptions that had drifted long.
    //
    // 34,000 is 17% of a 200k window, for the profile whose whole premise is "everything, for a
    // model that can afford it". Anything that cannot afford it has `search` and the presets, which
    // is where the real work on this went.
    // Raised a second time, to 36,000, and for the first time NOT on the strength of the per-tool
    // average alone - that argument is now enforced by PER_TOOL_CEILING above rather than restated
    // here. Between the two raises `full` gained live runtime observation, variable replication,
    // Niagara, Behavior Trees, Animation Blueprints, C++ compilation and Data Assets, and the
    // average went 320 -> 330 -> 335. The surface grew because the tool can do more.
    //
    // What is being protected has not changed: 36,000 is 18% of a 200k window, for the profile whose
    // entire premise is "everything, for a model that can afford it". Nothing that cannot afford it
    // should be loading this - `search` costs 2,373 and the presets 4-10k, which is where the real
    // work went, and all four of those profiles have comfortable headroom.
    //
    // Raised a third time, to 37,000, for three tools that read and change Enhanced Input - the
    // system every UE5 project keeps its key bindings in, and which nothing here could touch. The
    // raise was not the first move: the description of read_class_defaults was tightened by 66
    // tokens first, which was not enough on its own, and unreal_build_graph was looked at and left
    // alone. Trimming descriptions was measured and rejected as a lever for this project years of
    // sessions ago - they are the teaching a model relies on, and the per-tool average is 339
    // against a 420 ceiling, so there is no bloat to reclaim. The surface grew because the tool can
    // do more, which is the only reason this number is ever allowed to move.
    // Raised a fourth time, to 37,500, for unreal_find_in_data_tables. The gap it closes was found
    // by trying to answer a change request - "the machine gun should cost 500 instead of 300" - and
    // discovering that nothing in this server could locate the number. search_project indexes
    // Blueprint names, parents, functions and variables; a search for "Weapon_MachineGun", a real
    // row in this project, returned zero hits. An entire substrate of a data-driven game was
    // unsearchable, which made "whether it's C++ or Blueprints or a Data Table" untrue for one of
    // the three.
    //
    // Same order of moves as the last raise, and the raise was again not the first of them: the new
    // tool's own description was cut from 963 to 660 characters and its parameter prose tightened,
    // which took it from 263 tokens over to 180. Every tool description was then scanned for
    // repeated sentences - the whole surface holds 18 tokens of duplication, so there is nothing to
    // reclaim there either.
    //
    // The number that says whether this is bloat is the per-tool average, and it did not move: 339
    // before and 339 after, against a 420 cap. The profile is larger because it does more.
    // Raised a fifth time, to 38,000, for four tools that close the same kind of gap: you could
    // create things here and never remove or rename them. rename_asset and duplicate_asset are the
    // two content-browser operations a person does every day; rename_variable and remove_variable
    // are the same asymmetry one level down, and rename_variable is what "rename FireRate to
    // RateOfFire" - the sentence the change-request routing was built against - actually asks for.
    //
    // The number that says whether this is bloat went DOWN: 331 tokens per tool before these four,
    // 330 after, against a 420 cap. The surface grew because it does more.
    //
    // Raised rather than left at four tokens of headroom, which is where these four landed it. A
    // ceiling that cannot absorb a typo fix is not a budget, it is a tripwire for whoever works here
    // next - and the point of this number is to force an argument, not to block one.
    ceilingTokens: 38_000,
    why: "everything, for frontier models that can afford it",
  },
];

/**
 * What one tool is allowed to cost, on average, in any profile.
 *
 * This is the number that distinguishes the two things a rising total can mean, and until now it was
 * printed and never checked. A total that grows because six new capabilities arrived is the tool
 * getting better; a total that grows because descriptions are drifting long is the tool getting
 * worse, and only the per-tool average tells them apart. `full`'s own ceiling comment has said so
 * since it was last raised - "the number that says whether descriptions are bloating is the per-tool
 * average, and it is flat" - while the assertion underneath it went on gating the total.
 *
 * 420 against a spread of 335-376 today. Close enough to catch a description that doubles, loose
 * enough that adding a tool with an honest paragraph does not trip it. It is the tighter guard of
 * the two: a total ceiling can be argued up when real capability arrives, and this one cannot,
 * because nothing about new capability makes the average tool more expensive.
 */
const PER_TOOL_CEILING = 420;

async function measure(profile) {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: profile }, "measure-profiles");
  try {
    // Taken before the reachability probe below enables anything, or every profile would measure as
    // `full`.
    const { tools, chars, tokens } = await listTools(server);

    // The instructions field counts. A client sends it to the model on every turn exactly as it
    // sends tool definitions, so leaving it out did not make it free - it made this check report
    // less than half the standing cost on the `search` profile, which is the frontier default.
    const instructionChars = (server.instructions ?? "").length;
    const instructionTokens = estimateTokens(instructionChars);

    // Every tool the standing text names has to be reachable from this profile.
    //
    // "Reachable" is measured, not assumed, because the profiles differ in kind. `search` and `lazy`
    // DEFER: the other tools are registered and switched off, and unreal_enable_tools turns them on -
    // so naming them is exactly right. `minimal` and `core` are FIXED: a tool outside the list is
    // never registered at all, there is no handle to switch on, and naming it is a lie. Asking each
    // server what it can actually reach avoids having to encode that difference here and get it
    // wrong later.
    //
    // Worth the trouble: `minimal` named 18 tools and could reach 11. The first thing its step 1 told
    // a model to call (unreal_doctor), the tool step 5 was built around (unreal_build_graph), and the
    // one step 8 demanded before reporting anything done (unreal_verify_feature) were all absent -
    // aimed at the weakest models, which are the reason that profile exists and the least able to
    // recover from a tool that is not there.
    await server
      .request("tools/call", {
        name: "unreal_enable_tools",
        arguments: { groups: ["core", "cpp", "anim", "ai", "vfx", "edit", "ui", "materials", "data", "scene", "maintenance"] },
      })
      .catch(() => {});
    const afterEnabling = await listTools(server);

    // Prompts count too. unreal_handbook, unreal_recipes and unreal_workflow are named in the
    // standing text and are real - served over prompts/list, not tools/list. The first draft of this
    // check called all three unreachable on every profile, and a guard that cries wolf gets switched
    // off, so it asks both surfaces.
    const prompts = await server.request("prompts/list", {}).catch(() => ({}));
    const reachable = new Set([
      ...afterEnabling.tools.map((t) => t.name),
      ...(prompts.result?.prompts ?? []).map((p) => p.name),
    ]);
    const namedInInstructions = [
      ...new Set([...(server.instructions ?? "").matchAll(/unreal_[a-z_]+/g)].map((m) => m[0])),
    ];
    const unreachable = namedInInstructions.filter((n) => !reachable.has(n));

    const perTool = tools
      .map((t) => ({ name: t.name, chars: JSON.stringify(t).length }))
      .sort((a, b) => b.chars - a.chars);

    return {
      profile,
      toolCount: tools.length,
      chars,
      tokens,
      instructionTokens,
      standingTokens: tokens + instructionTokens,
      unreachable,
      perTool,
    };
  } finally {
    server.child.kill();
  }
}

async function main() {
  const asJson = process.argv.includes("--json");
  const results = [];
  for (const { name } of PROFILES) {
    results.push(await measure(name));
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log("Standing context by profile - what a model holds before its first call" + NEWLINE);
  console.log("  profile   tools   ~tools   ~instrs   standing   per tool   ceiling   ");
  console.log("  --------  ------  -------  --------  ---------  ---------  ----------");
  const problems = [];
  const bloated = [];
  for (const result of results) {
    const spec = PROFILES.find((p) => p.name === result.profile);
    const over = result.standingTokens > spec.ceilingTokens;
    if (over) problems.push({ ...result, spec });
    const perTool = Math.round(result.tokens / Math.max(result.toolCount, 1));
    if (perTool > PER_TOOL_CEILING) bloated.push({ ...result, spec, perTool });
    console.log(
      `  ${result.profile.padEnd(8)}  ${String(result.toolCount).padStart(6)}  ` +
        `${String(result.tokens).padStart(7)}  ${String(result.instructionTokens).padStart(8)}  ` +
        `${String(result.standingTokens).padStart(9)}  ` +
        // Per-tool is the number that says whether DESCRIPTIONS are growing. The total also grows
        // when the surface grows, which is not the same thing and should not read as the same
        // problem: adding a capability is meant to cost something.
        `${String(Math.round(result.tokens / Math.max(result.toolCount, 1))).padStart(9)}  ` +
        `${String(spec.ceilingTokens).padStart(8)}  ${over ? "OVER" : "ok"}`
    );
  }

  // The largest definitions are the actionable part: on a small model, description length is a real
  // cost, and this benchmark has already seen ~600 extra characters push a 7B into truncating its
  // output mid-JSON.
  const lazy = results.find((r) => r.profile === "lazy");
  if (lazy) {
    console.log(NEWLINE + "Largest definitions in `lazy` (where trimming pays most):");
    for (const tool of lazy.perTool.slice(0, 5)) {
      console.log(`  ${String(tool.chars).padStart(5)} chars  ${tool.name}`);
    }
  }

  // A profile whose standing text names a tool it does not have. Reported before the budget, and
  // fatal on its own, because it is a correctness failure rather than a cost one: the model is being
  // told to call something that is not there.
  const lying = results.filter((r) => r.unreachable.length > 0);
  if (lying.length > 0) {
    console.log(NEWLINE + `instructions name tools that are not registered (${lying.length} profile(s)):`);
    for (const r of lying) {
      console.log(
        `  - ${r.profile} names ${r.unreachable.length} name(s) it serves as neither a tool nor a prompt: ${r.unreachable.join(", ")}` +
          NEWLINE +
          `    This profile is fixed: a tool outside its list is never registered, so enable_tools cannot reach it.` +
          NEWLINE +
          `    Either add the tool to this profile, or stop naming it in buildInstructions() for this profile.`
      );
    }
    process.exit(1);
  }

  if (bloated.length > 0) {
    console.log(NEWLINE + `descriptions are bloating (${bloated.length} profile(s)):`);
    for (const b of bloated) {
      console.log(
        `  - ${b.profile} averages ~${b.perTool} tokens per tool across ${b.toolCount}, over the ${PER_TOOL_CEILING} ceiling.` +
          NEWLINE +
          `    This is the one that means the descriptions got worse rather than that the tool got bigger.` +
          NEWLINE +
          `    Trim the longest definitions - the list above names them - rather than raising this.`
      );
    }
    process.exit(1);
  }

  if (problems.length > 0) {
    console.log(NEWLINE + `profile budget exceeded (${problems.length}):`);
    for (const p of problems) {
      console.log(
        `  - ${p.profile} is ~${p.standingTokens} tokens standing (${p.tokens} tools + ${p.instructionTokens} instructions), over its ${p.spec.ceilingTokens} ceiling.` +
          NEWLINE +
          `    That ceiling exists because it ${p.spec.why}.` +
          NEWLINE +
          `    Either trim a description, move a tool to a group this profile does not include,` +
          NEWLINE +
          `    or argue for a higher ceiling here - but do not raise it silently.`
      );
    }
    process.exit(1);
  }
  console.log(NEWLINE + `profiles ok: ${results.length} profiles, all within budget, none naming a tool it lacks, none averaging over ${PER_TOOL_CEILING} tokens a tool`);
}

// Only when this file IS the command. measure-groups imports PROFILES from here so the two guards
// that measure the same surface cannot drift apart again - and an unguarded main() would mean that
// import silently spawned five servers, ran the whole profile measurement, and could call
// process.exit on its way out, taking its caller with it.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    console.error(`could not measure profiles: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  });
}
