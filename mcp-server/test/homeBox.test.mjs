import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const ev = (id, x, y, next) => ({ id, title: id, type: "CustomEvent", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });
const fn = (id, x, y, next) => ({ id, title: id, type: "CallFunction", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });
const detail = (r) => r.findings.find((f) => f.kind === "unboxed")?.detail ?? "";

test("a fragment wired into a boxed system is told to join it", () => {
  // "They want one titled box naming what they do" was wrong for two thirds of these: measured, 10
  // of the project's 15 no-entry clusters are wired to a system that is already boxed. They do not
  // want a box of their own; they want to be inside the one next door.
  const nodes = [
    box("b", -200, -200, 900, 500, "Event Tick"),
    ev("CE_Tick", 0, 0, "inside"),
    fn("inside", 300, 0, "stray1"),
    fn("stray1", 4000, 0, "stray2"),
    fn("stray2", 4300, 0),
  ];
  assert.match(detail(reviewLayout(nodes)), /wired into "Event Tick".*belong in that box/s);
});

test("a fragment fed BY a boxed system counts too", () => {
  // Looking only at outgoing pins would miss half of them - a fragment is as often fed by a boxed
  // system as feeding one.
  const nodes = [
    box("b", -200, -200, 900, 500, "Begin Play"),
    ev("CE_Start", 0, 0, "far1"),
    fn("far1", 4000, 0, "far2"),
    fn("far2", 4300, 0),
  ];
  assert.match(detail(reviewLayout(nodes)), /wired into "Begin Play"/);
});

test("a fragment touching several boxes is not told to pick one", () => {
  // "You belong in one of these four" is not an instruction, and picking the first would repeat the
  // mistake of naming a cluster after its first event.
  const nodes = [
    box("b1", -200, -200, 700, 400, "Alpha"),
    box("b2", -200, 900, 700, 400, "Beta"),
    ev("CE_A", 0, 0, "stray1"),
    ev("CE_B", 0, 1000, "stray1"),
    fn("stray1", 4000, 0, "stray2"),
    fn("stray2", 4300, 0),
  ];
  const d = detail(reviewLayout(nodes));
  assert.doesNotMatch(d, /wired into "/);
});

test("a fragment attached to nothing boxed says so, and does not invent a home", () => {
  const nodes = [
    box("far", -9000, -9000, 200, 200, "Elsewhere"),
    fn("a", 0, 0, "b"), fn("b", 300, 0, "c"), fn("c", 600, 0),
  ];
  assert.match(detail(reviewLayout(nodes)), /wired to nothing that is boxed either/);
});
