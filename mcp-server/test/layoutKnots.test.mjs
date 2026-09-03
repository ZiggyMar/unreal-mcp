import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const knot = (id, x, y, pins = []) => ({ id, title: "Reroute Node", type: "K2Node_Knot", x, y, pins });
const node = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x, y, pins });
const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const kinds = (r) => r.findings.map((f) => f.kind);

test("a run of reroute knots is not 'stacked'", () => {
  // Measured against a hand-maintained graph: 8 of 11 stacked findings were pairs of knots 32 apart,
  // which is exactly what a deliberate run of them looks like. False positives against the very code
  // being used as the standard are the clearest evidence a rule is wrong.
  const r = reviewLayout([knot("k1", 0, 0), knot("k2", 32, 0), knot("k3", 64, 0)]);
  assert.deepEqual(kinds(r), []);
});

test("two real nodes that close together are still reported", () => {
  const r = reviewLayout([node("a", 0, 0), node("b", 32, 0)]);
  assert.deepEqual(kinds(r), ["stacked"]);
});

test("a knot outside every comment box is not reported as unboxed", () => {
  // True, and meaningless: a bend in a wire belongs to no system.
  const r = reviewLayout([box("b", 0, 0, 200, 200, "Thing"), node("inside", 50, 50), knot("k", 5000, 5000)]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "unboxed"), []);
});

test("a real node outside every box is still reported", () => {
  const r = reviewLayout([box("b", 0, 0, 200, 200, "Thing"), node("inside", 50, 50), node("stray", 5000, 5000)]);
  assert.equal(r.findings.filter((f) => f.kind === "unboxed").length, 1);
});

test("a knot still counts toward wire length", () => {
  // Bending a wire does not shorten it. Excluding knots from LENGTH would hide exactly the long runs
  // people use them to route.
  const r = reviewLayout([node("a", 0, 0, ["out then -> k.execute"]), knot("k", 9000, 0)]);
  assert.ok(kinds(r).includes("longWire"));
});

test("knots are still counted in the node total", () => {
  // They are in the graph. Hiding them from the count would make the stats disagree with the editor.
  const r = reviewLayout([node("a", 0, 0), knot("k", 500, 0)]);
  assert.equal(r.stats.nodes, 2);
});
