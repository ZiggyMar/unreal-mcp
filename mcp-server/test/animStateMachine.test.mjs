import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const state = (id, x, y) => ({ id, title: id, type: "AnimStateNode", x, y });
const trans = (id, x, y) => ({ id, title: id, type: "AnimStateTransitionNode", x, y });
const fn = (id, x, y) => ({ id, title: id, type: "CallFunction", x, y });

test("an animation state machine is described, not assessed", () => {
  // Auditing function graphs for the first time produced 18 stacked findings, and 15 were transition
  // rules in ABP_NewPlayer's Locomotion and Aiming graphs sitting 30 to 99 apart - which is how a
  // state diagram sits. Nothing this checker measures applies to one: states are a web, not a chain.
  const nodes = [
    state("Idle", 0, 0), state("Movement", 300, 40), state("Jump", 600, 10),
    trans("Idle to Movement", 60, 19), trans("Movement to Idle", 79, 5), trans("Jump to Idle", 30, 13),
  ];
  const r = reviewLayout(nodes);
  assert.deepEqual(r.findings.map((f) => f.kind), ["notJudged"]);
  assert.match(r.findings[0].detail, /animation state machine/);
  assert.match(r.findings[0].detail, /nothing here can judge it/);
});

test("transition rules 30 apart are not called stacked", () => {
  // The exact false positive: by Blueprint rules these overlap; as a state diagram they do not.
  const r = reviewLayout([state("A", 0, 0), state("B", 400, 0), trans("A to B", 30, 13), trans("B to A", 60, 18)]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "stacked"), []);
});

test("an ordinary Blueprint graph is still judged", () => {
  // Half is the bar, and a Blueprint graph never contains a state node, so there is no mixed case.
  const r = reviewLayout([fn("a", 0, 0), fn("b", 20, 10)]);
  assert.deepEqual(r.findings.map((f) => f.kind), ["stacked"]);
});

test("a graph with a few anim nodes among real ones is still judged", () => {
  const nodes = [fn("a", 0, 0), fn("b", 20, 10), fn("c", 900, 0), fn("d", 1200, 0), state("odd", 5000, 5000)];
  assert.ok(reviewLayout(nodes).findings.some((f) => f.kind === "stacked"));
});

test("a declined graph reports no wire statistics it did not measure", () => {
  const r = reviewLayout([state("A", 0, 0), state("B", 400, 0), trans("A to B", 30, 13)]);
  assert.equal(r.stats.execWires, 0);
  assert.equal(r.stats.wireP90, 0);
  assert.equal(r.stats.nodes, 3);
});
