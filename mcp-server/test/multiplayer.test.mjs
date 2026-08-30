import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewMultiplayer } from "../dist/multiplayer.js";

const node = (id, type, title, execTo = []) => ({
  id,
  type,
  title,
  connectedPins: execTo.length
    ? [{ pin: "then", direction: "out", linkedTo: execTo.map((n) => ({ node: n, pin: "execute" })) }]
    : [],
});

const ids = (findings) => findings.map((f) => f.check);

test("a server event setting an unreplicated variable is flagged", () => {
  // The most common multiplayer bug in Blueprints: the server changes its own copy, every client
  // keeps the old value, and the symptom is "it works for the host".
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_VacuumPressed", ["s"]),
      node("s", "K2Node_VariableSet", "SET bVacuumOn", []),
    ],
    [{ name: "bVacuumOn", replicated: false }]
  );
  const finding = findings.find((f) => f.check === "server-writes-unreplicated");
  assert.ok(finding, `expected the bug to be caught, got ${ids(findings).join(", ")}`);
  assert.equal(finding.variable, "bVacuumOn");
  assert.match(finding.message, /no client will ever see it/i);
  assert.match(finding.fix, /Replicated|RepNotify/);
});

test("the same variable, replicated, is not flagged", () => {
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_VacuumPressed", ["s"]),
      node("s", "K2Node_VariableSet", "SET bVacuumOn", []),
    ],
    [{ name: "bVacuumOn", replicated: true }]
  );
  assert.deepEqual(findings, []);
});

test("a single-player Blueprint is left entirely alone", () => {
  // No server, client or multicast event and nothing replicated: none of this applies, and firing
  // here would put a multiplayer warning on every single-player project in existence.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_Event", "Event BeginPlay", ["s"]),
      node("s", "K2Node_VariableSet", "SET Health", []),
    ],
    [{ name: "Health", replicated: false }]
  );
  assert.deepEqual(findings, []);
});

test("the write is found several nodes down the chain", () => {
  // Real server events do work before they set anything; checking only the first node would miss
  // almost every real case.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_Fire", ["a"]),
      node("a", "K2Node_CallFunction", "Line Trace By Channel", ["b"]),
      node("b", "K2Node_IfThenElse", "Branch", ["s"]),
      node("s", "K2Node_VariableSet", "SET Ammo", []),
    ],
    [{ name: "Ammo", replicated: false }]
  );
  assert.ok(ids(findings).includes("server-writes-unreplicated"));
});

test("a variable this Blueprint does not declare is not guessed about", () => {
  // Inherited or component variables have no entry here, and inventing a verdict for them would be
  // the false positive that discredits the rest of the report.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_Fire", ["s"]),
      node("s", "K2Node_VariableSet", "SET SomethingInherited", []),
    ],
    [{ name: "Ammo", replicated: true }]
  );
  assert.ok(!ids(findings).includes("server-writes-unreplicated"));
});

test("each offending variable is reported once, not once per server event", () => {
  const findings = reviewMultiplayer(
    [
      node("e1", "K2Node_CustomEvent", "Server_On", ["s1"]),
      node("s1", "K2Node_VariableSet", "SET bActive", []),
      node("e2", "K2Node_CustomEvent", "Server_Off", ["s2"]),
      node("s2", "K2Node_VariableSet", "SET bActive", []),
    ],
    [{ name: "bActive", replicated: false }]
  );
  assert.equal(findings.filter((f) => f.check === "server-writes-unreplicated").length, 1);
});

test("replicated state written with no server event anywhere is raised as info", () => {
  // The mirror image: a client changes replicated state locally and the next server update
  // overwrites it. Info rather than warning because an authority check may well be in the chain.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_Event", "Event BeginPlay", ["s"]),
      node("s", "K2Node_VariableSet", "SET Score", []),
    ],
    [{ name: "Score", replicated: true }]
  );
  const finding = findings.find((f) => f.check === "replicated-set-without-server-event");
  assert.ok(finding, `expected the mirror case, got ${ids(findings).join(", ")}`);
  assert.equal(finding.severity, "info");
  assert.match(finding.fix, /Switch Has Authority|Server_/);
});

test("a multicast event alone marks the Blueprint as networked", () => {
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Multicast_Explode", ["s"]),
      node("s", "K2Node_VariableSet", "SET Score", []),
    ],
    [{ name: "Score", replicated: true }]
  );
  // Networked, so the mirror-image check is allowed to speak.
  assert.ok(ids(findings).includes("replicated-set-without-server-event"));
});

// --- casting to something that only exists on the server ---------------------------------------
const { findServerOnlyCasts } = await import("../dist/multiplayer.js");
const isGameMode = (name) => /^GM_|GameMode/.test(name);

