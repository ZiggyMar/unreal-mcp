import { test } from "node:test";
import assert from "node:assert/strict";

import { addEventHandler, resolveEvent } from "../dist/eventHandler.js";

function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd, params) {
      calls.push({ cmd, params });
      if (overrides[cmd]) return overrides[cmd](params);
      if (cmd === "find_node") {
        const known = {
          PrintString: "/Script/Engine.KismetSystemLibrary",
          K2_DestroyActor: "/Script/Engine.Actor",
        };
        const className = known[params.query];
        return {
          query: params.query,
          hits: className ? [{ functionName: params.query, className }] : [{ functionName: "PrintString", className: "/Script/Engine.KismetSystemLibrary" }],
          hitCount: className ? 1 : 1,
          catalogSize: 15000,
        };
      }
      if (cmd === "build_graph") {
        const nodes = {};
        for (const n of params.nodes ?? []) nodes[n.ref] = { id: `id_${n.ref}` };
        return { nodes, connectionsMade: (params.connections ?? []).length, pinDefaultsSet: (params.pinDefaults ?? []).length, compile: { success: true, errorCount: 0 } };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
}

const buildCall = (bridge) => bridge.calls.find((c) => c.cmd === "build_graph").params;

test("engine events are translated; custom names become custom events", () => {
  // A caller says "BeginPlay". Making them know it is really ReceiveBeginPlay is asking them to
  // know something they have no reason to know.
  assert.deepEqual(resolveEvent("BeginPlay"), { nodeType: "Event", eventName: "ReceiveBeginPlay" });
  assert.deepEqual(resolveEvent("begin play"), { nodeType: "Event", eventName: "ReceiveBeginPlay" });
  assert.deepEqual(resolveEvent("Tick"), { nodeType: "Event", eventName: "ReceiveTick" });
  assert.deepEqual(resolveEvent("OnPickedUp"), { nodeType: "CustomEvent", eventName: "OnPickedUp" });
});

test("the execution chain is wired in order, with no pin names from the caller", async () => {
  const bridge = fakeBridge();
  await addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [
    { function: "PrintString", className: "KismetSystemLibrary", params: { "In String": "hello" } },
    { function: "K2_DestroyActor", className: "Actor" },
  ]);

  const call = buildCall(bridge);
  assert.deepEqual(
    call.connections,
    [
      { from: "evt.then", to: "a0.execute" },
      { from: "a0.then", to: "a1.execute" },
    ],
    "the chain is the whole point: event -> first action -> second action"
  );
  assert.equal(call.nodes.length, 3);
  assert.equal(call.nodes[0].eventName, "ReceiveBeginPlay");
});

test("parameters become pin defaults on the right node", async () => {
  const bridge = fakeBridge();
  await addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [
    { function: "PrintString", className: "KismetSystemLibrary", params: { "In String": "hello" } },
  ]);
  assert.deepEqual(buildCall(bridge).pinDefaults, [{ node: "a0", pin: "In String", value: "hello" }]);
});

test("an omitted class is looked up in the live catalog", async () => {
  const bridge = fakeBridge();
  const result = await addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [
    { function: "PrintString" },
  ]);
  // Short class name, not the full path: that is what the node builder takes.
  assert.equal(buildCall(bridge).nodes[1].className, "KismetSystemLibrary");
  assert.deepEqual(result.resolvedFunctions, [{ requested: "PrintString", usedClass: "KismetSystemLibrary" }]);
});

test("a function the engine does not have fails BEFORE anything is built", async () => {
  const bridge = fakeBridge({
    find_node: () => ({ query: "Nope", hits: [{ functionName: "PrintString", className: "/Script/Engine.KismetSystemLibrary" }], hitCount: 1, catalogSize: 1 }),
  });
  await assert.rejects(
    () => addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [{ function: "Nope" }]),
    /function_not_found/
  );
  // Nothing was built: a half-written handler is worse than a refused one.
  assert.equal(bridge.calls.some((c) => c.cmd === "build_graph"), false);
});

test("a bad name suggests near-misses rather than dead-ending", async () => {
  const bridge = fakeBridge({
    find_node: () => ({
      query: "PrintSting",
      hits: [{ functionName: "PrintString", className: "/Script/Engine.KismetSystemLibrary" }],
      hitCount: 1,
      catalogSize: 1,
    }),
  });
  await assert.rejects(
    () => addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [{ function: "PrintSting" }]),
    /Did you mean: PrintString/
  );
});

test("everything lands in ONE atomic build, so a failure leaves nothing behind", async () => {
  const bridge = fakeBridge();
  await addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [
    { function: "PrintString", className: "KismetSystemLibrary" },
    { function: "K2_DestroyActor", className: "Actor" },
    { function: "PrintString", className: "KismetSystemLibrary" },
  ]);
  assert.equal(bridge.calls.filter((c) => c.cmd === "build_graph").length, 1);
});

test("an empty action list is refused", async () => {
  await assert.rejects(
    () => addEventHandler(fakeBridge(), "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", []),
    /no actions given/
  );
});

test("pin corrections from the bridge are passed through, not swallowed", async () => {
  const bridge = fakeBridge({
    build_graph: () => ({
      nodes: { evt: { id: "id_evt" }, a0: { id: "id_a0" } },
      connectionsMade: 1,
      pinDefaultsSet: 1,
      compile: { success: true, errorCount: 0 },
      pinNamesCorrected: ["'InString' -> 'In String'"],
    }),
  });
  const result = await addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [
    { function: "PrintString", className: "KismetSystemLibrary", params: { InString: "hi" } },
  ]);
  assert.deepEqual(result.pinNamesCorrected, ["'InString' -> 'In String'"]);
});

test("the result says what it cannot do, so nobody reaches for it for branches", async () => {
  const bridge = fakeBridge();
  const result = await addEventHandler(bridge, "/Game/BP_A.BP_A", "EventGraph", "BeginPlay", [
    { function: "PrintString", className: "KismetSystemLibrary" },
  ]);
  assert.match(result.note, /branches|build_graph/i);
});
