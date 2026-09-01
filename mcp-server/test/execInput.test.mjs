// Exec input pins that are not called "execute".
//
// execTargets accepted a target pin only if it matched /^(execute|exec|in|then)$/i, and a Timeline
// has none of those. So every execution wire into a timeline was invisible: explain_graph printed
// "nothing wired to it" for live events, and audit.ts - which builds liveNodeIds from the same
// chains - turned everything downstream of a timeline into dead-node findings.
//
// Measured across the real project before fixing: 21 links in 9 graphs of 168 Blueprints, 14 into
// Timelines and 7 into macro Reset pins.
//
// The second half of these tests is the more important half. Widening a name list is easy; the risk
// is a DATA pin called "Play" or "Reset" being counted as execution and inventing a chain that does
// not run. Hence the match is per node type.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isExecInput, execTargets } from "../dist/execFlow.js";

const timeline = { id: "t", type: "K2Node_Timeline", title: "TL_Aim" };
const macro = { id: "m", type: "K2Node_MacroInstance", title: "Do Once" };
const call = { id: "c", type: "K2Node_CallFunction", title: "Set Health" };

test("the ordinary names still work, on every node type", () => {
  for (const node of [timeline, macro, call]) {
    for (const name of ["execute", "exec", "in", "then", "Execute", "THEN"]) {
      assert.equal(isExecInput(node, name), true, `${node.type} / ${name}`);
    }
  }
});

test("a Timeline's own exec inputs count", () => {
  for (const name of ["Play", "PlayFromStart", "Stop", "Reverse", "ReverseFromEnd", "SetNewTime"]) {
    assert.equal(isExecInput(timeline, name), true, name);
  }
});

test("a macro's Enter/Open/Close/Toggle/Reset count", () => {
  for (const name of ["Enter", "Open", "Close", "Toggle", "Reset"]) {
    assert.equal(isExecInput(macro, name), true, name);
  }
});

test("the same names on an ordinary node do NOT count", () => {
  // This is the whole reason the check takes the node. "Play" is a fine name for a bool on a sound
  // node and "Reset" for one on a counter; counting either as execution invents a chain.
  for (const name of ["Play", "PlayFromStart", "Reset", "Open", "Stop"]) {
    assert.equal(isExecInput(call, name), false, name);
  }
});

test("a Timeline does not get the macro names, nor a macro the Timeline ones", () => {
  assert.equal(isExecInput(timeline, "Toggle"), false);
  assert.equal(isExecInput(macro, "PlayFromStart"), false);
});

test("types are matched with or without the K2Node_ prefix", () => {
  // Raw bridge replies carry K2Node_Timeline; compacted tool replies carry Timeline. Both reach
  // this code depending on the caller, and a check that only knew one would fix half the bug.
  assert.equal(isExecInput({ type: "Timeline" }, "PlayFromStart"), true);
  assert.equal(isExecInput({ type: "K2Node_Timeline" }, "PlayFromStart"), true);
});

test("an unknown or absent type falls back to the ordinary names only", () => {
  assert.equal(isExecInput(undefined, "then"), true);
  assert.equal(isExecInput(undefined, "PlayFromStart"), false);
  assert.equal(isExecInput({}, "Play"), false);
});

test("execTargets now follows an event into a timeline", () => {
  // The exact shape that was reported as dead: an event whose `then` runs into PlayFromStart.
  const event = {
    id: "e",
    type: "K2Node_CustomEvent",
    title: "VacuumPushedMC",
    connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "t", pin: "PlayFromStart" }] }],
  };
  const byId = new Map([
    ["e", event],
    ["t", timeline],
  ]);
  assert.deepEqual(
    execTargets(event, byId).map((n) => n.id),
    ["t"]
  );
});

test("execTargets still refuses a data link that happens to be named Play", () => {
  const setter = {
    id: "s",
    type: "K2Node_CallFunction",
    title: "Set Should Play",
    connectedPins: [{ pin: "ReturnValue", direction: "out", linkedTo: [{ node: "c", pin: "Play" }] }],
  };
  const byId = new Map([
    ["s", setter],
    ["c", call],
  ]);
  assert.deepEqual(execTargets(setter, byId), []);
});