test("a client-side cast to a GameMode is flagged", () => {
  // Found 24 times in one real project. A GameMode exists only on the server, so on every client
  // the cast fails silently and every node after it never runs.
  const findings = findServerOnlyCasts(
    [
      node("e", "K2Node_CustomEvent", "KillPlayerClient", ["c"]),
      node("c", "K2Node_DynamicCast", "Cast To GM_Gameplay", ["s"]),
      node("s", "K2Node_CallFunction", "SpawnSpectator", []),
    ],
    isGameMode,
    false
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "cast-to-server-only-class");
  assert.match(findings[0].message, /only on the server/i);
  assert.match(findings[0].fix, /GameState|Switch Has Authority/);
});

test("a GameMode casting to a GameMode is not flagged", () => {
  // The owner is server-only too, so there is no client for it to fail on.
  const findings = findServerOnlyCasts(
    [node("c", "K2Node_DynamicCast", "Cast To GM_Gameplay", [])],
    isGameMode,
    true
  );
  assert.deepEqual(findings, []);
});

test("a cast behind Switch Has Authority is not flagged", () => {
  // Guarded by construction: that branch only runs on the server. Detecting the guard rather than
  // assuming it is absent is what keeps this check trustworthy on a real project.
  const findings = findServerOnlyCasts(
    [
      {
        id: "a",
        type: "K2Node_SwitchHasAuthority",
        title: "Switch Has Authority",
        connectedPins: [{ pin: "Authority", direction: "out", linkedTo: [{ node: "c", pin: "execute" }] }],
      },
      node("c", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
    ],
    isGameMode,
    false
  );
  assert.deepEqual(findings, []);
});

test("the Remote branch of Switch Has Authority is still flagged", () => {
  // Remote is explicitly the client side, so a GameMode cast there is the bug in its purest form.
  const findings = findServerOnlyCasts(
    [
      {
        id: "a",
        type: "K2Node_SwitchHasAuthority",
        title: "Switch Has Authority",
        connectedPins: [{ pin: "Remote", direction: "out", linkedTo: [{ node: "c", pin: "execute" }] }],
      },
      node("c", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
    ],
    isGameMode,
    false
  );
  assert.equal(findings.length, 1);
});

test("a cast to something that is not server-only is left alone", () => {
  const findings = findServerOnlyCasts(
    [node("c", "K2Node_DynamicCast", "Cast To BP_Player", [])],
    isGameMode,
    false
  );
  assert.deepEqual(findings, []);
});

test("the same target is reported once, not once per cast node", () => {
  const findings = findServerOnlyCasts(
    [
      node("c1", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
      node("c2", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
      node("c3", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
    ],
    isGameMode,
    false
  );
  assert.equal(findings.length, 1);
});

test("the finding names the chain that reaches the cast", () => {
  // "This Blueprint casts to a GameMode" is hard to act on. Naming the entry point tells you where
  // to look, and whether the chain plausibly runs on a client at all - which is the real question.
  const findings = findServerOnlyCasts(
    [
      node("e", "K2Node_CustomEvent", "KillPlayerClient", ["m"]),
      node("m", "K2Node_CallFunction", "Disable Movement", ["c"]),
      node("c", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
    ],
    isGameMode,
    false
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /reached from KillPlayerClient/);
});

test("a cast no entry point reaches is still reported, without inventing a chain", () => {
  const findings = findServerOnlyCasts(
    [node("c", "K2Node_DynamicCast", "Cast To GM_Gameplay", [])],
    isGameMode,
    false
  );
  assert.equal(findings.length, 1);
  assert.ok(!/reached from/.test(findings[0].message));
});

test("a prefixed server event is still recognised as a server event", () => {
  // Real projects prefix custom events. CE_Server_FinishedCutscene is a server event, and reading
  // it as a client one produced a false positive on a real project.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "CE_Server_FinishedCutscene", ["s"]),
      node("s", "K2Node_VariableSet", "SET bReady", []),
    ],
    [{ name: "bReady", replicated: false }]
  );
  assert.ok(ids(findings).includes("server-writes-unreplicated"));
});

test("a name that merely contains 'server' is not treated as a server event", () => {
  // "Observer" must not match, or the convention becomes noise.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "ObserverUpdate", ["s"]),
      node("s", "K2Node_VariableSet", "SET bReady", []),
    ],
    [{ name: "bReady", replicated: false }]
  );
  assert.deepEqual(findings, []);
});

test("a GameMode cast inside a server event chain is correct, not a bug", () => {
  // A real project had CE_Server_FinishedCutscene casting to its GameMode, which is exactly right
  // and was reported as a bug until the server event was recognised as a guard.
  const findings = findServerOnlyCasts(
    [
      node("e", "K2Node_CustomEvent", "CE_Server_FinishedCutscene", ["c"]),
      node("c", "K2Node_DynamicCast", "Cast To GM_Lobby", []),
    ],
    isGameMode,
    false
  );
  assert.deepEqual(findings, []);
});

test("the same cast from a plain event is still a bug", () => {
  // The guard must be the server event itself, not merely the presence of one somewhere.
  const findings = findServerOnlyCasts(
    [
      node("e", "K2Node_Event", "Event BeginPlay", ["c"]),
      node("c", "K2Node_DynamicCast", "Cast To GM_Lobby", []),
      node("s", "K2Node_CustomEvent", "CE_Server_Something", []),
    ],
    isGameMode,
    false
  );
  assert.equal(findings.length, 1);
});

test("a server writing an object handle is not reported as a replication bug", () => {
  // Measured on a real project: this check reported BP_Player setting "CurrentActivePing" at cost
  // 100. It is not a bug - CurrentActivePing holds a BP_PingActor, and that Actor has bReplicates
  // true, so it replicates itself and every client already sees the ping. The variable is the
  // server's handle to it. A confident, plausible, wrong finding at the top of an audit is worse
  // than none: it sends a model to change code that is correct.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_TryPing", ["s"]),
      node("s", "K2Node_VariableSet", "SET CurrentActivePing", []),
    ],
    [{ name: "CurrentActivePing", type: "Object", subType: "BP_PingActor_C", replicated: false }]
  );

  assert.equal(
    findings.filter((f) => f.check === "server-writes-unreplicated").length,
    0,
    `an object handle must not be reported as unreplicated state, got ${ids(findings).join(", ")}`
  );

  const soft = findings.filter((f) => f.check === "server-writes-unreplicated-handle");
  assert.equal(soft.length, 1, "but it is still worth one look, so it is still reported");
  assert.match(soft[0].fix, /read_class_defaults/, "and it must say how to decide");
  assert.match(soft[0].fix, /BP_PingActor_C/, "naming what to check, not merely that something should be");
});

