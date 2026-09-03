import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const ev = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CustomEvent", x, y, pins });
const fn = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x, y, pins });
const knot = (id, x, y, pins = []) => ({ id, title: "Reroute", type: "K2Node_Knot", x, y, pins });
const kindsOf = (r) => r.findings.map((f) => f.kind);

test("a system whose event sits mid-chain is reported", () => {
  // Start is at x=900 but it runs Second at x=0: the reader has to find the beginning before they
  // can follow anything.
  const nodes = [
    ev("Start", 900, 0, ["out then -> Second.execute"]),
    fn("Second", 0, 0, ["out then -> Third.execute"]),
    fn("Third", 400, 0),
  ];
  const r = reviewLayout(nodes);
  const f = r.findings.find((x) => x.kind === "startsMidChain");
  assert.ok(f, "expected a startsMidChain finding");
  assert.match(f.detail, /900 to the right of Second/);
  assert.deepEqual(f.nodes, ["Start", "Second"]);
});

test("a system laid out left to right is not reported", () => {
  const nodes = [
    ev("Start", 0, 0, ["out then -> Second.execute"]),
    fn("Second", 400, 0, ["out then -> Third.execute"]),
    fn("Third", 800, 0),
  ];
  assert.ok(!kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});

test("a DELEGATE feeding a node to its left is not a mid-chain start", () => {
  // The false positive this check was measured against. AutoFire in BP_Player is a CustomEvent used
  // as a delegate: its OutputDelegate feeds Set Timer by Event, which sits to its LEFT because it
  // consumes the event rather than continuing from it. Following every out pin made this the single
  // violation in 70 real systems; following exec pins only makes it correctly silent.
  const nodes = [
    fn("SetTimer", 0, 0, ["out then -> SetHandle.execute"]),
    fn("SetHandle", 350, 0),
    ev("AutoFire", 900, 0, ["out OutputDelegate -> SetTimer.Delegate", "out then -> Fire.execute"]),
    fn("Fire", 1300, 0, ["out then -> Recoil.execute"]),
    fn("Recoil", 1700, 0),
  ];
  assert.ok(!kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});

test("a knot cannot claim the left edge", () => {
  // A reroute is a wire decoration. Letting one count as the system's leftmost node would report a
  // fault whenever a wire was routed back around the event, which is ordinary tidying.
  const nodes = [
    ev("Start", 0, 0, ["out then -> Hop.execute"]),
    knot("Hop", -600, 40, ["out then -> Second.execute"]),
    fn("Second", 400, 0, ["out then -> Third.execute"]),
    fn("Third", 800, 0),
  ];
  assert.ok(!kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});

test("being a few pixels right of what it runs is not a finding", () => {
  // Measured: an earlier BP_Player had Event Tick sitting FOUR pixels right of the CE_GuideFrame it
  // runs. Technically behind its own left edge, invisible on screen, and reporting it would bury the
  // one in the same graph that was 752 out.
  const nodes = [
    ev("Start", 4, 0, ["out then -> Second.execute"]),
    fn("Second", 0, 60, ["out then -> Third.execute"]),
    fn("Third", 500, 0),
  ];
  assert.ok(!kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});

test("a node's width past its own left edge does count", () => {
  const nodes = [
    ev("Start", 120, 0, ["out then -> Second.execute"]),
    fn("Second", 0, 60, ["out then -> Third.execute"]),
    fn("Third", 500, 0),
  ];
  assert.ok(kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});

test("a two-node stub is not judged", () => {
  // Nothing to read in the wrong order.
  const nodes = [
    ev("Start", 500, 0, ["out then -> Only.execute"]),
    fn("Only", 0, 0),
  ];
  assert.ok(!kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});

test("a loop wiring back to the event is not a mid-chain start", () => {
  // The chain closes a cycle, so somebody's exec wire has to point left. The event is still the
  // leftmost node, which is what the check actually asks.
  const nodes = [
    ev("Start", 0, 0, ["out then -> Wait.execute"]),
    fn("Wait", 400, 0, ["out then -> Check.execute"]),
    fn("Check", 800, 0, ["out then -> Wait.execute"]),
  ];
  assert.ok(!kindsOf(reviewLayout(nodes)).includes("startsMidChain"));
});
