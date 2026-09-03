import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const node = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x, y, pins });
const event = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CustomEvent", x, y, pins });
const unboxed = (r) => r.findings.filter((f) => f.kind === "unboxed");

// A box somewhere, so the check runs at all - it stays silent when no box carries dimensions.
const anchor = box("anchor", -9000, -9000, 100, 100, "Anchor");

test("a wired run of loose nodes is ONE finding, not one per node", () => {
  // It used to report per node and cap at 20, so a real graph returned twenty copies of the same
  // sentence with 56 more dropped. Nothing in that says how many boxes are missing.
  const r = reviewLayout([
    anchor,
    event("Start", 0, 0, ["out then -> a.execute"]),
    node("a", 300, 0, ["out then -> b.execute"]),
    node("b", 600, 0),
  ]);
  assert.equal(unboxed(r).length, 1);
  assert.match(unboxed(r)[0].detail, /3 nodes starting at Start/);
});

test("two systems a screen apart are two findings", () => {
  const r = reviewLayout([
    anchor,
    event("AlphaEvent", 0, 0, ["out then -> a.execute"]),
    node("a", 300, 0),
    event("BetaEvent", 0, 6000, ["out then -> b.execute"]),
    node("b", 300, 6000),
  ]);
  assert.equal(unboxed(r).length, 2);
});

test("a cluster with several entry events is described as several systems", () => {
  // Proximity merges neighbours, so naming only the first entry hid the rest - it read as one
  // system and was really three, which would suggest one box where three belong.
  const r = reviewLayout([
    anchor,
    event("CE_ServerSound", 0, 0),
    event("CE_MC_Sound", 200, 0),
    event("CE_ClientSound", 400, 0),
  ]);
  const f = unboxed(r);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /3 entry points: CE_ServerSound, CE_MC_Sound, CE_ClientSound/);
  assert.match(f[0].detail, /3 systems sitting together/);
});

test("a lone loose node still reads as one node, not a system", () => {
  const r = reviewLayout([anchor, node("stray", 0, 0)]);
  assert.match(unboxed(r)[0].detail, /^stray sits in no comment box/);
});

test("a cluster with no entry event says so rather than inventing a name", () => {
  const r = reviewLayout([anchor, node("a", 0, 0, ["out then -> b.execute"]), node("b", 300, 0), node("c", 600, 0)]);
  assert.match(unboxed(r)[0].detail, /no entry event/);
});

test("nodes inside a box are not reported", () => {
  const r = reviewLayout([box("b", 0, 0, 1000, 1000, "System"), node("inside", 100, 100), event("e", 200, 200)]);
  assert.deepEqual(unboxed(r), []);
});

test("every finding carries node ids a caller can act on", () => {
  const r = reviewLayout([anchor, event("Start", 0, 0, ["out then -> a.execute"]), node("a", 300, 0)]);
  assert.ok(unboxed(r)[0].nodes.length >= 2);
  assert.ok(unboxed(r)[0].nodes.every((id) => typeof id === "string" && id.length > 0));
});

test("a big graph reports systems, not a wall of nodes", () => {
  // The whole point: 40 loose nodes in 4 systems is 4 findings, and no cap silently eats the rest.
  const nodes = [anchor];
  for (let s = 0; s < 4; s++) {
    nodes.push(event(`Sys${s}`, 0, s * 5000, ["out then -> s" + s + "n0.execute"]));
    for (let i = 0; i < 9; i++) nodes.push(node(`s${s}n${i}`, 300 + i * 200, s * 5000));
  }
  const f = unboxed(reviewLayout(nodes));
  assert.equal(f.length, 4);
});
