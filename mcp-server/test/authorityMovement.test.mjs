import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewGraph } from "../dist/quality.js";

// The rubber-banding check, built from the shape that actually caused it.
//
// BP_BaseCharacter's DraggedByVacuum applied Add Force to the CharacterMovementComponent behind a
// Has Authority gate. CharacterMovement is client-predicted and server-corrected, so a force only
// the server applies is a disagreement by construction: the client never predicts it, the server
// insists on it, and the correction is what the player sees.
//
// It survived testing because a listen-server host never sees it - the host IS the authority.

/** A node in the shape the graph reader returns. */
const node = (id, type, title, pins = []) => ({ id, type, title, connectedPins: pins });
const exec = (to) => ({ pin: "then", direction: "out", linkedTo: to.map((n) => ({ node: n, pin: "execute" })) });
const cond = (from) => ({ pin: "Condition", direction: "in", linkedTo: [{ node: from, pin: "ReturnValue" }] });

test("a character force behind Has Authority is reported", () => {
  const report = reviewGraph("EventGraph", [
    node("ev01", "K2Node_Event", "Event Tick", [exec(["br01"])]),
    node("auth1", "K2Node_CallFunction", "Has Authority\nTarget is Actor"),
    node("br01", "K2Node_IfThenElse", "Branch", [cond("auth1"), exec(["force"])]),
    node("force", "K2Node_CallFunction", "Add Force\nTarget is Character Movement Component"),
  ]);
  const hit = (report.findings ?? []).find((f) => f.check === "authority-gated-character-movement");
  assert.ok(hit, `expected the rubber-band finding, got: ${(report.findings ?? []).map((f) => f.check).join(", ")}`);
  assert.deepEqual(hit.nodeIds, ["force"]);
  assert.match(hit.fix, /Is Locally Controlled/);
  // The second half of the fix matters as much as the first: gating correctly while leaving the
  // inputs unreplicated makes the client compute a different force from stale defaults, which is
  // how the first attempt at this fix would have shipped the drag silently doing nothing.
  assert.match(hit.fix, /replicate every variable/i);
});

test("moving a plain actor from the server is not reported", () => {
  // Setting a replicated actor's location on the server is ordinary and correct. Only a Character's
  // predicted movement is the problem, so this must not fire on everything behind an authority gate.
  const report = reviewGraph("EventGraph", [
    node("ev01", "K2Node_Event", "Event BeginPlay", [exec(["br01"])]),
    node("auth1", "K2Node_CallFunction", "Has Authority\nTarget is Actor"),
    node("br01", "K2Node_IfThenElse", "Branch", [cond("auth1"), exec(["move"])]),
    node("move", "K2Node_CallFunction", "Set Actor Location\nTarget is Actor"),
  ]);
  assert.equal((report.findings ?? []).find((f) => f.check === "authority-gated-character-movement"), undefined);
});

test("a character force NOT behind an authority gate is not reported", () => {
  // The fixed shape. Once the gate is Is Locally Controlled the finding has to go away, or it
  // becomes noise on the very graphs someone just corrected.
  const report = reviewGraph("EventGraph", [
    node("ev01", "K2Node_Event", "Event Tick", [exec(["br01"])]),
    node("local", "K2Node_CallFunction", "Is Locally Controlled\nTarget is Pawn"),
    node("br01", "K2Node_IfThenElse", "Branch", [cond("local"), exec(["force"])]),
    node("force", "K2Node_CallFunction", "Add Force\nTarget is Character Movement Component"),
  ]);
  assert.equal((report.findings ?? []).find((f) => f.check === "authority-gated-character-movement"), undefined);
});

test("the client arm of an authority branch is not reported", () => {
  // `else` is the client path, which is exactly where this movement belongs. Flagging it would tell
  // someone to undo the correct fix.
  const report = reviewGraph("EventGraph", [
    node("ev01", "K2Node_Event", "Event Tick", [exec(["br01"])]),
    node("auth1", "K2Node_CallFunction", "Has Authority\nTarget is Actor"),
    node("br01", "K2Node_IfThenElse", "Branch", [
      cond("auth1"),
      { pin: "else", direction: "out", linkedTo: [{ node: "force", pin: "execute" }] },
    ]),
    node("force", "K2Node_CallFunction", "Add Force\nTarget is Character Movement Component"),
  ]);
  assert.equal((report.findings ?? []).find((f) => f.check === "authority-gated-character-movement"), undefined);
});
