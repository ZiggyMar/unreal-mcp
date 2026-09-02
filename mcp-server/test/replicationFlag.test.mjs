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

test("a child is told to fix itself, because the parent's fix does not reach it", () => {
  // This test used to assert the opposite, and the assertion was wrong.
  //
  // It said: "Fixing BP_PlaceableBase fixes BP_Turret with it. Telling somebody to tick the box on
  // both is telling them to do it twice." That was never measured, and it is false. On the real
  // project this check was written against, BP_PlaceableBase was set to replicate and saved, and
  // BP_Turret and BP_DummyTurret - both direct children - still read `replicates: false`
  // afterwards. They still did after the parent was recompiled. A child Blueprint's CDO holds its
  // own serialized copy of the flag from the moment it was created and does not track the parent.
  // All three had to be set individually before the check stopped firing.
  //
  // The old advice sent a caller to fix one asset, told them the other two were already handled,
  // and left the bug in place under a note saying it was done. A fix line that produces a confident
  // wrong report is worse than no fix line at all, and this test was holding it in place.
  const [, turret] = findReplicationFlagFaults(PROJECT);
  assert.equal(turret.blueprint, "BP_Turret");
  assert.match(turret.observed, /BP_PlaceableBase has the same problem/);
  assert.match(turret.fix, /EVERY class here that reports this/);
  assert.doesNotMatch(turret.fix, /rather than this/);
});

test("the parent gets the same instruction, not a different one", () => {
  // Both ends of the chain have to be ticked, so both are told the same thing. Giving them
  // different advice is what made "fix the parent instead" look reasonable in the first place.
  const [base] = findReplicationFlagFaults(PROJECT);
  assert.equal(base.blueprint, "BP_PlaceableBase");
  assert.match(base.fix, /Tick "Replicates"/);
  assert.match(base.fix, /EVERY class here that reports this/);
});

test("unknown replication is not treated as false", () => {
  // A bridge that cannot report the flag must not produce a finding out of the absence.
  assert.deepEqual(
    findReplicationFlagFaults([{ name: "BP_Unknown", replicatedVariables: ["x"] }]),
    []
  );
});
