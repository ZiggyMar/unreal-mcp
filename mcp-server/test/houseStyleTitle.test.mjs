import { test } from "node:test";
import assert from "node:assert/strict";

import { houseStyleTitle, boxForBatch } from "../dist/placeNewNodes.js";

test("an event prefix is plumbing, not the system's name", () => {
  assert.equal(houseStyleTitle("CE_ServerToggleHealPrompt"), "Server Toggle Heal Prompt");
  assert.equal(houseStyleTitle("Event On Landed"), "On Landed");
});

test("a run-together name is split so the word count means something", () => {
  assert.equal(houseStyleTitle("ApplyTicketSkin"), "Apply Ticket Skin");
  assert.equal(houseStyleTitle("UpdateLocalVanPing"), "Update Local Van Ping");
});

test("shouting is 3% of this project, so it is not the default", () => {
  assert.equal(houseStyleTitle("TUTORIAL GUIDE ARROWS"), "Tutorial Guide Arrows");
});

test("a title already in house style is left alone", () => {
  assert.equal(houseStyleTitle("Movement"), "Movement");
  assert.equal(houseStyleTitle("Aim Server"), "Aim Server");
});

test("a long title is truncated rather than cut at punctuation", () => {
  // It used to cut at a colon or dash, and the evidence killed it: "Otherwise: the nearest pool
  // nobody else is closer to" became "Otherwise", and "Tutorial Guide 3 - Pick Target" became
  // "Tutorial Guide". Both kept the generic half and threw the meaning away, which is worse than
  // leaving the title alone.
  assert.equal(houseStyleTitle("Otherwise: the nearest pool nobody else is closer to"), "Otherwise: the nearest pool");
  // Truncation is not clever - it keeps the leading words, and on a title whose meaning is at the
  // END it keeps the wrong half. That is accepted, not hidden: this function only ever sees entry
  // event names, and a hand-written title is never passed through it. Asserting "Pick Target" here
  // would be asserting a cleverness the code does not have.
  assert.equal(houseStyleTitle("Tutorial Guide 3 - Pick Target"), "Tutorial Guide 3");
});

test("empty in, empty out - a box with no name is not offered at all", () => {
  assert.equal(houseStyleTitle(""), "");
  assert.equal(houseStyleTitle("   "), "");
});

test("a generated box is titled in house style, not raw", () => {
  const nodes = [
    { id: "e1", type: "K2Node_CustomEvent", title: "CE_ServerToggleHealPrompt", x: 0, y: 0 },
    { id: "n1", type: "K2Node_CallFunction", title: "A", x: 300, y: 0 },
    { id: "n2", type: "K2Node_CallFunction", title: "B", x: 600, y: 0 },
  ];
  const placements = nodes.map((n) => ({ nodeId: n.id, x: n.x, y: n.y }));
  const box = boxForBatch(nodes, ["e1", "n1", "n2"], placements);
  assert.equal(box.title, "Server Toggle Heal Prompt");
});
