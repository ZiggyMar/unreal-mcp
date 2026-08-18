import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanupBlueprint } from "../dist/cleanup.js";

function node(id, type, title, links = []) {
  const pins = new Map();
  for (const [pin, direction, toNode, toPin] of links) {
    const key = `${pin}:${direction}`;
    if (!pins.has(key)) pins.set(key, { pin, direction, linkedTo: [] });
    if (toNode) pins.get(key).linkedTo.push({ node: toNode, pin: toPin });
  }
  return { id, type, title, connectedPins: [...pins.values()] };
}

/** A graph with two dead nodes, a leftover print, and a placeholder variable name. */
function messyGraph() {
  return [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "p", "execute"]]),
    node("p", "K2Node_CallFunction", "Print String", [["execute", "in", "ev", "then"]]),
    node("dead1", "K2Node_CallFunction", "Get Player Controller"),
    node("dead2", "K2Node_CallFunction", "Get Game Mode"),
    node("setvar", "K2Node_VariableSet", "Set NewVar", [["execute", "in", "ev", "then"]]),
  ];
}

function fakeBridge({ failRemove = null } = {}) {
  const calls = [];
  let nodes = messyGraph();
  return {
    calls,
    async send(cmd, params) {
      calls.push({ cmd, params });
      if (cmd === "list_blueprint_graphs") return { path: params.path, graphs: [{ name: "EventGraph", nodeCount: nodes.length }] };
      if (cmd === "read_blueprint_graph_summary") return { path: params.path, graphName: params.graphName, nodes };
      if (cmd === "remove_node") {
        if (params.nodeId === failRemove) throw new Error(`node_not_found: ${params.nodeId}`);
        nodes = nodes.filter((n) => n.id !== params.nodeId);
        return { removed: params.nodeId };
      }
      if (cmd === "organize_graph") return { ok: true };
      throw new Error(`unexpected ${cmd}`);
    },
  };
}

test("dead nodes are removed, because a node wired to nothing cannot affect behaviour", async () => {
  const bridge = fakeBridge();
  const report = await cleanupBlueprint(bridge, "/Game/BP_Messy.BP_Messy");

  assert.equal(report.deadNodesRemoved, 2);
  const removed = bridge.calls.filter((c) => c.cmd === "remove_node").map((c) => c.params.nodeId);
  assert.deepEqual(removed.sort(), ["dead1", "dead2"]);
});

test("the leftover Print String is NOT removed, and the reason is stated", async () => {
  // Removing it means healing the exec chain around it. A cleanup that gets that subtly wrong
  // breaks a working graph while reporting success.
  const report = await cleanupBlueprint(fakeBridge(), "/Game/BP_Messy.BP_Messy");

  const left = report.leftForYou.find((l) => l.check === "debug-print-left-in");
  assert.ok(left, `expected the print to be left alone: ${JSON.stringify(report.leftForYou)}`);
  assert.match(left.why, /healing the execution chain|reconnect/i);
});

test("a placeholder name is left alone, because choosing a name is judgement", async () => {
  const report = await cleanupBlueprint(fakeBridge(), "/Game/BP_Messy.BP_Messy");
  const left = report.leftForYou.find((l) => l.check === "placeholder-name");
  assert.ok(left);
  assert.match(left.why, /judgement|says what the variable holds/i);
});

test("every untouched finding explains itself, so nothing reads as an oversight", async () => {
  const report = await cleanupBlueprint(fakeBridge(), "/Game/BP_Messy.BP_Messy");
  for (const item of report.leftForYou) {
    assert.ok(item.why.length > 30, `${item.check} has no real explanation`);
  }
});

test("the score is re-measured afterwards rather than assumed", async () => {
  const bridge = fakeBridge();
  const report = await cleanupBlueprint(bridge, "/Game/BP_Messy.BP_Messy");

  // Two reviews: one before, one after. Reporting success without re-checking is the same failure
  // as a model that reads findings and declares victory.
  const reviews = bridge.calls.filter((c) => c.cmd === "list_blueprint_graphs").length;
  assert.equal(reviews, 2);
  assert.ok(report.scoreAfter > report.scoreBefore, `score should improve: ${report.scoreBefore} -> ${report.scoreAfter}`);
});

test("dryRun changes nothing and says what it would do", async () => {
  const bridge = fakeBridge();
  const report = await cleanupBlueprint(bridge, "/Game/BP_Messy.BP_Messy", { dryRun: true });

  assert.equal(bridge.calls.filter((c) => c.cmd === "remove_node").length, 0);
  assert.equal(bridge.calls.filter((c) => c.cmd === "organize_graph").length, 0);
  assert.equal(report.dryRun, true);
  assert.equal(report.deadNodesRemoved, 2, "it should report what it would remove");
  assert.match(report.nextAction, /nothing was changed/i);
});

test("opting out of dead-node removal moves it to the left-alone list", async () => {
  const bridge = fakeBridge();
  const report = await cleanupBlueprint(bridge, "/Game/BP_Messy.BP_Messy", { removeDeadNodes: false });

  assert.equal(report.deadNodesRemoved, 0);
  assert.equal(bridge.calls.filter((c) => c.cmd === "remove_node").length, 0);
  assert.ok(report.leftForYou.some((l) => l.check === "dead-node"));
});

test("one stubborn node does not abandon the rest of the cleanup", async () => {
  const bridge = fakeBridge({ failRemove: "dead1" });
  const report = await cleanupBlueprint(bridge, "/Game/BP_Messy.BP_Messy");

  assert.equal(report.deadNodesRemoved, 1);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0].error, /node_not_found/);
  // ...and layout still ran.
  assert.ok(bridge.calls.some((c) => c.cmd === "organize_graph"));
});

test("labelSections false skips layout entirely", async () => {
  const bridge = fakeBridge();
  const report = await cleanupBlueprint(bridge, "/Game/BP_Messy.BP_Messy", { labelSections: false });
  assert.equal(report.graphsLaidOut, 0);
  assert.equal(bridge.calls.filter((c) => c.cmd === "organize_graph").length, 0);
});

test("a clean Blueprint is left alone and reports nothing to do", async () => {
  const clean = {
    async send(cmd, params) {
      if (cmd === "list_blueprint_graphs") return { path: params.path, graphs: [{ name: "EventGraph", nodeCount: 2 }] };
      if (cmd === "read_blueprint_graph_summary") {
        return {
          path: params.path,
          graphName: params.graphName,
          nodes: [
            node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "s", "execute"]]),
            node("s", "K2Node_VariableSet", "Set Health", [["execute", "in", "ev", "then"]]),
            node("c", "EdGraphNode_Comment", "Event BeginPlay"),
          ],
        };
      }
      if (cmd === "organize_graph") return { ok: true };
      throw new Error(`unexpected ${cmd}`);
    },
  };
  const report = await cleanupBlueprint(clean, "/Game/BP_Clean.BP_Clean");
  assert.equal(report.deadNodesRemoved, 0);
  assert.deepEqual(report.leftForYou, []);
  assert.equal(report.scoreBefore, 100);
});
