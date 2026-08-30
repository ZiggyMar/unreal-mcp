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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startAndInitialize, listTools, estimateTokens } from "./lib/mcpStdio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RECORD = join(here, "..", "src", "groupCosts.ts");

/** How far a recorded cost may drift before it is a lie rather than a rounding difference. */
const TOLERANCE_TOKENS = 150;

const NEWLINE = String.fromCharCode(10);

/** The groups unreal_enable_tools offers. Kept in the order its description lists them. */
const GROUPS = ["core", "cpp", "anim", "ai", "vfx", "edit", "ui", "materials", "data", "scene", "maintenance"];

/**
 * A ceiling on the whole surface, not on any one group.
 *
 * The number that matters is what a realistic job pays: `search` plus the groups it turns on. If
 * enabling everything costs about what `full` costs, the profile is doing its job - the saving comes
 * from not enabling everything, not from the groups being individually cheap.
 */
const ALL_GROUPS_CEILING = 32_000;

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

function checkRecord(rows) {
  if (!existsSync(RECORD)) return rows.map((r) => ({ group: r.group, recorded: "missing", measured: r.addedTokens }));
  const text = readFileSync(RECORD, "utf8");
  const drift = [];
  for (const row of rows) {
    const found = new RegExp(`\\b${row.group}:\\s*(\\d+)`).exec(text);
    const recorded = found ? Number(found[1]) : null;
    if (recorded === null || Math.abs(recorded - row.addedTokens) > TOLERANCE_TOKENS) {
      drift.push({ group: row.group, recorded: recorded ?? "missing", measured: row.addedTokens });
    }
  }
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
    const drift = checkRecord(rows);
    if (drift.length > 0) {
      console.error(NEWLINE + "recorded group costs have drifted from what the server actually sends:");
      for (const d of drift) console.error(`  ${d.group}: recorded ${d.recorded}, measured ${d.measured}`);
      console.error(
        `${NEWLINE}unreal_list_tools reports these numbers to a model deciding what to enable, so a stale ` +
          `one is worse than none. Re-run with --write and rebuild.`
      );
      process.exit(1);
    }
  }

  if (everything.tokens > ALL_GROUPS_CEILING) {
    console.error(
      NEWLINE +
        `every group enabled is ~${everything.tokens} tokens, over the ${ALL_GROUPS_CEILING} ceiling. ` +
        `That is the whole surface, so this is the same budget \`full\` is held to.`
    );
    process.exit(1);
  }
  console.log(NEWLINE + `groups ok: ${rows.length} measured, everything-on within ${ALL_GROUPS_CEILING} tokens`);
}

main().catch((err) => {
  console.error(`measure-groups failed: ${err.message}`);
  process.exit(1);
});
