import { test } from "node:test";
import assert from "node:assert/strict";

import { computeGraphLayout, groupIntoChains, estimateNodeSize, isEventNode } from "../dist/layout.js";

/** Terse helper: node("a", "K2Node_CallFunction", "Print String", [["then","out","b","execute"]]) */
function node(id, type, title, links = []) {
  const pins = new Map();
  for (const [pin, direction, toNode, toPin] of links) {
    const key = `${pin}:${direction}`;
    if (!pins.has(key)) pins.set(key, { pin, direction, linkedTo: [] });
    if (toNode) pins.get(key).linkedTo.push({ node: toNode, pin: toPin });
  }
  return { id, type, title, connectedPins: [...pins.values()] };
}

function positionOf(result, id) {
  const found = result.positions.find((p) => p.id === id);
  assert.ok(found, `no position for ${id}`);
  return found;
}

function assertNoOverlaps(result) {
  const boxes = result.positions;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
      const overlapY = a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!(overlapX && overlapY), `${a.id} overlaps ${b.id}`);
    }
  }
}

test("a linear exec chain lays out left to right, one node per column", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "print", "execute"]]),
    node("print", "K2Node_CallFunction", "Print String", [
      ["execute", "in", "ev", "then"],
      ["then", "out", "delay", "execute"],
    ]),
    node("delay", "K2Node_CallFunction", "Delay", [["execute", "in", "print", "then"]]),
  ];
  const result = computeGraphLayout(nodes);

  assert.equal(result.columns, 3);
  assert.equal(positionOf(result, "ev").column, 0);
  assert.equal(positionOf(result, "print").column, 1);
  assert.equal(positionOf(result, "delay").column, 2);
  assert.ok(positionOf(result, "ev").x < positionOf(result, "print").x);
  assert.ok(positionOf(result, "print").x < positionOf(result, "delay").x);
  assertNoOverlaps(result);
});

test("a straight exec chain is straightened onto one row", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event Tick", [["then", "out", "a", "execute"]]),
    node("a", "K2Node_CallFunction", "Add", [
      ["execute", "in", "ev", "then"],
      ["then", "out", "b", "execute"],
    ]),
    node("b", "K2Node_CallFunction", "Set Actor Location", [["execute", "in", "a", "then"]]),
  ];
  const result = computeGraphLayout(nodes);
  const ys = ["ev", "a", "b"].map((id) => positionOf(result, id).y);
  assert.deepEqual(ys, [ys[0], ys[0], ys[0]], `exec chain should share a row, got ${ys}`);
});

test("a branch puts both exec outputs in the same column without overlapping", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "br", "execute"]]),
    node("br", "K2Node_IfThenElse", "Branch", [
      ["execute", "in", "ev", "then"],
      ["True", "out", "yes", "execute"],
      ["False", "out", "no", "execute"],
    ]),
    node("yes", "K2Node_CallFunction", "Print String", [["execute", "in", "br", "True"]]),
    node("no", "K2Node_CallFunction", "Destroy Actor", [["execute", "in", "br", "False"]]),
  ];
  const result = computeGraphLayout(nodes);

  assert.equal(positionOf(result, "yes").column, positionOf(result, "no").column);
  assert.notEqual(positionOf(result, "yes").y, positionOf(result, "no").y);
  assertNoOverlaps(result);
});

test("a data node is placed left of the node that consumes it", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "set", "execute"]]),
    node("get", "K2Node_VariableGet", "Health", [["Health", "out", "set", "Value"]]),
    node("set", "K2Node_VariableSet", "Set Health", [
      ["execute", "in", "ev", "then"],
      ["Value", "in", "get", "Health"],
    ]),
  ];
  const result = computeGraphLayout(nodes);
  assert.ok(
    positionOf(result, "get").column < positionOf(result, "set").column,
    "a value must be produced to the left of where it is consumed"
  );
});

