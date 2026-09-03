import { test } from "node:test";
import assert from "node:assert/strict";

import { isEntryType } from "../dist/entryTypes.js";
import { reviewLayout } from "../dist/layoutReview.js";

test("the bare form counts, because that is what the summary emits", () => {
  // The graph summary strips K2Node_ before any caller sees a type. Matching only the full class
  // name made every entry node in a real graph invisible: the box suggester went 89 of 100 to 0 of
  // 100, because "CustomEvent" is not in a list of "K2Node_CustomEvent".
  assert.ok(isEntryType("CustomEvent"));
  assert.ok(isEntryType("K2Node_CustomEvent"));
  assert.ok(isEntryType("Event"));
  assert.ok(isEntryType("EnhancedInputAction"));
  assert.ok(isEntryType("ComponentBoundEvent"));
});

test("a non-entry type is still not an entry type in either form", () => {
  assert.ok(!isEntryType("CallFunction"));
  assert.ok(!isEntryType("K2Node_CallFunction"));
  assert.ok(!isEntryType("VariableGet"));
  assert.ok(!isEntryType(undefined));
  assert.ok(!isEntryType(""));
});

test("an input action starts a system, and gets a box", () => {
  // These were the misses that started this: EnhancedInputAction IA_OpenPause, Left Mouse Button,
  // F9 and F10 all start execution chains, and none of their type names contains "Event". The
  // ad-hoc /Event/i test in this file could never have seen them.
  const r = reviewLayout([
    { id: "anchor", title: "Comment", type: "EdGraphNode_Comment", x: -90000, y: -90000, width: 100, height: 100, text: "A" },
    { id: "ia", title: "IA_OpenPause", type: "EnhancedInputAction", x: 0, y: 0, pins: ["out then -> a1.execute"] },
    { id: "a1", title: "Toggle Menu", type: "CallFunction", x: 300, y: 0 },
  ]);
  const f = r.findings.find((x) => x.kind === "unboxed");
  assert.ok(f?.suggest?.length, "an input action should be nameable");
  assert.match(f.suggest[0].text, /Open Pause|IA/);
});
