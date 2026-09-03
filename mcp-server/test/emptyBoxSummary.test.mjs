import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const fn = (id, x, y) => ({ id, title: id, type: "CallFunction", x, y });
const box = (id, x, y, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: 300, height: 200, text });
const count = (r, kind) => r.findings.filter((f) => f.kind === kind).length;

/** A column grid with many stranded boxes: the shape a whole-graph relayout leaves behind. */
function relaidOut(emptyBoxes) {
  const out = [];
  for (let i = 0; i < 60; i++) out.push(fn(`n${i}`, (i % 6) * 400, Math.floor(i / 6) * 200));
  for (let i = 0; i < 20; i++) out.push(fn(`z${i}`, 0, 5000 + i * 150));
  // Boxes far from every node, exactly as a relayout leaves them.
  for (let i = 0; i < emptyBoxes; i++) out.push(box(`b${i}`, 20000 + i * 500, 20000, `Stranded ${i}`));
  return out;
}

test("a relaid-out graph names two stranded boxes, not eleven", () => {
  // Measured: 14 empty-box findings across the project, 11 of them in the one graph that already
  // carries a machineLaidOut finding whose own words are "the long wires and stranded boxes here are
  // one fault, not many". Listing all eleven beside it contradicts the sentence explaining them.
  const r = reviewLayout(relaidOut(11));
  assert.equal(count(r, "machineLaidOut"), 1);
  assert.equal(count(r, "emptyBox"), 2, "two examples, not eleven");
});

test("the relayout finding carries the count its list no longer prints", () => {
  const r = reviewLayout(relaidOut(11));
  const m = r.findings.find((f) => f.kind === "machineLaidOut");
  assert.match(m.detail, /11 of its comment boxes now hold nothing at all/);
});

test("a graph that was NOT relaid out still names every empty box", () => {
  // Three of the project's empty boxes are elsewhere, and each is a real leftover worth naming.
  const nodes = [fn("a", 0, 0), fn("b", 300, 0), box("e1", 9000, 0, "DebugDamage"), box("e2", 9000, 900, "Is Not Vacuuming Data"), box("e3", 9000, 1800, "Vacuum Speed Stat")];
  const r = reviewLayout(nodes);
  assert.equal(count(r, "machineLaidOut"), 0);
  assert.equal(count(r, "emptyBox"), 3);
});

test("two or fewer stranded boxes are named in full even when relaid out", () => {
  // A cause with no example is harder to act on than one with a couple.
  const r = reviewLayout(relaidOut(2));
  assert.equal(count(r, "emptyBox"), 2);
  const m = r.findings.find((f) => f.kind === "machineLaidOut");
  assert.doesNotMatch(m.detail, /hold nothing at all/, "no count needed when nothing was hidden");
});
