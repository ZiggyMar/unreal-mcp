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
