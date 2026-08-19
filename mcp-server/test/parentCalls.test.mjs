import { test } from "node:test";
import assert from "node:assert/strict";

import { findUncalledParentEvents } from "../dist/parentCalls.js";

const chain = (entry, steps) => ({ entry, steps, nodeIds: steps.map((_, i) => `${entry}-${i}`) });

/** The real one, reduced. */
const vacuumCase = (childTitles) => ({
  blueprint: "BP_Player",
  parentBlueprint: "BP_BaseCharacter",
  childChains: [chain("Event BeginPlay", ["Sequence", "Switch Has Authority", "SetMoveSpeed"])],
  childNodeTitles: childTitles,
  parentChains: [chain("Event BeginPlay", ["Add Component by Class", "Set VacuumableComp"])],
});

test("an overridden BeginPlay with no Parent call is reported, with what it skips", () => {
  // VacuumableComp was null on every player on every machine, and the log filled with "Accessed
  // None" 54 times a session. Nothing about the child's graph looked wrong.
  const found = findUncalledParentEvents(vacuumCase(["Event BeginPlay", "Sequence", "SetMoveSpeed"]));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /never calls Parent: BeginPlay/);
  // Naming what is skipped is the point: it is the sentence a human needs to judge the override.
  assert.match(found[0].message, /Add Component by Class -> Set VacuumableComp/);
});

test("a child that does call the parent is left alone", () => {
  const found = findUncalledParentEvents(vacuumCase(["Event BeginPlay", "Parent: BeginPlay", "SetMoveSpeed"]));
  assert.deepEqual(found, []);
});

test("the parent call counts wherever it sits, not only in the same chain", () => {
  // A child may route the parent call through a Sequence pin or another branch entirely.
  const found = findUncalledParentEvents({
    ...vacuumCase(["Event BeginPlay", "Parent: BeginPlay"]),
    childChains: [chain("Event BeginPlay", ["Sequence"])],
  });
  assert.deepEqual(found, []);
});

test("a parent that does nothing worth keeping is not a reason to send anybody anywhere", () => {
  const found = findUncalledParentEvents({
    blueprint: "BP_Child",
    parentBlueprint: "BP_Parent",
    childChains: [chain("Event BeginPlay", ["Do The Thing"])],
    childNodeTitles: ["Event BeginPlay"],
    parentChains: [chain("Event BeginPlay", ["Print String"])],
  });
  assert.deepEqual(found, []);
});

test("a parent with no implementation of that event is not a finding", () => {
  const found = findUncalledParentEvents({
    blueprint: "BP_Child",
    parentBlueprint: "BP_Parent",
    childChains: [chain("Event BeginPlay", ["Do The Thing"])],
    childNodeTitles: ["Event BeginPlay"],
    parentChains: [],
  });
  assert.deepEqual(found, []);
});

test("only the events where losing the parent's work is silent and expensive", () => {
  // Every input event and custom event in the project overriding something would be noise.
  const found = findUncalledParentEvents({
    blueprint: "BP_Child",
    parentBlueprint: "BP_Parent",
    childChains: [chain("Event AnyDamage", ["Set Health"])],
    childNodeTitles: ["Event AnyDamage"],
    parentChains: [chain("Event AnyDamage", ["Set Health", "Update HUD"])],
  });
  assert.deepEqual(found, []);
});

test("EndPlay counts too, because cleanup that never runs leaks quietly", () => {
  const found = findUncalledParentEvents({
    blueprint: "BP_Child",
    parentBlueprint: "BP_Parent",
    childChains: [chain("Event EndPlay", ["Save Stats"])],
    childNodeTitles: ["Event EndPlay"],
    parentChains: [chain("Event EndPlay", ["Clear and Invalidate Timer by Handle"])],
  });
  assert.equal(found.length, 1);
  assert.match(found[0].fix, /Add call to parent function/);
});
