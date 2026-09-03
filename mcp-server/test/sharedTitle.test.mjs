import { test } from "node:test";
import assert from "node:assert/strict";

import { sharedTitle, boxForBatch } from "../dist/placeNewNodes.js";

test("several systems are named by the word they share", () => {
  assert.equal(sharedTitle(["Server Sound", "MC Sound", "Client Sound"]), "Sound");
  assert.equal(sharedTitle(["Repair Start", "Repair End"]), "Repair");
});

test("systems sharing no word have no common name", () => {
  // Inventing one, or picking the first, claims a system that does not exist.
  assert.equal(sharedTitle(["Alpha", "Beta"]), "");
});

test("one name is its own shared name", () => {
  assert.equal(sharedTitle(["Movement"]), "Movement");
  assert.equal(sharedTitle([]), "");
});

test("a single box over several events is not named after the first one", () => {
  // Found end to end: eight nodes forming CE_RepairStart and CE_RepairEnd went into one box called
  // "Repair Start", naming half of what it contained. Third appearance of the same mistake - the
  // unboxed clustering said "17 nodes starting at KillPlayer" while hiding two more events, and
  // boxesForBatch named its OUTER box after the first part. It survived here because a batch under
  // the split threshold never reaches that code.
  const boxes = { id: "existing", title: "Comment", type: "EdGraphNode_Comment", x: -9e4, y: -9e4, width: 100, height: 100, text: "E" };
  const nodes = [
    { id: "e1", title: "CE_RepairStart", type: "K2Node_CustomEvent", x: 0, y: 0 },
    { id: "e2", title: "CE_RepairEnd", type: "K2Node_CustomEvent", x: 0, y: 0 },
    { id: "a", title: "a", type: "K2Node_CallFunction", x: 0, y: 0 },
  ];
  const places = nodes.map((n, i) => ({ nodeId: n.id, x: i * 260, y: 5000 }));
  assert.equal(boxForBatch([boxes, ...nodes], ["e1", "e2", "a"], places).title, "Repair");
});

test("a single box over unrelated events is refused, not misnamed", () => {
  const boxes = { id: "existing", title: "Comment", type: "EdGraphNode_Comment", x: -9e4, y: -9e4, width: 100, height: 100, text: "E" };
  const nodes = [
    { id: "e1", title: "CE_Alpha", type: "K2Node_CustomEvent", x: 0, y: 0 },
    { id: "e2", title: "CE_Beta", type: "K2Node_CustomEvent", x: 0, y: 0 },
    { id: "a", title: "a", type: "K2Node_CallFunction", x: 0, y: 0 },
  ];
  const places = nodes.map((n, i) => ({ nodeId: n.id, x: i * 260, y: 5000 }));
  assert.equal(boxForBatch([boxes, ...nodes], ["e1", "e2", "a"], places), undefined);
});
