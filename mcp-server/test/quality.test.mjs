import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewGraph } from "../dist/quality.js";

function node(id, type, title, links = []) {
  const pins = new Map();
  for (const [pin, direction, toNode, toPin] of links) {
    const key = `${pin}:${direction}`;
    if (!pins.has(key)) pins.set(key, { pin, direction, linkedTo: [] });
    if (toNode) pins.get(key).linkedTo.push({ node: toNode, pin: toPin });
  }
  return { id, type, title, connectedPins: [...pins.values()] };
}

const checks = (report) => report.findings.map((f) => f.check);

/** A small, clean graph: event -> set variable, nothing wrong with it. */
function cleanGraph() {
  return [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "set", "execute"]]),
    node("set", "K2Node_VariableSet", "Set Health", [["execute", "in", "ev", "then"]]),
    node("c", "EdGraphNode_Comment", "Event BeginPlay"),
  ];
}

test("a clean graph produces no findings and scores 100", () => {
  const report = reviewGraph("EventGraph", cleanGraph());
  assert.deepEqual(report.findings, []);
  assert.equal(report.score, 100);
  assert.equal(report.nodeCount, 2, "comment boxes are not counted as nodes");
});

test("an unconnected node is reported as dead", () => {
  const nodes = [...cleanGraph(), node("orphan", "K2Node_CallFunction", "Get Player Controller")];
  const report = reviewGraph("EventGraph", nodes);

  const finding = report.findings.find((f) => f.check === "dead-node");
  assert.ok(finding, `expected dead-node, got ${checks(report)}`);
  assert.deepEqual(finding.nodeIds, ["orphan"]);
  assert.equal(finding.severity, "warning");
});

test("a cast with no Cast Failed wired is flagged, and one with it wired is not", () => {
  const unhandled = [
    node("cast", "K2Node_DynamicCast", "Cast To BP_Player", [
      ["execute", "in", "ev", "then"],
      ["then", "out", "x", "execute"],
    ]),
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "cast", "execute"]]),
    node("x", "K2Node_CallFunction", "Do Thing", [["execute", "in", "cast", "then"]]),
  ];
  assert.ok(checks(reviewGraph("EventGraph", unhandled)).includes("unhandled-cast-failure"));

  const handled = [
    ...unhandled.filter((n) => n.id !== "cast"),
    node("cast", "K2Node_DynamicCast", "Cast To BP_Player", [
      ["execute", "in", "ev", "then"],
      ["then", "out", "x", "execute"],
      ["Cast Failed", "out", "x", "execute"],
    ]),
  ];
  assert.ok(!checks(reviewGraph("EventGraph", handled)).includes("unhandled-cast-failure"));
});

test("leftover Print String nodes are reported", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "p", "execute"]]),
    node("p", "K2Node_CallFunction", "Print String", [["execute", "in", "ev", "then"]]),
  ];
  const finding = reviewGraph("EventGraph", nodes).findings.find((f) => f.check === "debug-print-left-in");
  assert.ok(finding);
  assert.deepEqual(finding.nodeIds, ["p"]);
});

test("placeholder variable names are named in the message", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "s", "execute"]]),
    node("s", "K2Node_VariableSet", "Set NewVar", [["execute", "in", "ev", "then"]]),
  ];
  const finding = reviewGraph("EventGraph", nodes).findings.find((f) => f.check === "placeholder-name");
  assert.ok(finding, `expected placeholder-name, got ${checks(reviewGraph("EventGraph", nodes))}`);
  assert.match(finding.message, /NewVar/);
});

test("a real variable name is not mistaken for a placeholder", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "s", "execute"]]),
    node("s", "K2Node_VariableSet", "Set CurrentHealth", [["execute", "in", "ev", "then"]]),
  ];
  assert.ok(!checks(reviewGraph("EventGraph", nodes)).includes("placeholder-name"));
});

test("a heavy Event Tick chain is flagged, a short one is not", () => {
  const build = (length) => {
    const nodes = [node("ev", "K2Node_Event", "Event Tick", [["then", "out", "n0", "execute"]])];
    for (let i = 0; i < length; i++) {
      const links = [["execute", "in", i === 0 ? "ev" : `n${i - 1}`, "then"]];
      if (i < length - 1) links.push(["then", "out", `n${i + 1}`, "execute"]);
      nodes.push(node(`n${i}`, "K2Node_CallFunction", `Step ${i}`, links));
    }
    return nodes;
  };
  assert.ok(checks(reviewGraph("EventGraph", build(10))).includes("tick-heavy"));
  assert.ok(!checks(reviewGraph("EventGraph", build(3))).includes("tick-heavy"));
});

test("an event wired to nothing is reported as empty", () => {
  const nodes = [node("ev", "K2Node_CustomEvent", "OnPickedUp")];
  const finding = reviewGraph("EventGraph", nodes).findings.find((f) => f.check === "empty-event");
  assert.ok(finding);
  assert.deepEqual(finding.nodeIds, ["ev"]);
});

test("a Branch with only one path wired is info, not warning", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "br", "execute"]]),
    node("br", "K2Node_IfThenElse", "Branch", [
      ["execute", "in", "ev", "then"],
      ["True", "out", "x", "execute"],
    ]),
    node("x", "K2Node_CallFunction", "Do Thing", [["execute", "in", "br", "True"]]),
  ];
  const finding = reviewGraph("EventGraph", nodes).findings.find((f) => f.check === "branch-dead-path");
  assert.ok(finding);
  assert.equal(finding.severity, "info");
});

