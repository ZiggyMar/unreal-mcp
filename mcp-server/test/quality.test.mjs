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

test("UE's greyed-out placeholder events are not reported as events wired to nothing", () => {
  // Every new Blueprint gets ghost BeginPlay and Tick nodes: real UEdGraphNodes, but placeholders
  // rather than behaviour. Counting them meant a feature that compiled cleanly still failed
  // verification for two nodes this server had created itself moments earlier.
  const withGhosts = [
    { id: "g1", type: "K2Node_Event", title: "Event BeginPlay", ghost: true, connectedPins: [] },
    { id: "g2", type: "K2Node_Event", title: "Event Tick", ghost: true, connectedPins: [] },
    {
      id: "r1",
      type: "K2Node_Event",
      title: "Event ActorBeginOverlap",
      connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "x", pin: "execute" }] }],
    },
  ];
  const report = reviewGraph("EventGraph", withGhosts);
  assert.equal(
    report.findings.filter((f) => f.check === "empty-event").length,
    0,
    "placeholders are events nobody has written yet, not events wired to nothing"
  );
});

test("a real event wired to nothing is still reported", () => {
  // The ghost exemption must not become a blanket one.
  const report = reviewGraph("EventGraph", [
    { id: "r1", type: "K2Node_Event", title: "Event ActorBeginOverlap", connectedPins: [] },
  ]);
  assert.equal(report.findings.filter((f) => f.check === "empty-event").length, 1);
});

test("a cast that filters is not reported as an unhandled failure", () => {
  // Measured on a real project: this check fired on 142 casts, and the majority were the ordinary
  // Blueprint idiom of casting to find out WHETHER something is that class. Wiring Cast Failed there
  // would be wiring "do nothing" to "do nothing".
  const overlapFilter = [
    { id: "ev", type: "K2Node_ComponentBoundEvent", title: "On Component Begin Overlap (Trigger)", connectedPins: [
      { pin: "then", direction: "out", linkedTo: [{ node: "cast", pin: "execute" }] },
    ] },
    { id: "cast", type: "K2Node_DynamicCast", title: "Cast To BP_Player", connectedPins: [
      { pin: "execute", direction: "in", linkedTo: [{ node: "ev", pin: "then" }] },
      { pin: "then", direction: "out", linkedTo: [{ node: "do", pin: "execute" }] },
    ] },
    { id: "do", type: "K2Node_CallFunction", title: "Heal", connectedPins: [
      { pin: "execute", direction: "in", linkedTo: [{ node: "cast", pin: "then" }] },
    ] },
  ];
  const report = reviewGraph("EventGraph", overlapFilter);
  assert.equal(
    report.findings.find((f) => f.check === "unhandled-cast-failure"),
    undefined,
    "a cast reached from an overlap event IS the filter"
  );
});

test("a cast fed by a loop or a trace result is filtering too", () => {
  // The half the event walk misses. Seen in BP_Player: a cast fed by For Each Loop over actors, and
  // one fed by Break Hit Result off a line trace. Neither is reached from an overlap event.
  for (const sourceTitle of ["For Each Loop", "Break Hit Result", "Get All Actors Of Class"]) {
    const nodes = [
      { id: "ev", type: "K2Node_Event", title: "Event BeginPlay", connectedPins: [
        { pin: "then", direction: "out", linkedTo: [{ node: "cast", pin: "execute" }] },
      ] },
      { id: "src", type: "K2Node_CallFunction", title: sourceTitle, connectedPins: [
        { pin: "Array Element", direction: "out", linkedTo: [{ node: "cast", pin: "Object" }] },
      ] },
      { id: "cast", type: "K2Node_DynamicCast", title: "Cast To BP_Player", connectedPins: [
        { pin: "execute", direction: "in", linkedTo: [{ node: "ev", pin: "then" }] },
        { pin: "Object", direction: "in", linkedTo: [{ node: "src", pin: "Array Element" }] },
        { pin: "then", direction: "out", linkedTo: [{ node: "ev", pin: "then" }] },
      ] },
    ];
    const report = reviewGraph("EventGraph", nodes);
    assert.equal(
      report.findings.find((f) => f.check === "unhandled-cast-failure"),
      undefined,
      `${sourceTitle} feeds a filtering cast`
    );
  }
});

test("a cast nothing runs into cannot fail", () => {
  // Found in BP_Player's GetAnimBP: a Cast node whose `execute` pin is linked to nothing at all,
  // reported as a silent-failure risk when it is simply never reached.
  const nodes = [
    { id: "ev", type: "K2Node_Event", title: "Event BeginPlay", connectedPins: [] },
    { id: "cast", type: "K2Node_DynamicCast", title: "Cast To BP_Player", connectedPins: [
      { pin: "then", direction: "out", linkedTo: [{ node: "ev", pin: "execute" }] },
    ] },
  ];
  const report = reviewGraph("EventGraph", nodes);
  assert.equal(report.findings.find((f) => f.check === "unhandled-cast-failure"), undefined);
});

