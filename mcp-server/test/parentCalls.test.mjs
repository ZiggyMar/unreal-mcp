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

test("a child that reads what the parent sets is called a real bug, plainly", () => {
  // The BP_Player case, worked by hand on a real game: BP_BaseCharacter's BeginPlay is the only
  // place VacuumableComp is set, and BP_Player reads it and calls two functions on it. That is
  // decisive - the component is None on the player and those calls silently do nothing.
  const [finding] = findUncalledParentEvents({
    blueprint: "BP_Player",
    parentBlueprint: "BP_BaseCharacter",
    childChains: [{ entry: "Event BeginPlay", steps: ["Sequence", "Switch Has Authority"], nodeIds: [] }],
    childNodeTitles: ["Event BeginPlay", "Get VacuumableComp", "Parent: Tick"],
    parentChains: [{ entry: "Event BeginPlay", steps: ["Add Component by Class", "Set VacuumableComp"], nodeIds: [] }],
  });
  assert.ok(finding, "the finding must still fire");
  assert.match(finding.observed, /VacuumableComp/);
  assert.match(finding.observed, /real bug/i);
});

test("a child that reads none of it is flagged as possibly deliberate", () => {
  // The PC_Gameplay case: PC_Base's BeginPlay creates the root layout widget, and no child reads
  // MyRootLayout. Adding the parent call there could create a second widget, so the same check must
  // reach the opposite recommendation on the same shape of evidence.
  const [finding] = findUncalledParentEvents({
    blueprint: "PC_Gameplay",
    parentBlueprint: "PC_Base",
    childChains: [{ entry: "Event BeginPlay", steps: ["Delay", "SetupAudio"], nodeIds: [] }],
    childNodeTitles: ["Event BeginPlay", "Get SomethingElse"],
    parentChains: [{ entry: "Event BeginPlay", steps: ["Create Widget", "Set MyRootLayout"], nodeIds: [] }],
  });
  assert.ok(finding);
  assert.match(finding.observed, /may be deliberate/i);
  assert.match(finding.observed, /second one/i, "it must warn what 'fixing' it could do");
});

test("a parent that sets things nobody reads is not treated as a missing call", () => {
  // The real case this came from: PC_Lobby, PC_Gameplay and PC_MainMenu all skip PC_Base's
  // BeginPlay, and following the old advice would have been wrong in all three. What that chain
  // sets is MyRootLayout - written once, read by nothing across 181 Blueprints - and the function
  // that would consume it has one call site, itself dead. A replaced UI system, not a missing call.
  // Adding the parent call there does not fix a bug; it puts an unused widget back on screen.
  const findings = findUncalledParentEvents({
    blueprint: "PC_Gameplay",
    parentBlueprint: "PC_Base",
    childChains: [chain("Event BeginPlay", ["Delay", "Get ShopWidget"])],
    childNodeTitles: ["Event BeginPlay", "Delay", "Get ShopWidget"],
    parentChains: [chain("Event BeginPlay", ["Create Widget", "Set MyRootLayout", "Add to Viewport"])],
  });
  const finding = findings.find((f) => f.check === "parent-event-not-called");
  assert.ok(finding, "the check should still fire - it is a real observation, just not a real fix");
  assert.match(finding.fix, /Check before adding it/);
  assert.match(finding.fix, /unreal_trace_variable/);
  assert.doesNotMatch(finding.fix, /^unreal_add_node/, "it must not LEAD with the action it is unsure about");
});

test("a parent that sets nothing is safe to inherit, and the fix says so", () => {
  // The other half of the same split, and the one a test in this file caught me getting wrong.
  // "Nothing reads what the parent sets" is vacuously true when the parent sets NOTHING - a chain
  // that clears a timer or registers input has no state to duplicate, and cleanup is the one thing
  // you always want to inherit.
  const findings = findUncalledParentEvents({
    blueprint: "BP_Child",
    parentBlueprint: "BP_Parent",
    childChains: [chain("Event EndPlay", ["Print String"])],
    childNodeTitles: ["Event EndPlay", "Print String"],
    parentChains: [chain("Event EndPlay", ["Clear and Invalidate Timer by Handle"])],
  });
  const finding = findings.find((f) => f.check === "parent-event-not-called");
  assert.ok(finding);
  assert.match(finding.fix, /^unreal_add_node/, "with no state to duplicate, the action leads");
  assert.match(finding.observed, /sets no variables at all/);
});
