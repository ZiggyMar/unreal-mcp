import { test } from "node:test";
import assert from "node:assert/strict";

import { score, rankSuggestions, notFoundSubject, rankContextSuggestions } from "../dist/didYouMean.js";

const fn = (functionName, className) => ({ functionName, className });

// Exactly what a live editor answered, copied from the reply rather than imagined.
const SPAWN_ACTOR = [
  fn("Spawn", "/Game/ThirdParty/SuperGrid/TutorialLevel/Blueprints/LevelElements/BP_Conveyor.BP_Conveyor_C"),
  fn("Spawn", "/Script/UMG.Viewport"),
  fn("SpawnActorFromClass", "/Script/EditorScriptingUtilities.EditorLevelLibrary"),
  fn("SpawnActorFromClass", "/Script/UnrealEd.EditorActorSubsystem"),
  fn("SpawnActorFromObject", "/Script/EditorScriptingUtilities.EditorLevelLibrary"),
];

test("the right answer stops being ranked third", () => {
  const ranked = rankSuggestions("SpawnActor", SPAWN_ACTOR);
  assert.equal(ranked[0].functionName, "SpawnActorFromClass");
  // The two bare "Spawn" entries are five characters of a ten-character query and are not near
  // misses; one of them is a tutorial conveyor in ThirdParty content.
  assert.ok(!ranked.some((r) => r.functionName === "Spawn"), "bare Spawn should be gone");
});

test("a tie keeps the engine's own order rather than an order invented here", () => {
  const ranked = rankSuggestions("SpawnActor", SPAWN_ACTOR);
  const both = ranked.filter((r) => r.functionName === "SpawnActorFromClass");
  assert.equal(both.length, 2);
  assert.match(both[0].className, /EditorLevelLibrary/);
  assert.match(both[1].className, /EditorActorSubsystem/);
});

test("five characters out of twenty-six is not a near miss", () => {
  // The live answer for this was `Apply` from VariantManagerBlueprintLibrary.
  const ranked = rankSuggestions("ApplyRootMotionRadialForce", [fn("Apply", "/Script/VariantManager.VariantManagerBlueprintLibrary")]);
  assert.deepEqual(ranked, []);
});

test("a candidate containing the query beats one that merely starts the same", () => {
  assert.ok(score("SpawnActor", "SpawnActorFromClass") > score("SpawnActor", "SpawnSomethingElse"));
});

test("among containing candidates the shortest wins", () => {
  assert.ok(score("Spawn", "SpawnActor") > score("Spawn", "SpawnActorFromClassDeferred"));
});

test("an exact match outranks everything", () => {
  assert.ok(score("PrintString", "PrintString") > score("PrintString", "PrintStringWithCategory"));
});

test("a caller who typed more than the real name still gets it, if it is most of the query", () => {
  // "GetPlayerControllerX" -> "GetPlayerController" is 19 of 20 characters.
  assert.notEqual(score("GetPlayerControllerX", "GetPlayerController"), null);
  assert.equal(score("GetActorLocationInWorldSpaceNow", "Get"), null);
});

test("the subject is pulled out of any not-found error", () => {
  assert.equal(notFoundSubject("node_signature_not_found: SpawnActor {\"didYouMean\":[]}"), "SpawnActor");
  assert.equal(notFoundSubject("class_not_found: UMyThing"), "UMyThing");
  assert.equal(notFoundSubject("unknown_type: FVector"), undefined);
});

test("an emptied list is removed, not left as an empty array", () => {
  // `"didYouMean":[]` still costs tokens and still invites the reader to look for an answer that is
  // not there.
  const out = rankContextSuggestions("node_signature_not_found: ApplyRootMotionRadialForce", {
    didYouMean: [fn("Apply", "/Script/VariantManager.VariantManagerBlueprintLibrary")],
  });
  assert.equal("didYouMean" in out, false);
});

test("context without suggestions is passed through untouched", () => {
  const ctx = { availablePins: ["execute", "then"] };
  assert.equal(rankContextSuggestions("pin_not_found: Exec", ctx), ctx);
});

test("an error with no name to rank against is left alone", () => {
  const ctx = { didYouMean: [fn("Spawn", "/Script/UMG.Viewport")] };
  assert.equal(rankContextSuggestions("something_went_wrong", ctx), ctx);
});

test("a suggestion entry with no function name is skipped rather than crashing", () => {
  const ranked = rankSuggestions("SpawnActor", [{ className: "/Script/Engine" }, ...SPAWN_ACTOR]);
  assert.equal(ranked[0].functionName, "SpawnActorFromClass");
});

test("plain names rank the same way, for lists the bridge prints as prose", async () => {
  const { rankNames } = await import("../dist/didYouMean.js");
  // The real case: a wrong graph name printed twelve of fifty-eight graphs alphabetically and cut
  // off one entry before EventGraph, which was obviously what was meant.
  const graphs = ["AddData", "CameraLineTrace", "CanAim", "CanShoot", "EndVacuumObjects", "EventGraph"];
  assert.deepEqual(rankNames("EventGrph", graphs), ["EventGraph"]);
  assert.deepEqual(rankNames("CanShot", graphs), ["CanShoot"]);
  assert.deepEqual(rankNames("Nonsense", graphs), []);
});
