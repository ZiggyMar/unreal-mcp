import { test } from "node:test";
import assert from "node:assert/strict";

import { findServerSideUi, findEmptyRepNotifies, isServerEvent } from "../dist/clientSync.js";

const nodes = (list) => new Map(list.map((n) => [n.id, n]));

test("a server event that updates a widget is reported", async () => {
  // The real one: a repair timer running on the server pushed the progress ring into the widget.
  // The host's ring filled; everyone else watched a frozen bar. No error, no failed cast.
  const found = await findServerSideUi(
    [{ entryId: "e", entry: "UpdateRepairTimer", nodeIds: ["cast", "set"] }],
    nodes([
      { id: "cast", type: "K2Node_DynamicCast", title: "Cast To WB_Interaction_FW" },
      { id: "set", type: "K2Node_CallFunction", title: "Set Scalar Parameter Value" },
    ]),
    { netModeOf: async () => "Executes On Server", isWidgetClass: async (c) => c === "WB_Interaction_FW" }
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /host's screen and nobody else's/);
});

test("the same UI work on a normal event is left alone", async () => {
  const found = await findServerSideUi(
    [{ entryId: "e", entry: "ShowMenu", nodeIds: ["w"] }],
    nodes([{ id: "w", type: "K2Node_CallFunction", title: "Create Widget" }]),
    { netModeOf: async () => undefined, isWidgetClass: async () => true }
  );
  assert.deepEqual(found, []);
});

test("a server event that touches no UI costs nothing to check", async () => {
  // Replication is looked up lazily, because it costs a call per event. A graph with no widget work
  // must not pay for it.
  let asked = 0;
  const found = await findServerSideUi(
    [{ entryId: "e", entry: "ServerApplyDamage", nodeIds: ["a"] }],
    nodes([{ id: "a", type: "K2Node_VariableSet", title: "SET Health" }]),
    {
      netModeOf: async () => {
        asked += 1;
        return "Executes On Server";
      },
      isWidgetClass: async () => false,
    }
  );
  assert.deepEqual(found, []);
  assert.equal(asked, 0, "replication must only be looked up for chains that touch a widget");
});

test("a cast is judged a widget by its ancestry, not by its name", async () => {
  // Widget classes get called all sorts of things. W_, WB_, WBP_, or nothing at all.
  const found = await findServerSideUi(
    [{ entryId: "e", entry: "ServerRefresh", nodeIds: ["c"] }],
    nodes([{ id: "c", type: "K2Node_DynamicCast", title: "Cast To RepairRing" }]),
    { netModeOf: async () => "Executes On Server", isWidgetClass: async (c) => c === "RepairRing" }
  );
  assert.equal(found.length, 1);
});

test("an empty RepNotify is reported as the missing half of a feature", () => {
  const found = findEmptyRepNotifies(
    [{ name: "CurrentRepairProgress", repNotify: "OnRep_CurrentRepairProgress" }],
    () => true
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /sent to every client on every change/);
});

test("a RepNotify with a body, and a plain replicated variable, are both fine", () => {
  assert.deepEqual(findEmptyRepNotifies([{ name: "Health", repNotify: "OnRep_Health" }], () => false), []);
  assert.deepEqual(findEmptyRepNotifies([{ name: "Health" }], () => true), []);
});

test("an unreadable notify graph is not evidence of emptiness", () => {
  // Reporting "it is empty" because the graph could not be read would be inventing a finding.
  assert.deepEqual(findEmptyRepNotifies([{ name: "X", repNotify: "OnRep_X" }], () => undefined), []);
});

test("only Executes On Server counts as a server event", () => {
  assert.equal(isServerEvent("Executes On Server"), true);
  assert.equal(isServerEvent("Executes On All"), false);
  assert.equal(isServerEvent("Executes On Owning Client"), false);
  assert.equal(isServerEvent(undefined), false);
});