test("a server writing ordinary state is still reported at full weight", () => {
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_TakeDamage", ["s"]),
      node("s", "K2Node_VariableSet", "SET Health", []),
    ],
    [{ name: "Health", type: "float", replicated: false }]
  );
  assert.equal(findings.filter((f) => f.check === "server-writes-unreplicated").length, 1);
});

test("a server write is never suppressed just because this Blueprint does not read it", () => {
  // The mistake this pins. A first attempt dropped the finding when nothing in the Blueprint read
  // the variable, or when every read was server-side. Both are wrong, because reads live in OTHER
  // Blueprints: a HUD widget reading the player's value on a client is exactly the bug this check
  // exists for, and it would have been silenced by a rule that only ever looked at one asset.
  // Suppressing a real finding is far worse than reporting a doubtful one.
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_RequestPurchase", ["s"]),
      node("s", "K2Node_VariableSet", "SET CostServer", []),
    ],
    [{ name: "CostServer", type: "int", replicated: false }]
  );
  const finding = findings.find((f) => f.check === "server-writes-unreplicated");
  assert.ok(finding, "the finding must survive even with no reads in this asset");
  assert.match(finding.observed, /widget or another actor/i, "and must say what it cannot see");
});

test("the evidence is separated from the conclusion", () => {
  // A read whose value feeds a node OUTSIDE any server chain is the case that matters: a client
  // really does read what the server changed, and will keep reading the stale value.
  //
  // The first version of this test used a Get wired to nothing and asserted "worth fixing". It
  // passed for the wrong reason - back then every Get looked client-side, because a Get has no exec
  // pins and could never be exec-reachable. Fixing that broke this test, correctly.
  const get = node("g", "K2Node_VariableGet", "GET Health", []);
  get.connectedPins = [{ pin: "Health", direction: "out", linkedTo: [{ node: "hud", pin: "InValue" }] }];
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_TakeDamage", ["s"]),
      node("s", "K2Node_VariableSet", "SET Health", []),
      node("tick", "K2Node_Event", "Event Tick", ["hud"]),
      node("hud", "K2Node_CallFunction", "Set Health Bar Percent", []),
      get,
    ],
    [{ name: "Health", type: "float", replicated: false }]
  );
  const finding = findings.find((f) => f.check === "server-writes-unreplicated");
  assert.match(finding.observed, /worth fixing/i, "a read consumed off the server is the real bug");
});

test("a read is judged by where its value goes, not by the Get node itself", () => {
  // A Get node is pure data - no exec pins - so it is never reachable by walking execution. Asking
  // whether the GET is server-reachable always answered "no", which made the evidence claim "a
  // client reads this" about every variable in the project: confident, and wrong. What decides it is
  // the node the value feeds.
  const get = node("g", "K2Node_VariableGet", "GET CostServer", []);
  get.connectedPins = [{ pin: "CostServer", direction: "out", linkedTo: [{ node: "use", pin: "Value" }] }];
  const findings = reviewMultiplayer(
    [
      node("e", "K2Node_CustomEvent", "Server_RequestPurchase", ["s"]),
      node("s", "K2Node_VariableSet", "SET CostServer", ["use"]),
      node("use", "K2Node_CallFunction", "Print String", []),
      get,
    ],
    [{ name: "CostServer", type: "int", replicated: false }]
  );
  const finding = findings.find((f) => f.check === "server-writes-unreplicated");
  assert.match(finding.observed, /also on the server/i, "the consumer is inside the server chain");
  assert.doesNotMatch(finding.observed, /worth fixing/i);
});
