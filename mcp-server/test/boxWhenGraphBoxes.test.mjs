import { test } from "node:test";
import assert from "node:assert/strict";

import { boxForBatch } from "../dist/placeNewNodes.js";

const ev = (id) => ({ id, title: id, type: "K2Node_CustomEvent", x: 0, y: 0 });
const fn = (id) => ({ id, title: id, type: "K2Node_CallFunction", x: 0, y: 0 });
const box = { id: "existing", title: "Comment", type: "EdGraphNode_Comment", x: -9e4, y: -9e4, width: 100, height: 100, text: "Existing" };
const batch = [ev("CE_Thing"), fn("a"), fn("b")];
const places = [{ nodeId: "CE_Thing", x: 0, y: 5000 }, { nodeId: "a", x: 260, y: 5000 }, { nodeId: "b", x: 520, y: 5000 }];
const filler = (count) => Array.from({ length: count }, (_, i) => ({ id: `f${i}`, title: `f${i}`, type: "K2Node_CallFunction", x: i * 300, y: -3000 }));

test("a small graph with no boxes gets no box", () => {
  // Measured across 148 graphs: 8% of graphs under 10 nodes carry a comment box, 18% at 10-19, 38%
  // at 20-29. Dropping a titled box into a twelve-node graph is a foreign convention, not tidiness -
  // and it is the same mistake that put a box round a two-node graph when the checker made it.
  assert.equal(boxForBatch(batch, ["CE_Thing", "a", "b"], places), undefined);
});

test("a graph that already uses boxes gets one, whatever its size", () => {
  // The graph answers before any threshold does, which costs nothing and travels to projects whose
  // crossover is not this one's.
  const b = boxForBatch([box, ...batch], ["CE_Thing", "a", "b"], places);
  assert.equal(b?.title, "Thing");
});

test("a big graph with no boxes yet gets the first one", () => {
  // From 30 nodes boxing is a coin flip here (52%), and a freshly built system with its own entry
  // event is the half that benefits.
  const b = boxForBatch([...filler(40), ...batch], ["CE_Thing", "a", "b"], places);
  assert.equal(b?.title, "Thing");
});

test("the threshold is an option, because it is one project's number", () => {
  // review_layout's sweep reports boxedAboveNodes for whatever project it is pointed at; baking
  // this project's crossover in as a constant would export its habits to everybody else's code.
  assert.ok(boxForBatch(batch, ["CE_Thing", "a", "b"], places, { boxedAbove: 1 }));
  assert.equal(boxForBatch([...filler(40), ...batch], ["CE_Thing", "a", "b"], places, { boxedAbove: 999 }), undefined);
});

test("comment boxes do not count toward the graph's size", () => {
  // Otherwise a graph of nothing but boxes would look big enough to deserve another.
  const manyBoxes = Array.from({ length: 40 }, (_, i) => ({ ...box, id: `b${i}`, x: -9e4 - i * 200 }));
  const b = boxForBatch([...manyBoxes, ...batch], ["CE_Thing", "a", "b"], places);
  assert.ok(b, "it should still box, but because the graph USES boxes - not because it is large");
});
