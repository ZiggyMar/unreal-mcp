import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const fn = (id, x, y, pins = []) => ({ id, title: id, type: "CallFunction", x, y, pins });
const kinds = (r) => r.findings.map((f) => f.kind);

/** A column grid: many nodes, few distinct X, a big block sharing one. */
function grid(count, cols) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(fn(`n${i}`, (i % cols) * 400, Math.floor(i / cols) * 200));
  // A block at a single X, the way a relayout leaves unplaced nodes at the origin.
  for (let i = 0; i < Math.ceil(count * 0.3); i++) out.push(fn(`z${i}`, 0, 5000 + i * 150));
  return out;
}

/** Hand-shaped: nearly every node at its own X. */
function handBuilt(count) {
  return Array.from({ length: count }, (_, i) => fn(`h${i}`, i * 317, (i % 5) * 180));
}

test("a column grid is reported once, not once per symptom", () => {
  // 44 of this project's 76 long wires are in ONE graph, and they are not 44 faults. GM_Gameplay was
  // relaid out into a column grid, which moved every node and left eleven comment boxes naming
  // systems that had gone.
  const r = reviewLayout(grid(60, 6));
  assert.ok(kinds(r).includes("machineLaidOut"));
  assert.match(r.findings.find((f) => f.kind === "machineLaidOut").detail, /relaid out by a tool/);
});

test("a hand-shaped graph is not accused", () => {
  // Measured: GM_Gameplay sits at 9.8 nodes per distinct X, every other graph in the project between
  // 1.1 and 2.0. The gap is what makes this checkable rather than a matter of taste.
  assert.ok(!kinds(reviewLayout(handBuilt(120))).includes("machineLaidOut"));
});

test("few columns alone is not enough, nor a block alone", () => {
  // Either signal by itself could describe a tidy graph that happens to align, so both are required.
  const fewColumnsNoBlock = Array.from({ length: 60 }, (_, i) => fn(`a${i}`, (i % 6) * 400, i * 120));
  assert.ok(!kinds(reviewLayout(fewColumnsNoBlock)).includes("machineLaidOut"), "a 10-per-column graph with no block");
  const blockButSpread = [...handBuilt(100), ...Array.from({ length: 12 }, (_, i) => fn(`z${i}`, 0, 9000 + i * 150))];
  assert.ok(!kinds(reviewLayout(blockButSpread)).includes("machineLaidOut"), "a small block in a spread graph");
});

test("a small graph is never accused", () => {
  // Under 40 nodes the ratio means nothing - three nodes in one column is a chain, not a relayout.
  assert.ok(!kinds(reviewLayout(grid(12, 3))).includes("machineLaidOut"));
});

test("long wires are capped, and the stats still count them all", () => {
  // Past a handful they are the same fact restated. The lengths stay in the stats so nothing is lost.
  const far = [];
  for (let i = 0; i < 30; i++) {
    far.push(fn(`s${i}`, 0, i * 200, [`out Value -> t${i}.In`]));
    far.push(fn(`t${i}`, 9000, i * 200));
  }
  const r = reviewLayout(far);
  assert.ok(r.findings.filter((f) => f.kind === "longWire").length <= 8, "capped");
  assert.ok(r.stats.wireP90 > 2000, "every wire still measured");
});
