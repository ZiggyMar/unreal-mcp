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

test("a delete that deleted nothing is not counted as cleaned up", async () => {
  // delete_asset answers {requested: 1, deleted: 0} as a SUCCESS response when the engine refuses,
  // so a cleanup block that only catches exceptions counts that as done. Seven BP_TrialParent*
  // Blueprints accumulated in /Game/MCPTrial that way, over seven runs that each printed
  // "cleaned up 2 assets", until an unrelated script crashed reading one of them.
  const { cleanUpScratch } = await import("../scripts/lib/scratch.mjs");
  const said = [];
  const log = (line) => said.push(line);

  assert.equal(await cleanUpScratch(["/Game/MCPTrial/A"], async () => ({ requested: 1, deleted: 1 }), log), true);
  assert.equal(
    await cleanUpScratch(["/Game/MCPTrial/A"], async () => ({ requested: 1, deleted: 0 }), log),
    false,
    "a delete that removed nothing is a failure however calmly it reported itself"
  );
  assert.ok(said.some((line) => /left behind/.test(line)), "and it is said out loud");
});

test("a reply without the counts is left alone rather than assumed broken", async () => {
  // Only an explicit report of deleting nothing counts. Treating an unrecognised shape as a failure
  // would turn every future change to the reply into a wall of false alarms.
  const { cleanUpScratch } = await import("../scripts/lib/scratch.mjs");
  assert.equal(await cleanUpScratch(["/Game/MCPTrial/A"], async () => ({ ok: true }), () => {}), true);
  assert.equal(await cleanUpScratch(["/Game/MCPTrial/A"], async () => undefined, () => {}), true);
});

test("the sweep only ever touches the scratch namespace", async () => {
  // It runs at the start of a trial against the real project. A path outside /Game/MCPTrial must
  // never reach the remove callback, whatever the listing hands back.
  const { sweepScratch } = await import("../scripts/lib/scratch.mjs");
  const removed = [];
  await sweepScratch({
    list: async () => ["/Game/MCPTrial/Mine", "/Game/AntiVirusSquad/_Core/BP_Player", "/Game/MCPTrialish/NotMine"],
    remove: async (path) => {
      removed.push(path);
      return { requested: 1, deleted: 1 };
    },
    log: () => {},
  });
  // /Game/MCPTrialish is the case worth having: it starts with the scratch root as a STRING and is
  // a different folder. The first version of this test asserted it WOULD be swept, which is how a
  // test ends up encoding the bug it was written to prevent - and this one runs force:true against
  // the real project.
  assert.deepEqual(removed, ["/Game/MCPTrial/Mine"]);
  assert.ok(!removed.includes("/Game/AntiVirusSquad/_Core/BP_Player"), "a real asset is never swept");
  assert.ok(!removed.includes("/Game/MCPTrialish/NotMine"), "and neither is a folder that merely starts with the same letters");
});

test("a listing that fails does not stop the trial, but does say so", async () => {
  const { sweepScratch } = await import("../scripts/lib/scratch.mjs");
  const said = [];
  const result = await sweepScratch({
    list: async () => {
      throw new Error("bridge not answering");
    },
    remove: async () => {},
    log: (line) => said.push(line),
  });
  assert.deepEqual(result, { found: 0, removed: 0, failed: [] });
  assert.ok(said.some((line) => /could not check/.test(line)), "starting on an unknown state is stated, not assumed");
});

test("the whole family is deleted in one call, because one at a time cannot", async () => {
  // This is why the trials leaked, bisected against the editor rather than guessed:
  //
  //   parent alone, saved                                    deletes
  //   parent + graph + compile, no child                     deletes
  //   parent + saved child, NO graphs                        deletes
  //   parent + saved child, graphs on both  -> child deletes, PARENT REFUSES
  //   the same pair in one paths[] call     -> both delete
  //
  // Deleting the child first leaves the parent holding a reference nothing in the session releases.
  // The bridge said so all along - paths[] exists because "its members reference each other, and
  // force-delete breaks those intra-set links" - the cleanup just never used it.
  const { cleanUpScratch } = await import("../scripts/lib/scratch.mjs");
  const singles = [];
  const batches = [];
  const ok = await cleanUpScratch(
    ["/Game/MCPTrial/Parent", "/Game/MCPTrial/Child"],
    async (p) => {
      singles.push(p);
      return { requested: 1, deleted: 1 };
    },
    () => {},
    async (paths) => {
      batches.push(paths);
      return { requested: paths.length, deleted: paths.length };
    }
  );
  assert.equal(ok, true);
  assert.deepEqual(batches, [["/Game/MCPTrial/Parent", "/Game/MCPTrial/Child"]], "one call for the set");
  assert.deepEqual(singles, [], "and no per-asset calls at all");
});

test("a batch that removes nothing falls back rather than reporting success", async () => {
  // The failure this whole thread began with: delete_asset answers {requested: n, deleted: 0}
  // WITHOUT raising. A batch path that trusted the absence of an exception would reintroduce exactly
  // the silent leak it was written to stop.
  const { cleanUpScratch } = await import("../scripts/lib/scratch.mjs");
  const singles = [];
  const said = [];
  const ok = await cleanUpScratch(
    ["/Game/MCPTrial/A", "/Game/MCPTrial/B"],
    async (p) => {
      singles.push(p);
      return { requested: 1, deleted: 0 };
    },
    (line) => said.push(line),
    async () => ({ requested: 2, deleted: 0 })
  );
  assert.equal(ok, false, "nothing was deleted, so this is not success");
  assert.deepEqual(singles, ["/Game/MCPTrial/B", "/Game/MCPTrial/A"], "it fell back, child-first");
  assert.ok(said.some((l) => /falling back/.test(l)), "and said so");
});

test("a caller with no batch remover still works", async () => {
  // Not every caller can delete a set. The single-path path has to keep its honest reporting.
  const { cleanUpScratch } = await import("../scripts/lib/scratch.mjs");
  const removed = [];
  const ok = await cleanUpScratch(
    ["/Game/MCPTrial/Only"],
    async (p) => {
      removed.push(p);
      return { requested: 1, deleted: 1 };
    },
    () => {}
  );
  assert.equal(ok, true);
  assert.deepEqual(removed, ["/Game/MCPTrial/Only"]);
});

test("one asset does not need a batch call", async () => {
  const { cleanUpScratch } = await import("../scripts/lib/scratch.mjs");
  let batched = false;
  await cleanUpScratch(
    ["/Game/MCPTrial/Solo"],
    async () => ({ requested: 1, deleted: 1 }),
    () => {},
    async () => {
      batched = true;
      return { requested: 1, deleted: 1 };
    }
  );
  assert.equal(batched, false, "a single path is a single call either way");
});
