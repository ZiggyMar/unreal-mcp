import { test } from "node:test";
import assert from "node:assert/strict";

import { findDeadGraphs, graphKey } from "../dist/systemLiveness.js";

const ev = (blueprint, graphName, titles) => ({
  blueprint,
  graphName,
  nodes: [{ type: "K2Node_Event", title: "Event BeginPlay" }, ...titles.map((t) => ({ type: "K2Node_CallFunction", title: t }))],
});
const fn = (blueprint, graphName, titles = []) => ({
  blueprint,
  graphName,
  nodes: titles.map((t) => ({ type: "K2Node_CallFunction", title: t })),
});

test("a function nothing calls is dead; one an event calls is not", () => {
  const r = findDeadGraphs([
    ev("BP_A", "EventGraph", ["DoTheThing"]),
    fn("BP_A", "DoTheThing"),
    fn("BP_A", "LeftOverFromTheOldWay"),
  ]);
  assert.ok(!r.dead.has(graphKey("BP_A", "DoTheThing")), "called by the event graph");
  assert.ok(r.dead.has(graphKey("BP_A", "LeftOverFromTheOldWay")), "called by nothing");
  assert.ok(!r.dead.has(graphKey("BP_A", "EventGraph")), "an event graph is never dead");
});

test("liveness carries through a chain, not just one hop", () => {
  // The whole reason this is a fixpoint rather than a single pass: a helper called only by another
  // helper is live, and a one-hop check would bury it with the genuinely abandoned ones.
  const r = findDeadGraphs([
    ev("BP_A", "EventGraph", ["First"]),
    fn("BP_A", "First", ["Second"]),
    fn("BP_A", "Second", ["Third"]),
    fn("BP_A", "Third"),
    fn("BP_A", "Orphan"),
  ]);
  for (const name of ["First", "Second", "Third"]) {
    assert.ok(!r.dead.has(graphKey("BP_A", name)), `${name} is reachable through the chain`);
  }
  assert.ok(r.dead.has(graphKey("BP_A", "Orphan")));
});

test("display titles with spaces still match the graph they call", () => {
  // Unreal renders a graph called SetInput on a node as "Set Input". Comparing raw strings would
  // call every function in the project dead, which is the failure mode that matters most here.
  const r = findDeadGraphs([ev("BP_A", "EventGraph", ["Set Input"]), fn("BP_A", "SetInput")]);
  assert.ok(!r.dead.has(graphKey("BP_A", "SetInput")));
});

test("a call from another Blueprint counts", () => {
  // A child calling a function on its parent is the ordinary case, and the display title carries no
  // owner, so names are matched across the project rather than within one asset.
  const r = findDeadGraphs([ev("PC_Child", "EventGraph", ["SetInput"]), fn("PC_Base", "SetInput")]);
  assert.ok(!r.dead.has(graphKey("PC_Base", "SetInput")));
});

test("engine-called graphs are never reported dead", () => {
  // Nothing in any Blueprint calls a construction script or an OnRep_, and reporting them as
  // abandoned would send somebody to delete replication callbacks.
  const r = findDeadGraphs([
    ev("BP_A", "EventGraph", []),
    fn("BP_A", "UserConstructionScript"),
    fn("BP_A", "OnRep_Health"),
  ]);
  assert.equal(r.dead.size, 0, `expected none dead, got ${[...r.dead].join(", ")}`);
});

test("it errs toward live, which is the direction that matters", () => {
  // Measured against the real project: where this disagreed with the bridge's own reachability it
  // called a dead graph LIVE, never the other way round. Reporting live code as dead would send
  // somebody to delete something that runs.
  const r = findDeadGraphs([
    ev("BP_A", "EventGraph", ["Maybe Called"]),
    fn("BP_B", "MaybeCalled"),
  ]);
  assert.equal(r.dead.size, 0, "an ambiguous name match resolves to live, not dead");
});
