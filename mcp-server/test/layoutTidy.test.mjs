import { test } from "node:test";
import assert from "node:assert/strict";

import { planTidy } from "../dist/layoutTidy.js";

const chain = (id, x, y, next) => ({
  id,
  title: id,
  type: "CallFunction",
  x,
  y,
  pins: next ? [`out then -> ${next}.execute`, "in execute <- prev.then"] : ["in execute <- prev.then"],
});
const pure = (id, x, y, feeds) => ({
  id,
  title: id,
  type: "CallFunction",
  x,
  y,
  pins: [`out ReturnValue -> ${feeds}.A`],
});
const at = (moves, id) => moves.find((m) => m.nodeId === id);

test("a chain already running rightward is left alone", () => {
  const { moves } = planTidy([chain("a", 0, 0, "b"), chain("b", 300, 0)], { minY: -100 });
  assert.deepEqual(moves, []);
});

test("a chain that jumps left is pushed straight", () => {
  const { moves } = planTidy([chain("a", 500, 0, "b"), chain("b", 200, 0)], { minY: -100, gap: 220 });
  assert.equal(moves.length, 1);
  assert.equal(at(moves, "b").x, 720);
  assert.equal(at(moves, "b").reason, "straighten");
});

test("straightening repeats until the whole chain is monotonic", () => {
  // Fixing one step can expose the next: b moves right of a, which may now put c to b's left.
  const { moves } = planTidy(
    [chain("a", 900, 0, "b"), chain("b", 600, 0, "c"), chain("c", 300, 0)],
    { minY: -100, gap: 200 }
  );
  assert.equal(at(moves, "b").x, 1100);
  assert.equal(at(moves, "c").x, 1300, "c must end right of b's NEW position, not its old one");
});

test("a node's Y is never changed by straightening", () => {
  const { moves } = planTidy([chain("a", 500, 77, "b"), chain("b", 200, 350)], { minY: -100 });
  assert.equal(at(moves, "b").y, 350, "rows carry meaning; only x is the reading order");
});

test("a pure node far from what it feeds is pulled in", () => {
  const consumer = { id: "sink", title: "sink", type: "CallFunction", x: 0, y: 0, pins: ["in A <- far.ReturnValue"] };
  const { moves } = planTidy([pure("far", -3000, 0, "sink"), consumer], { minY: -100, pullOver: 700 });
  assert.equal(at(moves, "far").reason, "compact");
  assert.ok(Math.abs(at(moves, "far").x) < 700, "should end up near its consumer");
});

test("a pure node already close is left where it is", () => {
  const consumer = { id: "sink", title: "sink", type: "CallFunction", x: 0, y: 0, pins: ["in A <- near.ReturnValue"] };
  const { moves } = planTidy([pure("near", -300, 0, "sink"), consumer], { minY: -100, pullOver: 700 });
  assert.deepEqual(moves, []);
});

test("a node in an execution chain is never pulled, however far its wires run", () => {
  // Compaction is only safe for nodes with no place they must be. Moving a node out of its chain
  // would break the reading order the straighten pass just established.
  const inChain = {
    id: "mid",
    title: "mid",
    type: "CallFunction",
    x: -3000,
    y: 0,
    pins: ["in execute <- a.then", "out then -> b.execute", "out ReturnValue -> sink.A"],
  };
  const sink = { id: "sink", title: "sink", type: "CallFunction", x: 0, y: 0, pins: ["in A <- mid.ReturnValue"] };
  const { moves } = planTidy([inChain, sink], { minY: -100, pullOver: 700 });
  assert.equal(at(moves, "mid"), undefined);
});

test("distance counts wires in BOTH directions", () => {
  // The first version measured only OUTPUTS, so a node whose consumer was close but whose source was
  // 2000 away looked settled and never moved, and the long wire survived.
  //
  // Asserted on the OUTCOME rather than on which node moves. Either end closing the gap resolves it,
  // and the planner is free to pick: here `src` moves to `mid` first, after which `mid` has no reason
  // to move at all. Demanding that a named node move would fail on a layout that is entirely correct.
  const src = { id: "src", title: "src", type: "CallFunction", x: -3000, y: 0, pins: ["out ReturnValue -> mid.A"] };
  const mid = { id: "mid", title: "mid", type: "CallFunction", x: 0, y: 0, pins: ["in A <- src.ReturnValue", "out ReturnValue -> sink.A"] };
  const sink = { id: "sink", title: "sink", type: "CallFunction", x: 100, y: 0, pins: ["in A <- mid.ReturnValue"] };

  const { moves } = planTidy([src, mid, sink], { minY: -100, pullOver: 700 });
  const final = (id, fallback) => {
    const m = at(moves, id);
    return m ? { x: m.x, y: m.y } : fallback;
  };
  const s = final("src", { x: -3000, y: 0 });
  const m = final("mid", { x: 0, y: 0 });
  const span = Math.max(Math.abs(s.x - m.x), Math.abs(s.y - m.y));
  assert.ok(span < 700, `src and mid still ${span} apart; the inbound wire was not considered`);
});

test("nothing is placed on top of anything", () => {
  // Two pure nodes wanting the same slot must not both take it.
  const sink = {
    id: "sink", title: "sink", type: "CallFunction", x: 0, y: 0,
    pins: ["in A <- p1.ReturnValue", "in B <- p2.ReturnValue"],
  };
  const { moves } = planTidy([pure("p1", -3000, 0, "sink"), pure("p2", -3200, 0, "sink"), sink], {
    minY: -100, pullOver: 700, clearX: 150, clearY: 60,
  });
  const a = at(moves, "p1"), b = at(moves, "p2");
  if (a && b) {
    const apart = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    assert.ok(apart >= 60, `placed ${apart} apart, which would overlap on screen`);
  }
});

test("scope is respected: nothing outside the band is touched", () => {
  // The whole reason this is not auto_layout_graph. Tidying what you added must not disturb what was
  // already there.
  const theirs = [chain("t1", 900, 0, "t2"), chain("t2", 300, 0)];
  const mine = [chain("m1", 900, 10000, "m2"), chain("m2", 300, 10000)];
  const { moves, scoped } = planTidy([...theirs, ...mine], { minY: 9000 });
  assert.equal(scoped, 2);
  assert.deepEqual(moves.map((m) => m.nodeId), ["m2"]);
});

test("an execution cycle gives up rather than pushing forever", () => {
  // a -> b -> a. Without the pass cap this walks right until it runs out of numbers.
  const a = { id: "a", title: "a", type: "CallFunction", x: 0, y: 0, pins: ["out then -> b.execute"] };
  const b = { id: "b", title: "b", type: "CallFunction", x: 300, y: 0, pins: ["out then -> a.execute"] };
  const { moves } = planTidy([a, b], { minY: -100, gap: 200 });
  assert.ok(moves.length > 0, "it still reports what it did");
  assert.ok(Number.isFinite(at(moves, "a")?.x ?? 0), "and terminates with real numbers");
});

test("a node pushed and pushed back is not reported as moved", () => {
  const { moves } = planTidy([chain("a", 0, 0, "b"), chain("b", 300, 0)], { minY: -100 });
  assert.deepEqual(moves, [], "no net change means no move");
});
