import { test } from "node:test";
import assert from "node:assert/strict";

import { capGraphSummary, DEFAULT_MAX_NODES } from "../dist/graphSummary.js";

const node = (id, type, title) => ({ id, type, title });

/** A graph the size of a real one: BP_Player's EventGraph is 807 nodes. */
function bigGraph(count = 807) {
  const nodes = [
    node("e1", "K2Node_Event", "Event BeginPlay"),
    node("e2", "K2Node_Event", "Event Tick"),
    node("e3", "K2Node_CustomEvent", "ServerTakeDamage"),
  ];
  for (let i = nodes.length; i < count; i++) {
    nodes.push(node(`n${i}`, "K2Node_CallFunction", i % 40 === 0 ? `Cast To BP_Health` : `Print String ${i}`));
  }
  return { path: "/Game/X.X", graphName: "EventGraph", nodes };
}

test("a small graph carries no truncation bookkeeping, but is still compacted", () => {
  const small = { path: "/Game/X.X", graphName: "EventGraph", nodes: [node("a", "K2Node_Event", "Event BeginPlay")] };
  const out = capGraphSummary(small);
  assert.equal(out.truncated, undefined, "nothing was cut, so nothing should claim it was");
  assert.equal(out.totalNodes, undefined);
  assert.equal(out.path, "/Game/X.X");
  // Compaction is not about size-per-graph, it is about shape: the wiring form costs the same per
  // node whether there are five of them or eight hundred, so it applies either way.
  assert.equal(out.nodes[0].type, "Event", "the K2Node_ prefix identifies nothing and is stripped");
});

test("wiring is flattened to one readable line per pin", () => {
  // Measured: 65% of a real graph reply was JSON keys and punctuation, mostly because every link is
  // its own {"node":..,"pin":..} object - "node" and "pin" repeated 1,642 times to carry two short
  // strings each.
  const wired = {
    nodes: [
      {
        id: "aaaaaaaa",
        type: "K2Node_Event",
        title: "Event BeginPlay",
        connectedPins: [
          { pin: "then", direction: "out", linkedTo: [{ node: "bbbbbbbb", pin: "execute" }] },
          { pin: "unused", direction: "out", linkedTo: [] },
        ],
      },
    ],
  };
  const out = capGraphSummary(wired);
  assert.deepEqual(out.nodes[0].pins, ["out then -> bbbbbbbb.execute", "out unused"]);
  assert.equal(out.nodes[0].connectedPins, undefined, "the nested form should not also be carried");
});

test("a node with no connections carries no pins field at all", () => {
  const out = capGraphSummary({ nodes: [node("a", "K2Node_Event", "Event BeginPlay")] });
  assert.equal(out.nodes[0].pins, undefined, "an empty array would cost tokens to say nothing");
});

test("a huge graph is capped, and says so rather than looking complete", () => {
  // The measured case: 807 nodes returned 126,477 tokens - 63% of a 200k window in one call.
  const out = capGraphSummary(bigGraph());
  assert.equal(out.nodes.length, DEFAULT_MAX_NODES);
  assert.equal(out.totalNodes, 807);
  assert.equal(out.truncated, true);
  assert.equal(out.omitted, 807 - DEFAULT_MAX_NODES);
  assert.match(out.next, /match/, "it must say how to ask a cheaper question");
  assert.match(out.next, /unreal_explain_graph/);
});

test("entry points are never the nodes that get dropped", () => {
  // A cap that loses the events leaves a list of function calls belonging to nothing.
  const out = capGraphSummary(bigGraph(), { maxNodes: 5 });
  // Types come back with the K2Node_ prefix stripped.
  const kinds = out.nodes.map((n) => n.type);
  assert.ok(kinds.includes("Event"), "events must survive the cap");
  assert.ok(kinds.includes("CustomEvent"), "custom events too");
  assert.equal(out.nodes.filter((n) => n.type === "Event").length, 2, "both events, not just one");
});

test("match answers a specific question for a fraction of the nodes", () => {
  const out = capGraphSummary(bigGraph(), { match: "Cast" });
  assert.ok(out.nodes.length > 0 && out.nodes.length < 40, `expected a handful, got ${out.nodes.length}`);
  assert.ok(out.nodes.every((n) => /Cast/i.test(n.title)));
  assert.equal(out.totalNodes, 807, "the total is still reported so the caller knows what it did not see");
});

test("match is applied before the cap, not after", () => {
  // Filtering after capping would search only the first 60 nodes and miss everything beyond them -
  // which on an 807-node graph is almost the whole graph.
  const nodes = [];
  for (let i = 0; i < 400; i++) nodes.push(node(`n${i}`, "K2Node_CallFunction", "Print String"));
  nodes.push(node("target", "K2Node_CallFunction", "Apply Damage To Health"));
  const out = capGraphSummary({ nodes }, { match: "Health" });
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].id, "target", "a match near the end must still be found");
});

test("maxNodes can be raised when the whole graph is genuinely wanted", () => {
  const out = capGraphSummary(bigGraph(), { maxNodes: 5000 });
  assert.equal(out.nodes.length, 807);
  assert.equal(out.truncated, undefined, "nothing was cut, so nothing should claim it was");
});

test("a match that finds nothing is empty and honest, not the whole graph", () => {
  const out = capGraphSummary(bigGraph(), { match: "zzz-nothing-here" });
  assert.equal(out.nodes.length, 0);
  assert.equal(out.matched, 0);
  assert.equal(out.totalNodes, 807);
});