test("a cast on a setup path is still reported, which is the point", () => {
  // The case the check was written for: fail here and the rest of the initialisation silently never
  // happens. Narrowing the check must not turn it off.
  const nodes = [
    { id: "ev", type: "K2Node_Event", title: "Event BeginPlay", connectedPins: [
      { pin: "then", direction: "out", linkedTo: [{ node: "cast", pin: "execute" }] },
    ] },
    { id: "gi", type: "K2Node_CallFunction", title: "Get Game Instance", connectedPins: [
      { pin: "ReturnValue", direction: "out", linkedTo: [{ node: "cast", pin: "Object" }] },
    ] },
    { id: "cast", type: "K2Node_DynamicCast", title: "Cast To AVS_GameInstance", connectedPins: [
      { pin: "execute", direction: "in", linkedTo: [{ node: "ev", pin: "then" }] },
      { pin: "Object", direction: "in", linkedTo: [{ node: "gi", pin: "ReturnValue" }] },
      { pin: "then", direction: "out", linkedTo: [{ node: "setup", pin: "execute" }] },
    ] },
    { id: "setup", type: "K2Node_CallFunction", title: "Load Save Game", connectedPins: [
      { pin: "execute", direction: "in", linkedTo: [{ node: "cast", pin: "then" }] },
    ] },
  ];
  const report = reviewGraph("EventGraph", nodes);
  const finding = report.findings.find((f) => f.check === "unhandled-cast-failure");
  assert.ok(finding, "a setup cast with no failure path is the real finding");
  assert.deepEqual(finding.nodeIds, ["cast"]);
});

/** A graph containing only a function entry with nothing wired to it. */
const emptyFunction = (name) => [{ id: "entry", type: "K2Node_FunctionEntry", title: name, connectedPins: [] }];

test("a function with no body is reported, because a caller's call does nothing", () => {
  // Found by asking a real question. "The countdown never shows up": GS_Gameplay has ShowCountdown,
  // UpdateCountdown and HideCountdown, and every one is an entry node with nothing wired to it.
  // empty-event covered events; nothing covered a FUNCTION whose body is empty, which is the case
  // where a caller exists and its call silently does nothing.
  const report = reviewGraph("ShowCountdown", emptyFunction("ShowCountdown"));
  const finding = report.findings.find((f) => f.check === "empty-function");
  assert.ok(finding);
  assert.match(finding.message, /no body/);
  // Whether it matters turns on something this check cannot see, so the fix names the call that
  // settles it rather than asserting.
  assert.match(finding.fix, /unreal_trace_function_calls/);
});

test("a Blueprint Interface's graphs are signatures, and empty is the point", () => {
  // Reported 63 findings before this exclusion, and BI_Power/PowerOn was among them. An interface
  // declares signatures; its graphs have no body by design. Reporting them is the same mistake
  // unhandled-cast-failure made - a check firing on ordinary, correct practice.
  const report = reviewGraph("PowerOn", emptyFunction("PowerOn"), { isInterface: true });
  assert.equal(report.findings.find((f) => f.check === "empty-function"), undefined);
});

test("an event dispatcher is not an unfinished function", () => {
  // The one that nearly shipped. An event dispatcher is a `mcdelegate` VARIABLE, and Unreal also
  // exposes its signature as a graph with a K2Node_FunctionEntry and connectedPins: []. On BP_Player
  // that is ChangeHealth and SendMessageToHUD - indistinguishable from an unfinished function unless
  // you know what the name is, and without this the check reports every dispatcher in the project.
  const report = reviewGraph("ChangeHealth", emptyFunction("ChangeHealth"), {
    delegateNames: new Set(["ChangeHealth", "SendMessageToHUD"]),
  });
  assert.equal(report.findings.find((f) => f.check === "empty-function"), undefined);
});

test("the construction script and a RepNotify are left to the checks that own them", () => {
  // Every Blueprint has a UserConstructionScript and empty is its normal state. An empty OnRep_ is
  // already reported by repnotify-does-nothing, at its own cost - reporting it twice would double
  // count one defect, which is what the cast check was doing with cast-to-server-only-class.
  for (const name of ["UserConstructionScript", "OnRep_Health"]) {
    const report = reviewGraph(name, emptyFunction(name));
    assert.equal(report.findings.find((f) => f.check === "empty-function"), undefined, name);
  }
});

test("a function with a body is not reported", () => {
  // Narrowing a check must not turn it off.
  const nodes = [
    { id: "entry", type: "K2Node_FunctionEntry", title: "Heal", connectedPins: [
      { pin: "then", direction: "out", linkedTo: [{ node: "do", pin: "execute" }] },
    ] },
    { id: "do", type: "K2Node_CallFunction", title: "Set Health", connectedPins: [
      { pin: "execute", direction: "in", linkedTo: [{ node: "entry", pin: "then" }] },
    ] },
  ];
  const report = reviewGraph("Heal", nodes);
  assert.equal(report.findings.find((f) => f.check === "empty-function"), undefined);
});
