import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const node = (id, x, y) => ({ id, title: id, type: "K2Node_CallFunction", x, y });
const empty = (r) => r.findings.filter((f) => f.kind === "emptyBox");

test("a titled box with nothing in it is reported", () => {
  // Measured: 17 of this project's 377 boxes hold nothing, and ELEVEN are in the one graph the sweep
  // flags as the outlier. That graph has 63 of 206 nodes at x=0 and 21 distinct x values across a
  // 6928-unit span - column-grid output from an automatic layout. The relayout moved the nodes and
  // left the boxes behind, so "Win Screen" and "Begin Play" name empty rectangles.
  const r = reviewLayout([box("b", 0, 0, 800, 400, "Win Screen"), node("far", 5000, 5000)]);
  assert.equal(empty(r).length, 1);
  assert.match(empty(r)[0].detail, /"Win Screen" is a comment box with nothing inside it/);
});

test("a box holding nodes is fine", () => {
  const r = reviewLayout([box("b", 0, 0, 800, 400, "Firing"), node("n", 100, 100)]);
  assert.deepEqual(empty(r), []);
});

test("a box holding only other boxes is NOT empty", () => {
  // That is the nesting convention - an outer box naming the system, inner ones naming its parts.
  const r = reviewLayout([
    box("outer", 0, 0, 2000, 2000, "Sound"),
    box("inner", 100, 100, 500, 500, "Server Sound"),
    node("n", 200, 200),
  ]);
  assert.deepEqual(empty(r), []);
});

test("an untitled empty box is reported once, as untitled", () => {
  // One finding per box. An untitled box has a worse problem than being empty.
  const r = reviewLayout([box("b", 0, 0, 800, 400, ""), node("far", 5000, 5000)]);
  assert.deepEqual(empty(r), []);
  assert.equal(r.findings.filter((f) => f.kind === "untitledBox").length, 1);
});

test("a box containing only a knot is empty", () => {
  // A knot is a bend in a wire. A box drawn round one describes no system.
  const r = reviewLayout([
    box("b", 0, 0, 800, 400, "Leftover"),
    { id: "k", title: "Reroute Node", type: "K2Node_Knot", x: 100, y: 100 },
  ]);
  assert.equal(empty(r).length, 1);
});

test("a box with no dimensions is not judged", () => {
  const sizeless = { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, text: "Vague" };
  const r = reviewLayout([sizeless, node("far", 5000, 5000)]);
  assert.deepEqual(empty(r), []);
});
