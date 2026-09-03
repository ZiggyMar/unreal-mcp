import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const fn = (id, x, y) => ({ id, title: id, type: "CallFunction", x, y });
const get = (id, x, y) => ({ id, title: id, type: "VariableGet", x, y });
const stacked = (r) => r.findings.filter((f) => f.kind === "stacked");

test("a compact Get sitting 32 directly under a node is not stacked", () => {
  // Five of the project's nine stacked findings were exactly this: dx 0, dy 32 - a Get abutting the
  // node above rather than covering it, which is ordinary tight packing and appears in the
  // hand-maintained standard too. One threshold for both axes treated nodes as square.
  assert.deepEqual(stacked(reviewLayout([fn("Set Scalar Parameter Value", 0, 0), get("Get OrbMaterial", 0, 32)])), []);
});

test("two nodes 36 apart side by side ARE stacked", () => {
  // No Blueprint node is 36 wide, so this genuinely overlaps - and the square threshold of 40 only
  // caught it by accident.
  assert.equal(stacked(reviewLayout([fn("Cast To AVS_GameInstance", 0, 0), fn("Branch", 36, 2)])).length, 1);
});

test("a horizontal overlap the old square threshold missed is now caught", () => {
  // dx 76, dy 28 in a real graph: comfortably inside a node's width, and the 40-unit square rule let
  // it through. Widening the horizontal limit found a fault while removing six false ones.
  assert.equal(stacked(reviewLayout([fn("To Text (String)", 0, 0), get("Get Player Color", 76, 28)])).length, 1);
});

test("exactly the same place is still the clearest case", () => {
  const r = reviewLayout([fn("Set IconRetries", 100, 100), fn("UpdatePromptIcon", 100, 100)]);
  assert.equal(stacked(r).length, 1);
  assert.match(stacked(r)[0].detail, /exactly the same place/);
});

test("the finding names both axes, because one number hid which mattered", () => {
  const r = reviewLayout([fn("a", 0, 0), fn("b", 36, 2)]);
  assert.match(stacked(r)[0].detail, /36 across and 2 down/);
});

test("a column of getters at the project's usual spacings is left alone", () => {
  // Measured in the standard: the common close spacings are 48, 64 and 96, all clear of the limit.
  const col = [48, 96, 160, 224].map((y, i) => get(`g${i}`, 0, y));
  assert.deepEqual(stacked(reviewLayout([fn("host", 0, 0), ...col])), []);
});