test("a fully wired Branch is not flagged", () => {
  const nodes = [
    node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "br", "execute"]]),
    node("br", "K2Node_IfThenElse", "Branch", [
      ["execute", "in", "ev", "then"],
      ["True", "out", "x", "execute"],
      ["False", "out", "y", "execute"],
    ]),
    node("x", "K2Node_CallFunction", "Do Thing", [["execute", "in", "br", "True"]]),
    node("y", "K2Node_CallFunction", "Other Thing", [["execute", "in", "br", "False"]]),
  ];
  assert.ok(!checks(reviewGraph("EventGraph", nodes)).includes("branch-dead-path"));
});

test("an oversized graph is flagged for extraction into functions", () => {
  const nodes = [node("ev", "K2Node_Event", "Event BeginPlay", [["then", "out", "n0", "execute"]])];
  for (let i = 0; i < 70; i++) {
    const links = [["execute", "in", i === 0 ? "ev" : `n${i - 1}`, "then"]];
    if (i < 69) links.push(["then", "out", `n${i + 1}`, "execute"]);
    nodes.push(node(`n${i}`, "K2Node_CallFunction", `Step ${i}`, links));
  }
  const found = checks(reviewGraph("EventGraph", nodes));
  assert.ok(found.includes("graph-too-large"));
  assert.ok(found.includes("long-exec-chain"));
});

test("unlabelled sections are reported only when chains outnumber comment boxes", () => {
  const twoChains = [
    node("ev1", "K2Node_Event", "Event BeginPlay", [["then", "out", "a", "execute"]]),
    node("a", "K2Node_CallFunction", "Do A", [["execute", "in", "ev1", "then"]]),
    node("ev2", "K2Node_Event", "Event Tick", [["then", "out", "b", "execute"]]),
    node("b", "K2Node_CallFunction", "Do B", [["execute", "in", "ev2", "then"]]),
  ];
  assert.ok(checks(reviewGraph("EventGraph", twoChains)).includes("unlabelled-sections"));

  const boxed = [...twoChains, node("c1", "EdGraphNode_Comment", "A"), node("c2", "EdGraphNode_Comment", "B")];
  assert.ok(!checks(reviewGraph("EventGraph", boxed)).includes("unlabelled-sections"));
});

test("the score falls with severity and never goes below zero", () => {
  const clean = reviewGraph("EventGraph", cleanGraph());
  assert.equal(clean.score, 100);

  const messy = reviewGraph("EventGraph", [
    node("ev", "K2Node_CustomEvent", "OnThing"),
    node("orphan", "K2Node_CallFunction", "Get Player Controller"),
    node("p", "K2Node_CallFunction", "Print String"),
    node("s", "K2Node_VariableSet", "Set NewVar"),
  ]);
  assert.ok(messy.score < clean.score);
  assert.ok(messy.score >= 0);
  assert.equal(messy.summary.warnings, messy.findings.filter((f) => f.severity === "warning").length);
});

test("findings are ordered most severe first, and every one carries a fix", () => {
  const report = reviewGraph("EventGraph", [
    node("ev1", "K2Node_Event", "Event BeginPlay", [["then", "out", "p", "execute"]]),
    node("p", "K2Node_CallFunction", "Print String", [["execute", "in", "ev1", "then"]]),
    node("ev2", "K2Node_Event", "Event Tick", [["then", "out", "q", "execute"]]),
    node("q", "K2Node_CallFunction", "Do B", [["execute", "in", "ev2", "then"]]),
  ]);
  const rank = { error: 0, warning: 1, info: 2 };
  const ranks = report.findings.map((f) => rank[f.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  for (const finding of report.findings) {
    assert.ok(finding.fix.length > 20, `${finding.check} needs an actionable fix`);
    assert.ok(finding.check.length > 0);
  }
});

test("an empty graph is not an error and is not scored down", () => {
  const report = reviewGraph("EventGraph", []);
  assert.equal(report.score, 100);
  assert.deepEqual(report.findings, []);
  assert.equal(report.nodeCount, 0);
});

test("an unconnected event is not called a dead node", () => {
  // Found on real code: cleanup said it would remove 2 dead nodes and, in the same result, that 2
  // empty events were "only you know which was intended". They were the same two nodes.
  //
  // It matters beyond the contradiction: on a Blueprint whose parent is also a Blueprint, an empty
  // override event suppresses the parent's implementation, so deleting it restores parent
  // behaviour - a behaviour change, from the one tool that promises never to make one.
  const report = reviewGraph("EventGraph", [
    node("1", "K2Node_Event", "Event BeginPlay"),
    node("2", "K2Node_Event", "Event ActorBeginOverlap"),
  ]);
  const deadNode = report.findings.find((f) => f.check === "dead-node");
  assert.equal(deadNode, undefined, "an unconnected event was reported as a removable dead node");
  assert.ok(
    report.findings.some((f) => f.check === "empty-event"),
    "the events should still be reported, as empty-event"
  );
});

test("a genuinely stray node is still reported as dead", () => {
  // The other half: excluding events must not neuter the check that made it worth having.
  const report = reviewGraph("EventGraph", [
    node("1", "K2Node_Event", "Event BeginPlay", [["then", "out", "2", "execute"]]),
    node("2", "K2Node_CallFunction", "Print String", [["execute", "in", "1", "then"]]),
    node("3", "K2Node_CallFunction", "Get Actor Location"),
  ]);
  const deadNode = report.findings.find((f) => f.check === "dead-node");
  assert.ok(deadNode, "a stray non-event node was not reported");
  assert.deepEqual(deadNode.nodeIds, ["3"]);
});
