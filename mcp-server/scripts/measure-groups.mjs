#!/usr/bin/env node
// What does it cost to switch a group of tools ON?
//
// The `search` profile is the frontier default and its whole premise is this: start at four tools,
// enable only the groups the job needs, and never pay for the rest. That premise has never been
// measured. `check:profiles` measures what a profile costs STANDING; nothing measured what a group
// costs to ADD, so "enable only what you need" was advice with no numbers behind it - including in
// unreal_enable_tools' own description, which a model reads before deciding what to turn on.
//
// This measures it the way a client experiences it: start the server on `search`, list tools, call
// enable_tools for one group, list again, and take the difference. No editor is needed, because
// enabling a group is a registration change and nothing more.
//
// The measured costs are also written into src/groupCosts.ts, so unreal_list_tools can tell a model
// what a group costs BEFORE it enables one. That number lives in a generated file rather than in a
// description for two reasons: a hand-written number rots (this repo has the scar - four tools were
// added to `lazy` and the documented size stayed put), and enable_tools sits in the `minimal`
// profile, which is at exactly its 4,000-token ceiling with no slack to spend on prose. A reply
// costs nothing until it is called.
//
// Run with --write after changing any tool description; without it, this FAILS when the recorded
// numbers have drifted, which is what keeps them true.
//
// Usage: node scripts/measure-groups.mjs [--json] [--write]

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { PROFILES, PER_TOOL_CEILING } from "./measure-profiles.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startAndInitialize, listTools, estimateTokens } from "./lib/mcpStdio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RECORD = join(here, "..", "src", "groupCosts.ts");

/** How far a recorded cost may drift before it is a lie rather than a rounding difference. */
const TOLERANCE_TOKENS = 150;

const NEWLINE = String.fromCharCode(10);

/** The groups unreal_enable_tools offers. Kept in the order its description lists them. */
// Asked for rather than typed out. This was the third hardcoded copy of the group list, and it is
// the one that fails quietly: a group missing here is simply never measured, so unreal_list_tools
// reports "~? tok" for it and a model choosing what to enable is choosing blind. The census names
// every group the server actually has, so ask the server.
const GROUPS = await discoverGroups();

/**
 * A ceiling on the whole surface, not on any one group.
 *
 * The number that matters is what a realistic job pays: `search` plus the groups it turns on. If
 * enabling everything costs about what `full` costs, the profile is doing its job - the saving comes
 * from not enabling everything, not from the groups being individually cheap.
 *
 * Taken FROM the `full` profile rather than written down again, because the two are the same
 * measurement: every group enabled and every tool registered are the same set of tools. They were
 * two separate literals until they disagreed - `full` was raised to 34,000 once, loudly, with a
 * recorded argument, and this was left at 32,000, so a surface inside its documented budget was
 * reported as over a stale one. Deriving it means the argument only has to be made in one place.
 */
// Every group enabled is judged the way `full` is judged: per tool, not in total.
//
// This read PROFILES.find(p => p.name === "full").ceilingTokens, and `full` deliberately has no such
// field - it is the one profile with no fixed size, budgeted per tool instead. So the ceiling was
// `undefined`, `everything.tokens > undefined` is always false, and this check has been unable to
// fail since that change. It still printed "groups ok: ... everything-on within undefined tokens",
// which is the exact shape this project keeps finding: a guard reporting success while watching
// nothing, with the word `undefined` sitting in the output where a number should be.
//
// Using the per-tool rule rather than restoring a total is the honest fix. Enabling every group is
// the same surface `full` stands, so it should answer to the same standard, and a total would go
// stale every time a group gains a tool.

/**
 * Every group the server actually has, from its own census.
 *
 * "core" is not in the census - it is the profile's set rather than a group - so it is added, which
 * is the one thing this still has to know.
 */
