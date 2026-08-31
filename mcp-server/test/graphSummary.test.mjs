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

test("a filtered read carries the nodes its matches are wired to", () => {
  // The failure this prevents: match "Kronos Match", get back a node whose wiring reads
  // `in HostParams <- BE59B028.ReturnValue`, and BE59B028 is not in the reply. The link cannot be
  // followed, so the filter that was supposed to save a call has cost one instead.
  const result = capGraphSummary({
    nodes: [
      {
        id: "AAAA1111",
        type: "K2Node_CallFunction",
        title: "Create Kronos Match",
        connectedPins: [{ pin: "HostParams", direction: "in", linkedTo: [{ node: "BBBB2222", pin: "ReturnValue" }] }],
      },
      {
        id: "BBBB2222",
        type: "K2Node_CallFunction",
        title: "Make Kronos Host Params",
        connectedPins: [{ pin: "ReturnValue", direction: "out", linkedTo: [{ node: "AAAA1111", pin: "HostParams" }] }],
      },
      { id: "CCCC3333", type: "K2Node_CallFunction", title: "Print String", connectedPins: [] },
    ],
  }, { match: "Kronos Match" });

  assert.equal(result.matched, 1);
  assert.equal(result.neighbours, 1);
  const ids = result.nodes.map((n) => n.id);
  assert.ok(ids.includes("AAAA1111"), "the match itself");
  assert.ok(ids.includes("BBBB2222"), "the node its HostParams pin comes from");
  assert.ok(!ids.includes("CCCC3333"), "an unrelated node is still excluded");
});

test("a neighbour is labelled and carries no wiring of its own", () => {
  // One hop, deliberately. A neighbour's own links would name a second ring of ids that are not in
  // the reply, which is the same unresolvable-link problem one step further out.
  const result = capGraphSummary({
    nodes: [
      {
        id: "AAAA1111",
        type: "K2Node_CallFunction",
        title: "Create Kronos Match",
        connectedPins: [{ pin: "HostParams", direction: "in", linkedTo: [{ node: "BBBB2222", pin: "ReturnValue" }] }],
      },
      {
        id: "BBBB2222",
        type: "K2Node_CallFunction",
        title: "Make Kronos Host Params",
        connectedPins: [{ pin: "Playlist", direction: "in", linkedTo: [{ node: "DDDD4444", pin: "out" }] }],
      },
      { id: "DDDD4444", type: "K2Node_VariableGet", title: "Get Playlist", connectedPins: [] },
    ],
  }, { match: "Create Kronos" });

  const near = result.nodes.find((n) => n.id === "BBBB2222");
  assert.equal(near.neighbour, true);
  assert.equal(near.pins, undefined, "a neighbour carries no pins");
  assert.equal(near.title, "Make Kronos Host Params", "but it carries the title, which is the point");
  assert.ok(!result.nodes.some((n) => n.id === "DDDD4444"), "and it stops at one hop");
});

test("an unfiltered read is unchanged by neighbour expansion", () => {
  const nodes = [
    { id: "A", type: "K2Node_Event", title: "Event BeginPlay", connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "B", pin: "execute" }] }] },
    { id: "B", type: "K2Node_CallFunction", title: "Print String", connectedPins: [] },
  ];
  const result = capGraphSummary({ nodes });
  assert.equal(result.nodes.length, 2);
  assert.equal(result.neighbours, undefined);
  assert.ok(!result.nodes.some((n) => n.neighbour), "nothing is labelled a neighbour when nothing was filtered");
});

test("no link in a filtered reply points at a node that is not in it", () => {
  // The invariant, stated as itself rather than as the mechanism that delivers it. Verified live on
  // a real 809-node graph across three different filters: zero dangling ids in every one.
  const nodes = [];
  for (let i = 0; i < 200; i += 1) {
    nodes.push({
      id: `N${String(i).padStart(4, "0")}`,
      type: "K2Node_CallFunction",
      title: i % 3 === 0 ? `Cast To Thing ${i}` : `Other ${i}`,
      connectedPins: [
        { pin: "execute", direction: "in", linkedTo: [{ node: `N${String((i + 199) % 200).padStart(4, "0")}`, pin: "then" }] },
        { pin: "then", direction: "out", linkedTo: [{ node: `N${String((i + 1) % 200).padStart(4, "0")}`, pin: "execute" }] },
      ],
    });
  }
  // maxNodes deliberately below the match count, so the cap path runs and cuts some matches.
  const result = capGraphSummary({ nodes }, { match: "Cast To", maxNodes: 10 });
  assert.ok(result.truncated, "the cap must actually have fired for this to be the case under test");

  const present = new Set(result.nodes.map((n) => n.id));
  for (const n of result.nodes) {
    for (const line of n.pins ?? []) {
      const targets = /(?:->|<-)\s*(.+)$/.exec(line);
      if (!targets) continue;
      for (const ref of targets[1].split(", ")) {
        assert.ok(present.has(ref.split(".")[0]), `${n.id} links to ${ref}, which is not in the reply`);
      }
    }
  }
});

test("an unfiltered capped read does not pay for neighbour backfill", () => {
  // Guarding a regression that was measured, not imagined: backfilling cut nodes on the unfiltered
  // path took the 809-node graph from 2,121 tokens to 3,879. The commonest read of all must not get
  // more expensive to fix dangling links in a reply that already announces it is truncated.
  const nodes = [];
  for (let i = 0; i < 300; i += 1) {
    nodes.push({
      id: `N${String(i).padStart(4, "0")}`,
      type: "K2Node_CallFunction",
      title: `Node ${i}`,
      connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: `N${String((i + 1) % 300).padStart(4, "0")}`, pin: "execute" }] }],
    });
  }
  const result = capGraphSummary({ nodes }, { maxNodes: 20 });
  assert.equal(result.shown, 20);
  assert.equal(result.nodes.length, 20, "exactly the cap, with nothing added back");
  assert.equal(result.neighbours, undefined);
});
