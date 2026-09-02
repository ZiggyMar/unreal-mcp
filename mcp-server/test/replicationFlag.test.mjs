import { test } from "node:test";
import assert from "node:assert/strict";

import { findReplicationFlagFaults } from "../dist/replicationFlag.js";

// Exactly what a real project reported, controls included.
const PROJECT = [
  { name: "BP_PlaceableBase", parentClass: "Actor", replicates: false, replicatedVariables: ["a", "b", "c", "d"] },
  { name: "BP_Turret", parentClass: "BP_PlaceableBase_C", replicates: false, replicatedVariables: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
  { name: "BP_Player", parentClass: "BP_BaseCharacter_C", replicates: true, replicatedVariables: ["h1", "h2"] },
  { name: "BP_FireWall", parentClass: "Actor", replicates: true, replicatedVariables: ["r1"] },
  { name: "BP_Prop", parentClass: "Actor", replicates: false, replicatedVariables: [] },
];

test("both offenders are reported and neither control is", () => {
  const found = findReplicationFlagFaults(PROJECT);
  assert.deepEqual(found.map((f) => f.blueprint), ["BP_PlaceableBase", "BP_Turret"]);
});

test("a replicating Actor with replicated variables is exactly right", () => {
  // BP_FireWall's parent is a plain Actor and it replicates, so this is not flagging everything
  // descended from Actor.
  const found = findReplicationFlagFaults([PROJECT[3]]);
  assert.deepEqual(found, []);
});

test("an Actor with no replicated variables is not the subject of this check", () => {
  assert.deepEqual(findReplicationFlagFaults([PROJECT[4]]), []);
});

test("an inherited flag is blamed on the parent that owns it", () => {
  // Fixing BP_PlaceableBase fixes BP_Turret with it. Telling somebody to tick the box on both is
  // telling them to do it twice.
  const [, turret] = findReplicationFlagFaults(PROJECT);
  assert.equal(turret.blueprint, "BP_Turret");
  assert.match(turret.observed, /inherited from BP_PlaceableBase/);
  assert.match(turret.fix, /Fix BP_PlaceableBase rather than this/);
});

test("the root offender is told to fix itself", () => {
  const [base] = findReplicationFlagFaults(PROJECT);
  assert.equal(base.blueprint, "BP_PlaceableBase");
  assert.doesNotMatch(base.fix, /rather than this/);
  assert.match(base.fix, /Tick "Replicates"/);
});

test("unknown replication is not treated as false", () => {
  // A bridge that cannot report the flag must not produce a finding out of the absence.
  assert.deepEqual(
    findReplicationFlagFaults([{ name: "BP_Unknown", replicatedVariables: ["x"] }]),
    []
  );
});