async function discoverGroups() {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "measure-groups-discover");
  try {
    const result = await server.request("tools/call", {
      name: "unreal_list_tools",
      arguments: {},
    });
    const census = JSON.parse((result.result ?? result).content[0].text);
    // Deduplicated: the census counts tools by the group they were registered under, and core tools
    // are registered under "core" - so it is already in there. Prepending it unconditionally wrote
    // the key twice and TypeScript refused the generated file, which is a fine way to find out.
    return [...new Set(["core", ...Object.keys(census.groups)])];
  } finally {
    server.child.kill();
  }
}

async function measureGroup(group) {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "measure-groups");
  try {
    const before = await listTools(server);
    const result = await server.request("tools/call", {
      name: "unreal_enable_tools",
      arguments: { groups: [group] },
    });
    // A group that fails to enable would otherwise measure as "costs nothing", which is the most
    // dangerous possible reading of this table.
    const text = JSON.stringify(result?.result ?? {});
    if (result?.result?.isError) throw new Error(`enable_tools failed for "${group}": ${text.slice(0, 200)}`);

    const after = await listTools(server);
    if (after.tools.length <= before.tools.length) {
      throw new Error(`enabling "${group}" added no tools - the group name is probably wrong`);
    }
    return {
      group,
      addedTools: after.tools.length - before.tools.length,
      addedTokens: after.tokens - before.tokens,
      totalTokens: after.tokens,
    };
  } finally {
    server.child.kill();
  }
}

/**
 * What one Blueprint feature costs if you name the tools instead of enabling a group.
 *
 * The server instructions tell every frontier model this is much cheaper. That was a hand-written
 * "~4.5k" for a long time; it happened to be right (measured 4,552), but a number nobody checks is
 * a number that is eventually wrong, and this one is read by every session on the frontier default.
 */
const FEATURE_SET = [
  "unreal_scaffold_blueprint",
  "unreal_add_component",
  "unreal_build_graph",
  "unreal_compile_blueprint",
  "unreal_review_blueprint",
  "unreal_save_blueprint",
  "unreal_find_node",
  "unreal_read_blueprint_summary",
];

async function measureFeatureSet() {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "measure-groups");
  try {
    const result = await server.request("tools/call", {
      name: "unreal_enable_tools",
      arguments: { tools: FEATURE_SET },
    });
    if (result?.result?.isError) throw new Error("enable_tools rejected an exact tools list");
    const after = await listTools(server);
    if (after.tools.length < FEATURE_SET.length) {
      throw new Error(`naming ${FEATURE_SET.length} tools enabled only ${after.tools.length - 4}`);
    }
    return after.tokens;
  } finally {
    server.child.kill();
  }
}

/**
 * What each preset costs on its own.
 *
 * Measured because the answer is not "presets are always cheaper". One is much cheaper than `core`;
 * stacking four of them measured 14,368, which is MORE than `core` at 11,666. A model doing a job
 * that spans four surfaces should enable the group, and it can only know that if the numbers exist.
 */
async function measurePresets() {
  const rows = [];
  for (const preset of ["diagnose", "feature", "ui", "data", "cpp"]) {
    const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "measure-groups");
    try {
      const r = await server.request("tools/call", { name: "unreal_enable_tools", arguments: { preset } });
      if (r?.result?.isError) throw new Error(`preset "${preset}" would not enable`);
      const after = await listTools(server);
      rows.push({ preset, tools: after.tools.length, tokens: after.tokens });
    } finally {
      server.child.kill();
    }
  }
  return rows;
}

async function measureAllGroups() {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "measure-groups");
  try {
    const before = await listTools(server);
    await server.request("tools/call", { name: "unreal_enable_tools", arguments: { groups: GROUPS } });
    const after = await listTools(server);
    return { baseline: before, everything: after };
  } finally {
    server.child.kill();
  }
}

