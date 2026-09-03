import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";
import { planTidy } from "../dist/layoutTidy.js";

const fn = (id, x, y, pins = []) => ({ id, title: id, type: "CallFunction", x, y, pins });

test("else, then_0 and macro exec pins count as execution", () => {
  // Exec outputs are named by the node: a Branch has "then" and "else", a Sequence "then_0" and
  // "then_1", a Switch Has Authority "Authority", an Is Valid macro "Is Valid". The old list knew
  // then / Then N / LoopBody / Completed / execute, so on one real graph it counted 69 execution
  // wires where there were 82 - a 19% undercount, five of them "else".
  const r = reviewLayout([
    fn("Branch", 0, 0, ["out then -> a.execute", "out else -> b.execute"]),
    fn("Seq", 0, 400, ["out then_0 -> c.execute", "out then_1 -> d.execute"]),
    fn("Auth", 0, 800, ["out Authority -> e.execute"]),
    fn("a", 300, 0), fn("b", 300, 100), fn("c", 300, 400), fn("d", 300, 500), fn("e", 300, 800),
  ]);
  assert.equal(r.stats.execWires, 5, "every exec wire counted, whatever the pin is called");
});

test("a data wire is still not an execution wire", () => {
  // The target settles unfamiliar names, and a data pin is not called .execute.
  const r = reviewLayout([fn("Get", 0, 0, ["out Value -> a.In", "out Array Element -> b.InputObject"]), fn("a", 300, 0), fn("b", 300, 100)]);
  assert.equal(r.stats.execWires, 0);
});

test("a wire that closes a loop is not a chain reading backwards", () => {
  // 9 of this project's 18 backward wires ran out of a Delay and 3 more out of a For Each Loop -
  // retry loops and loop bodies. A cycle cannot be drawn with every wire pointing right, so two
  // thirds of the finding was reporting loops for being loops.
  const r = reviewLayout([
    fn("Delay", 900, 0, ["out Completed -> Check.execute"]),
    fn("Check", 0, 0, ["out then -> Delay.execute"]),
  ]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "backwardFlow"), []);
});

test("a genuine leftward chain is still reported", () => {
  const r = reviewLayout([fn("First", 900, 0, ["out then -> Second.execute"]), fn("Second", 0, 0)]);
  assert.equal(r.findings.filter((f) => f.kind === "backwardFlow").length, 1);
});

test("straightening never drops a node onto another", () => {
  // The straighten pass set x and checked nothing - only compact looked for collisions - so it
  // could land a node on one already standing there. Measured on a real system, which came back
  // with a stacked pair the tidy itself had just created.
  const nodes = [
    fn("a", 0, 0, ["out then -> b.execute"]),
    fn("b", -400, 0),
    fn("blocker", 220, 0),
  ];
  const r = planTidy(nodes, {});
  for (const m of r.moves) {
    for (const o of nodes) {
      if (o.id === m.nodeId) continue;
      const other = r.moves.find((x) => x.nodeId === o.id) ?? o;
      const apart = Math.max(Math.abs(other.x - m.x), Math.abs(other.y - m.y));
      assert.ok(apart >= 60, `${m.nodeId} landed ${apart} from ${o.id}`);
    }
  }
});
