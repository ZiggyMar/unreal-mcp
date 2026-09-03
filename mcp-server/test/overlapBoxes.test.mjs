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
const kinds = (r) => r.findings.map((f) => f.kind);

test("two boxes that half-overlap are reported", () => {
  // The worst layout fault there is, and the checker missed it while its author hit it by hand: a
  // comment box OWNS the nodes inside it and drags them, so two boxes sharing a region both claim
  // the same nodes and moving either corrupts the other.
  const r = reviewLayout([box("a", 0, 0, 1000, 500, "Left"), box("b", 800, 0, 1000, 500, "Right")]);
  const found = r.findings.filter((f) => f.kind === "overlappingBoxes");
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /"Left" and "Right"/);
  assert.match(found[0].detail, /Nest one inside the other/);
});

test("a box nested inside another is fine", () => {
  // Nesting is the convention, not a fault: 40 nested pairs in one hand-organised graph, an outer
  // box naming the system and inner ones naming its parts.
  const r = reviewLayout([box("outer", 0, 0, 2000, 2000, "Inputs"), box("inner", 100, 100, 500, 500, "Movement")]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "overlappingBoxes"), []);
});

test("boxes that merely touch edges are not overlapping", () => {
  const r = reviewLayout([box("a", 0, 0, 500, 500, "A"), box("b", 500, 0, 500, 500, "B")]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "overlappingBoxes"), []);
});

test("separated boxes are fine", () => {
  const r = reviewLayout([box("a", 0, 0, 400, 400, "A"), box("b", 900, 900, 400, 400, "B")]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "overlappingBoxes"), []);
});

test("an identical pair counts once, not twice", () => {
  const r = reviewLayout([box("a", 0, 0, 500, 500, "A"), box("b", 250, 250, 500, 500, "B")]);
  assert.equal(r.findings.filter((f) => f.kind === "overlappingBoxes").length, 1);
});

test("a box with no size cannot overlap anything", () => {
  // Same rule as containment: without dimensions this is unknowable, and guessing would invent a
  // fault in somebody's graph.
  const sizeless = { id: "a", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, text: "A" };
  const r = reviewLayout([sizeless, box("b", 0, 0, 500, 500, "B")]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "overlappingBoxes"), []);
});

test("an untitled box in an overlap is described, not left blank", () => {
  const r = reviewLayout([box("a", 0, 0, 1000, 500, ""), box("b", 800, 0, 1000, 500, "Right")]);
  const found = r.findings.filter((f) => f.kind === "overlappingBoxes");
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /an untitled box/);
});
