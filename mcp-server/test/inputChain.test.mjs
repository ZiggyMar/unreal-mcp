import { test } from "node:test";
import assert from "node:assert/strict";

import { gatesAlongChain, describeGates } from "../dist/inputChain.js";

// Built from the real chain this was written for: holding the vacuum did nothing, and finding out
// why meant reading the input node, following exec pins, reading each Branch and chasing what fed
// its condition - one call at a time, three times in one session.
//
//   EnhancedInputAction IA_Vacuum -> StartVaccum -> Branch(isAlive) -> Can Aim -> Branch(Can Aim) -> Set Tag

const node = (id, type, title, pins = []) => ({ id, type, title, pins });
const execOut = (name, to) => ({ name, direction: "out", category: "exec", linkedTo: [{ node: to, pin: "execute" }] });
const condFrom = (from) => ({ name: "Condition", direction: "in", category: "bool", linkedTo: [{ node: from, pin: "ReturnValue" }] });

const chain = () =>
  new Map(
    [
      node("input", "K2Node_EnhancedInputAction", "EnhancedInputAction IA_Vacuum", [execOut("Started", "start")]),
      node("start", "K2Node_CustomEvent", "StartVaccum", [execOut("then", "br1")]),
      node("alive", "K2Node_VariableGet", "Get isAlive"),
      node("br1", "K2Node_IfThenElse", "Branch", [condFrom("alive"), execOut("then", "canaim")]),
      node("canaim", "K2Node_MacroInstance", "Can Aim", [execOut("then", "br2")]),
      node("aimret", "K2Node_CallFunction", "Can Aim\nTarget is BP Player"),
      node("br2", "K2Node_IfThenElse", "Branch", [condFrom("aimret"), execOut("then", "tag")]),
      node("tag", "K2Node_CallFunction", "Set Gameplay Tag MC"),
    ].map((n) => [n.id, n])
  );

test("every gate between the input and the effect is named, in order", () => {
  const gates = gatesAlongChain("input", chain());
  assert.deepEqual(
    gates.map((g) => g.reads),
    ["Get isAlive", "Can Aim"],
    "the two conditions that decide whether the vacuum starts"
  );
  // Order is the whole point: the first false one is the one that stopped it.
  assert.ok(gates[0].step < gates[1].step);
});

test("the else path is not followed", () => {
  // `else` is what runs when the gate FAILS. Reporting gates found down there would describe the
  // chain that runs when the ability does not, which is the opposite of the question.
  const nodes = chain();
  nodes.get("br1").pins.push({
    name: "else",
    direction: "out",
    category: "exec",
    linkedTo: [{ node: "elseBranch", pin: "execute" }],
  });
  nodes.set("elseBranch", node("elseBranch", "K2Node_IfThenElse", "Branch", [condFrom("alive")]));
  const gates = gatesAlongChain("input", nodes);
  assert.equal(gates.filter((g) => g.nodeId === "elseBranch").length, 0);
});

test("a gate whose condition source was not read is still reported", () => {
  // Half an answer beats none: the caller still learns a gate exists and where it is.
  const nodes = chain();
  nodes.delete("alive");
  const gates = gatesAlongChain("input", nodes);
  assert.equal(gates.length, 2);
  assert.equal(gates[0].reads, "ReturnValue");
});

test("a chain with no gates reports none rather than inventing one", () => {
  const nodes = new Map(
    [node("input", "K2Node_EnhancedInputAction", "EnhancedInputAction IA_Jump", [execOut("Started", "jump")]), node("jump", "K2Node_CallFunction", "Jump")].map(
      (n) => [n.id, n]
    )
  );
  assert.deepEqual(gatesAlongChain("input", nodes), []);
  assert.equal(describeGates("IA_Jump", []), undefined);
});

test("a loop in the exec graph terminates the walk", () => {
  const nodes = new Map(
    [
      node("a", "K2Node_CustomEvent", "A", [execOut("then", "b")]),
      node("b", "K2Node_CallFunction", "B", [execOut("then", "a")]),
    ].map((n) => [n.id, n])
  );
  assert.deepEqual(gatesAlongChain("a", nodes), []);
});

