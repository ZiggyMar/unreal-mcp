/**
 * The decompiler's job is to produce code that says what the graph does. These tests are written
 * against the two things that actually go wrong: control flow rendered as a flat list (which is
 * what every naive version does), and arguments silently disappearing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { decompileGraph, DSL_GRAMMAR } from "../dist/graphDsl.js";

const link = (node, pin) => ({ node, pin });

/** BeginPlay -> Branch(bIsOpen) -> then: PrintString "open" / else: PrintString "shut" */
function branchingGraph() {
  return {
    graphName: "EventGraph",
    nodes: [
      {
        id: "n_event",
        type: "K2Node_Event",
        title: "Event BeginPlay",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [link("n_branch", "execute")] }],
      },
      {
        id: "n_get",
        type: "K2Node_VariableGet",
        title: "bIsOpen",
        connectedPins: [{ pin: "bIsOpen", direction: "out", linkedTo: [link("n_branch", "Condition")] }],
      },
      {
        id: "n_branch",
        type: "K2Node_IfThenElse",
        title: "Branch",
        connectedPins: [
          { pin: "execute", direction: "in", linkedTo: [link("n_event", "then")] },
          { pin: "Condition", direction: "in", linkedTo: [link("n_get", "bIsOpen")] },
          { pin: "then", direction: "out", linkedTo: [link("n_open", "execute")] },
          { pin: "else", direction: "out", linkedTo: [link("n_shut", "execute")] },
        ],
      },
      {
        id: "n_open",
        type: "K2Node_CallFunction",
        title: "Print String",
        values: { InString: "open" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [link("n_branch", "then")] }],
      },
      {
        id: "n_shut",
        type: "K2Node_CallFunction",
        title: "Print String",
        values: { InString: "shut" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [link("n_branch", "else")] }],
      },
    ],
  };
}

test("a branch is rendered as if/else, not as a flat list", () => {
  const { code, warnings } = decompileGraph(branchingGraph());

  assert.match(code, /\(event EventBeginPlay/, "the title's spaces are removed so the name round-trips");
  assert.match(code, /\(if bIsOpen/, "the condition is the variable, read through its wire");
  assert.match(code, /\(else/);
  // The two prints must be on opposite sides of the else, not one after the other.
  const thenIdx = code.indexOf('"open"');
  const elseIdx = code.indexOf("(else");
  const shutIdx = code.indexOf('"shut"');
  assert.ok(thenIdx > 0 && elseIdx > thenIdx && shutIdx > elseIdx, `wrong ordering:\n${code}`);
  assert.deepEqual(warnings, []);
});

test("literals survive, with the pin that carries them", () => {
  const { code } = decompileGraph(branchingGraph());
  assert.match(code, /\(call PrintString :InString "open"\)/);
});

test("a boolean literal is not quoted and a string one is", () => {
  const g = {
    nodes: [
      {
        id: "e",
        type: "K2Node_Event",
        title: "BeginPlay",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [link("c", "execute")] }],
      },
      {
        id: "c",
        type: "K2Node_CallFunction",
        title: "Set Hidden",
        values: { bNewHidden: "true", Count: "3", Reason: "hello" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [link("e", "then")] }],
      },
    ],
  };
  const { code } = decompileGraph(g);
  assert.match(code, /:bNewHidden true/, "a boolean is a bare token");
  assert.match(code, /:Reason "hello"/, "text is quoted");
  assert.match(code, /:Count 3/, "a number is a bare token");
});

test("a reroute knot is stepped over, not reported as a step", () => {
  const g = {
    nodes: [
      {
        id: "e",
        type: "K2Node_Event",
        title: "BeginPlay",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [link("k", "InputPin")] }],
      },
      {
        id: "k",
        type: "K2Node_Knot",
        title: "Reroute Node",
        connectedPins: [
          { pin: "InputPin", direction: "in", linkedTo: [link("e", "then")] },
          { pin: "OutputPin", direction: "out", linkedTo: [link("c", "execute")] },
        ],
      },
      {
        id: "c",
        type: "K2Node_CallFunction",
        title: "Print String",
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [link("k", "OutputPin")] }],
      },
    ],
  };
  const { code } = decompileGraph(g);
  assert.match(code, /PrintString/);
  assert.doesNotMatch(code, /Reroute/, "a wire is not a step");
});

