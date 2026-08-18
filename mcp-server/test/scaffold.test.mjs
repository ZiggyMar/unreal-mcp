import { test } from "node:test";
import assert from "node:assert/strict";

import { scaffoldBlueprint } from "../dist/scaffold.js";

function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    order: () => calls.map((c) => c.cmd),
    async send(cmd, params) {
      calls.push({ cmd, params });
      if (overrides[cmd]) return overrides[cmd](params);
      switch (cmd) {
        case "create_blueprint":
          return { path: `${params.packagePath}.X`, name: "X" };
        case "add_variable":
          return { added: true, name: params.variableName };
        case "add_component":
          return { name: params.name, class: params.componentClass };
        case "set_component_property":
          return { property: params.property, value: params.value };
        case "find_node":
          return { hits: [{ functionName: params.query, className: "/Script/Engine.KismetSystemLibrary" }] };
        case "build_graph":
          return { nodes: { evt: { id: "1" }, a0: { id: "2" } }, connectionsMade: 1, pinDefaultsSet: 0 };
        case "compile_blueprint":
          return { success: true, errorCount: 0 };
        case "list_blueprint_graphs":
          return { graphs: [{ name: "EventGraph", nodeCount: 2 }] };
        case "read_blueprint_graph_summary":
          // A real graph, so layout has something to move. An empty one makes the layout step a
          // no-op and the test would pass or fail for the wrong reason.
          return {
            graphName: "EventGraph",
            nodes: [
              {
                id: "1",
                type: "K2Node_Event",
                title: "Event BeginPlay",
                connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] }],
              },
              {
                id: "2",
                type: "K2Node_CallFunction",
                title: "Print String",
                connectedPins: [{ pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] }],
              },
            ],
          };
        case "organize_graph":
          return { ok: true };
        case "save_blueprint":
          return { saved: true };
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
  };
}

const SPEC = {
  packagePath: "/Game/BP/BP_Pickup",
  parentClass: "Actor",
  variables: [{ name: "Health", type: "float", defaultValue: "100" }],
  components: [{ componentClass: "SphereComponent", name: "Trigger", properties: { SphereRadius: "120" } }],
  handlers: [{ event: "BeginPlay", actions: [{ function: "PrintString", className: "KismetSystemLibrary" }] }],
};

test("a whole Blueprint is built from one call", async () => {
  const bridge = fakeBridge();
  const result = await scaffoldBlueprint(bridge, SPEC);

  assert.equal(result.created, true);
  assert.deepEqual(result.variablesAdded, ["Health"]);
  assert.deepEqual(result.componentsAdded, ["Trigger"]);
  assert.deepEqual(result.handlersBuilt, ["ReceiveBeginPlay"]);
  assert.equal(result.saved, true);
});

test("state exists before behaviour references it", async () => {
  // A handler that reads a variable added afterwards would not compile. The order is the value
  // this tool provides, so it is asserted rather than assumed.
  const bridge = fakeBridge();
  await scaffoldBlueprint(bridge, SPEC);
  const order = bridge.order();
  assert.ok(order.indexOf("create_blueprint") < order.indexOf("add_variable"));
  assert.ok(order.indexOf("add_variable") < order.indexOf("build_graph"));
  assert.ok(order.indexOf("add_component") < order.indexOf("build_graph"));
});

test("it compiles once at the end, not after every step", async () => {
  const bridge = fakeBridge();
  await scaffoldBlueprint(bridge, {
    ...SPEC,
    handlers: [
      { event: "BeginPlay", actions: [{ function: "PrintString", className: "KismetSystemLibrary" }] },
      { event: "Tick", actions: [{ function: "PrintString", className: "KismetSystemLibrary" }] },
    ],
  });
  // Compiling is the expensive part; three compiles to build three handlers is three times the wait.
  assert.equal(bridge.calls.filter((c) => c.cmd === "compile_blueprint").length, 1);
});

test("saving happens once, at the end", async () => {
  const bridge = fakeBridge();
  await scaffoldBlueprint(bridge, SPEC);
  const saves = bridge.calls.filter((c) => c.cmd === "save_blueprint");
  assert.equal(saves.length, 1);
  // ...and the create must not have saved an empty asset first.
  assert.equal(bridge.calls.find((c) => c.cmd === "create_blueprint").params.save, false);
});

test("one bad variable does not cost the caller the whole feature", async () => {
  const bridge = fakeBridge({
    add_variable: (params) => {
      if (params.variableName === "Bad") throw new Error("unknown_type: nonsense");
      return { added: true };
    },
  });
  const result = await scaffoldBlueprint(bridge, {
    ...SPEC,
    variables: [{ name: "Bad", type: "nonsense" }, { name: "Health", type: "float" }],
  });

  assert.deepEqual(result.variablesAdded, ["Health"]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].step, /Bad/);
  // The rest still happened.
  assert.deepEqual(result.handlersBuilt, ["ReceiveBeginPlay"]);
  assert.match(result.summary, /1 step\(s\) failed/);
});

test("component properties are applied to the component just added", async () => {
  const bridge = fakeBridge();
  await scaffoldBlueprint(bridge, SPEC);
  const set = bridge.calls.find((c) => c.cmd === "set_component_property");
  assert.equal(set.params.component, "Trigger");
  assert.equal(set.params.property, "SphereRadius");
});

test("the graph is laid out and the result reviewed", async () => {
  const bridge = fakeBridge();
  const result = await scaffoldBlueprint(bridge, SPEC);
  assert.ok(bridge.calls.some((c) => c.cmd === "organize_graph"), "layout should run");
  assert.ok(result.review, "the caller should be told whether what it built is any good");
});

test("no handlers means no layout work", async () => {
  const bridge = fakeBridge();
  await scaffoldBlueprint(bridge, { ...SPEC, handlers: [] });
  assert.equal(bridge.calls.some((c) => c.cmd === "organize_graph"), false);
});

test("save:false leaves it unsaved and says so", async () => {
  const bridge = fakeBridge();
  const result = await scaffoldBlueprint(bridge, { ...SPEC, save: false });
  assert.equal(result.saved, false);
  assert.equal(bridge.calls.some((c) => c.cmd === "save_blueprint"), false);
});

test("a failure to create the Blueprint stops everything, because nothing else can work", async () => {
  const bridge = fakeBridge({
    create_blueprint: () => {
      throw new Error("package_already_exists: /Game/BP/BP_Pickup");
    },
  });
  await assert.rejects(() => scaffoldBlueprint(bridge, SPEC), /package_already_exists/);
  assert.equal(bridge.calls.some((c) => c.cmd === "add_variable"), false);
});
