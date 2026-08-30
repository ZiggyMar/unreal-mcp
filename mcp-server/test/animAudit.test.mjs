import { test } from "node:test";
import assert from "node:assert/strict";

import { findAnimStateMachineFaults } from "../dist/animAudit.js";

/** The shape unreal_read_anim_blueprint returns. */
const machine = (name, states) => ({ stateMachines: [{ stateMachine: name, states }] });

test("a state with no way out is reported", () => {
  // Reads to a player as the character freezing in one pose. The machine looks finished in the
  // editor because the state IS wired - just not outward - so nothing warns.
  const findings = findAnimStateMachineFaults(
    machine("Locomotion", [
      { state: "Idle", transitions: [{ to: "Death", rule: "Get IsDead" }] },
      { state: "Death", transitions: "none - nothing leaves this state" },
    ]),
    "ABP_Enemy"
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "anim-state-no-exit");
  assert.match(findings[0].message, /Death/);
  assert.match(findings[0].message, /never leaves/i);
});

test("a single-state machine is left alone, because that is an ordinary looping pose", () => {
  // The check must not fire on every idle-only machine in a project, or it fires on all of them and
  // is ignored on all of them.
  const findings = findAnimStateMachineFaults(
    machine("Idle", [{ state: "Idle", transitions: "none - nothing leaves this state" }]),
    "ABP_Prop"
  );
  assert.deepEqual(findings, []);
});

test("a transition with an empty rule is reported as unreachable", () => {
  const findings = findAnimStateMachineFaults(
    machine("Locomotion", [
      { state: "Idle", transitions: [{ to: "Run", rule: "empty - this transition can never fire" }] },
      { state: "Run", transitions: [{ to: "Idle", rule: "NOT Get Moving" }] },
    ]),
    "ABP_Player"
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "anim-transition-never-fires");
  assert.match(findings[0].message, /Idle" -> "Run/);
});

test("a real rule is never mistaken for an empty one", () => {
  // "empty" has to be anchored: a condition mentioning an "IsEmpty" node is a working rule.
  const findings = findAnimStateMachineFaults(
    machine("Locomotion", [
      { state: "Idle", transitions: [{ to: "Run", rule: "NOT Boolean IsEmpty Get Inventory" }] },
      { state: "Run", transitions: [{ to: "Idle", rule: "Get Stopped" }] },
    ]),
    "ABP_Player"
  );
  assert.deepEqual(findings, []);
});

test("an Anim Blueprint with no state machines produces nothing", () => {
  // Blending poses directly from variables is normal, not a fault.
  assert.deepEqual(findAnimStateMachineFaults({ stateMachines: [] }, "ABP_Blend"), []);
  assert.deepEqual(findAnimStateMachineFaults({}, "ABP_Blend"), []);
});

test("every finding says what to do, not just what is wrong", () => {
  const findings = findAnimStateMachineFaults(
    machine("Locomotion", [
      { state: "A", transitions: "none - nothing leaves this state" },
      { state: "B", transitions: [{ to: "A", rule: "empty - this transition can never fire" }] },
    ]),
    "ABP_X"
  );
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.ok(finding.fix.length > 40, `a fix that does not say what to do is not a fix: ${finding.fix}`);
  }
});
