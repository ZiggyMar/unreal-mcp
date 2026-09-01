import { test } from "node:test";
import assert from "node:assert/strict";

import { summariseRuntimeLog, logFileFor } from "../dist/runtimeLog.js";

const line = (category, verbosity, message, frame = 100) =>
  `[2026.08.18-23.09.26:336][${frame}]${category}: ${verbosity}: ${message}`;

const accessedNone = (property, owner, node, graph, blueprint) =>
  `Blueprint Runtime Error: "Accessed None trying to read (real) property ${property} in ${owner}". ` +
  `Node:  ${node} Graph:  ${graph} Function:  Execute Ubergraph ${blueprint} Blueprint:  ${blueprint}`;

test("a Blueprint runtime error is returned as fields, not as text", () => {
  // The engine names the exact node. Handing that back as a sentence makes the caller parse it
  // again, and the whole value is that nobody has to go looking.
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line("PIE", "Error", accessedNone("VacuumableComp", "BP_BaseCharacter_C", "RemovePlayer", "EventGraph", "BP_Player")),
    ].join("\n")
  );
  assert.equal(result.issues.length, 1);
  const issue = result.issues[0];
  assert.equal(issue.blueprint, "BP_Player");
  assert.equal(issue.node, "RemovePlayer");
  assert.equal(issue.graph, "EventGraph");
  assert.equal(issue.property, "VacuumableComp");
  assert.match(issue.fix, /does not exist on a client unless it replicates/);
});

test("the same error a thousand times is one problem", () => {
  // One null dereference on Tick fills the log. Ungrouped, the report is the same wall the log was.
  const noise = accessedNone("Comp", "BP_C", "Tick", "EventGraph", "BP_Thing");
  const result = summariseRuntimeLog(
    ["[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel", ...Array.from({ length: 500 }, () => line("PIE", "Error", noise))].join("\n")
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].count, 500);
  assert.equal(result.errorCount, 500);
});

test("only the last Play session is reported", () => {
  // Reporting an earlier session as current is how an already-fixed bug gets fixed twice.
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-22.00.00:000][ 10]LogPlayLevel: PlayLevel",
      line("PIE", "Error", accessedNone("Old", "BP_C", "OldNode", "EventGraph", "BP_Fixed")),
      "[2026.08.18-23.00.00:000][ 90]LogPlayLevel: PlayLevel",
      line("PIE", "Error", accessedNone("New", "BP_C", "NewNode", "EventGraph", "BP_Broken")),
    ].join("\n")
  );
  assert.equal(result.lastSessionOnly, true);
  assert.deepEqual(result.issues.map((i) => i.blueprint), ["BP_Broken"]);
});

test("wholeLog opts back in to everything", () => {
  const text = [
    "[2026.08.18-22.00.00:000][ 10]LogPlayLevel: PlayLevel",
    line("PIE", "Error", accessedNone("Old", "BP_C", "OldNode", "EventGraph", "BP_Fixed")),
    "[2026.08.18-23.00.00:000][ 90]LogPlayLevel: PlayLevel",
    line("PIE", "Error", accessedNone("New", "BP_C", "NewNode", "EventGraph", "BP_Broken")),
  ].join("\n");
  const result = summariseRuntimeLog(text, { wholeLog: true });
  assert.equal(result.lastSessionOnly, false);
  assert.equal(result.issues.length, 2);
});

test("engine noise is counted separately, not hidden and not mixed in", () => {
  // A filter that hides too much turns a diagnostic tool into one that says everything is fine.
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line("LogTemp", "Error", "[SteamUtils] Steam API is not initialized! Ensure Steam is running."),
      line("LogOutputDevice", "Error", "[Callstack] 0x00007ffd UnrealEditor-Core.dll!UnknownFunction []"),
      line("PIE", "Error", accessedNone("Real", "BP_C", "RealNode", "EventGraph", "BP_Real")),
    ].join("\n")
  );
  assert.deepEqual(result.issues.map((i) => i.blueprint), ["BP_Real"]);
  assert.equal(result.noise.length, 2, "noise must still be counted, so it can be seen if it matters");
  assert.equal(result.errorCount, 3, "and it still counts toward the total");
});

test("warnings stay out unless asked for", () => {
  const text = [
    "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
    line("LogBlueprint", "Warning", "something mildly wrong"),
  ].join("\n");
  assert.equal(summariseRuntimeLog(text).issues.length, 0);
  assert.equal(summariseRuntimeLog(text).warningCount, 1, "counted even when not detailed");
  assert.equal(summariseRuntimeLog(text, { includeWarnings: true }).issues.length, 1);
});

test("addresses and long numbers are normalised so the same fault groups", () => {
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line("LogTemp", "Error", "Failed at 0x00007ffdaa11 with handle 123456"),
      line("LogTemp", "Error", "Failed at 0x00007ffdbb22 with handle 654321"),
    ].join("\n")
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].count, 2);
});

