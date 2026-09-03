import { test } from "node:test";
import assert from "node:assert/strict";

import { placeNewNodes } from "../dist/placeNewNodes.js";

const n = (id, x, y, pins = []) => ({ id, title: id, type: "CallFunction", x, y, pins });
const at = (out, id) => out.find((p) => p.nodeId === id);

test("nodes built into an existing chain land beside it, not at the origin", () => {
  // The bug this exists for: three nodes built with no coordinates all arrived at (0,0), stacked on
  // each other and on a node called UpdateLocalVanPing.
  const host = n("host", 4000, 500, ["out then -> fresh.execute"]);
  const fresh = n("fresh", 0, 0, ["in execute <- host.then"]);
  const out = placeNewNodes([host, fresh], ["fresh"]);
  const p = at(out, "fresh");
  assert.ok(p.x > 4000, "should sit to the right of what it attaches to");
  assert.ok(Math.abs(p.y - 500) < 400, "and near its row");
});

test("a batch attached to nothing goes to clear canvas, not the origin", () => {
  const theirs = [n("a", 0, 0), n("b", 500, 900), n("c", -300, 1500)];
  const fresh = n("fresh", 0, 0);
  const out = placeNewNodes([...theirs, fresh], ["fresh"]);
  const p = at(out, "fresh");
  assert.ok(p.y > 1500, `expected clear space below everything, got y=${p.y}`);
});

test("nothing already in the graph is moved", () => {
  const theirs = [n("a", 0, 0), n("b", 500, 900)];
  const out = placeNewNodes([...theirs, n("fresh", 0, 0)], ["fresh"]);
  assert.deepEqual(out.map((p) => p.nodeId), ["fresh"]);
});

test("a batch of several is laid left to right, in declared order", () => {
  const host = n("host", 1000, 0, ["out then -> f1.execute"]);
  const out = placeNewNodes([host, n("f1", 0, 0, ["in execute <- host.then"]), n("f2", 0, 0), n("f3", 0, 0)], [
    "f1", "f2", "f3",
  ]);
  const xs = ["f1", "f2", "f3"].map((id) => at(out, id).x);
  assert.ok(xs[0] < xs[1] && xs[1] < xs[2], `expected increasing x, got ${xs.join(", ")}`);
});

test("no two placed nodes land on top of each other", () => {
  const host = n("host", 0, 0, ["out then -> f1.execute"]);
  const fresh = ["f1", "f2", "f3", "f4"].map((id) => n(id, 0, 0, id === "f1" ? ["in execute <- host.then"] : []));
  const out = placeNewNodes([host, ...fresh], ["f1", "f2", "f3", "f4"]);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const apart = Math.max(Math.abs(out[i].x - out[j].x), Math.abs(out[i].y - out[j].y));
      assert.ok(apart >= 60, `${out[i].nodeId} and ${out[j].nodeId} only ${apart} apart`);
    }
  }
});

test("a new node never lands on an existing one", () => {
  // The failure that started this: the origin was occupied, and the batch went there anyway.
  const occupant = n("theirs", 1260, 0);
  const host = n("host", 1000, 0, ["out then -> fresh.execute"]);
  const out = placeNewNodes([occupant, host, n("fresh", 0, 0, ["in execute <- host.then"])], ["fresh"]);
  const p = at(out, "fresh");
  const apart = Math.max(Math.abs(p.x - 1260), Math.abs(p.y - 0));
  assert.ok(apart >= 60, `landed ${apart} from an existing node`);
});

test("an empty batch asks for nothing", () => {
  assert.deepEqual(placeNewNodes([n("a", 0, 0)], []), []);
});

test("comment boxes are not treated as obstacles", () => {
  // A box is meant to have nodes inside it. Avoiding boxes would push every new node out of the very
  // grouping it belongs in.
  const box = { id: "box", title: "Comment", type: "EdGraphNode_Comment", x: 1200, y: 0 };
  const host = n("host", 1000, 0, ["out then -> fresh.execute"]);
  const out = placeNewNodes([box, host, n("fresh", 0, 0, ["in execute <- host.then"])], ["fresh"]);
  assert.equal(at(out, "fresh").x, 1260, "should take the slot the box occupies");
});

test("a short summary id matches the full id build_graph reports", () => {
  // build_graph returns 32-character ids; the summary shortens them to 8. Comparing the two directly
  // matched nothing, so the placement ran and moved zero nodes while reporting success - the exact
  // shape of a fix that looks applied and is not.
  const host = n("host", 1000, 0, ["out then -> ABCD1234.execute"]);
  const fresh = n("ABCD1234", 0, 0, ["in execute <- host.then"]);
  const out = placeNewNodes([host, fresh], ["ABCD1234FFFFFFFFFFFFFFFFFFFFFFFF"]);
  assert.equal(out.length, 1, "the short id in the graph must match the long id from the build");
  assert.ok(out[0].x > 1000);
});

// --- automatic boxing of a new system ---------------------------------------------------------
import { boxForBatch } from "../dist/placeNewNodes.js";

const ev = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CustomEvent", x, y, pins });

test("a standalone system gets a box named after its event", () => {
  const nodes = [ev("CE_Thing", 0, 0), n("a", 0, 0), n("b", 0, 0)];
  const placements = [
    { nodeId: "CE_Thing", x: 0, y: 5000 },
    { nodeId: "a", x: 260, y: 5000 },
    { nodeId: "b", x: 520, y: 5000 },
  ];
  const box = boxForBatch(nodes, ["CE_Thing", "a", "b"], placements);
  // The event is what the system IS - but CE_ is plumbing, and this project's box titles are names.
  // Measured over 148 graphs: 2 words median, 3% shouted, "Movement" and "Firing", not "CE_Thing".
  assert.equal(box.title, "Thing", "the event names the system; the CE_ prefix does not");
  assert.ok(box.x < 0 && box.y < 5000, "the box surrounds its nodes");
  assert.ok(box.width > 520, "and is wide enough for the last one");
});

test("a batch wired into existing work gets no box", () => {
  // It belongs to whatever already owns that chain. Boxing it would claim a system that is really
  // an addition to somebody else's.
  const host = n("host", 1000, 0, ["out then -> CE_Thing.execute"]);
  const nodes = [host, ev("CE_Thing", 0, 0, ["in execute <- host.then"]), n("a", 0, 0), n("b", 0, 0)];
  const placements = [
    { nodeId: "CE_Thing", x: 1260, y: 0 },
    { nodeId: "a", x: 1520, y: 0 },
    { nodeId: "b", x: 1780, y: 0 },
  ];
  assert.equal(boxForBatch(nodes, ["CE_Thing", "a", "b"], placements), undefined);
});

test("a batch with no entry event gets no box", () => {
  // An untitled box groups nodes while explaining nothing - a fault in its own right.
  const nodes = [n("a", 0, 0), n("b", 0, 0), n("c", 0, 0)];
  const placements = [
    { nodeId: "a", x: 0, y: 5000 },
    { nodeId: "b", x: 260, y: 5000 },
    { nodeId: "c", x: 520, y: 5000 },
  ];
  assert.equal(boxForBatch(nodes, ["a", "b", "c"], placements), undefined);
});

test("one or two nodes are not a system", () => {
  const nodes = [ev("CE_Thing", 0, 0), n("a", 0, 0)];
  const placements = [{ nodeId: "CE_Thing", x: 0, y: 5000 }, { nodeId: "a", x: 260, y: 5000 }];
  assert.equal(boxForBatch(nodes, ["CE_Thing", "a"], placements), undefined);
});
