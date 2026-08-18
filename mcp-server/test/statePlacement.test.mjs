import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewStatePlacement } from "../dist/statePlacement.js";

test("a score on a Character is flagged, and the fix names where it goes", () => {
  // The bug this exists for: a pawn is destroyed on death and respawn, so this reads as correct
  // until somebody dies, weeks after it was written.
  const findings = reviewStatePlacement("Character", [{ name: "Score", type: "int" }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "state-outlives-owner");
  assert.match(findings[0].fix, /PlayerState/);
  assert.match(findings[0].message, /destroyed and recreated/);
});

test("the same variable on a PlayerState is not flagged", () => {
  // PlayerState is the right answer, so finding it there is not a finding.
  assert.deepEqual(reviewStatePlacement("PlayerState", [{ name: "Score", type: "int" }]), []);
});

test("progression points at the GameInstance, not the PlayerState", () => {
  const findings = reviewStatePlacement("Character", [{ name: "UnlockedLevels", type: "int" }]);
  assert.equal(findings.length, 1);
  assert.match(findings[0].fix, /GameInstance|SaveGame/);
});

test("health is deliberately NOT flagged", () => {
  // Health while alive genuinely belongs on the body. Flagging it would be the false positive that
  // teaches a caller to distrust every other finding, which quality.ts warns about explicitly.
  assert.deepEqual(reviewStatePlacement("Character", [{ name: "Health", type: "float" }]), []);
});

test("a name that merely contains a keyword is not flagged", () => {
  // "ScoreboardWidget" is a widget reference, not a score. Whole-word matching is what keeps this
  // check trustworthy.
  const findings = reviewStatePlacement("Character", [
    { name: "ScoreboardWidget", type: "object:UserWidget" },
    { name: "TeammateMeshes", type: "object:StaticMesh" },
  ]);
  assert.deepEqual(findings, []);
});

test("several misplaced variables are each reported", () => {
  const findings = reviewStatePlacement("MyPlayerCharacter", [
    { name: "Score", type: "int" },
    { name: "TeamIndex", type: "int" },
    { name: "Health", type: "float" },
  ]);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.variable).sort(), ["Score", "TeamIndex"]);
});

test("an Actor that is not a pawn is left alone", () => {
  // A scoreboard actor holding a score is not the bug this looks for; only owners that get
  // destroyed while the player keeps playing are.
  assert.deepEqual(reviewStatePlacement("Actor", [{ name: "Score", type: "int" }]), []);
});
