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
// Usage: node scripts/trial-feature.mjs      (needs an editor open)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NL = String.fromCharCode(10);

const PKG = "/Game/__MCPFeatureTrial/BP_TrialPickup";
const PATH = `${PKG}.BP_TrialPickup`;

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, UNREAL_MCP_PROFILE: "full" },
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
  const problem = r.error ? "JSON-RPC error" : check ? check(text, parsed) : null;
  if (problem) stalls.push({ label, problem, reply: text.slice(0, 240).split(NL).join(" ") });
  console.log(`  ${label.padEnd(34)} ${String(Math.round(text.length / 4)).padStart(5)} tok${problem ? "   <-- STALL" : ""}`);
  return { text, parsed };
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "trial", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NL);

console.log("building a feature end to end\n");

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

console.log(`\n${calls} calls, ~${tokens} tokens`);
if (stalls.length > 0) {
  console.log(`\nthe loop is broken in ${stalls.length} place(s):`);
  for (const s of stalls) console.log(`  - ${s.label}: ${s.problem}\n      ${s.reply}`);
  child.kill();
  process.exit(1);
}
console.log("\nfeature trial ok: the whole path works, and the trial left nothing behind");
child.kill();
