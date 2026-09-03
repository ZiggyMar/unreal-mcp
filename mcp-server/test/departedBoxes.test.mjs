import { test } from "node:test";
import assert from "node:assert/strict";

import { planTidy } from "../dist/layoutTidy.js";

const box = (id, x, y, w, h, text) => ({ id, type: "EdGraphNode_Comment", title: "Comment", x, y, width: w, height: h, text });
const chain = (id, x, next) => ({ id, type: "K2Node_CallFunction", title: id, x, y: 0, pins: next ? [`out then -> ${next}.execute`] : [] });

test("the box that is grown is the one the node LEFT", () => {
  // `before` lists every box a node was in, and nested boxes mean that is usually several - one node
  // sat in "Pick Target", "Guide Arrows" AND "Nearest Pool" at once. Growing the first that could
  // grow picked a box the node never left and returned a rectangle identical to the existing one.
  // The move was then tagged as needing a resize it did not need, the bridge refused the no-op, and
  // four good moves were dropped in a system whose backward wires could then not be straightened.
  const nodes = [
    box("outer", -500, -500, 6000, 1200, "Outer"),
    box("inner", -100, -100, 700, 400, "Inner"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  // Only the inner box is outgrown; the outer one has room to spare and must not be touched.
  for (const g of r.growths) assert.equal(g.boxId, "inner", `grew ${g.boxId}, which nothing left`);
});

test("a growth that changes nothing is not recorded", () => {
  // Asking the bridge to resize a box to the size it already is is a call that can only fail, and on
  // a plugin without the action that refusal takes the move down with it.
  const nodes = [
    box("roomy", -2000, -2000, 12000, 4000, "Roomy"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80),
  ];
  const r = planTidy(nodes, {});
  for (const g of r.growths) {
    const before = nodes.find((n) => n.id === g.boxId);
    const identical = before.x === g.x && before.y === g.y && before.width === g.width && before.height === g.height;
    assert.ok(!identical, `recorded a no-op growth for ${g.boxId}`);
  }
  assert.ok(r.moves.every((m) => !m.needsBox), "no move should claim to need a resize it does not");
});

test("a move that leaves no box needs no growth at all", () => {
  const nodes = [chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80)];
  const r = planTidy(nodes, {});
  assert.equal(r.growths.length, 0);
  assert.ok(r.moves.every((m) => !m.needsBox));
});
