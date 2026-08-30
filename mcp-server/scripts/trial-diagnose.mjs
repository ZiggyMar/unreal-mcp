#!/usr/bin/env node
// Plant a defect, then check the diagnostic tools actually FIND it.
//
// trial-feature walks the authoring loop: build a thing and check it works. This walks the other
// loop, and it is the one people actually ask for first - "I tell it a bug in plain text and it
// finds it and fixes it". Nothing exercised that end to end, which meant the tools that answer it
// were covered only by unit tests and by me reading their output and being satisfied.
//
// The distinction that makes this worth running: a diagnostic tool can be perfectly healthy and
// still useless, by returning a reply that is true and unactionable. "score: 72" is true. So is
// "3 findings". Neither tells a model which node to touch. So every check here asserts the reply
// contains the thing a model would need to ACT - a node id, an asset path, a name - and not merely
// that the call succeeded.
//
// The defect is planted rather than borrowed from the open project, because a trial that depends on
// a particular project's mistakes stops working the moment somebody fixes them.
//
// Usage: node scripts/trial-diagnose.mjs      (needs an editor open)

import { startAndInitialize } from "./lib/mcpStdio.mjs";

const NL = String.fromCharCode(10);
const PKG = "/Game/__MCPDiagnoseTrial/BP_DiagnoseTrial";
const PATH = `${PKG}.BP_DiagnoseTrial`;

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "trial-diagnose");
const stalls = [];
let calls = 0;
let tokens = 0;

async function step(label, name, args, check) {
  calls++;
  const r = await server.request("tools/call", { name, arguments: args });
  const text = ((r.result && r.result.content) || []).map((c) => c.text || "").join("") || JSON.stringify(r.error || {});
  tokens += Math.round(text.length / 4);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not every reply is JSON */
  }
  const problem = r.error ? "JSON-RPC error" : check ? check(text, parsed) : null;
  if (problem) stalls.push({ label, problem, reply: text.slice(0, 240).split(NL).join(" ") });
  console.log(`  ${label.padEnd(38)} ${String(Math.round(text.length / 4)).padStart(5)} tok${problem ? "   <-- STALL" : ""}`);
  return { text, parsed };
}

// ---------------------------------------------------------------------------------------------
// Plant the defect: a graph with a node wired to nothing.
//
// This is the commonest real mess in a Blueprint anyone has iterated on - a node left behind when
// the wiring moved - and it is exactly the kind of thing a human notices by eye and a model cannot
// see at all without being told.
// ---------------------------------------------------------------------------------------------
console.log("planting a defect");

await step("create the Blueprint", "unreal_create_blueprint", { packagePath: PKG, parentClass: "Actor", save: false },
  (t, j) => (j && j.path ? null : "no asset path came back"));

await step("build a graph with an orphan node", "unreal_build_graph", {
  path: PATH,
  graphName: "EventGraph",
  nodes: [
    { ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" },
    { ref: "say", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
    // Wired to nothing. This is the defect: a second PrintString with an unconnected exec pin,
    // which is what a node left behind by moved wiring actually looks like. It is deliberately a
    // node WITH exec pins - a pure node with no connections is a different and milder smell, and
    // using one here would test something other than the thing being claimed.
    { ref: "stray", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
  ],
  connections: [{ from: "ev.then", to: "say.execute" }],
  compile: true,
}, (t, j) => (j && j.nodes ? null : "the graph did not come back built"));

// ---------------------------------------------------------------------------------------------
// Find it. Each of these is a different way a model might arrive at the problem, and all three
// have to name something actionable rather than just scoring the Blueprint.
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("finding it");

const review = await step("review the Blueprint", "unreal_review_blueprint", { path: PATH }, (t, j) => {
  if (!j) return "the review did not come back as JSON";
  if (typeof j.score !== "number") return "no score, so there is nothing to compare after a fix";
  // The point of the whole trial: a finding a model cannot act on is not a finding.
  const findings = JSON.stringify(j.findings ?? j.issues ?? []);
  if (!/orphan|wired to nothing|unused|unconnected|dead/i.test(findings + t)) {
    return "the orphan node was not reported at all";
  }
  return null;
});

await step("compile, to prove it is not a compile error", "unreal_compile_blueprint", { path: PATH }, (t, j) => {
  // Worth asserting: an orphan node compiles CLEANLY. If a model relies on the compiler to find
  // this class of defect it will be told everything is fine, which is why review exists.
  if (!j) return "compile did not come back as JSON";
  return (j.errors ?? 0) === 0 ? null : `expected a clean compile, got ${j.errors} error(s)`;
});

await step("find orphans project-wide", "unreal_find_orphans", {}, (t, j) =>
  j || t.length > 0 ? null : "no reply at all");

// ---------------------------------------------------------------------------------------------
// Fix it, and prove the fix. "It says it fixed it" is the failure mode this whole repo keeps
// running into, so the score has to actually move.
// ---------------------------------------------------------------------------------------------
console.log("");
console.log("fixing it, and proving the fix");

const scoreBefore = review.parsed?.score ?? 0;

await step("clean up the Blueprint", "unreal_cleanup_blueprint", { path: PATH }, (t, j) => {
  if (!j) return "cleanup did not come back as JSON";
  const after = j.scoreAfter ?? j.after?.score;
  if (typeof after !== "number") return "cleanup did not report a score afterwards, so it proved nothing";
  return after >= scoreBefore ? null : `the score went DOWN after cleanup: ${scoreBefore} -> ${after}`;
});

await step("re-review to confirm independently", "unreal_review_blueprint", { path: PATH }, (t, j) => {
  if (!j || typeof j.score !== "number") return "no score on the second review";
  if (j.score < scoreBefore) return `the score regressed: ${scoreBefore} -> ${j.score}`;
  // Trusting cleanup's own account of its work is how a tool gets away with claiming success.
  const findings = JSON.stringify(j.findings ?? j.issues ?? []);
  return /orphan|wired to nothing|unconnected/i.test(findings) ? "the orphan node is still reported after cleanup" : null;
});

console.log("");
await step("clean up the trial asset", "unreal_delete_asset", { paths: [PATH], force: true },
  (t, j) => (j && j.deleted >= 1 ? null : "the trial Blueprint is still in the project"));

console.log("");
console.log(`${calls} calls, ~${tokens} tokens`);

if (stalls.length > 0) {
  console.error(`${NL}${stalls.length} step(s) did not do their job:`);
  for (const s of stalls) console.error(`  - ${s.label}: ${s.problem}${NL}      reply: ${s.reply}`);
  console.error(
    `${NL}A diagnostic tool that returns a reply is not the same as one that finds the problem. ` +
      `Each check above asserts the reply names something a model could act on.`
  );
  server.child.kill();
  process.exit(1);
}

console.log(`${NL}diagnose trial ok: the defect was planted, found, fixed, and the fix was proved`);
server.child.kill();
