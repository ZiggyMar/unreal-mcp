import { test } from "node:test";
import assert from "node:assert/strict";

import { planTidy } from "../dist/layoutTidy.js";

const box = (id, x, y, width, height, text) => ({
  id, type: "EdGraphNode_Comment", title: "Comment", x, y, width, height, text,
});
const chain = (id, x, next) => ({
  id, type: "K2Node_CallFunction", title: id, x, y: 0,
  pins: next ? [`out then -> ${next}.execute`] : [],
});
const ids = (r) => r.moves.map((m) => m.nodeId);

test("straightening will not push a node out through the edge of its box", () => {
  // Demonstrated before the fix: a five-node chain inside a box ending at x 700 straightened its
  // last node from x 160 to x 880, out of the box. The box then no longer owned it, and nothing in
  // the graph showed that had happened.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Firing"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  assert.deepEqual(ids(r), ["b", "c", "d"], "the moves that stay inside are still made");
  assert.ok(!ids(r).includes("e"), "the one that would leave the box is refused");
  assert.equal(r.heldByBox, 1);
});

test("compacting will not pull a node INTO a box it was never in", () => {
  // The same fault in the other direction: a node at x -5000 was pulled to x 440, inside a box that
  // had never held it. It would then move with a system it does not belong to.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Firing"),
    { id: "a", type: "K2Node_CustomEvent", title: "Fire", x: 0, y: 0, pins: ["out then -> b.execute"] },
    { id: "b", type: "K2Node_CallFunction", title: "Shoot", x: 200, y: 0, pins: ["out then -> far.execute"] },
    { id: "far", type: "K2Node_CallFunction", title: "Far", x: -5000, y: 0, pins: [] },
  ];
  const r = planTidy(nodes, {});
  assert.ok(!ids(r).includes("far"));
  assert.equal(r.heldByBox, 1);
});

test("a graph with no comment boxes tidies exactly as before", () => {
  // The guard must not cost anything where there is nothing to protect.
  const nodes = [chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160)];
  const r = planTidy(nodes, {});
  assert.deepEqual(ids(r), ["b", "c", "d", "e"]);
  assert.equal(r.heldByBox, 0);
});

test("a move wholly inside one box is allowed", () => {
  const nodes = [
    box("b1", -1000, -1000, 6000, 2000, "Roomy"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80),
  ];
  const r = planTidy(nodes, {});
  assert.deepEqual(ids(r), ["b", "c"]);
  assert.equal(r.heldByBox, 0);
});

test("moving between two boxes is refused, not just leaving one", () => {
  const nodes = [
    box("b1", -100, -100, 400, 400, "Left"),
    box("b2", 700, -100, 900, 400, "Right"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  for (const m of r.moves) {
    assert.ok(m.x <= 300, `${m.nodeId} left the Left box at x ${m.x}`);
  }
  assert.ok(r.heldByBox > 0);
});

test("a box with no dimensions cannot hold anything back", () => {
  // Same rule as everywhere else here: without extent, containment is unknowable, and guessing it
  // would refuse moves on the strength of an invented boundary.
  const sizeless = { id: "b1", type: "EdGraphNode_Comment", title: "Comment", x: 0, y: 0, text: "Vague" };
  const nodes = [sizeless, chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80)];
  const r = planTidy(nodes, {});
  assert.deepEqual(ids(r), ["b", "c"]);
  assert.equal(r.heldByBox, 0);
});