test("a pure node is inlined into the argument that uses it", () => {
  const g = {
    nodes: [
      {
        id: "e",
        type: "K2Node_Event",
        title: "BeginPlay",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [link("p", "execute")] }],
      },
      {
        id: "pure",
        type: "K2Node_CallFunction",
        title: "Get Actor Location",
        connectedPins: [{ pin: "ReturnValue", direction: "out", linkedTo: [link("p", "NewLocation")] }],
      },
      {
        id: "p",
        type: "K2Node_CallFunction",
        title: "Set Actor Location",
        connectedPins: [
          { pin: "execute", direction: "in", linkedTo: [link("e", "then")] },
          { pin: "NewLocation", direction: "in", linkedTo: [link("pure", "ReturnValue")] },
        ],
      },
    ],
  };
  const { code } = decompileGraph(g);
  assert.match(code, /:NewLocation \(GetActorLocation\)/, `pure node should be inlined:\n${code}`);
});

test("a cast renders its outcomes as named continuations", () => {
  const g = {
    nodes: [
      {
        id: "e",
        type: "K2Node_Event",
        title: "BeginPlay",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [link("cast", "execute")] }],
      },
      {
        id: "cast",
        type: "K2Node_DynamicCast",
        title: "Cast To BP_Door",
        connectedPins: [
          { pin: "execute", direction: "in", linkedTo: [link("e", "then")] },
          { pin: "then", direction: "out", linkedTo: [link("ok", "execute")] },
          { pin: "CastFailed", direction: "out", linkedTo: [link("bad", "execute")] },
        ],
      },
      {
        id: "ok",
        type: "K2Node_CallFunction",
        title: "Print String",
        values: { InString: "door" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [link("cast", "then")] }],
      },
      {
        id: "bad",
        type: "K2Node_CallFunction",
        title: "Print String",
        values: { InString: "not a door" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [link("cast", "CastFailed")] }],
      },
    ],
  };
  const { code } = decompileGraph(g);
  assert.match(code, /\(cast BP_Door/, "the cast names its target class, not its editor label");
  assert.match(code, /\(:then/);
  assert.match(code, /\(:CastFailed/);
  assert.ok(code.indexOf('"door"') < code.indexOf("(:CastFailed"), "each branch under its own continuation");
});

test("a cycle stops instead of hanging", () => {
  const g = {
    nodes: [
      {
        id: "e",
        type: "K2Node_Event",
        title: "Tick",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [link("a", "execute")] }],
      },
      {
        id: "a",
        type: "K2Node_CallFunction",
        title: "A",
        connectedPins: [
          { pin: "execute", direction: "in", linkedTo: [link("e", "then")] },
          { pin: "then", direction: "out", linkedTo: [link("b", "execute")] },
        ],
      },
      {
        id: "b",
        type: "K2Node_CallFunction",
        title: "B",
        connectedPins: [
          { pin: "execute", direction: "in", linkedTo: [link("a", "then")] },
          { pin: "then", direction: "out", linkedTo: [link("a", "execute")] },
        ],
      },
    ],
  };
  const { code } = decompileGraph(g);
  assert.match(code, /loops back/);
});

test("missing literals are reported, not silently dropped", () => {
  const g = branchingGraph();
  // Strip every literal, as an older plugin without includeDefaults would return.
  for (const n of g.nodes) delete n.values;

  const { warnings, code } = decompileGraph(g);
  assert.ok(
    warnings.some((w) => /withPinValues/.test(w)),
    "the caller must be told the arguments are missing"
  );
  assert.match(code, /\(if bIsOpen/, "structure is still correct without literals");
});

test("orphaned nodes are counted rather than ignored", () => {
  const g = branchingGraph();
  g.nodes.push({ id: "lonely", type: "K2Node_CallFunction", title: "Unused", connectedPins: [] });
  const { orphaned } = decompileGraph(g);
  assert.equal(orphaned, 1);
});

test("a graph with no entry point says so", () => {
  const g = { nodes: [{ id: "x", type: "K2Node_VariableGet", title: "V", connectedPins: [] }] };
  const { warnings } = decompileGraph(g);
  assert.ok(warnings.some((w) => /no entry point/.test(w)));
});

test("an empty graph is empty, not an error", () => {
  const r = decompileGraph({ nodes: [] });
  assert.equal(r.code, "");
  assert.deepEqual(r.warnings, []);
  assert.equal(r.orphaned, 0);
});

test("the DSL is dramatically cheaper than the structure it came from", () => {
  const g = branchingGraph();
  const structure = JSON.stringify(g).length;
  const { code } = decompileGraph(g);
  assert.ok(
    code.length < structure * 0.5,
    `DSL ${code.length} chars vs structure ${structure} - the whole point is that it is smaller`
  );
});

test("the grammar documents every form the reader can emit", () => {
  for (const form of ["(event", "(fn", "(call", "(set", "(cast", "(macro", "(bind", "(if", "(else", "(:"]) {
    assert.ok(DSL_GRAMMAR.includes(form), `grammar is missing ${form}`);
  }
});
