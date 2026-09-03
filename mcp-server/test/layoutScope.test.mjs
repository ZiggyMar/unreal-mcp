import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const node = (id, x, y) => ({ id, title: id, type: "K2Node_CallFunction", x, y });

test("a box reaching into the scope is in scope, even if its origin is not", () => {
  // A box starts up and left of everything it holds, so its origin is routinely outside a region its
  // contents sit well inside. Filtering boxes by origin reported "no comment box in scope" over
  // fourteen nodes that were inside two of them - work accused of being loose while correctly boxed,
  // where the obvious fix (draw another box) would have made a real overlap out of nothing.
  const r = reviewLayout([box("b", 3000, 0, 2000, 600, "Vaccum"), node("n", 3400, 200)], { minX: 3300 });
  assert.equal(r.stats.commentBoxes, 1);
  assert.deepEqual(r.findings.filter((f) => f.kind === "unboxed"), []);
});

test("a box entirely outside the scope stays outside it", () => {
  const r = reviewLayout([box("b", 0, 0, 500, 500, "Elsewhere"), node("n", 3400, 200)], { minX: 3300 });
  assert.equal(r.stats.commentBoxes, 0);
});

test("nodes are still filtered by their own position", () => {
  const r = reviewLayout([node("in", 3400, 0), node("out", 100, 0)], { minX: 3300 });
  assert.equal(r.stats.nodes, 1);
});

test("a box reaching in vertically counts too", () => {
  const r = reviewLayout([box("b", 0, 9000, 1000, 3000, "Guide"), node("n", 400, 10200)], { minY: 10000 });
  assert.equal(r.stats.commentBoxes, 1);
});

test("a sizeless box falls back to its origin", () => {
  // Without dimensions its reach is unknowable, and inventing one would pull unrelated boxes in.
  const sizeless = { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, text: "A" };
  const r = reviewLayout([sizeless, node("n", 3400, 0)], { minX: 3300 });
  assert.equal(r.stats.commentBoxes, 0);
});
