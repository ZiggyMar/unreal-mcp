/**
 * Which replies print a float32's widening artefact?
 *
 * A float32 widened to a double prints its own approximation error: 0.2 becomes
 * 0.20000000298023224, seventeen digits of a number that holds about seven. Those digits are not
 * precision, and a reader has to know to ignore them.
 *
 * Found in read_niagara_system and fixed there; found again in read_anim_blueprint immediately
 * afterwards, which is the signal to stop fixing instances. This asks every read on a real project
 * rather than reading 64 SetNumberField calls and guessing which take a float.
 */
import { call } from "./bridge.mjs";

const LONG_DECIMAL = /-?\d+\.\d{8,}/g;

async function firstAsset(className) {
  const r = await call("list_assets", { className, maxResults: 5 }, 180000).catch(() => null);
  return (r?.result?.assets ?? []).map((a) => (typeof a === "string" ? a : a.path)).find(Boolean);
}

const BP = "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player.BP_Player";
const cases = [
  ["read_anim_blueprint", { path: await firstAsset("AnimBlueprint") }],
  ["read_level_sequence", { path: await firstAsset("LevelSequence") }],
  ["read_behavior_tree", { path: await firstAsset("BehaviorTree") }],
  ["read_niagara_system", { path: await firstAsset("NiagaraSystem") }],
  ["read_asset_properties", { path: await firstAsset("AnimMontage") }],
  ["read_timeline", { path: BP }],
  ["read_class_defaults", { path: BP }],
  ["list_variables", { path: BP }],
  ["list_components", { path: BP }],
  ["list_actors", {}],
  ["list_input_mappings", {}],
  ["read_blueprint_graph_summary", { path: BP, graphName: "EventGraph" }],
];

console.log(`  ${"read".padEnd(32)}${"long decimals".padStart(14)}   sample`);
console.log(`  ${"-".repeat(32)}${"-".repeat(14)}   ${"-".repeat(40)}`);

for (const [cmd, args] of cases) {
  if (!args || args.path === undefined && cmd !== "list_actors" && cmd !== "list_input_mappings") {
    console.log(`  ${cmd.padEnd(32)}${"(no asset)".padStart(14)}`);
    continue;
  }
  let text = "";
  try {
    const r = await call(cmd, args, 240000);
    text = JSON.stringify(r.result ?? r);
  } catch (err) {
    console.log(`  ${cmd.padEnd(32)}${"(failed)".padStart(14)}   ${String(err.message).slice(0, 40)}`);
    continue;
  }
  const hits = text.match(LONG_DECIMAL) ?? [];
  const wasted = hits.reduce((n, h) => n + Math.max(0, h.length - 6), 0);
  console.log(
    `  ${cmd.padEnd(32)}${String(hits.length).padStart(14)}   ${hits[0] ?? ""}${hits.length ? `  (~${Math.round(wasted / 4)} tok of noise)` : ""}`
  );
}
