import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const fn = (id, x, y, next) => ({ id, title: id, type: "CallFunction", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });
const ev = (id, x, y, next) => ({ id, title: id, type: "CustomEvent", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });

test("a graph with no comment boxes reports no unboxed findings", () => {
  // Deliberate, and re-tested rather than assumed. Flagging boxless graphs looked obviously right -
  // nothing is boxed, and that is knowable. Measured, it took this project from 85 clean graphs to
  // 3 and flagged a TWO-node graph. The project's own convention is 54% of nodes in a box, and its
  // author leaves 30-to-60-node widget and anim graphs unboxed on purpose; reporting those imposes
  // a rule the standard does not follow.
  //
  // The real complaint - that such a graph read as "clean" - is a reporting problem, fixed in the
  // sweep's clean count, which now separates "clean" from "no boxes to check".
  const nodes = [ev("CE_Thing", 0, 0, "n1"), fn("n1", 300, 0, "n2"), fn("n2", 600, 0)];
  assert.deepEqual(reviewLayout(nodes).findings.filter((f) => f.kind === "unboxed"), []);
});

test("the other checks still run on a boxless graph", () => {
  // Silence about boxing is not silence about everything - a boxless graph is still checked for
  // backward flow and stacking, which is what makes it different from "nothing was checked".
  const nodes = [
    ev("CE_Thing", 1000, 0, "n1"),
    fn("n1", 0, 0),
    fn("dup", 0, 20),
  ];
  const kinds = reviewLayout(nodes).findings.map((f) => f.kind);
  assert.ok(kinds.includes("backwardFlow"), "a leftward chain is still reported");
  assert.ok(kinds.includes("stacked"), "overlapping nodes are still reported");
});

test("a graph whose only boxes have no size stays silent about boxing", () => {
  // The genuinely unknowable case: containment cannot be judged without dimensions, and guessing
  // would invent a fault in somebody's graph.
  const sizeless = { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, text: "Vague" };
  const nodes = [sizeless, ev("CE_Thing", 0, 0, "n1"), fn("n1", 300, 0, "n2"), fn("n2", 600, 0)];
  assert.deepEqual(reviewLayout(nodes).findings.filter((f) => f.kind === "unboxed"), []);
});

test("a boxed graph still reports what sits outside its boxes", () => {
  const nodes = [
    { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: -100, y: -100, width: 900, height: 400, text: "Thing" },
    ev("CE_Thing", 0, 0, "n1"),
    fn("n1", 300, 0),
    ev("CE_Stray", 0, 5000, "s1"),
    fn("s1", 300, 5000),
  ];
  assert.equal(reviewLayout(nodes).findings.filter((f) => f.kind === "unboxed").length, 1);
});
