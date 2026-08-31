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

test("an animation Blueprint's graphs are never reported dead", () => {
  // Its graphs are EVALUATED by the animation system, not called by a node: AnimGraph itself, one
  // per state, one per transition rule. Measured on the real project, ABP_NewPlayer alone
  // contributed 25 of 219 - Locomotion, Idle, Jump and eighteen graphs all named Transition - and
  // every one was wrong. Detected by the presence of an AnimGraph rather than by parentClass,
  // because the parent is usually the project's own C++ anim instance.
  const r = findDeadGraphs([
    { blueprint: "ABP_Hero", graphName: "AnimGraph", nodes: [], parentClass: "AVSAnimInstance" },
    { blueprint: "ABP_Hero", graphName: "Locomotion", nodes: [], parentClass: "AVSAnimInstance" },
    { blueprint: "ABP_Hero", graphName: "Transition", nodes: [], parentClass: "AVSAnimInstance" },
    { blueprint: "BP_Other", graphName: "EventGraph", nodes: [{ type: "K2Node_Event", title: "Event BeginPlay" }] },
    { blueprint: "BP_Other", graphName: "ReallyUncalled", nodes: [] },
  ]);
  assert.equal([...r.dead].filter((k) => k.startsWith("ABP_Hero")).length, 0, "no anim graph is reported");
  assert.ok(r.dead.has(graphKey("BP_Other", "ReallyUncalled")), "ordinary Blueprints are unaffected");
});

test("dead graphs are grouped by Blueprint, worst proportion first", () => {
  // The useful unit is the Blueprint, not the graph. A ratio also carries its own confidence: one
  // uncalled helper in forty is housekeeping, and most of a Blueprint being uncalled is a system
  // that was replaced. Sorting on the raw count would put the big Blueprints on top instead.
  const graphs = [
    { blueprint: "BP_Big", graphName: "EventGraph", nodes: [{ type: "K2Node_Event", title: "Event BeginPlay" }] },
    ...Array.from({ length: 20 }, (_, i) => ({ blueprint: "BP_Big", graphName: `Used${i}`, nodes: [] })),
    { blueprint: "BP_Big", graphName: "StrayOne", nodes: [] },
    { blueprint: "BP_Big", graphName: "StrayTwo", nodes: [] },
    { blueprint: "BP_Replaced", graphName: "OldA", nodes: [] },
    { blueprint: "BP_Replaced", graphName: "OldB", nodes: [] },
    { blueprint: "BP_Replaced", graphName: "OldC", nodes: [] },
  ];
  // Make BP_Big's twenty Used* graphs genuinely reachable.
  graphs[0].nodes.push(...Array.from({ length: 20 }, (_, i) => ({ type: "K2Node_CallFunction", title: `Used${i}` })));

  const r = findDeadGraphs(graphs);
  // BP_Replaced is 3 of 3, but three graphs is not enough for a proportion to mean anything: on the
  // real project that ranking put Lyra sample widgets ("3 of 4") above the game's own GameState.
  assert.ok(!r.byBlueprint.some((b) => b.blueprint === "BP_Replaced"), "too small to rank");
  const big = r.byBlueprint.find((b) => b.blueprint === "BP_Big");
  assert.equal(big.dead, 2);
  assert.equal(big.of, 23);
});

test("an interface's function is never reported dead in its implementers", () => {
  // An implementation lives in the implementing Blueprint and is invoked by interface dispatch, so
  // no node calls it by name and every implementation of every interface looked abandoned.
  // Measured: EnemyScalePriority flagged in five gameplay Blueprints at once, declared by an
  // interface in all five.
  const r = findDeadGraphs([
    { blueprint: "BPI_Thing", graphName: "EnemyScalePriority", nodes: [], parentClass: "Interface" },
    { blueprint: "BP_A", graphName: "EventGraph", nodes: [{ type: "K2Node_Event", title: "Event BeginPlay" }] },
    { blueprint: "BP_A", graphName: "EnemyScalePriority", nodes: [] },
    { blueprint: "BP_B", graphName: "EnemyScalePriority", nodes: [] },
    { blueprint: "BP_B", graphName: "GenuinelyUncalled", nodes: [] },
  ]);
  assert.ok(!r.dead.has(graphKey("BP_A", "EnemyScalePriority")), "an interface implementation is not abandoned");
  assert.ok(!r.dead.has(graphKey("BP_B", "EnemyScalePriority")));
  assert.ok(r.dead.has(graphKey("BP_B", "GenuinelyUncalled")), "ordinary functions are still checked");
});
