import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCallers, resolveServerAuthority } from "../dist/authorityMap.js";

const unit = (blueprint, name, nodes) => ({
  key: `${blueprint}::${name}`,
  blueprint,
  name,
  entryId: `${blueprint}.${name}.entry`,
  nodes,
});
const node = (id, type, title, pins = []) => ({ id, type, title, connectedPins: pins });
const index = (units) => new Map(units.map((u) => [u.key, u]));

/**
 * The real shape, reduced: a server RPC on the player reaches a widget update on a firewall through
 * an interface message, a plain function, a plain event and a timer. Nothing after the first
 * declares any replication, and all of it runs on the server.
 */
function firewallProject() {
  return [
    unit("BP_Player", "TraceInteract", [node("m", "K2Node_Message", "Interacted")]),
    unit("BP_FireWall", "Interacted", [node("call", "K2Node_CallFunction", "StartRepair")]),
    unit("BP_FireWall", "StartRepair", [node("timer", "K2Node_CallFunction", "Set Timer by Event")]),
    unit("BP_FireWall", "UpdateRepairTimer", [
      node("ev", "K2Node_CustomEvent", "UpdateRepairTimer", [
        { pin: "OutputDelegate", direction: "out", linkedTo: [{ node: "timer", pin: "Delegate" }] },
      ]),
      node("w", "K2Node_DynamicCast", "Cast To WB_Interaction_FW"),
    ]),
  ];
}

test("authority is inherited across an interface message, a call and a timer", async () => {
  const units = firewallProject();
  const callers = buildCallers(units);
  const asked = [];
  const result = await resolveServerAuthority(
    "BP_FireWall::UpdateRepairTimer",
    index(units),
    callers,
    async (u) => {
      asked.push(u.name);
      return u.name === "TraceInteract";
    }
  );
  assert.equal(result.server, true, `expected server authority; asked ${asked.join(", ")}`);
  assert.deepEqual(result.via, [
    "TraceInteract (Executes On Server)",
    "Interacted",
    "StartRepair",
    "UpdateRepairTimer",
  ]);
});

test("only units on the path back are ever asked about", async () => {
  // The whole point of walking backwards: reading every event's replication would be a bridge call
  // per event across the project.
  const units = [...firewallProject(), unit("BP_Unrelated", "SomethingElse", [])];
  const asked = new Set();
  await resolveServerAuthority("BP_FireWall::UpdateRepairTimer", index(units), buildCallers(units), async (u) => {
    asked.add(u.name);
    return u.name === "TraceInteract";
  });
  assert.ok(!asked.has("SomethingElse"), "an unrelated unit must never be asked about");
});

test("no server RPC anywhere means no authority is claimed", async () => {
  const units = firewallProject();
  const result = await resolveServerAuthority(
    "BP_FireWall::UpdateRepairTimer",
    index(units),
    buildCallers(units),
    async () => false
  );
  assert.equal(result.server, false);
  assert.deepEqual(result.via, []);
});

test("a call cycle terminates instead of hanging", async () => {
  const units = [
    unit("BP_A", "One", [node("a", "K2Node_CallFunction", "Two")]),
    unit("BP_A", "Two", [node("b", "K2Node_CallFunction", "One")]),
  ];
  const result = await resolveServerAuthority("BP_A::One", index(units), buildCallers(units), async () => false);
  assert.equal(result.server, false);
});

test("a same-named function in another Blueprint is not treated as a local call", async () => {
  // Only an interface message crosses a Blueprint boundary. A plain call node names something in
  // its own Blueprint, and matching it globally would invent callers everywhere.
  const units = [
    unit("BP_A", "Caller", [node("a", "K2Node_CallFunction", "Update")]),
    unit("BP_B", "Update", []),
  ];
  const callers = buildCallers(units);
  assert.equal(callers.get("BP_B::Update"), undefined);
});

test("an interface message does reach every implementer", async () => {
  const units = [
    unit("BP_A", "Caller", [node("a", "K2Node_Message", "Interacted")]),
    unit("BP_B", "Interacted", []),
    unit("BP_C", "Interacted", []),
  ];
  const callers = buildCallers(units);
  assert.deepEqual([...(callers.get("BP_B::Interacted") ?? [])], ["BP_A::Caller"]);
  assert.deepEqual([...(callers.get("BP_C::Interacted") ?? [])], ["BP_A::Caller"]);
});
