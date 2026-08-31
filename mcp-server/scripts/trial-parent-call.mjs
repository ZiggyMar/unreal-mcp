// Plant the second most expensive finding this project makes, fix it with one call, and prove the
// chain survived - against a real editor, on assets this creates and deletes.
//
// The bug: adding an event to a child Blueprint REPLACES the parent's rather than extending it.
// Nothing warns and it compiles clean.
//
// This trial has already earned its place twice. It caught unreal_call_parent_function reporting
// "already calls the parent" about a graph where the parent node existed and NOTHING RAN IT -
// presence mistaken for effect. And the way it got into that state is the bug itself: creating an
// override event makes the editor add the parent call for you, and the next thing to touch the
// event's exec pin displaces it. The trial's own setup did that by accident, which is how sharp
// the edge is.
import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { sweepScratch, cleanUpScratch, SCRATCH_ROOT } from "./lib/scratch.mjs";
import { callParentFirst } from "../dist/parentCall.js";


/** Read the graph fresh and follow exec from the BeginPlay event, independent of the tool's own view. */
async function walkChain(b, path) {
  const summary = await b.send("read_blueprint_graph_summary", { path, graphName: "EventGraph" });
  const nodes = summary.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur = nodes.find((n) => /Event/.test(n.type) && /beginplay/i.test(n.title.replace(/[^a-z]/gi, "")));
  const walk = [];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    walk.push(cur.title);
    const out = (cur.connectedPins ?? []).find((p) => p.direction === "out" && /^(then|exec)$/i.test(p.pin));
    const next = out?.linkedTo?.[0]?.node;
    cur = next ? byId.get(next) : undefined;
  }
  return walk;
}

const b = new UnrealBridgeClient();
const stamp = String(Date.now()).slice(-6);
const PARENT = `/Game/MCPTrial/BP_TrialParent${stamp}`;
const CHILD = `/Game/MCPTrial/BP_TrialChild${stamp}`;

const cleanup = [];

// This trial is where the seven leftover Blueprints came from - runs killed before `finally` could
// execute. An exit path cannot clean up after a process that is no longer running, so the sweep
// happens on the way in.
await sweepScratch({
  list: async () => {
    const listed = await b.send("list_blueprints", { pathPrefix: SCRATCH_ROOT, maxResults: 200 });
    return (listed.blueprints ?? []).map((bp) => bp.path);
  },
  remove: (path) => b.send("delete_asset", { path, force: true }),
});

try {
  await b.send("create_blueprint", { packagePath: PARENT, parentClass: "Actor" });
  cleanup.push(PARENT);
  // The parent does something on BeginPlay, so skipping it is a real omission.
  await b.send("build_graph", {
    path: PARENT,
    graphName: "EventGraph",
    nodes: [
      { ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" },
      { ref: "p", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
    ],
    connections: [{ from: "ev.then", to: "p.execute" }],
  });
  await b.send("save_blueprint", { path: PARENT });

  await b.send("create_blueprint", { packagePath: CHILD, parentClass: `${PARENT}.${PARENT.split("/").pop()}_C` });
  cleanup.push(CHILD);
  // The child overrides BeginPlay and runs its OWN chain, replacing the parent's silently.
  await b.send("build_graph", {
    path: CHILD,
    graphName: "EventGraph",
    nodes: [
      { ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" },
      { ref: "a", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
      { ref: "c", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
    ],
    connections: [
      { from: "ev.then", to: "a.execute" },
      { from: "a.then", to: "c.execute" },
    ],
  });
  await b.send("save_blueprint", { path: CHILD });

  const chainWas = await walkChain(b, CHILD);
  console.log("before :", chainWas.join(" -> "));

  const dry = await callParentFirst(b, CHILD, "EventGraph", "BeginPlay", { dryRun: true });
  console.log("dryRun :", dry.summary);
  console.log("        displaced:", JSON.stringify(dry.displaced));

  const real = await callParentFirst(b, CHILD, "EventGraph", "BeginPlay");
  console.log("applied:", real.summary);
  console.log("        verified:", real.verified, "errors:", real.errorsBefore, "->", real.errorsAfter);

  const walk = await walkChain(b, CHILD);
  console.log("after  :", walk.join(" -> "));

  // The claim is about the CHAIN, not the node count. Creating an override event makes the editor
  // add a parent call already, and build_graph then displaces it - which is the bug this fixes - so
  // the node may well have existed before and the total is unchanged. What has to be true is that
  // the parent runs second and everything that ran before still runs after it.
  const ok =
    walk.length === chainWas.length + 1 &&
    /^Parent/i.test(walk[1] ?? "") &&
    chainWas.slice(1).every((title, i) => walk[i + 2] === title);
  const twice = await callParentFirst(b, CHILD, "EventGraph", "BeginPlay");
  console.log("rerun  :", twice.alreadyPresent ? "alreadyPresent, unchanged" : "ADDED A SECOND ONE");

  console.log(ok && twice.alreadyPresent && !twice.added ? "\nPARENT-CALL TRIAL OK" : "\nPARENT-CALL TRIAL FAILED");
} finally {
  await cleanUpScratch(cleanup, (path) => b.send("delete_asset", { path, force: true }), console.log, (paths) => b.send("delete_asset", { paths, force: true }));
}
