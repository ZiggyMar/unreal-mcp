/**
 * The write half. The test that matters most is the last one: text produced by the reader has to be
 * accepted by the writer, or the two halves are separate features that happen to look alike.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { compileDsl, parseDsl, DslError } from "../dist/graphDslCompile.js";
import { decompileGraph } from "../dist/graphDsl.js";

const wired = (c, from, to) => c.some((x) => x.from === from && x.to === to);
const refOf = (nodes, pred) => nodes.find(pred)?.ref;

test("a linear chain wires each statement to the next", () => {
  const { nodes, connections } = compileDsl(`
    (event BeginPlay
      (call PrintString :InString "one")
      (call PrintString :InString "two"))
  `);

  const event = refOf(nodes, (n) => n.nodeType === "Event");
  const calls = nodes.filter((n) => n.nodeType === "CallFunction");
  assert.equal(calls.length, 2);
  assert.ok(wired(connections, `${event}.then`, `${calls[0].ref}.execute`));
  assert.ok(wired(connections, `${calls[0].ref}.then`, `${calls[1].ref}.execute`), "second call follows the first");
});

test("BeginPlay is an engine Event and a made-up name is a CustomEvent", () => {
  assert.equal(compileDsl("(event BeginPlay (call A))").nodes[0].nodeType, "Event");
  assert.equal(compileDsl("(event OnDoorOpened (call A))").nodes[0].nodeType, "CustomEvent");
});

test("literals become pin defaults and wires become connections", () => {
  const { nodes, pinDefaults, connections } = compileDsl(`
    (event BeginPlay
      (call SetActorHiddenInGame :bNewHidden true :Target myActor))
  `);
  assert.ok(pinDefaults.some((p) => p.pin === "bNewHidden" && p.value === "true"));
  const varGet = nodes.find((n) => n.nodeType === "VariableGet" && n.variableName === "myActor");
  assert.ok(varGet, "a bare word is read as a variable");
  const call = nodes.find((n) => n.functionName === "SetActorHiddenInGame");
  assert.ok(wired(connections, `${varGet.ref}.myActor`, `${call.ref}.Target`));
});

test("an if wires both branches off the Branch node and nothing after it", () => {
  const { nodes, connections } = compileDsl(`
    (event BeginPlay
      (if bIsLocked
        (call PrintString :InString "locked")
        (else
          (set bIsLocked true))))
  `);

  const branch = refOf(nodes, (n) => n.nodeType === "Branch");
  const print = refOf(nodes, (n) => n.functionName === "PrintString");
  const set = refOf(nodes, (n) => n.nodeType === "VariableSet");

  assert.ok(wired(connections, `${branch}.then`, `${print}.execute`));
  assert.ok(wired(connections, `${branch}.else`, `${set}.execute`));
  assert.ok(
    !connections.some((c) => c.from === `${branch}.then` && c.to === `${set}.execute`),
    "the else body must not also hang off then"
  );
});

test("a pure call inside an argument becomes a pure node wired into that pin", () => {
  const { nodes, connections } = compileDsl(`
    (event BeginPlay
      (call SetActorLocation :NewLocation (GetActorLocation)))
  `);
  const pure = nodes.find((n) => n.functionName === "GetActorLocation");
  const outer = nodes.find((n) => n.functionName === "SetActorLocation");
  assert.equal(pure.pure, true, "an expression node is pure; it has no place in the exec chain");
  assert.ok(wired(connections, `${pure.ref}.ReturnValue`, `${outer.ref}.NewLocation`));
});

test("named continuations wire their own bodies and end the chain", () => {
  const { nodes, connections } = compileDsl(`
    (event BeginPlay
      (cast BP_Door :Object hitActor
        (:then (call PrintString :InString "door"))
        (:CastFailed (call PrintString :InString "not a door"))))
  `);
  const cast = refOf(nodes, (n) => n.nodeType === "Cast");
  const prints = nodes.filter((n) => n.functionName === "PrintString");
  assert.equal(prints.length, 2);
  assert.ok(wired(connections, `${cast}.then`, `${prints[0].ref}.execute`));
  assert.ok(wired(connections, `${cast}.CastFailed`, `${prints[1].ref}.execute`));
});

test("a bind lets a later statement use an earlier result", () => {
  const { nodes, connections } = compileDsl(`
    (event BeginPlay
      (bind hit (call LineTraceByChannel))
      (call PrintString :InString hit))
  `);
  const trace = refOf(nodes, (n) => n.functionName === "LineTraceByChannel");
  const print = refOf(nodes, (n) => n.functionName === "PrintString");
  assert.ok(wired(connections, `${trace}.ReturnValue`, `${print}.InString`));
  assert.ok(
    !nodes.some((n) => n.nodeType === "VariableGet" && n.variableName === "hit"),
    "a bound name is not a variable read"
  );
});

test("comments and strings containing parens do not break the reader", () => {
  const forms = parseDsl(`
    ; a comment with ( unbalanced parens
    (event BeginPlay
      (call PrintString :InString "text with ) and ( in it"))
  `);
  assert.equal(forms.length, 1);
  const { pinDefaults } = compileDsl(`(event BeginPlay (call PrintString :InString "a ) b"))`);
  assert.equal(pinDefaults[0].value, "a ) b");
});

test("syntax errors name the line and do not reach the editor", () => {
  assert.throws(() => compileDsl("(event BeginPlay (call A)"), (e) => e instanceof DslError && /unbalanced/.test(e.message));
  assert.throws(() => compileDsl("(call PrintString)"), /event .* or \(fn/);
  assert.throws(() => compileDsl("(event E (call A :InString))"), /:InString has no value/);
  assert.throws(() => compileDsl("(event E (frobnicate X))"), /unknown statement/);
  assert.throws(() => compileDsl(""), /nothing to build/);
});

test("statements after a branch are rejected rather than silently dropped", () => {
  assert.throws(
    () => compileDsl(`(event E (if c (call A)) (call B))`),
    /unreachable/,
    "nothing can follow a branch; wiring it anywhere would be a guess"
  );
});

test("ROUND TRIP: the reader's output is accepted by the writer", () => {
  const l = (n, p) => ({ node: n, pin: p });
  const graph = {
    graphName: "EventGraph",
    nodes: [
      {
        id: "e",
        type: "K2Node_Event",
        title: "Event BeginPlay",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [l("br", "execute")] }],
      },
      {
        id: "v",
        type: "K2Node_VariableGet",
        title: "Get bIsLocked",
        connectedPins: [{ pin: "bIsLocked", direction: "out", linkedTo: [l("br", "Condition")] }],
      },
      {
        id: "br",
        type: "K2Node_IfThenElse",
        title: "Branch",
        connectedPins: [
          { pin: "execute", direction: "in", linkedTo: [l("e", "then")] },
          { pin: "Condition", direction: "in", linkedTo: [l("v", "bIsLocked")] },
          { pin: "then", direction: "out", linkedTo: [l("p", "execute")] },
          { pin: "else", direction: "out", linkedTo: [l("s", "execute")] },
        ],
      },
      {
        id: "p",
        type: "K2Node_CallFunction",
        title: "Print String",
        values: { InString: "locked" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [l("br", "then")] }],
      },
      {
        id: "s",
        type: "K2Node_VariableSet",
        title: "SET bIsLocked",
        values: { bIsLocked: "true" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [l("br", "else")] }],
      },
    ],
  };

  const { code, warnings } = decompileGraph(graph);
  assert.deepEqual(warnings, [], `reader complained:\n${code}`);

  const built = compileDsl(code);

  // The same shapes must come back out: one event, one branch, one print, one variable set.
  assert.equal(built.nodes.filter((n) => n.nodeType === "Event").length, 1);
  assert.equal(built.nodes.filter((n) => n.nodeType === "Branch").length, 1);
  assert.equal(built.nodes.filter((n) => n.functionName === "PrintString").length, 1);
  assert.equal(built.nodes.filter((n) => n.nodeType === "VariableSet").length, 1);

  // And the literals survived the trip, which is the part that silently rots.
  assert.ok(built.pinDefaults.some((p) => p.value === "locked"));
  assert.ok(built.pinDefaults.some((p) => p.value === "true"));

  const branch = built.nodes.find((n) => n.nodeType === "Branch").ref;
  const print = built.nodes.find((n) => n.functionName === "PrintString").ref;
  const set = built.nodes.find((n) => n.nodeType === "VariableSet").ref;
  assert.ok(wired(built.connections, `${branch}.then`, `${print}.execute`));
  assert.ok(wired(built.connections, `${branch}.else`, `${set}.execute`));
});

test("ROUND TRIP: an edit to the text is an edit to the graph", () => {
  const source = `(event BeginPlay
  (call PrintString :InString "before"))`;
  const edited = source.replace('"before"', '"after"');
  const built = compileDsl(edited);
  assert.ok(built.pinDefaults.some((p) => p.pin === "InString" && p.value === "after"));
  assert.equal(built.pinDefaults.length, 1);
});

test("a function block is refused, not built unattached", () => {
  // The reader emits (fn ...) for any function graph, so this is a real round trip somebody will
  // attempt. The first version of the writer lowered the body and wired nothing to the function's
  // entry node - every statement orphaned, compiling to nothing. A function that silently does not
  // run is worse than one that was never written.
  assert.throws(
    () => compileDsl('(fn DoTheThing (call PrintString :InString "hi"))'),
    (e) => {
      assert.match(e.message, /cannot be written back yet/);
      assert.match(e.message, /never run/, "it must say what the silent failure would have been");
      assert.match(e.message, /graphName/, "and what to do instead");
      return true;
    }
  );
});

test("refusing a function block does not half-build it", () => {
  // Nothing may reach the editor from a refused parse - the throw has to happen before any caller
  // could take ctx.nodes and send them.
  let built;
  try {
    built = compileDsl('(fn F (call A))');
  } catch {
    built = undefined;
  }
  assert.equal(built, undefined, "a refusal returns nothing, not a partial payload");
});

test("reading a function graph still works even though writing one does not", async () => {
  const { decompileGraph } = await import("../dist/graphDsl.js");
  const g = {
    nodes: [
      {
        id: "entry",
        type: "K2Node_FunctionEntry",
        title: "DoTheThing",
        connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "c", pin: "execute" }] }],
      },
      {
        id: "c",
        type: "K2Node_CallFunction",
        title: "Print String",
        values: { InString: "hi" },
        connectedPins: [{ pin: "execute", direction: "in", linkedTo: [{ node: "entry", pin: "then" }] }],
      },
    ],
  };
  const { code } = decompileGraph(g);
  assert.match(code, /\(fn DoTheThing/, "the read side is unaffected by the write side's limit");
  assert.match(code, /:InString "hi"/);
});
