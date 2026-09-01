#!/usr/bin/env node
// Which replies spend tokens printing a float32's own approximation error?
//
// A float32 widened to a double prints seventeen digits of a number that holds about seven: 0.2
// becomes 0.20000000298023224. Those extra digits are not precision, they are a widening artefact,
// and a reader has to know to ignore them. They were found and fixed in read_niagara_system, then
// found again next door in read_anim_blueprint - which is the signal to stop fixing instances and
// measure the surface instead.
//
// Measured THROUGH THE TOOL, not the bridge. Several reads round in the tool layer, so a bridge-level
// scan reports noise that no model ever sees and would send this chasing fixes that are already made.
//
// Run: node scripts/measure-float-noise.mjs

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const callTool = join(here, "call-tool.mjs");

// Eight or more decimals is the tell. A genuine authored value - 0.25, 1.5, 60.0 - never needs them;
// a float32 widened to a double almost always does.
const LONG_DECIMAL = /-?\d+\.\d{8,}/g;

function call(tool, args) {
  const r = spawnSync(process.execPath, [callTool, tool, JSON.stringify(args), "--full"], {
    encoding: "utf8",
    timeout: 240000,
  });
  const out = `${r.stdout ?? ""}`;
  const body = out.split("\n").slice(2).join("\n");
  return body.startsWith("MCP error") || body.startsWith("Unreal") ? null : body;
}

function firstAsset(className) {
  const body = call("unreal_list_assets", { className, maxResults: 5 });
  if (!body) return undefined;
  try {
    const j = JSON.parse(body);
    const assets = j.assets ?? [];
    const a = assets.map((x) => (typeof x === "string" ? x : x.path)).find(Boolean);
    return a;
  } catch {
    return undefined;
  }
}

const BP = "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player";

const cases = [
  ["unreal_read_anim_blueprint", () => ({ path: firstAsset("AnimBlueprint") })],
  ["unreal_read_level_sequence", () => ({ path: firstAsset("LevelSequence") })],
  ["unreal_read_behavior_tree", () => ({ path: firstAsset("BehaviorTree") })],
  ["unreal_read_niagara_system", () => ({ path: firstAsset("NiagaraSystem") })],
  ["unreal_read_asset_properties", () => ({ path: firstAsset("AnimMontage") })],
  ["unreal_read_timeline", () => ({ path: BP })],
  ["unreal_read_class_defaults", () => ({ path: BP })],
  ["unreal_list_variables", () => ({ path: BP })],
  ["unreal_list_components", () => ({ path: BP })],
  ["unreal_list_actors", () => ({})],
  ["unreal_read_input_context", () => ({ path: firstAsset("InputMappingContext") })],
];

console.log("Float widening noise, measured through the tool layer\n");
console.log(`  ${"read".padEnd(32)}${"hits".padStart(6)}${"~tokens".padStart(9)}   worst example`);
console.log(`  ${"-".repeat(32)}${"-".repeat(6)}${"-".repeat(9)}   ${"-".repeat(30)}`);

let total = 0;
for (const [tool, mkArgs] of cases) {
  const args = mkArgs();
  if (args && "path" in args && !args.path) {
    console.log(`  ${tool.padEnd(32)}${"-".padStart(6)}${"-".padStart(9)}   (no such asset in project)`);
    continue;
  }
  const body = call(tool, args);
  if (body === null) {
    console.log(`  ${tool.padEnd(32)}${"-".padStart(6)}${"-".padStart(9)}   (failed)`);
    continue;
  }
  const hits = body.match(LONG_DECIMAL) ?? [];
  // Every digit past six decimals is noise. Roughly four characters to the token.
  const wasted = hits.reduce((n, h) => {
    const dot = h.indexOf(".");
    return n + Math.max(0, h.length - dot - 1 - 6);
  }, 0);
  const tokens = Math.round(wasted / 4);
  total += tokens;
  const worst = hits.slice().sort((a, b) => b.length - a.length)[0] ?? "";
  console.log(
    `  ${tool.padEnd(32)}${String(hits.length).padStart(6)}${String(tokens).padStart(9)}   ${worst}`
  );
}

console.log(`\n  ${"total".padEnd(32)}${"".padStart(6)}${String(total).padStart(9)} tokens per full sweep`);
console.log(
  "\n  Every one of these is a digit no reader can use. The fix is to round at the point the number\n" +
    "  is written into JSON, which is also the only place that knows it came from a float."
);