/** The generated record unreal_list_tools reads. Generated, so nobody has to remember to update it. */
function renderRecord(rows, baseline, everything, featureSet, presets) {
  const entries = rows.map((r) => `  ${r.group}: ${r.addedTokens},`).join(NEWLINE);
  return [
    "// GENERATED by scripts/measure-groups.mjs --write. Do not edit by hand.",
    "//",
    "// What each group of tools costs to enable, in tokens of tool definitions, measured by starting",
    "// the server on the `search` profile and diffing tools/list around an enable_tools call.",
    "//",
    "// unreal_list_tools reports these so a model can choose what to switch on knowing the price.",
    "// `npm run measure:groups` fails when they drift, because a stale number here is worse than none.",
    "",
    `/** Tool-definition tokens standing on the \`search\` profile before anything is enabled. */`,
    `export const SEARCH_BASELINE_TOKENS = ${baseline};`,
    "",
    "/** Tokens added by enabling each group. */",
    "export const GROUP_COST_TOKENS: Record<string, number> = {",
    entries,
    "};",
    "",
    "/** Everything enabled at once, for the rare job that genuinely needs the whole surface. */",
    `export const ALL_GROUPS_TOKENS = ${everything};`,
    "",
    "/** Naming the eight tools one Blueprint feature needs, instead of enabling the `core` group. */",
    `export const FEATURE_SET_TOKENS = ${featureSet};`,
    "",
    "/** Standing cost of each preset, enabled on its own from the `search` baseline. */",
    "export const PRESET_COST_TOKENS: Record<string, number> = {",
    presets.map((p) => `  ${p.preset}: ${p.tokens},`).join(NEWLINE),
    "};",
    "",
  ].join(NEWLINE);
}

/** One record block, so a key that exists in two of them is read from the right one. */
function blockOf(text, constName) {
  const start = text.indexOf(constName);
  if (start < 0) return "";
  const end = text.indexOf("};", start);
  return end < 0 ? "" : text.slice(start, end);
}

/**
 * Everything this file records, compared with what was just measured.
 *
 * It used to check the fourteen groups and nothing else, while writing SEVEN more figures nobody
 * ever compared: the baseline, everything-on, the named-feature set, and all five presets. Every one
 * of them had drifted, some a long way - the baseline read 1,140 against a measured 1,536, and
 * `anim` was recorded at 306 against 1,678, understating itself more than five times over to the
 * model reading it to decide what to switch on.
 *
 * The gap was invisible because the report PRINTS all of them. A run showed the preset table and the
 * everything-on total right above a line saying costs were ok, which is a check that looks like it
 * covers what is on the screen and does not.
 *
 * The presets are read out of their own block. `ui`, `data` and `cpp` are the names of both a group
 * and a preset, and the old `\bui:\s*(\d+)` matched whichever came first in the file - which happened
 * to be the group, so the naive version would have compared a preset against a group's cost and
 * called it drift, or worse, called it fine.
 */
function checkRecord(rows, baseline, everything, featureSet, presets) {
  if (!existsSync(RECORD)) return rows.map((r) => ({ group: r.group, recorded: "missing", measured: r.addedTokens }));
  const text = readFileSync(RECORD, "utf8");
  const groupBlock = blockOf(text, "GROUP_COST_TOKENS");
  const presetBlock = blockOf(text, "PRESET_COST_TOKENS");
  const drift = [];

  const compare = (label, recorded, measured) => {
    if (recorded === null || Math.abs(recorded - measured) > TOLERANCE_TOKENS) {
      drift.push({ group: label, recorded: recorded ?? "missing", measured });
    }
  };
  const numberIn = (block, key) => {
    const found = new RegExp(`\\b${key}:\\s*(\\d+)`).exec(block);
    return found ? Number(found[1]) : null;
  };
  const scalar = (name) => {
    const found = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(text);
    return found ? Number(found[1]) : null;
  };

  for (const row of rows) compare(row.group, numberIn(groupBlock, row.group), row.addedTokens);
  for (const p of presets) compare(`preset ${p.preset}`, numberIn(presetBlock, p.preset), p.tokens);
  compare("SEARCH_BASELINE_TOKENS", scalar("SEARCH_BASELINE_TOKENS"), baseline);
  compare("ALL_GROUPS_TOKENS", scalar("ALL_GROUPS_TOKENS"), everything);
  compare("FEATURE_SET_TOKENS", scalar("FEATURE_SET_TOKENS"), featureSet);

  return drift;
}

