import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const entry = (id, x, y, next) => ({ id, title: id, type: "FunctionEntry", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });
const fn = (id, x, y, next) => ({ id, title: id, type: "CallFunction", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });
const unboxed = (r) => r.findings.filter((f) => f.kind === "unboxed");

test("a function's whole body is not reported as an unboxed system", () => {
  // Auditing function graphs for the first time produced "62 nodes starting at GetVacuumableObject
  // are in no comment box" - a cluster rooted at the FunctionEntry, covering the entire graph.
  // Boxing all of it and naming it after the function says nothing the graph's own name does not.
  const nodes = [
    box("anchor", -9000, -9000, 100, 100, "Anchor"),
    entry("GetVacuumableObject", 0, 0, "a"),
    fn("a", 300, 0, "b"), fn("b", 600, 0, "c"), fn("c", 900, 0),
  ];
  assert.deepEqual(unboxed(reviewLayout(nodes)), []);
});

test("a fragment inside a function graph is still reported", () => {
  // Only the cluster that IS the function is skipped. Parts of it worth naming are not.
  const nodes = [
    box("anchor", -9000, -9000, 100, 100, "Anchor"),
    entry("VaccumObjects", 0, 0, "a"),
    fn("a", 300, 0, "b"), fn("b", 600, 0, "c"), fn("c", 900, 0),
    // A separate island, far away, wired to nothing in the main chain.
    fn("x", 9000, 5000, "y"), fn("y", 9300, 5000),
  ];
  assert.equal(unboxed(reviewLayout(nodes)).length, 1);
});

test("an EventGraph system is untouched by the rule", () => {
  // The skip keys on FunctionEntry specifically. A CustomEvent covering a whole graph is a system
  // that genuinely wants a box, and this project boxes them.
  const nodes = [
    box("anchor", -9000, -9000, 100, 100, "Anchor"),
    { id: "CE_Thing", title: "CE_Thing", type: "CustomEvent", x: 0, y: 0, pins: ["out then -> a.execute"] },
    fn("a", 300, 0, "b"), fn("b", 600, 0),
  ];
  assert.equal(unboxed(reviewLayout(nodes)).length, 1);
});

test("a function graph whose entry covers only part of it is still reported", () => {
  // Under the 60% bar the cluster is a part, not the whole, and parts are worth naming.
  const nodes = [box("anchor", -9000, -9000, 100, 100, "Anchor"), entry("Small", 0, 0, "a"), fn("a", 300, 0)];
  for (let i = 0; i < 12; i++) nodes.push(fn(`o${i}`, 9000 + i * 300, 4000));
  assert.ok(unboxed(reviewLayout(nodes)).length >= 1);
});
