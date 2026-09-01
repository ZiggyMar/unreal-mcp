#!/usr/bin/env node
// Build a small feature end to end against a live editor, and fail if the LOOP is broken.
//
// The unit tests cover the pieces and they were all green while five separate defects sat in the
// path between them. Every one appeared only when something actually used the tools in order:
//
//   - deleting a Blueprint and rebuilding it under the same name refused, so iterating stopped dead
//   - the quality gate returned score 95 for a Blueprint that did not compile
//   - the review penalised the placeholder BeginPlay and Tick that create_blueprint had just made
//   - verify_feature counted one asset twice because the journal spells it two ways
//   - and the first trial harness reported "0 stalls" while three calls had plainly failed
//
// None of those is visible from a unit test, because each one is about what the NEXT call sees. So
// this walks the whole path - create, add a component, build a graph, compile, review, verify, throw
// it away and build it again - and checks each reply contains what that step is for. A reply that
// merely arrives is not a working step; that mistake is what hid three of the five.
//
// Uses engine classes only, so it runs against any project rather than the one it was written on.
//
// Usage: node scripts/trial-feature.mjs             (needs an editor open)
//        node scripts/trial-feature.mjs --by-name   (same trial, paying only for the tools it uses)
//
// --by-name exists to check a claim the server instructions make to every frontier model: that
// passing enable_tools an exact `tools` list instead of a group is much cheaper and still works.
// Advice with no evidence behind it is how this repo has been wrong before, so this runs the whole
// trial on nothing but the tools it actually calls - derived from THIS FILE, so the list cannot
// drift away from what the trial does - and prints what that standing context costs beside `core`.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NL = String.fromCharCode(10);

const CORE_TOKENS = 11666; // measured by `npm run measure:groups`; see src/groupCosts.ts

const PKG = "/Game/__MCPFeatureTrial/BP_TrialPickup";
const PATH = `${PKG}.BP_TrialPickup`;

const byName = process.argv.includes("--by-name");
const byPreset = process.argv.includes("--by-preset");

