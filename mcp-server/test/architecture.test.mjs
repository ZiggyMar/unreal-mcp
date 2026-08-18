import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewGraph } from "../dist/quality.js";

/** A node in the shape read_blueprint_graph_summary returns. */
const node = (id, type, title, execTo = []) => ({
  id,
  type,
  title,
  connectedPins: [
    ...(execTo.length
      ? [{ pin: "then", direction: "out", linkedTo: execTo.map((n) => ({ node: n, pin: "execute" })) }]
      : []),
    { pin: "execute", direction: "in", linkedTo: [{ node: "in", pin: "then" }] },
  ],
});

const findingIds = (report) => report.findings.map((f) => f.check);

test("Get All Actors Of Class on Tick is an error, not a suggestion", () => {
  // This walks every actor in the level, 60+ times a second. It is the most common cause of a
  // Blueprint project quietly losing its framerate, and it was in the real project on day one.
  const report = reviewGraph("EventGraph", [
    node("t", "K2Node_Event", "Event Tick", ["g"]),
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
  ]);
  const finding = report.findings.find((f) => f.check === "level-sweep-every-frame");
  assert.ok(finding, `expected the sweep to be flagged, got ${findingIds(report).join(", ")}`);
  assert.equal(finding.severity, "error");
  assert.match(finding.fix, /BeginPlay|overlap|dispatcher/i);
});

test("the same call NOT reachable from Tick is not flagged as per-frame", () => {
  // Once at BeginPlay is ordinary and correct. Flagging it would be the false positive that
  // teaches a caller to ignore the report.
  const report = reviewGraph("EventGraph", [
    node("b", "K2Node_Event", "Event BeginPlay", ["g"]),
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
  ]);
  assert.ok(!findingIds(report).includes("level-sweep-every-frame"));
});

test("a cast on Tick is flagged and the fix says cache it", () => {
  const report = reviewGraph("EventGraph", [
    node("t", "K2Node_Event", "Event Tick", ["c"]),
    node("c", "K2Node_DynamicCast", "Cast To BP_Player", []),
  ]);
  const finding = report.findings.find((f) => f.check === "cast-every-frame");
  assert.ok(finding, `expected a cast finding, got ${findingIds(report).join(", ")}`);
  assert.match(finding.fix, /BeginPlay|store/i);
});

test("spawning on Tick is flagged", () => {
  const report = reviewGraph("EventGraph", [
    node("t", "K2Node_Event", "Event Tick", ["s"]),
    node("s", "K2Node_CallFunction", "SpawnActor BP_Bullet", []),
  ]);
  assert.ok(findingIds(report).includes("spawn-every-frame"));
});

test("reachability follows the whole chain, not just the first node", () => {
  // A sweep three nodes downstream of Tick still runs every frame. Checking only Tick's immediate
  // target would miss almost every real case, since real chains have work in front of the problem.
  const report = reviewGraph("EventGraph", [
    node("t", "K2Node_Event", "Event Tick", ["a"]),
    node("a", "K2Node_CallFunction", "Do A", ["b"]),
    node("b", "K2Node_CallFunction", "Do B", ["g"]),
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
  ]);
  assert.ok(findingIds(report).includes("level-sweep-every-frame"));
});

test("a graph with no Tick event reports no per-frame findings at all", () => {
  const report = reviewGraph("EventGraph", [
    node("e", "K2Node_CustomEvent", "Sys_Fire", ["g"]),
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
    node("c", "K2Node_DynamicCast", "Cast To BP_Player", []),
  ]);
  for (const id of ["level-sweep-every-frame", "cast-every-frame", "spawn-every-frame"]) {
    assert.ok(!findingIds(report).includes(id), `${id} fired without an Event Tick`);
  }
});

test("a data link does not count as execution flow", () => {
  // Following data pins would make almost everything look reachable from Tick, and the report
  // would become noise.
  const report = reviewGraph("EventGraph", [
    {
      id: "t",
      type: "K2Node_Event",
      title: "Event Tick",
      connectedPins: [{ pin: "DeltaSeconds", direction: "out", linkedTo: [{ node: "g", pin: "Radius" }] }],
    },
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
  ]);
  assert.ok(!findingIds(report).includes("level-sweep-every-frame"));
});

test("a timer plus a level sweep is raised as a question, not an accusation", () => {
  // Where the real project's cost actually was: a timer started a scan event and the scan walked
  // every actor. Proving the timer drives THAT chain needs the timer's function-name pin value,
  // which a graph summary deliberately omits - so this says "these two are here, check them"
  // rather than asserting a link it cannot see.
  const report = reviewGraph("EventGraph", [
    node("e", "K2Node_CustomEvent", "Server_Pressed", ["t"]),
    node("t", "K2Node_CallFunction", "Set Timer by Function Name", []),
    node("s", "K2Node_CustomEvent", "Scan", ["g"]),
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
  ]);
  const finding = report.findings.find((f) => f.check === "level-sweep-maybe-repeating");
  assert.ok(finding, `expected the timer/sweep pairing, got ${findingIds(report).join(", ")}`);
  assert.equal(finding.severity, "info", "an unproven link must not outrank a real defect");
  assert.match(finding.fix, /register|store|once/i);
});

test("a level sweep with no timer and no Tick is left alone", () => {
  const report = reviewGraph("EventGraph", [
    node("e", "K2Node_CustomEvent", "OnBegin", ["g"]),
    node("g", "K2Node_CallFunction", "GetAllActorsOfClass", []),
  ]);
  for (const id of ["level-sweep-every-frame", "level-sweep-maybe-repeating", "level-sweep-repeated"]) {
    assert.ok(!findingIds(report).includes(id), `${id} fired on a one-off sweep`);
  }
});
