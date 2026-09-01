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
// Usage: node scripts/trial-diagnose.mjs               (needs an editor open)
//        node scripts/trial-diagnose.mjs --by-preset   (same trial, on the "diagnose" preset alone)
//
// --by-preset is how the preset earns the word "sufficient". A curated tool list always LOOKS
// complete; the only way to know is to run the whole loop with nothing else switched on and see
// whether it finishes. If a tool is missing, this fails on the step that needed it.

import { startAndInitialize } from "./lib/mcpStdio.mjs";

const NL = String.fromCharCode(10);
const PKG = "/Game/__MCPDiagnoseTrial/BP_DiagnoseTrial";
const PATH = `${PKG}.BP_DiagnoseTrial`;

const byPreset = process.argv.includes("--by-preset");
const server = await startAndInitialize(
  { UNREAL_MCP_PROFILE: byPreset ? "search" : "full" },
  "trial-diagnose"
);

if (byPreset) {
  const size = async () => {
    const listed = await server.request("tools/list", {});
    return Math.round(JSON.stringify(listed?.result?.tools ?? []).length / 4);
  };
  const before = await size();
  const r = await server.request("tools/call", {
    name: "unreal_enable_tools",
    // The preset plus this trial's own scaffolding. Planting a defect means creating a Blueprint and
    // throwing it away afterwards, and neither is part of diagnosing anything - a preset that
    // included them would be claiming a job it does not do. Every step BETWEEN them runs on the
    // preset alone, which is what is being tested.
    arguments: { preset: "diagnose", tools: ["unreal_create_blueprint", "unreal_delete_asset"] },
  });
  if (r?.result?.isError) {
    console.error("the diagnose preset would not enable:", JSON.stringify(r.result).slice(0, 200));
    process.exit(1);
  }
  console.log(`diagnose preset + 2 harness tools: ${await size()} tokens standing (search baseline ${before}); core would be 11666`);
  console.log("");
}
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
  // A tool that REFUSED did not answer, whatever its own check thinks.
  //
  // This used to test `r.error` only, which is the JSON-RPC transport error - a tool-level refusal
  // arrives as `result.isError` with the reason as ordinary text content. So a step whose check was
  // "did anything come back" passed on the refusal, because a refusal is words.
  //
  // It was not hypothetical. "find orphans project-wide" called unreal_find_orphans with `{}`, which
  // the schema rejects for missing `of` and `pairedWith`, and this trial reported the whole loop
  // green - "the defect was planted, found, fixed, and the fix was proved" - with one of the finding
  // steps having never run. It even costed the error message at 89 tokens.
  const refused = r.result?.isError === true;
  const problem = r.error
    ? "JSON-RPC error"
    : refused
      ? "the tool refused the call"
      : check
        ? check(text, parsed)
        : null;
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

// A second, independent finder for the same defect.
//
// This used to call unreal_find_orphans with `{}`, and it was wrong twice. The schema rejects that
// for missing `of` and `pairedWith`, so the step never ran - and it passed anyway, because its check
// was "did anything come back" and a refusal is words. But even with the right arguments it was the
// wrong tool: find_orphans looks for a LEVEL ACTOR of one class stranded far from its partner class,
// which is half a deletion in a map, not a node left behind in a graph.
//
// explain_graph is the tool that can actually see this. Its `unreachable` list is nodes no event
// chain reaches, which is exactly what the planted defect is - and it is worth having a second
// finder that arrives at the answer a different way, because review_blueprint agreeing with itself
// twice proves less than two tools agreeing once.
await step(
  "explain the graph, to reach the orphan another way",
  "unreal_explain_graph",
  { path: PATH, graphName: "EventGraph" },
  (t, j) => {
    if (!j) return "explain_graph did not come back as JSON";
    // The prose, not a field. explain_graph deliberately drops the `unreachable` ARRAY from its
    // reply because the sentence already says the same thing - the array was 110 tokens of restating
    // it - so the orphan shows up in `text` or nowhere.
    const text = String(j.text ?? "");
    if (!/not reached by any event chain/i.test(text)) {
      return `no unreachable sentence, so the orphan has nowhere to show up: ${text.slice(0, 160)}`;
    }
    // The planted node is a PrintString wired to nothing. Naming it is the whole point: a count
    // would be true and unactionable.
    return /Print\s*String/i.test(text) ? null : "the unreachable list does not name the stray node";
  }
);

// The way a bug report actually arrives: a name, in prose, and nothing else.
//
// This step exists because its absence hid a real gap. The `diagnose` preset - the one whose whole
// job is finding a reported bug - did not contain unreal_map_system, the tool "the countdown never
// shows up" lands on. Nothing caught it, because this trial planted a defect and went straight to
// the tools that find THAT defect. A preset check only checks the path the trial walks.
await step("find the system from a name alone", "unreal_map_system", { query: "DiagnoseTrial" }, (t, j) => {
  if (!j) return "no reply";
  if (/disabled/i.test(t)) return "map_system is not in this preset - a bug report has nowhere to land";
  return String(j.text ?? "").includes("DiagnoseTrial") ? null : "the planted Blueprint was not in the map";
});

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
