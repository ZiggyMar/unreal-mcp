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

/**
 * The invariant, checked directly: after tidying, every node is inside exactly the boxes it started
 * inside - allowing for boxes that grew to keep it.
 *
 * This is what the guard is FOR. Two earlier tests here asserted the mechanism instead ("e is
 * refused", "no move goes past x 300") and both broke the moment growing a box became possible,
 * even though the thing they were protecting was still true. Asserting the outcome survives a
 * change in how the outcome is reached.
 */
function ownershipHeld(nodes, r) {
  const boxes = nodes.filter((n) => n.type === "EdGraphNode_Comment");
  const grown = new Map(r.growths.map((g) => [g.boxId, g]));
  const at = new Map(r.moves.map((m) => [m.nodeId, m]));
  const inside = (b, x, y) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  for (const n of nodes) {
    if (n.type === "EdGraphNode_Comment") continue;
    const end = at.get(n.id) ?? n;
    for (const b of boxes) {
      if (typeof b.width !== "number") continue;
      const before = inside(b, n.x, n.y);
      const after = inside(grown.get(b.id) ?? b, end.x, end.y);
      assert.equal(after, before, `${n.id} changed membership of box ${b.id}`);
    }
  }
}

test("a straightened chain never changes which box owns it", () => {
  // Demonstrated before the fix: a five-node chain inside a box ending at x 700 straightened its
  // last node from x 160 to x 880, out of the box. The box then no longer owned it, and nothing in
  // the graph showed that had happened.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Firing"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  ownershipHeld(nodes, r);
  assert.deepEqual(ids(r), ["b", "c", "d", "e"], "with room to grow, every move still lands");
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

test("a node is never carried from one box into another", () => {
  // The Left box can grow a little, but not into the Right one and not far enough to reach it - so
  // some of the chain moves and the rest is held. Either way no node changes hands.
  const nodes = [
    box("b1", -100, -100, 400, 400, "Left"),
    box("b2", 700, -100, 900, 400, "Right"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  ownershipHeld(nodes, r);
  assert.ok(r.heldByBox > 0, "the moves that could not be accommodated were refused");
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

test("a box grows rather than the tidy being refused, when there is room", () => {
  // Growing is what a person does when a chain outgrows its box. Refusing was only ever the fallback
  // - it left the wire bent because there was no resize action in the bridge to express the fix.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Firing"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  assert.deepEqual(ids(r), ["b", "c", "d", "e"], "every move lands");
  assert.equal(r.heldByBox, 0);
  assert.equal(r.growths.length, 1);
  assert.equal(r.growths[0].boxId, "b1");
  assert.ok(r.growths[0].width > 800, "the box got wider");
});

test("a box will not grow into another box", () => {
  // Growing into one makes exactly the partial overlap that corrupts both when either is dragged.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Firing"),
    box("b2", 900, -100, 600, 400, "Other"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  assert.equal(r.growths.length, 0);
  assert.equal(r.heldByBox, 1);
});

test("a box will not grow over a node that was never in it", () => {
  // The ownership bug in the other direction: a box that grows over somebody else's node adopts it.
  // This was live once - the stranger was skipped by POSITION, so a node standing exactly where the
  // moving one landed was mistaken for it and the box grew straight over it.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Firing"),
    { id: "stranger", type: "K2Node_CallFunction", title: "Stranger", x: 880, y: 0, pins: [] },
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  assert.equal(r.growths.length, 0);
  assert.equal(r.heldByBox, 1);
});

test("a move that needs a box widened says which box", () => {
  // Recorded rather than re-derived. The caller used to work this out from geometry - "is the move
  // past the box's right edge" - against the GROWN extent, so a move landing inside the box that
  // would have existed passed the test and was applied anyway.
  //
  // Found end to end, not by unit test: the running plugin predates resize_comment_box, the resize
  // was refused, the dependent moves were supposedly dropped, and a node still left its box. Seven
  // in beforehand, six after.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Packed"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  const needy = r.moves.filter((m) => m.needsBox);
  assert.ok(needy.length > 0, "some move should depend on the growth");
  assert.ok(needy.every((m) => m.needsBox === "b1"), "and name the box it depends on");
  // Moves that fit inside the box as it stands must NOT claim to need it.
  assert.ok(r.moves.some((m) => !m.needsBox), "moves that already fit carry no dependency");
});

test("dropping the moves that needed a refused growth leaves ownership intact", () => {
  // What the caller does when the bridge refuses the resize: keep only the moves with no dependency.
  const nodes = [
    box("b1", -100, -100, 800, 400, "Packed"),
    chain("a", 0, "b"), chain("b", 40, "c"), chain("c", 80, "d"), chain("d", 120, "e"), chain("e", 160),
  ];
  const r = planTidy(nodes, {});
  const kept = r.moves.filter((m) => !m.needsBox);
  const b = nodes[0];
  for (const m of kept) {
    const inside = m.x >= b.x && m.x <= b.x + b.width && m.y >= b.y && m.y <= b.y + b.height;
    assert.ok(inside, `${m.nodeId} left the box at x ${m.x} with no growth applied`);
  }
});
