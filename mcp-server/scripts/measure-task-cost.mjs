#!/usr/bin/env node
// What does a whole TASK cost, and does dispatch mode make it cheaper or dearer?
//
// Everything else here measures one number at a time: measure-profiles guards the standing cost of
// the tool definitions, measure-reads guards what a single reply costs. Neither answers the question
// a frontier model's bill is actually made of, which is what it costs to finish a piece of work.
//
// The two modes trade against each other and nobody had put a number on the trade:
//
//   full    every tool advertised. Large standing cost, paid once and then served from the prompt
//           cache, and each call is a direct call with no wrapper.
//   search  three tools advertised. Tiny standing cost, but every call goes through
//           unreal_call_tool, which costs a wrapper on the way in and can add guidance on the way
//           out - and that is per call, so it grows with the task while the standing saving does not.
//
// So there is a break-even, and where it sits decides which mode to recommend. Guessing at it would
// be exactly the kind of unmeasured claim the rest of this repo exists to avoid.
//
// A note on the standing cost, because it is easy to overstate. The tool list is sent before the
// system prompt and the messages, so with prompt caching it is paid at full price ONCE and read
// cheaply after that. It is NOT re-charged per turn. What re-charges it is a change to the tool
// list, which is why unreal_enable_tools is expensive and unreal_call_tool exists.
//
// Usage: node scripts/measure-task-cost.mjs        (needs an editor open)

import { startAndInitialize, listTools, estimateTokens } from "./lib/mcpStdio.mjs";

const SCRATCH = "/Game/MCPTaskCost/BP_TaskCostProbe";

/** The steps a "find this bug and fix it" task actually takes, in order. */
const TASK = [
  ["create the Blueprint", "unreal_create_blueprint", { packagePath: SCRATCH, parentClass: "Actor" }],
  [
    "build a graph with an orphan node",
    "unreal_build_graph",
    {
      path: SCRATCH,
      graphName: "EventGraph",
      nodes: [
        { ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" },
        { ref: "say", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
        // The defect: a second PrintString wired to nothing, which is what a node left behind by
        // moved wiring looks like. Same shape trial-diagnose plants, so the two agree on the task.
        { ref: "stray", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
      ],
      connections: [{ from: "ev.then", to: "say.execute" }],
      compile: true,
    },
  ],
  ["review the Blueprint", "unreal_review_blueprint", { path: SCRATCH }],
  ["compile it", "unreal_compile_blueprint", { path: SCRATCH }],
  ["explain the graph", "unreal_explain_graph", { path: SCRATCH, graphName: "EventGraph" }],
  ["clean up the Blueprint", "unreal_cleanup_blueprint", { path: SCRATCH, dryRun: false }],
  ["re-review to confirm", "unreal_review_blueprint", { path: SCRATCH }],
  ["delete the trial asset", "unreal_delete_asset", { path: SCRATCH, force: true }],
];

async function run(mode) {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: mode }, `task-cost-${mode}`);
  const listed = await listTools(server);

  // Start from nothing, every time.
  //
  // The task creates an asset and deletes it at the end, so a run that dies in the middle leaves it
  // behind and the NEXT run fails on "package_already_exists" - which happened twice while this was
  // being written. A benchmark that only works on a clean machine is one nobody runs twice. Not
  // counted: this is setup, and charging it to the mode would flatter whichever ran second.
  await server
    .request("tools/call", {
      name: mode === "search" ? "unreal_call_tool" : "unreal_delete_asset",
      arguments:
        mode === "search"
          ? { tool: "unreal_delete_asset", args: { path: SCRATCH, force: true } }
          : { path: SCRATCH, force: true },
    })
    .catch(() => undefined);

  let replyTokens = 0;
  let requestTokens = 0;
  const perStep = [];

  for (const [label, tool, args] of TASK) {
    // In search mode nothing but the three meta-tools is advertised, so every step goes through the
    // dispatcher exactly as a model would have to.
    const outgoing =
      mode === "search"
        ? { name: "unreal_call_tool", arguments: { tool, args } }
        : { name: tool, arguments: args };

    requestTokens += estimateTokens(JSON.stringify(outgoing).length);
    const res = await server.request("tools/call", { name: outgoing.name, arguments: outgoing.arguments });
    const text = (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    // Refuse to report a cost for a call that failed.
    //
    // The first run of this script passed `params` where the dispatcher wants `args`, so every step
    // came back as the same validation error - and search "won" by 308 tokens per task, because an
    // error is short. Eight identical step costs is what gave it away. A benchmark that silently
    // measures failures reports whichever mode fails more cheaply.
    if (res?.result?.isError) {
      console.error(`\n${mode}: "${label}" failed, so there is nothing to measure:`);
      console.error(`  ${text.slice(0, 300)}`);
      process.exit(1);
    }

    const t = estimateTokens(text.length);
    replyTokens += t;
    perStep.push({ label, tokens: t });
  }

  server.child.kill();
  return { mode, standing: listed.tokens, tools: listed.tools.length, replyTokens, requestTokens, perStep };
}

const full = await run("full");
const search = await run("search");

console.log(`\n  ${"step".padEnd(34)}${"full".padStart(8)}${"search".padStart(9)}`);
console.log(`  ${"-".repeat(34)}${"-".repeat(8)}${"-".repeat(9)}`);
for (let i = 0; i < TASK.length; i++) {
  console.log(
    `  ${full.perStep[i].label.padEnd(34)}${String(full.perStep[i].tokens).padStart(8)}${String(search.perStep[i].tokens).padStart(9)}`
  );
}

const row = (label, a, b) => console.log(`  ${label.padEnd(34)}${String(a).padStart(8)}${String(b).padStart(9)}`);
console.log("");
row("tools advertised", full.tools, search.tools);
row("standing (paid once, then cached)", full.standing, search.standing);
row("requests sent", full.requestTokens, search.requestTokens);
row("replies received", full.replyTokens, search.replyTokens);
console.log("");
row("first run of this task", full.standing + full.requestTokens + full.replyTokens, search.standing + search.requestTokens + search.replyTokens);
row("each repeat, cache warm", full.requestTokens + full.replyTokens, search.requestTokens + search.replyTokens);

const standingSaved = full.standing - search.standing;
const perTaskExtra = search.requestTokens + search.replyTokens - (full.requestTokens + full.replyTokens);
console.log("");
if (perTaskExtra <= 0) {
  console.log(`  search is cheaper on BOTH counts: ${standingSaved} tokens of standing cost saved, and`);
  console.log(`  ${-perTaskExtra} fewer tokens per run of the task.`);
} else {
  const breakEven = standingSaved / perTaskExtra;
  console.log(`  search saves ${standingSaved} standing tokens and costs ${perTaskExtra} more per run of`);
  console.log(`  this ${TASK.length}-call task, so it stays ahead for the first ${breakEven.toFixed(1)} runs -`);
  console.log(`  about ${Math.round(breakEven * TASK.length)} calls - and is dearer after that.`);
}
