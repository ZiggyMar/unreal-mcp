import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const fn = (id, x, y, pins = []) => ({ id, title: id, type: "CallFunction", x, y, pins });
const longs = (r) => r.findings.filter((f) => f.kind === "longWire");

test("a source feeding several readers is not told to sit beside them all", () => {
  // Measured: 16 of this project's 66 long DATA wires come from a source feeding 3+ nodes, so a
  // quarter of the advice could not be followed. You cannot move one node beside four.
  const r = reviewLayout([
    fn("Sequence", 0, 0, ["out Value -> a.In, b.In, c.In"]),
    fn("a", 9000, 0), fn("b", 9000, 200), fn("c", 9000, 400),
  ]);
  assert.ok(longs(r).length > 0);
  for (const f of longs(r)) {
    assert.match(f.detail, /feeds 3 nodes in all - it cannot sit beside them all/);
    assert.match(f.detail, /Read it into a variable near/);
  }
});

test("a source with one reader still gets the simple advice", () => {
  const r = reviewLayout([fn("Get Thing", 0, 0, ["out Value -> a.In"]), fn("a", 9000, 0)]);
  assert.equal(longs(r).length, 1);
  assert.match(longs(r)[0].detail, /Move it beside what reads it/);
  assert.doesNotMatch(longs(r)[0].detail, /cannot sit beside/);
});

test("an exec wire keeps its own remedy, whatever the fan-out", () => {
  // A call through a custom event costs no wire at all, which is the exec answer and not the data one.
  const r = reviewLayout([
    fn("Start", 0, 0, ["out then -> a.execute, b.execute, c.execute"]),
    fn("a", 9000, 0), fn("b", 9000, 200), fn("c", 9000, 400),
  ]);
  for (const f of longs(r)) assert.match(f.detail, /custom event costs no wire/);
});

test("fan-out counts distinct nodes, not pins", () => {
  // Two pins into the same node is one reader, and telling somebody it is three would be a lie
  // dressed as a measurement.
  const r = reviewLayout([
    fn("Src", 0, 0, ["out A -> a.In", "out B -> a.Other"]),
    fn("a", 9000, 0),
  ]);
  for (const f of longs(r)) assert.doesNotMatch(f.detail, /cannot sit beside/);
});
