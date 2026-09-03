import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, width, height, text) => ({
  id,
  title: "Comment",
  type: "EdGraphNode_Comment",
  x,
  y,
  width,
  height,
  text,
});
const node = (id, x, y) => ({ id, title: id, type: "K2Node_CallFunction", x, y });
const overlaps = (r) => r.findings.filter((f) => f.kind === "overlappingBoxes");

test("two boxes that half-overlap over a node are reported", () => {
  // The worst layout fault there is, and the checker missed it while its author hit it by hand: a
  // comment box OWNS the nodes inside it and drags them, so two boxes sharing a region both claim
  // the same nodes and moving either corrupts the other.
  const r = reviewLayout([
    box("a", 0, 0, 1000, 500, "Left"),
    box("b", 800, 0, 1000, 500, "Right"),
    node("caught", 900, 200),
  ]);
  assert.equal(overlaps(r).length, 1);
  assert.match(overlaps(r)[0].detail, /"Left" and "Right"/);
  assert.match(overlaps(r)[0].detail, /1 node is caught in the shared region: caught/);
  assert.match(overlaps(r)[0].detail, /Nest one inside the other/);
});

test("an overlap with nothing in it is not a fault", () => {
  // Measured: of nine overlaps in a hand-maintained graph, four shared a region 16 to 64 units thin
  // - a hairline from dragging a box by hand, with nothing inside it and nothing that can go wrong.
  // The harm is the nodes caught in the shared region, not the geometry, so ask that directly.
  const r = reviewLayout([box("a", 0, 0, 1000, 500, "Left"), box("b", 984, 0, 1000, 500, "Right")]);
  assert.deepEqual(overlaps(r), []);
});

test("the finding names the contested nodes, so it can be acted on", () => {
  const r = reviewLayout([
    box("a", 0, 0, 1000, 500, "Interacts"),
    box("b", 800, 0, 1000, 500, "Recoil"),
    node("Recoil", 850, 100),
    node("TL_Recoil", 900, 200),
    node("Add Controller Pitch Input", 950, 300),
    node("Extra", 960, 400),
  ]);
  const f = overlaps(r)[0];
  assert.match(f.detail, /4 nodes are caught/);
  assert.match(f.detail, /Recoil, TL_Recoil, Add Controller Pitch Input and 1 more/);
  // Box ids first, then the contested nodes, so a caller can jump straight to them.
  assert.ok(f.nodes.length > 2);
});

test("a box nested inside another is fine", () => {
  // Nesting is the convention, not a fault: 40 nested pairs in one hand-organised graph, an outer
  // box naming the system and inner ones naming its parts.
  const r = reviewLayout([
    box("outer", 0, 0, 2000, 2000, "Inputs"),
    box("inner", 100, 100, 500, 500, "Movement"),
    node("n", 200, 200),
  ]);
  assert.deepEqual(overlaps(r), []);
});

test("boxes that merely touch edges are not overlapping", () => {
  const r = reviewLayout([box("a", 0, 0, 500, 500, "A"), box("b", 500, 0, 500, 500, "B"), node("n", 200, 200)]);
  assert.deepEqual(overlaps(r), []);
});

test("separated boxes are fine", () => {
  const r = reviewLayout([box("a", 0, 0, 400, 400, "A"), box("b", 900, 900, 400, 400, "B")]);
  assert.deepEqual(overlaps(r), []);
});

test("an identical pair counts once, not twice", () => {
  const r = reviewLayout([box("a", 0, 0, 500, 500, "A"), box("b", 250, 250, 500, 500, "B"), node("n", 300, 300)]);
  assert.equal(overlaps(r).length, 1);
});

test("a box with no size cannot overlap anything", () => {
  // Same rule as containment: without dimensions this is unknowable, and guessing would invent a
  // fault in somebody's graph.
  const sizeless = { id: "a", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, text: "A" };
  const r = reviewLayout([sizeless, box("b", 0, 0, 500, 500, "B"), node("n", 100, 100)]);
  assert.deepEqual(overlaps(r), []);
});

test("an untitled box in an overlap is described, not left blank", () => {
  const r = reviewLayout([box("a", 0, 0, 1000, 500, ""), box("b", 800, 0, 1000, 500, "Right"), node("n", 900, 200)]);
  assert.equal(overlaps(r).length, 1);
  assert.match(overlaps(r)[0].detail, /an untitled box/);
});

test("a knot in the shared region does not make an overlap a fault", () => {
  // A knot is a bend in a wire. It has no contents to lose and belongs to no system, so a box
  // dragged out from under it corrupts nothing.
  const r = reviewLayout([
    box("a", 0, 0, 1000, 500, "Left"),
    box("b", 800, 0, 1000, 500, "Right"),
    { id: "k", title: "Reroute Node", type: "K2Node_Knot", x: 900, y: 200 },
  ]);
  assert.deepEqual(overlaps(r), []);
});
