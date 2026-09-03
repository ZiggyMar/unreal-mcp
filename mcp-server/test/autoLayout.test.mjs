import { test } from "node:test";
import assert from "node:assert/strict";

import { autoLayoutGraph } from "../dist/autoLayout.js";

function node(id, type, title, links = []) {
  const pins = new Map();
  for (const [pin, direction, toNode, toPin] of links) {
    const key = `${pin}:${direction}`;
    if (!pins.has(key)) pins.set(key, { pin, direction, linkedTo: [] });
    if (toNode) pins.get(key).linkedTo.push({ node: toNode, pin: toPin });
  }
  return { id, type, title, connectedPins: [...pins.values()] };
}

/** A bridge that records calls and replies with a fixed graph summary. */
function fakeBridge(nodes, { failMoveFor = null } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd, params) {
      calls.push({ cmd, params });
      if (cmd === "read_blueprint_graph_summary") {
        return { path: params.path, graphName: params.graphName, nodes };
      }
      if (cmd === "organize_graph") {
        if (params.action === "move_node" && params.nodeId === failMoveFor) {
          throw new Error(`node_not_found: ${params.nodeId}`);
        }
        return { ok: true };
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  };
}

const CHAIN = [
  node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "p", "execute"]]),
  node("p", "K2Node_CallFunction", "Print String", [
    ["execute", "in", "ev", "then"],
    ["then", "out", "d", "execute"],
  ]),
  node("d", "K2Node_CallFunction", "Delay", [["execute", "in", "p", "then"]]),
];

test("every node is moved, once, with integer coordinates", async () => {
  const bridge = fakeBridge(CHAIN);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph", { addCommentBoxes: false });

  assert.equal(report.nodesMoved, 3);
  assert.deepEqual(report.failures, []);

  const moves = bridge.calls.filter((c) => c.params?.action === "move_node");
  assert.equal(moves.length, 3);
  assert.deepEqual(
    moves.map((m) => m.params.nodeId).sort(),
    ["d", "ev", "p"]
  );
  for (const move of moves) {
    assert.ok(Number.isInteger(move.params.x), "x must be an integer");
    assert.ok(Number.isInteger(move.params.y), "y must be an integer");
    assert.equal(move.params.path, "/Game/BP_Foo.BP_Foo");
    assert.equal(move.params.graphName, "EventGraph");
  }
});

test("the graph is read exactly once, before any write", async () => {
  const bridge = fakeBridge(CHAIN);
  await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph");

  const reads = bridge.calls.filter((c) => c.cmd === "read_blueprint_graph_summary");
  assert.equal(reads.length, 1);
  assert.equal(bridge.calls[0].cmd, "read_blueprint_graph_summary");
});

test("a comment box is added per chain, enclosing its nodes with padding", async () => {
  const bridge = fakeBridge(CHAIN);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph");

  assert.deepEqual(report.commentBoxesAdded, ["Event BeginPlay"]);

  const boxes = bridge.calls.filter((c) => c.params?.action === "add_comment_box");
  assert.equal(boxes.length, 1);
  const box = boxes[0].params;
  assert.equal(box.text, "Event BeginPlay");

  const moves = bridge.calls.filter((c) => c.params?.action === "move_node");
  const minX = Math.min(...moves.map((m) => m.params.x));
  const minY = Math.min(...moves.map((m) => m.params.y));
  assert.ok(box.x < minX, "the box must start left of its leftmost node");
  assert.ok(box.y < minY, "the box must start above its topmost node, leaving room for the title bar");
  assert.ok(box.width > 0 && box.height > 0);
  // Every node must fall inside the box.
  for (const move of moves) {
    assert.ok(move.params.x >= box.x, `${move.params.nodeId} is left of the box`);
    assert.ok(move.params.y >= box.y, `${move.params.nodeId} is above the box`);
    assert.ok(move.params.x <= box.x + box.width, `${move.params.nodeId} is right of the box`);
    assert.ok(move.params.y <= box.y + box.height, `${move.params.nodeId} is below the box`);
  }
});

test("running twice does not stack duplicate comment boxes", async () => {
  const withExistingBox = [...CHAIN, node("c1", "EdGraphNode_Comment", "Event BeginPlay")];
  const bridge = fakeBridge(withExistingBox);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph");

  assert.deepEqual(report.commentBoxesAdded, []);
  assert.deepEqual(report.commentBoxesSkipped, ["Event BeginPlay"]);
  assert.equal(report.existingCommentBoxes, 1);
  assert.equal(bridge.calls.filter((c) => c.params?.action === "add_comment_box").length, 0);
});

