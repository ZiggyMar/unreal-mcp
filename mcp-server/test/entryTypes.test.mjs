import { test } from "node:test";
import assert from "node:assert/strict";

import { ENTRY_TYPES, isEntryType } from "../dist/entryTypes.js";

// Every kind here was added because leaving it out produced a confident wrong answer about real
// code, so the tests are named after the wrong answer rather than after the type.

test("an Enhanced Input action starts a chain", () => {
  // Its absence made explain_graph list 25 entry points for a player Blueprint and not one input
  // action, and made trace_function_calls call a live ping system dead.
  assert.equal(isEntryType("K2Node_EnhancedInputAction"), true);
  assert.equal(isEntryType("K2Node_EnhancedInputActionEvent"), true);
});

test("a button's On Clicked starts a chain", () => {
  // Its absence described whole menus as dead code.
  assert.equal(isEntryType("K2Node_ComponentBoundEvent"), true);
});

test("the ordinary kinds still count", () => {
  for (const kind of ["K2Node_Event", "K2Node_CustomEvent", "K2Node_FunctionEntry", "K2Node_Timeline"]) {
    assert.equal(isEntryType(kind), true, `${kind} should start a chain`);
  }
});

test("a mid-chain node does not start a chain", () => {
  // The check has to be able to say no, or everything is an entry point and nothing is dead code.
  for (const kind of ["K2Node_CallFunction", "K2Node_IfThenElse", "K2Node_VariableGet", "K2Node_Knot"]) {
    assert.equal(isEntryType(kind), false, `${kind} is not an entry point`);
  }
});

test("a missing type is handled rather than thrown on", () => {
  // Node type comes off the wire and may be absent; a reader crashing on that is worse than a
  // reader that says "not an entry".
  assert.equal(isEntryType(undefined), false);
  assert.equal(isEntryType(""), false);
});

test("the list has no duplicates", () => {
  assert.equal(new Set(ENTRY_TYPES).size, ENTRY_TYPES.length, ENTRY_TYPES.join(", "));
});