test("a signature-mismatch error points at the repair tool that fixes it", () => {
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line("LogBlueprint", "Error", "[Compiler] In use pin  Target  no longer exists on node  Get Health . Please refresh node or break links to remove pin."),
    ].join("\n")
  );
  assert.match(result.issues[0].fix, /unreal_refresh_blueprint/);
});

test("a clean session says so instead of inventing something", () => {
  const result = summariseRuntimeLog("[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel");
  assert.deepEqual(result.issues, []);
  assert.match(result.nextAction, /No errors/);
});

test("the log path is derived from the .uproject the editor reports", () => {
  // Asked of the editor rather than configured, so it cannot read one project's log while editing
  // another.
  const path = logFileFor("A:/UnrealProjects/AVS56_BugHunt/AntiVirusSquad.uproject");
  assert.match(path.replace(/\\/g, "/"), /AVS56_BugHunt\/Saved\/Logs\/AntiVirusSquad\.log$/);
});

// --- Shapes that arrived as "?" ------------------------------------------------------------------
//
// Three of the twelve issues from a real PIE session came back with no blueprint and no node - a
// count with nothing to act on, which is the shape of finding this project keeps deleting. Two
// patterns account for all of them.

test("an owner named with spaces still yields the node - \"in not an UClass\"", () => {
  // (\S+) could not match "not an UClass", so the whole line went unparsed. 35 occurrences in one
  // session, all reported as "?".
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line(
        "PIE",
        "Error",
        'Blueprint Runtime Error: "Accessed None trying to read (real) property CallFunc_Array_Get_Item in not an UClass". ' +
          "Node:  SetNavLinkStatus Graph:  TakeDamage Function:  Take Damage Blueprint:  BP_FireWall"
      ),
    ].join("\n")
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].blueprint, "BP_FireWall");
  assert.equal(result.issues[0].node, "SetNavLinkStatus");
  assert.equal(result.issues[0].property, "CallFunc_Array_Get_Item");
});

test("a destroyed actor is a different bug from one that was never set, and says so", () => {
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line(
        "PIE",
        "Error",
        'Blueprint Runtime Error: "Attempted to access BP_PingActor_C_1 via property VanPing, but ' +
          'BP_PingActor_C_1 is not valid (pending kill or garbage)". Node:  Destroy Actor Graph:  EventGraph ' +
          "Function:  Execute Ubergraph BP Data Drop Off Station Blueprint:  BP_DataDropOffStation"
      ),
    ].join("\n")
  );
  assert.equal(result.issues.length, 1);
  const issue = result.issues[0];
  assert.equal(issue.blueprint, "BP_DataDropOffStation");
  assert.equal(issue.node, "Destroy Actor");
  assert.equal(issue.property, "VanPing");
  assert.equal(issue.destroyed, true);
  // The advice has to distinguish the two. "Never set" and "set, then destroyed" have different fixes.
  assert.match(issue.fix, /destroyed/i);
  assert.doesNotMatch(issue.fix, /never set on that machine/);
});

test("one bug across many spawned instances is one issue, not one per instance", () => {
  // BP_PingActor_C_1 and BP_PingActor_C_2 are the same Destroy Actor in the same graph. Reported
  // separately they were 8x and 6x - two middling rows instead of one that sorts where it belongs.
  const pending = (n) =>
    `Blueprint Runtime Error: "Attempted to access BP_PingActor_C_${n} via property VanPing, but ` +
    `BP_PingActor_C_${n} is not valid (pending kill or garbage)". Node:  Destroy Actor Graph:  EventGraph ` +
    `Function:  Execute Ubergraph BP Data Drop Off Station Blueprint:  BP_DataDropOffStation`;
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line("PIE", "Error", pending(1)),
      line("PIE", "Error", pending(2)),
      line("PIE", "Error", pending(1)),
    ].join("\n")
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].count, 3);
});

test("two genuinely different actors are still two issues", () => {
  // The normalisation collapses the instance NUMBER, not the class. Collapsing further would hide
  // real distinctions, which is the failure mode of every over-eager dedupe.
  const pending = (cls) =>
    `Blueprint Runtime Error: "Attempted to access ${cls}_C_1 via property Ref, but ${cls}_C_1 ` +
    `is not valid (pending kill or garbage)". Node:  Destroy Actor Graph:  EventGraph ` +
    `Function:  Execute Ubergraph X Blueprint:  BP_Host`;
  const result = summariseRuntimeLog(
    [
      "[2026.08.18-23.09.00:000][ 50]LogPlayLevel: PlayLevel",
      line("PIE", "Error", pending("BP_PingActor")),
      line("PIE", "Error", pending("BP_OtherActor")),
    ].join("\n")
  );
  assert.equal(result.issues.length, 2);
});