test("addCommentBoxes:false lays out without touching comments", async () => {
  const bridge = fakeBridge(CHAIN);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph", { addCommentBoxes: false });

  assert.equal(report.nodesMoved, 3);
  assert.deepEqual(report.commentBoxesAdded, []);
  assert.equal(bridge.calls.filter((c) => c.params?.action === "add_comment_box").length, 0);
});

test("one unmovable node is reported without abandoning the rest of the graph", async () => {
  const bridge = fakeBridge(CHAIN, { failMoveFor: "p" });
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph", { addCommentBoxes: false });

  assert.equal(report.nodesMoved, 2);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].nodeId, "p");
  assert.match(report.failures[0].error, /node_not_found/);
});

test("a single-node chain is not boxed", async () => {
  const bridge = fakeBridge([node("ev", "K2Node_Event", "Event BeginPlay")]);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph");

  assert.equal(report.nodesMoved, 1);
  assert.deepEqual(report.commentBoxesAdded, []);
});

test("an empty graph does no writes at all", async () => {
  const bridge = fakeBridge([]);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph");

  assert.equal(report.nodesMoved, 0);
  assert.equal(bridge.calls.filter((c) => c.cmd === "organize_graph").length, 0);
});

test("two events get one box each, and the boxes do not overlap", async () => {
  const nodes = [
    node("ev1", "K2Node_Event", "Event BeginPlay", [["then", "out", "a1", "execute"]]),
    node("a1", "K2Node_CallFunction", "Print String", [["execute", "in", "ev1", "then"]]),
    node("ev2", "K2Node_Event", "Event Tick", [["then", "out", "a2", "execute"]]),
    node("a2", "K2Node_CallFunction", "Add", [["execute", "in", "ev2", "then"]]),
  ];
  const bridge = fakeBridge(nodes);
  const report = await autoLayoutGraph(bridge, "/Game/BP_Foo.BP_Foo", "EventGraph");

  assert.deepEqual(report.commentBoxesAdded.sort(), ["Event BeginPlay", "Event Tick"]);

  const [b1, b2] = bridge.calls.filter((c) => c.params?.action === "add_comment_box").map((c) => c.params);
  const overlapX = b1.x < b2.x + b2.width && b2.x < b1.x + b1.width;
  const overlapY = b1.y < b2.y + b2.height && b2.y < b1.y + b1.height;
  assert.ok(!(overlapX && overlapY), "comment boxes must not overlap, or they hide each other");
});

test("a graph that already has comment boxes gets no new ones", () => {
  // The duplicate-box bug, in miniature. The old dedupe compared against `node.title`, which for a
  // comment box is the literal string "Comment" - the box's name lives in `text`, which LayoutNode
  // does not carry. So nothing ever matched and a second run boxed the same nodes again, leaving an
  // overlappingBoxes fault where both boxes claim every node. Measured on BP_TrailerMomGlitch: it
  // reported existingCommentBoxes 1 and then added "Event BeginPlay" over a hand-titled box.
  const nodes = [
    node("box", "EdGraphNode_Comment", "Comment"),
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "a", "execute"]]),
    node("a", "K2Node_CallFunction", "A", [["execute", "in", null, null], ["then", "out", "b", "execute"]]),
    node("b", "K2Node_CallFunction", "B", [["execute", "in", null, null]]),
  ];
  const bridge = fakeBridge(nodes);
  return autoLayoutGraph(bridge, { path: "/Game/X", graphName: "EventGraph" }).then((report) => {
    const added = bridge.calls.filter(
      (c) => c.cmd === "organize_graph" && c.params.action === "add_comment_box"
    );
    assert.equal(added.length, 0, "must not add a box to an already-boxed graph");
    assert.equal(report.commentBoxesAdded.length, 0);
    assert.ok(report.commentBoxesSkipped.length > 0, "and must say what it left alone");
    assert.equal(report.existingCommentBoxes, 1);
  });
});

test("a graph with no boxes still gets them", () => {
  // The fix must not disable boxing on a fresh graph, which is what the tool is for.
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "a", "execute"]]),
    node("a", "K2Node_CallFunction", "A", [["execute", "in", null, null], ["then", "out", "b", "execute"]]),
    node("b", "K2Node_CallFunction", "B", [["execute", "in", null, null]]),
  ];
  const bridge = fakeBridge(nodes);
  return autoLayoutGraph(bridge, { path: "/Game/X", graphName: "EventGraph" }).then((report) => {
    assert.ok(report.commentBoxesAdded.length > 0, "a fresh graph should still be boxed");
  });
});