async function main() {
  const asJson = process.argv.includes("--json");
  const rows = [];
  for (const group of GROUPS) rows.push(await measureGroup(group));
  const { baseline, everything } = await measureAllGroups();
  const featureSet = await measureFeatureSet();
  const presets = await measurePresets();

  if (asJson) {
    console.log(JSON.stringify({ baseline: baseline.tokens, rows, everything: everything.tokens }, null, 2));
    return;
  }

  console.log(`Cost of enabling a group, from the \`search\` baseline of ~${baseline.tokens} tokens` + NEWLINE);
  console.log("  group         tools   ~tokens added   running total");
  console.log("  ------------  ------  --------------  -------------");
  for (const row of rows) {
    console.log(
      `  ${row.group.padEnd(12)}  ${String(row.addedTools).padStart(6)}  ` +
        `${String(row.addedTokens).padStart(14)}  ${String(row.totalTokens).padStart(13)}`
    );
  }

  console.log(
    NEWLINE +
      `Everything enabled: ${everything.tools.length} tools, ~${everything.tokens} tokens. ` +
      `A job that needs only \`core\` pays ~${rows.find((r) => r.group === "core")?.totalTokens} instead.`
  );
  console.log("");
  console.log("  preset        tools   standing");
  console.log("  ------------  ------  --------");
  for (const p of presets) {
    console.log(`  ${p.preset.padEnd(12)}  ${String(p.tools).padStart(6)}  ${String(p.tokens).padStart(8)}`);
  }

  console.log(
    NEWLINE +
      `Naming the eight tools one Blueprint feature needs: ~${featureSet} tokens - ` +
      `${Math.round(100 - (100 * featureSet) / (rows.find((r) => r.group === "core")?.totalTokens ?? 1))}% less than enabling \`core\`.`
  );

  // Keep unreal_list_tools honest about what a group costs.
  if (process.argv.includes("--write")) {
    writeFileSync(RECORD, renderRecord(rows, baseline.tokens, everything.tokens, featureSet, presets), "utf8");
    console.log(NEWLINE + `wrote ${RECORD}`);
  } else {
    const drift = checkRecord(rows, baseline.tokens, everything.tokens, featureSet, presets);
    if (drift.length > 0) {
      console.error(NEWLINE + "recorded costs have drifted from what the server actually sends:");
      for (const d of drift) console.error(`  ${d.group}: recorded ${d.recorded}, measured ${d.measured}`);
      console.error(
        `${NEWLINE}unreal_list_tools reports these numbers to a model deciding what to enable, so a stale ` +
          `one is worse than none. Re-run with --write and rebuild.`
      );
      process.exit(1);
    }
  }

  const everythingPerTool = Math.round(everything.tokens / everything.tools.length);
  if (everythingPerTool > PER_TOOL_CEILING) {
    console.error(
      NEWLINE +
        `every group enabled averages ~${everythingPerTool} tokens across ${everything.tools.length} tools, ` +
        `over the ${PER_TOOL_CEILING} per-tool ceiling. That is the whole surface, so it answers to the ` +
        `same budget \`full\` does: descriptions are bloating, or a group gained something expensive.`
    );
    process.exit(1);
  }
  console.log(NEWLINE + `groups ok: ${rows.length + presets.length + 3} recorded figures checked (${rows.length} groups, ${presets.length} presets, baseline, everything-on, feature set), everything-on averages ~${everythingPerTool} tokens a tool across ${everything.tools.length}, within ${PER_TOOL_CEILING}`);
}

main().catch((err) => {
  console.error(`measure-groups failed: ${err.message}`);
  process.exit(1);
});