test("the sentence names the gates in order and says which one matters", () => {
  const text = describeGates("IA_Vacuum", gatesAlongChain("input", chain()));
  assert.match(text, /Get isAlive -> Can Aim/);
  assert.match(text, /FIRST one that is false/);
});

test("a repeated condition is named once", () => {
  // Has Authority twice in a chain is common and saying it twice is noise.
  const nodes = chain();
  nodes.get("br2").pins = [condFrom("alive"), execOut("then", "tag")];
  const text = describeGates("IA_Vacuum", gatesAlongChain("input", nodes));
  assert.equal((text.match(/Get isAlive/g) ?? []).length, 1);
});

test("a call to a custom event is followed into its body", () => {
  // The case that matters and the one the first version missed. An ability's gates live inside the
  // server RPC, not in the input chain that asks for it: pressing the vacuum calls StartVaccum, and
  // isAlive and Can Aim are inside StartVaccum. Calling an event does not link to its body in the
  // exec graph - the body is its own entry point - so following links alone walks straight past.
  const nodes = new Map(
    [
      node("input", "K2Node_EnhancedInputAction", "EnhancedInputAction IA_Vacuum", [execOut("Started", "callStart")]),
      node("callStart", "K2Node_CallFunction", "Start Vaccum\nTarget is BP Player"),
      // The event body, reachable only by name.
      node("evStart", "K2Node_CustomEvent", "Start Vaccum", [execOut("then", "br1")]),
      node("alive", "K2Node_VariableGet", "Get isAlive"),
      node("br1", "K2Node_IfThenElse", "Branch", [condFrom("alive"), execOut("then", "done")]),
      node("done", "K2Node_CallFunction", "Set Gameplay Tag MC"),
    ].map((n) => [n.id, n])
  );
  const events = new Map([["Start Vaccum", "evStart"]]);

  assert.deepEqual(gatesAlongChain("input", nodes, 40).map((g) => g.reads), [], "without the event map it finds nothing");
  assert.deepEqual(
    gatesAlongChain("input", nodes, 40, events).map((g) => g.reads),
    ["Get isAlive"],
    "with it, the gate inside the event is found"
  );
});

test("a call that is not an event in this graph is stepped over, not followed", () => {
  // Print String is not an event here; treating every call as one would send the walk anywhere a
  // name happened to collide.
  const nodes = new Map(
    [
      node("input", "K2Node_EnhancedInputAction", "EnhancedInputAction IA_Test", [execOut("Started", "call")]),
      node("call", "K2Node_CallFunction", "Print String", [execOut("then", "br")]),
      node("cond", "K2Node_VariableGet", "Get Ready"),
      node("br", "K2Node_IfThenElse", "Branch", [condFrom("cond")]),
    ].map((n) => [n.id, n])
  );
  assert.deepEqual(gatesAlongChain("input", nodes, 40, new Map([["Something Else", "nowhere"]])).map((g) => g.reads), ["Get Ready"]);
});

test("a call is matched to its event across the editor's spacing", () => {
  // The bug the first version shipped with, and the reason its own test passed: the editor writes a
  // CALL node's title as a display name - "Start Vaccum" - while the EVENT is named StartVaccum.
  // Matching literally works only when both sides are spelled the same way, which no real graph does.
  const nodes = new Map(
    [
      node("input", "K2Node_EnhancedInputAction", "EnhancedInputAction IA_Vacuum", [execOut("Started", "call")]),
      node("call", "K2Node_CallFunction", "Start Vaccum\nTarget is BP Player"),
      node("ev", "K2Node_CustomEvent", "StartVaccum", [execOut("then", "br")]),
      node("alive", "K2Node_VariableGet", "Get isAlive"),
      node("br", "K2Node_IfThenElse", "Branch", [condFrom("alive")]),
    ].map((n) => [n.id, n])
  );
  const gates = gatesAlongChain("input", nodes, 40, new Map([["StartVaccum", "ev"]]));
  assert.deepEqual(gates.map((g) => g.reads), ["Get isAlive"]);
});