// Derived from this file rather than written down: a hand-kept list would drift the first time a
// step was added, and would then be measuring a set the trial does not use.
const TOOLS_USED = [
  ...new Set([...readFileSync(fileURLToPath(import.meta.url), "utf8").matchAll(/"(unreal_[a-z0-9_]+)"/g)].map((m) => m[1])),
];

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, UNREAL_MCP_PROFILE: byName || byPreset ? "search" : "full" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const waiters = new Map();
child.stdout.on("data", (c) => {
  buf += c.toString();
  let at;
  while ((at = buf.indexOf(NL)) >= 0) {
    const line = buf.slice(0, at).trim();
    buf = buf.slice(at + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
let seq = 1;
const rpc = (method, params) =>
  new Promise((res) => { const my = ++seq; waiters.set(my, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + NL); });

const stalls = [];
let calls = 0;
let tokens = 0;

async function step(label, name, args, check) {
  calls++;
  const r = await rpc("tools/call", { name, arguments: args });
  const text = ((r.result && r.result.content) || []).map((c) => c.text || "").join("") || JSON.stringify(r.error || {});
  tokens += Math.round(text.length / 4);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not every reply is JSON */ }
  // A tool that REFUSED did not answer, whatever its own check thinks. Same hole trial-diagnose and
  // trial-runtime had, which between them hid six steps that had never executed.
  const problem = r.error
    ? "JSON-RPC error"
    : r.result?.isError === true
      ? "the tool refused the call"
      : check
        ? check(text, parsed)
        : null;
  if (problem) stalls.push({ label, problem, reply: text.slice(0, 240).split(NL).join(" ") });
  console.log(`  ${label.padEnd(34)} ${String(Math.round(text.length / 4)).padStart(5)} tok${problem ? "   <-- STALL" : ""}`);
  return { text, parsed };
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trial", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NL);

// Enable exactly what this trial uses, and price it against the group a model would otherwise reach
// for. The comparison is the point: if the named set is not much cheaper, the advice is wrong.

// The five presets have to be sufficient for the jobs they name, and a curated list always looks
// sufficient. This trial spans Blueprints, components, data tables, C++ and UMG, so it runs on the
// four presets that cover those - plus create_blueprint and delete_asset, which are the harness's
// own scaffolding and belong to no preset.
if (byPreset) {
  const sizeOf = async () => {
    const listed = await rpc("tools/list", {});
    return Math.round(JSON.stringify(listed?.result?.tools ?? []).length / 4);
  };
  for (const preset of ["feature", "ui", "data", "cpp"]) {
    const r = await rpc("tools/call", { name: "unreal_enable_tools", arguments: { preset } });
    if (r?.result?.isError) {
      console.error(`preset "${preset}" would not enable:`, JSON.stringify(r.result).slice(0, 200));
      process.exit(1);
    }
  }
  await rpc("tools/call", {
    name: "unreal_enable_tools",
    arguments: { tools: ["unreal_create_blueprint", "unreal_delete_asset"] },
  });
  console.log(`four presets + 2 harness tools: ${await sizeOf()} tokens standing; core would be ${CORE_TOKENS}`);
  console.log("");
}

if (byName) {
  const sizeOf = async () => {
    const listed = await rpc("tools/list", {});
    return Math.round(JSON.stringify(listed?.result?.tools ?? []).length / 4);
  };
  const baseline = await sizeOf();
  await rpc("tools/call", { name: "unreal_enable_tools", arguments: { tools: TOOLS_USED } });
  const named = await sizeOf();
  console.log(`enabled ${TOOLS_USED.length} tools by name: ${named} tokens standing (search baseline ${baseline})`);
  console.log(`for comparison, enabling "core" instead costs ${CORE_TOKENS} tokens standing`);
  console.log("");
}


console.log("the Blueprint surface");

await step("create the Blueprint", "unreal_create_blueprint", { packagePath: PKG, parentClass: "Actor", save: false },
  (t, j) => (j && j.path ? null : "no asset path came back"));

await step("add a collision component", "unreal_add_component", { path: PATH, componentClass: "SphereComponent", name: "Trigger" },
  (t) => (t.includes("Trigger") ? null : "the component name is not in the reply"));

// Overlap -> cast the other actor to a Pawn -> print. Engine classes only, and the cast pin name is
// deliberately written without its space, because resolving that near miss is load-bearing: no model
// reliably knows the pin is called "AsPawn" versus "As Pawn".
const built = await step("build overlap -> cast -> print", "unreal_build_graph", {
  path: PATH,
  graphName: "EventGraph",
  nodes: [
    { ref: "ev", nodeType: "Event", eventName: "ReceiveActorBeginOverlap" },
    { ref: "cast", nodeType: "Cast", targetClass: "/Script/Engine.Pawn" },
    { ref: "say", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
  ],
  connections: [
    { from: "ev.then", to: "cast.execute" },
    { from: "ev.OtherActor", to: "cast.Object" },
    { from: "cast.then", to: "say.execute" },
  ],
  compile: true,
}, (t, j) => {
  if (!j || !j.compile) return "no compile result";
  if (j.compile.success !== true) return `built graph does not compile: ${JSON.stringify(j.compile.messages || []).slice(0, 160)}`;
  if ((j.connectionsMade ?? 0) < 3) return `expected 3 connections, made ${j.connectionsMade}`;
  return null;
});

await step("read the graph back", "unreal_read_blueprint_summary", { path: PATH, graphName: "EventGraph" }, (t, j) => {
  const nodes = (j && j.nodes) || [];
  if (nodes.length === 0) return "no nodes came back";
  // The placeholders UE puts in every new Blueprint must be marked, or every quality check counts
  // them as events wired to nothing and the feature fails for furniture the tool itself created.
  const ghosts = nodes.filter((n) => n.ghost);
  return ghosts.length > 0 ? null : "no node is marked ghost - UE's placeholder events are unmarked again";
});

await step("review", "unreal_review_blueprint", { path: PATH }, (t, j) => {
  if (!j) return "review did not return JSON";
  if (j.compiles !== true) return "review did not confirm the Blueprint compiles";
  const findings = JSON.stringify(j.review || j);
  return findings.includes("empty-event") ? "review flagged the placeholder events again" : null;
});

await step("verify_feature", "unreal_verify_feature", { paths: [PATH] }, (t, j) => {
  if (!j || !j.verdict) return "no verdict";
  if ((j.checked || []).length !== 1) return `one asset should be checked once, got ${JSON.stringify(j.checked)}`;
  return null;
});

// Throw it away and build it again. This is what iterating looks like, and it used to stop here.
await step("delete it", "unreal_delete_asset", { paths: [PATH], force: true },
  (t, j) => (j && j.deleted >= 1 ? null : "nothing was deleted"));

await step("rebuild under the same name", "unreal_create_blueprint", { packagePath: PKG, parentClass: "Actor", save: false },
  (t, j) => (j && j.path ? null : "could not recreate the asset after deleting it"));

await step("final cleanup", "unreal_delete_asset", { paths: [PATH], force: true },
  (t, j) => (j && j.deleted >= 1 ? null : "cleanup failed - a trial asset is left in the project"));

// ---------------------------------------------------------------------------------------------
// The data surface. A model is told "whether it is C++ or Blueprints or a Data Table", and a Data
// Table is where the most expensive bug this project has seen actually lived: a row's class
// reference cleared to None, which the engine resolves to null and the consumer silently ignores.
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("the data surface");

const STRUCT = "/Game/__MCPFeatureTrial/S_TrialRow";
const TABLE = "/Game/__MCPFeatureTrial/DT_Trial";
const TABLE_PATH = `${TABLE}.DT_Trial`;

await step("create a row struct", "unreal_create_struct", {
  packagePath: STRUCT,
  fields: [{ name: "Thing", type: "object:StaticMesh" }, { name: "Count", type: "int" }],
}, (t, j) => (j && (j.path || j.created) ? null : "no struct came back"));

await step("create a Data Table", "unreal_create_data_table", { packagePath: TABLE, rowStruct: STRUCT },
  (t, j) => (j && (j.path || j.created) ? null : "no table came back"));

// An engine asset that exists in every project, so the reference actually resolves. A class path
// would not: an object field wants an instance, and the row would silently stay empty - which is
// how the first version of this trial "failed", by writing a fixture the engine could not store.
await step("add a good row", "unreal_add_data_table_row", {
  path: TABLE_PATH, rowName: "Good", values: { Thing: "/Engine/BasicShapes/Cube.Cube", Count: "3" },
}, (t, j) => {
  if (!t.includes("Good")) return "the row name is not in the reply";
  const stored = j && j.values && j.values.Thing;
  // The reply reads the row BACK rather than echoing the input, so this checks the engine kept it.
  return stored && stored !== "None" ? null : `the reference did not store: ${JSON.stringify(stored)}`;
});

// A row whose reference is empty while a sibling fills it in - exactly the shape that shipped.
await step("add a row with an empty reference", "unreal_add_data_table_row", {
  path: TABLE_PATH, rowName: "Empty", values: { Count: "1" },
}, (t) => (t.includes("Empty") ? null : "the row name is not in the reply"));

await step("check_data_tables finds it", "unreal_check_data_tables", { paths: [TABLE_PATH] }, (t, j) => {
  if (!j) return "no JSON";
  const hit = (j.nullReferences || []).some((n) => n.rowName === "Empty");
  return hit ? null : `the empty reference was not reported: ${JSON.stringify(j.nullReferences || [])}`;
});

await step("repair it with set_data_table_row", "unreal_set_data_table_row", {
  path: TABLE_PATH, rowName: "Empty", values: { Thing: "/Engine/BasicShapes/Cube.Cube" },
}, (t, j) => {
  const before = j && j.changed && j.changed.Thing && j.changed.Thing.before;
  return before ? null : "the reply should report what the field was before the change";
});

await step("check_data_tables is clean now", "unreal_check_data_tables", { paths: [TABLE_PATH] },
  (t, j) => (j && j.verdict === "clean" ? null : `still reporting problems: ${JSON.stringify((j || {}).nullReferences || [])}`));

await step("delete a row, get its values back", "unreal_remove_data_table_row", { path: TABLE_PATH, rowName: "Empty" },
  (t, j) => (j && j.was && Object.keys(j.was).length > 0 ? null : "a delete that cannot be undone returned no values"));

await step("clean up the data assets", "unreal_delete_asset", { paths: [TABLE_PATH, `${STRUCT}.S_TrialRow`], force: true },
  (t, j) => (j && j.deleted >= 1 ? null : "the trial's data assets are still in the project"));

// ---------------------------------------------------------------------------------------------
// The C++ surface. Locations, never contents - the client already reads files better than a tool
// wrapper could; what it cannot do is know where the project's source actually lives.
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("the C++ surface");

const modules = await step("map the C++ modules", "unreal_find_source", {}, (t, j) => {
  if (!j) return "no JSON";
  // A Blueprint-only project is a valid answer, and must say so rather than looking like a failure.
  // modules is a map from module name to where it lives, not a list - Object.keys, not .length. A
  // `.length` on a map is undefined, which compares false against 0 and would pass this check by
  // accident rather than by being right.
  if (Object.keys(j.modules || {}).length === 0) return j.note ? null : "no modules and no explanation";
  return null;
});

if (modules.parsed && Object.keys(modules.parsed.modules || {}).length > 0) {
  await step("locate a symbol in C++", "unreal_find_source", { symbol: "AActor" }, (t, j) => {
    if (!j) return "no JSON";
    if (Object.keys(j.matches || {}).length === 0 && !j.note) return "no matches and no explanation";
    return null;
  });
} else {
  console.log("  (project has no C++ modules - symbol lookup skipped)");
}

// ---------------------------------------------------------------------------------------------
// The asset surface: VFX, sound and animation.
//
// There is no Niagara tool or animation tool here, and the README argues there does not need to be
// for the common case - attaching and driving assets that already exist is what a feature actually
// requires, and the component tools do that. That claim was tested once, by hand, and then written
// down. A claim tested once is a claim that was true once; this keeps it true, and it is cheap.
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("the asset surface (VFX, sound, animation)");

const FX = "/Game/__MCPFeatureTrial/BP_TrialFx";
const FX_PATH = `${FX}.BP_TrialFx`;

await step("create an actor for components", "unreal_create_blueprint", { packagePath: FX, parentClass: "Actor", save: false },
  (t, j) => (j && j.path ? null : "no asset path came back"));

for (const cls of ["NiagaraComponent", "AudioComponent", "SkeletalMeshComponent", "StaticMeshComponent"]) {
  await step(`attach a ${cls}`, "unreal_add_component", { path: FX_PATH, componentClass: cls, name: `C_${cls}` },
    (t) => (t.includes(`C_${cls}`) ? null : `${cls} did not attach - the claim that VFX and audio need no dedicated tool rests on this`));
}

// Pointing a component at an existing asset is the other half of the claim: attaching a component
// that references nothing would satisfy the step above and none of the intent.
await step("point it at a real asset", "unreal_set_component_property", {
  path: FX_PATH, component: "C_StaticMeshComponent", property: "StaticMesh", value: "/Engine/BasicShapes/Cube.Cube",
}, (t, j) => {
  const stored = j && j.value;
  return stored && String(stored).includes("Cube") ? null : `the asset reference did not stick: ${JSON.stringify(stored)}`;
});

await step("clean up the component actor", "unreal_delete_asset", { paths: [FX_PATH], force: true },
  (t, j) => (j && j.deleted >= 1 ? null : "the trial's component actor is still in the project"));

// ---------------------------------------------------------------------------------------------
// The UI surface. "A HUD bound to a value" is one of the recipes this project ships, so the widget
// path is not a nice-to-have - it is a documented workflow, and a documented workflow that nothing
// exercises is a claim rather than a feature.
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("the UI surface");

const WBP = "/Game/__MCPFeatureTrial/WBP_Trial";
const WBP_PATH = `${WBP}.WBP_Trial`;

await step("create a Widget Blueprint", "unreal_create_widget_blueprint", { packagePath: WBP },
  (t, j) => (j && j.path ? null : "no widget blueprint came back"));

await step("add a text block", "unreal_add_widget", { path: WBP_PATH, widgetClass: "TextBlock", name: "HealthText" },
  (t) => (t.includes("HealthText") ? null : "the widget name is not in the reply"));

await step("add a progress bar", "unreal_add_widget", { path: WBP_PATH, widgetClass: "ProgressBar", name: "HealthBar" },
  (t) => (t.includes("HealthBar") ? null : "the widget name is not in the reply"));

await step("read the widget tree", "unreal_list_widgets", { path: WBP_PATH }, (t, j) => {
  const widgets = (j && j.widgets) || [];
  const names = widgets.map((w) => w.name);
  if (!names.includes("HealthText") || !names.includes("HealthBar")) {
    return `both widgets should be in the tree, got ${JSON.stringify(names)}`;
  }
  // A flat list of names would pass the check above and tell a model nothing about layout.
  return widgets.some((w) => w.isPanel) ? null : "the tree reports no panel, so nesting is invisible";
});

await step("set a widget property", "unreal_set_widget_property", { path: WBP_PATH, widget: "HealthText", property: "Text", value: "Health" },
  (t, j) => (j && String(j.value).includes("Health") ? null : `the property did not stick: ${JSON.stringify(j && j.value)}`));

await step("clean up the widget", "unreal_delete_asset", { paths: [WBP_PATH], force: true },
  (t, j) => (j && j.deleted >= 1 ? null : "the trial's widget blueprint is still in the project"));

console.log(`\n${calls} calls, ~${tokens} tokens`);
if (stalls.length > 0) {
  console.log(`\nthe loop is broken in ${stalls.length} place(s):`);
  for (const s of stalls) console.log(`  - ${s.label}: ${s.problem}\n      ${s.reply}`);
  child.kill();
  process.exit(1);
}
console.log("\nfeature trial ok: the whole path works, and the trial left nothing behind");
child.kill();
