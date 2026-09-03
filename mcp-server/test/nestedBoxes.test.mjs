import { test } from "node:test";
import assert from "node:assert/strict";

import { boxesForBatch } from "../dist/placeNewNodes.js";

const ev = (id, pins = []) => ({ id, title: id, type: "K2Node_CustomEvent", x: 0, y: 0, pins });
const fn = (id, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x: 0, y: 0, pins });
/** An existing box far from everything: this graph already uses boxes, which is what boxForBatch
 * reads before deciding. Without it a small synthetic graph correctly gets no box at all. */
const usesBoxes = { id: "existing", title: "Comment", type: "EdGraphNode_Comment", x: -90000, y: -90000, width: 100, height: 100, text: "Existing" };


/** A chain of `count` nodes hanging off `evId`, laid out left to right on row `row`. */
function system(evId, count, row) {
  const nodes = [ev(evId, [`out then -> ${evId}_0.execute`])];
  for (let i = 0; i < count; i++) {
    nodes.push(fn(`${evId}_${i}`, i + 1 < count ? [`out then -> ${evId}_${i + 1}.execute`] : []));
  }
  const placements = nodes.map((n, i) => ({ nodeId: n.id, x: i * 260, y: row }));
  return { nodes, placements };
}

test("a small batch stays one box", () => {
  const a = system("CE_Alpha", 4, 0);
  const boxes = boxesForBatch([usesBoxes, ...a.nodes], a.nodes.map((n) => n.id), a.placements);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].title, "Alpha");
});

test("a big batch with several events becomes an outer box and named parts", () => {
  // The project's boxes hold a median of 7 nodes and a p90 of 20, with 104 nested pairs - an outer
  // box naming the system, inner ones naming its parts. A single box round forty nodes is not what
  // this codebase looks like.
  const a = system("CE_ServerSound", 10, 0);
  const b = system("CE_MC_Sound", 10, 400);
  const c = system("CE_ClientSound", 10, 800);
  const nodes = [...a.nodes, ...b.nodes, ...c.nodes];
  const placements = [...a.placements, ...b.placements, ...c.placements];
  const boxes = boxesForBatch([usesBoxes, ...nodes], nodes.map((n) => n.id), placements);

  assert.ok(boxes.length > 1, "it should nest");
  assert.equal(boxes[0].outer, true);
  // The outer box is named for what the parts SHARE, not for the first event. Naming it after the
  // first is the mistake the unboxed check had to be fixed for, where "17 nodes starting at
  // KillPlayer" quietly hid two more events and read as one system.
  assert.equal(boxes[0].title, "Sound");
  assert.deepEqual(boxes.slice(1).map((x) => x.title), ["Server Sound", "MC Sound", "Client Sound"]);
});

test("parts that share no word get no outer box, rather than a misleading one", () => {
  // There is no honest name for the whole here, and naming it after whichever event came first
  // would claim a system that does not exist. Two named parts is still better organised than one
  // box with the wrong name on it.
  const a = system("CE_Alpha", 10, 0);
  const b = system("CE_Beta", 10, 400);
  const nodes = [...a.nodes, ...b.nodes];
  const boxes = boxesForBatch([usesBoxes, ...nodes], nodes.map((n) => n.id), [...a.placements, ...b.placements]);
  assert.deepEqual(boxes.map((x) => x.title), ["Alpha", "Beta"]);
  assert.ok(boxes.every((x) => !x.outer));
});

test("a big batch with ONE event stays one box", () => {
  // Chopping a chain into "Part 1" and "Part 2" every seven nodes would satisfy the measurement and
  // mean nothing. Fake structure reads worse than one honest box, so it only splits where a real
  // name exists.
  const a = system("CE_Solo", 40, 0);
  const boxes = boxesForBatch([usesBoxes, ...a.nodes], a.nodes.map((n) => n.id), a.placements);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].title, "Solo");
});

test("every inner box sits inside the outer one", () => {
  const a = system("CE_AlphaSound", 10, 0);
  const b = system("CE_BetaSound", 10, 400);
  const nodes = [...a.nodes, ...b.nodes];
  const placements = [...a.placements, ...b.placements];
  const [outer, ...inner] = boxesForBatch([usesBoxes, ...nodes], nodes.map((n) => n.id), placements);
  for (const box of inner) {
    assert.ok(box.x >= outer.x, `${box.title} starts left of its parent`);
    assert.ok(box.y >= outer.y, `${box.title} starts above its parent`);
    assert.ok(box.x + box.width <= outer.x + outer.width, `${box.title} runs past its parent`);
    assert.ok(box.y + box.height <= outer.y + outer.height, `${box.title} runs below its parent`);
  }
});

test("no node is claimed by two inner boxes", () => {
  // Claiming a node twice would build exactly the overlapping boxes this whole effort exists to
  // prevent - both boxes own it, and dragging either takes it from the other.
  const a = system("CE_AlphaSound", 10, 0);
  const b = system("CE_BetaSound", 10, 400);
  const nodes = [...a.nodes, ...b.nodes];
  const placements = [...a.placements, ...b.placements];
  const [, ...inner] = boxesForBatch([usesBoxes, ...nodes], nodes.map((n) => n.id), placements);
  for (let i = 0; i < inner.length; i++) {
    for (let j = i + 1; j < inner.length; j++) {
      const p = inner[i], q = inner[j];
      const share = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
      assert.ok(!share, `${p.title} and ${q.title} overlap`);
    }
  }
});

test("a batch anchored to existing work still gets no box at all", () => {
  const host = { id: "host", title: "host", type: "K2Node_CallFunction", x: 0, y: 0 };
  const a = system("CE_Alpha", 10, 0);
  const b = system("CE_Beta", 10, 400);
  a.nodes[0].pins = ["out then <- host.execute"];
  const nodes = [host, ...a.nodes, ...b.nodes];
  const ids = [...a.nodes, ...b.nodes].map((n) => n.id);
  assert.deepEqual(boxesForBatch(nodes, ids, [...a.placements, ...b.placements]), []);
});