test("a cycle is laid out rather than hanging or throwing", () => {
  const nodes = [
    node("a", "K2Node_CallFunction", "A", [["then", "out", "b", "execute"]]),
    node("b", "K2Node_CallFunction", "B", [
      ["execute", "in", "a", "then"],
      ["then", "out", "a", "execute"],
    ]),
  ];
  const result = computeGraphLayout(nodes);
  assert.equal(result.positions.length, 2);
  assertNoOverlaps(result);
});

test("comment boxes are excluded from layout and reported as skipped", () => {
  const nodes = [
    node("c", "EdGraphNode_Comment", "Some existing comment"),
    node("ev", "K2Node_Event", "Event BeginPlay"),
  ];
  const result = computeGraphLayout(nodes);
  assert.deepEqual(result.skipped, ["c"]);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].id, "ev");
});

test("an empty graph is not an error", () => {
  const result = computeGraphLayout([]);
  assert.deepEqual(result.positions, []);
  assert.equal(result.columns, 0);
});

test("disconnected nodes all get positions and none overlap", () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i}`, "K2Node_CallFunction", `Node ${i}`));
  const result = computeGraphLayout(nodes);
  assert.equal(result.positions.length, 12);
  assertNoOverlaps(result);
});

test("a wide fan-out stays overlap-free after straightening", () => {
  const links = [];
  const nodes = [];
  for (let i = 0; i < 8; i++) {
    links.push([`Then_${i}`, "out", `t${i}`, "execute"]);
    nodes.push(node(`t${i}`, "K2Node_CallFunction", `Target ${i}`, [["execute", "in", "seq", `Then_${i}`]]));
  }
  nodes.unshift(node("seq", "K2Node_ExecutionSequence", "Sequence", links));
  const result = computeGraphLayout(nodes);
  assert.equal(result.positions.length, 9);
  assertNoOverlaps(result);
});

test("node size estimates grow with title length and pin count, within bounds", () => {
  const small = estimateNodeSize(node("a", "K2Node_CallFunction", "Add"));
  const large = estimateNodeSize(
    node("b", "K2Node_CallFunction", "Set Actor Relative Location And Rotation With Sweep", [
      ["execute", "in"],
      ["Target", "in"],
      ["New Location", "in"],
      ["then", "out"],
    ])
  );
  assert.ok(large.width > small.width);
  assert.ok(large.height > small.height);
  assert.ok(large.width <= 460, "width must stay bounded so columns do not run away");
});

test("event nodes are recognised across the event node families", () => {
  assert.ok(isEventNode(node("a", "K2Node_Event", "Event BeginPlay")));
  assert.ok(isEventNode(node("b", "K2Node_CustomEvent", "MyEvent")));
  assert.ok(isEventNode(node("c", "K2Node_InputAxisEvent", "InputAxis MoveForward")));
  assert.ok(!isEventNode(node("d", "K2Node_CallFunction", "Print String")));
});

test("chains group per event, disjointly, pulling in the data each one uses", () => {
  const nodes = [
    node("ev1", "K2Node_Event", "Event BeginPlay", [["then", "out", "p1", "execute"]]),
    node("p1", "K2Node_CallFunction", "Print String", [
      ["execute", "in", "ev1", "then"],
      ["In String", "in", "g1", "Name"],
    ]),
    node("g1", "K2Node_VariableGet", "Name", [["Name", "out", "p1", "In String"]]),
    node("ev2", "K2Node_Event", "Event Tick", [["then", "out", "p2", "execute"]]),
    node("p2", "K2Node_CallFunction", "Add", [["execute", "in", "ev2", "then"]]),
  ];
  const groups = groupIntoChains(nodes);

  assert.equal(groups.length, 2);
  const beginPlay = groups.find((g) => g.rootId === "ev1");
  const tick = groups.find((g) => g.rootId === "ev2");
  assert.deepEqual([...beginPlay.nodeIds].sort(), ["ev1", "g1", "p1"]);
  assert.deepEqual([...tick.nodeIds].sort(), ["ev2", "p2"]);
  assert.equal(beginPlay.title, "Event BeginPlay");

  const all = groups.flatMap((g) => g.nodeIds);
  assert.equal(new Set(all).size, all.length, "a node must belong to exactly one comment box");
});
