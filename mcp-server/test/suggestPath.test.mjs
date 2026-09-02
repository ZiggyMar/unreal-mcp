import { test } from "node:test";
import assert from "node:assert/strict";

import { leafName, notFoundPath, rankCandidates, suggestionLine } from "../dist/suggestPath.js";

const c = (name, path) => ({ name, path });

const PROJECT = [
  c("BP_Player", "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player"),
  c("WBP_PlayerDeath", "/Game/AntiVirusSquad/_Core/Widgets/InGame/Death/WBP_PlayerDeath"),
  c("WBP_PlayerInfo", "/Game/AntiVirusSquad/_Core/Widgets/InGame/HUD/Info/Players/WBP_PlayerInfo"),
  c("ABP_Player", "/Game/AntiVirusSquad/Characters/Players/Animations/ABP_Player"),
  c("BP_FireWall", "/Game/AntiVirusSquad/_Core/Interactables/BP_FireWall"),
];

test("the name is right and the folders are wrong - the common real case", () => {
  // Both of these were guessed while doing ordinary work on this project, minutes apart. The name
  // was correct every time; only the folders were invented.
  const missing = notFoundPath(
    "UnrealMCPBridge error: blueprint_not_found: /Game/Blueprints/Characters/BP_Player.BP_Player. Either it does not exist"
  );
  assert.equal(missing, "/Game/Blueprints/Characters/BP_Player.BP_Player");
  const hits = rankCandidates(leafName(missing), PROJECT);
  assert.deepEqual(hits, ["/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player"]);
  assert.equal(suggestionLine(hits), "Did you mean `/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player`?");
});

test("the object suffix is stripped, because the bridge echoes it back even when you did not send it", () => {
  assert.equal(leafName("/Game/A/B/BP_Thing.BP_Thing"), "BP_Thing");
  assert.equal(leafName("/Game/A/B/BP_Thing"), "BP_Thing");
});

test("an exact name ends it - no substring garnish beside a hit", () => {
  // ABP_Player, WBP_PlayerDeath and WBP_PlayerInfo all CONTAIN "bp_player". Offering them next to
  // the real BP_Player would make the caller choose between four paths when only one is the answer,
  // and one of the wrong ones is an Animation Blueprint.
  const hits = rankCandidates("BP_Player", PROJECT);
  assert.deepEqual(hits, ["/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player"]);
  assert.match(suggestionLine(hits), /^Did you mean `/);
});

test("with no exact match, substrings are the fallback and several may be offered", () => {
  const hits = rankCandidates("Player", PROJECT);
  assert.ok(hits.length > 1, "several names contain Player and none of them IS Player");
  assert.match(suggestionLine(hits), /^Did you mean one of these\?/);
});

test("nothing plausible means nothing is said", () => {
  // The whole risk of this feature. A wrong "did you mean" lands on a caller who is already lost,
  // and carries more conviction than the error it replaced.
  assert.deepEqual(rankCandidates("BP_Inventory", PROJECT), []);
  assert.equal(suggestionLine([]), undefined);
});

test("a needle too short to mean anything matches nothing", () => {
  // "BP" is in four of the five names. Suggesting all of them is noise wearing the costume of help.
  assert.deepEqual(rankCandidates("BP", PROJECT), []);
});

test("errors that are not about a path are left alone", () => {
  assert.equal(notFoundPath("UnrealMCPBridge error: unknown_cmd: run_console_command"), undefined);
  assert.equal(
    notFoundPath("UnrealMCPBridge error: variable_not_found: Health. ownerClass is BP_Player"),
    undefined
  );
});

test("asset_not_found is handled too, not just blueprint_not_found", () => {
  assert.equal(
    notFoundPath("UnrealMCPBridge error: asset_not_found: /Game/Data/DT_Skins.DT_Skins"),
    "/Game/Data/DT_Skins.DT_Skins"
  );
});

test("a row without a path is skipped rather than crashing the lookup", () => {
  assert.deepEqual(rankCandidates("BP_Player", [{ name: "BP_Player" }, ...PROJECT]).slice(0, 1), [
    "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player",
  ]);
});

test("a graph_not_found names the graph it could not find", async () => {
  const { notFoundGraph } = await import("../dist/suggestPath.js");
  assert.equal(
    notFoundGraph("UnrealMCPBridge error: graph_not_found: EventGrph. This Blueprint has 58 graphs, including: AddData"),
    "EventGrph"
  );
  assert.equal(notFoundGraph("UnrealMCPBridge error: blueprint_not_found: /Game/X"), undefined);
});

test("an empty name suggests nothing, rather than everything", () => {
  // Mutation testing said removing the `want.length === 0` early return changes nothing, and it was
  // right - the substring arm below requires `want.length >= 3`, so an empty needle can never reach
  // it. The early return is a redundant fast path, not a load-bearing guard.
  //
  // The first reading of that result was the opposite: "nothing catches this, so the guard is
  // unwatched". Worth recording, because a surviving mutant means one of two things - a missing test,
  // or code that does not matter - and they are easy to confuse. Checking what the mutant actually
  // RETURNED settled it in one call.
  //
  // The behaviour is still worth pinning, which is why this stays. A substring search for "" is true
  // of every candidate, so if the `>= 3` rule were ever relaxed, an empty or missing name would
  // produce a confident "did you mean" list of unrelated assets - the worst answer to "I do not know
  // what you meant", because it looks like knowledge. This test does not care WHICH line prevents
  // that; it cares that something does.
  assert.deepEqual(rankCandidates("", [{ path: "/Game/A/BP_One" }, { path: "/Game/B/BP_Two" }]), []);
  assert.deepEqual(rankCandidates("   ".trim(), [{ path: "/Game/A/BP_One" }]), []);
});
