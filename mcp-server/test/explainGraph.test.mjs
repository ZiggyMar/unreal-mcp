import { test } from "node:test";
import assert from "node:assert/strict";

import { explainGraph } from "../dist/explainGraph.js";

/** Build a summary in the shape read_blueprint_graph_summary returns. */
function graph(nodes) {
  return { path: "/Game/X.X", graphName: "EventGraph", nodes };
}

const node = (id, type, title, links = []) => ({
  id,
  type,
  title,
  connectedPins: links.length
    ? [{ pin: "then", direction: "out", linkedTo: links.map(([n, p]) => ({ node: n, pin: p ?? "execute" })) }]
    : [],
});

test("an event chain is reported in execution order", () => {
  const result = explainGraph(
    graph([
      node("1", "K2Node_Event", "Event BeginPlay", [["2"]]),
      node("2", "K2Node_CallFunction", "Print String", [["3"]]),
      node("3", "K2Node_CallFunction", "Delay"),
    ])
  );

  assert.equal(result.chains.length, 1);
  assert.equal(result.chains[0].entry, "Event BeginPlay");
  assert.deepEqual(result.chains[0].steps, ["Print String", "Delay"]);
  assert.match(result.text, /Event BeginPlay -> Print String -> Delay/);
});

test("an event with nothing wired to it is called out, not omitted", () => {
  // Dead events are one of the most common real defects and they are invisible in a node list.
  // The measured example: a real player Blueprint had two of them.
  const result = explainGraph(graph([node("1", "K2Node_Event", "Event ActorBeginOverlap")]));
  assert.match(result.text, /nothing wired to it/);
});

test("both arms of a branch survive", () => {
  // Following execution depth-first would silently drop the second arm, which is exactly the half
  // of a graph someone is usually asking about.
  const result = explainGraph(
    graph([
      node("1", "K2Node_Event", "Event Tick", [["2"]]),
      {
        id: "2",
        type: "K2Node_IfThenElse",
        title: "Branch",
        connectedPins: [
          { pin: "then", direction: "out", linkedTo: [{ node: "3", pin: "execute" }] },
          { pin: "else", direction: "out", linkedTo: [{ node: "4", pin: "execute" }] },
        ],
      },
      node("3", "K2Node_CallFunction", "Do The Thing"),
      node("4", "K2Node_CallFunction", "Do The Other Thing"),
    ])
  );

  const steps = result.chains[0].steps;
  assert.ok(steps.includes("Do The Thing"), `missing the true arm: ${steps.join(", ")}`);
  assert.ok(steps.includes("Do The Other Thing"), `missing the false arm: ${steps.join(", ")}`);
});

test("a loop back into the chain terminates instead of hanging", () => {
  const result = explainGraph(
    graph([
      node("1", "K2Node_Event", "Event Tick", [["2"]]),
      node("2", "K2Node_CallFunction", "A", [["3"]]),
      node("3", "K2Node_CallFunction", "B", [["2"]]),
    ])
  );
  assert.deepEqual(result.chains[0].steps, ["A", "B"]);
});

test("comment boxes are layout, not behaviour", () => {
  const result = explainGraph(
    graph([
      node("1", "K2Node_Event", "Event BeginPlay", [["2"]]),
      node("2", "K2Node_CallFunction", "Print String"),
      node("9", "EdGraphNode_Comment", "Setup"),
    ])
  );
  assert.ok(!result.text.includes("Setup"), "a comment box was described as behaviour");
  assert.ok(!result.unreachable.includes("Setup"), "a comment box was reported as dead logic");
});

test("nodes no chain reaches are summarised by name and count, not listed one by one", () => {
  const result = explainGraph(
    graph([
      node("1", "K2Node_Event", "Event BeginPlay", [["2"]]),
      node("2", "K2Node_CallFunction", "Print String"),
      node("3", "K2Node_VariableGet", "Get Actor Location"),
      node("4", "K2Node_VariableGet", "Get Actor Location"),
      node("5", "K2Node_VariableGet", "Get Actor Location"),
    ])
  );
  assert.ok(
    result.unreachable.some((entry) => entry === "Get Actor Location (x3)"),
    `expected a counted entry, got ${JSON.stringify(result.unreachable)}`
  );
});

test("every kind of entry point starts a chain", () => {
  // Input events and custom events are where a player-facing Blueprint actually begins; treating
  // only K2Node_Event as an entry would describe a real player Blueprint as almost entirely dead.
  const result = explainGraph(
    graph([
      node("1", "K2Node_InputAxisEvent", "InputAxis MoveForward", [["4"]]),
      node("2", "K2Node_CustomEvent", "Server_Fire", [["4"]]),
      node("3", "K2Node_InputActionEvent", "InputAction Jump", [["4"]]),
      node("4", "K2Node_CallFunction", "Do Something"),
    ])
  );
  assert.equal(result.chains.length, 3);
});

test("the explanation is dramatically smaller than the structure it came from", () => {
  // The entire reason this exists: a real 104-node graph costs ~8,800 tokens as structure, which
  // is more than a small model's whole context. If this ever stops being much cheaper, it has no
  // reason to exist.
  const many = [node("e", "K2Node_Event", "Event BeginPlay", [["n0"]])];
  for (let i = 0; i < 100; i += 1) {
    many.push(node(`n${i}`, "K2Node_CallFunction", `Function Number ${i}`, i < 99 ? [[`n${i + 1}`]] : []));
  }
  const source = graph(many);
  const explained = explainGraph(source);
  const ratio = JSON.stringify(source).length / explained.text.length;
  assert.ok(ratio > 5, `expected a large reduction, got ${ratio.toFixed(1)}x`);
});

test("two entry points running into the same nodes are called out", () => {
  // This caught a mistake in the making. A real Blueprint had Event Begin Play and Event Tick
  // running into ONE shared caching chain, so deleting the part that only makes sense on the
  // server would have silently broken BeginPlay too. Printed one after another the chains look
  // independent; they are not.
  const result = explainGraph(
    graph([
      node("b", "K2Node_Event", "Event BeginPlay", [["shared"]]),
      node("t", "K2Node_Event", "Event Tick", [["shared"]]),
      node("shared", "K2Node_DynamicCast", "Cast To GM_Gameplay", []),
    ])
  );
  assert.match(result.text, /Event BeginPlay and Event Tick run into the same nodes/);
});

test("independent chains are not described as shared", () => {
  const result = explainGraph(
    graph([
      node("b", "K2Node_Event", "Event BeginPlay", [["x"]]),
      node("x", "K2Node_CallFunction", "Do A"),
      node("t", "K2Node_Event", "Event Tick", [["y"]]),
      node("y", "K2Node_CallFunction", "Do B"),
    ])
  );
  assert.ok(!/run into the same nodes/.test(result.text));
});

test("a shared chain is mentioned once, not once per entry", () => {
  const result = explainGraph(
    graph([
      node("b", "K2Node_Event", "Event BeginPlay", [["shared"]]),
      node("t", "K2Node_Event", "Event Tick", [["shared"]]),
      node("shared", "K2Node_CallFunction", "Cache Refs", []),
    ])
  );
  assert.equal((result.text.match(/run into the same nodes/g) ?? []).length, 1);
});

test("a button's On Clicked is an entry point, not dead logic", () => {
  // K2Node_ComponentBoundEvent is what a widget button handler is. Leaving it out described every
  // UMG Blueprint as almost entirely dead - the handlers and the entire menu hanging off them were
  // reported as "not reached by any event chain". Found by reading a real UI Blueprint.
  const result = explainGraph(
    graph([
      node("btn", "K2Node_ComponentBoundEvent", "On Clicked (HostButton)", [["host"]]),
      node("host", "K2Node_CallFunction", "Create Kronos Match", []),
    ])
  );
  assert.equal(result.chains.length, 1);
  assert.match(result.text, /On Clicked \(HostButton\) -> Create Kronos Match/);
  assert.deepEqual(result.unreachable, []);
});

test("a chain longer than the print cap does not report its own live nodes as dead", () => {
  // The regression this guards. Traversal used to stop at 40 steps, so `visited` never learned
  // about anything past it and every later node came back under "not reached by any event chain" -
  // dead logic - while being plainly live. audit.ts builds liveNodeIds from these chains, so one
  // long graph produced a page of false dead-node findings.
  const CHAIN = 60;
  const nodes = [node("e", "K2Node_Event", "Event BeginPlay", [["n0"]])];
  for (let i = 0; i < CHAIN; i++) {
    const next = i === CHAIN - 1 ? [] : [[`n${i + 1}`]];
    nodes.push(node(`n${i}`, "K2Node_CallFunction", `Step ${i}`, next));
  }

  const result = explainGraph(graph(nodes));

  assert.equal(result.unreachable.length, 0, `live nodes reported as unreachable: ${result.unreachable.join(", ")}`);
  assert.equal(result.chains[0].steps.length, CHAIN, "every step should be walked, not just the printed ones");
  assert.equal(
    result.chains[0].nodeIds.length,
    CHAIN + 1,
    "nodeIds feeds audit's liveNodeIds and must cover the whole chain"
  );
});

test("the printed line is still capped, and says how much it left out", () => {
  const CHAIN = 60;
  const nodes = [node("e", "K2Node_Event", "Event BeginPlay", [["n0"]])];
  for (let i = 0; i < CHAIN; i++) {
    const next = i === CHAIN - 1 ? [] : [[`n${i + 1}`]];
    nodes.push(node(`n${i}`, "K2Node_CallFunction", `Step ${i}`, next));
  }

  const result = explainGraph(graph(nodes));
  // 60 walked, 40 printed, so the reader is told about the other 20 rather than "...(more)".
  assert.match(result.text, /\.\.\.\(20 more steps\)/);
  assert.ok(result.chains[0].truncated, "truncated now describes the rendered line");

  // And the cap is a choice the caller can make.
  const full = explainGraph(graph(nodes), { maxStepsPerChain: 100 });
  assert.doesNotMatch(full.text, /more steps/);
  assert.equal(full.chains[0].truncated, false);
});

/** A node with arbitrary pins, for the data-side wiring a Branch condition needs. */
const wired = (id, type, title, pins) => ({ id, type, title, connectedPins: pins });

test("a Branch names what it tests, so the chain carries the decision", () => {
  // The case this was written for. "Branch -> Branch -> Add Force" is true of a thousand graphs and
  // useless in all of them; the second condition being Has Authority is the entire reason a shipped
  // vacuum never ran on a client.
  const result = explainGraph(
    graph([
      wired("1", "K2Node_FunctionEntry", "DraggedByVacuum", [
        { pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] },
      ]),
      wired("2", "K2Node_IfThenElse", "Branch", [
        { pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] },
        { pin: "Condition", direction: "in", linkedTo: [{ node: "cond", pin: "ReturnValue" }] },
        { pin: "then", direction: "out", linkedTo: [{ node: "3", pin: "execute" }] },
      ]),
      wired("cond", "K2Node_CallFunction", "Has Authority", [
        { pin: "ReturnValue", direction: "out", linkedTo: [{ node: "2", pin: "Condition" }] },
      ]),
      wired("3", "K2Node_CallFunction", "Add Force", [
        { pin: "execute", direction: "in", linkedTo: [{ node: "2", pin: "then" }] },
      ]),
    ])
  );

  assert.deepEqual(result.chains[0].steps, ["Branch (Has Authority)", "Add Force"]);
  assert.match(result.text, /Branch \(Has Authority\)/);
});

test("a boolean expression is resolved past the operator that joins it", () => {
  // "Branch (AND Boolean)" says a conjunction decides this, which is true of every AND ever written.
  const result = explainGraph(
    graph([
      wired("1", "K2Node_Event", "Event Tick", [
        { pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] },
      ]),
      wired("2", "K2Node_IfThenElse", "Branch", [
        { pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] },
        { pin: "Condition", direction: "in", linkedTo: [{ node: "and", pin: "ReturnValue" }] },
      ]),
      wired("and", "K2Node_CommutativeAssociativeBinaryOperator", "AND Boolean", [
        { pin: "A", direction: "in", linkedTo: [{ node: "tag", pin: "ReturnValue" }] },
        { pin: "B", direction: "in", linkedTo: [{ node: "not", pin: "ReturnValue" }] },
      ]),
      wired("tag", "K2Node_CallFunction", "CheckGameplayTag", []),
      wired("not", "K2Node_CallFunction", "NOT Boolean", [
        { pin: "A", direction: "in", linkedTo: [{ node: "dead", pin: "ReturnValue" }] },
      ]),
      wired("dead", "K2Node_VariableGet", "Get isDead", []),
    ])
  );

  assert.deepEqual(result.chains[0].steps, ["Branch (CheckGameplayTag AND NOT Get isDead)"]);
});

test("a condition routed through a reroute reports the value, not the wire", () => {
  // A knot is somebody tidying their graph. Reporting it gives "Branch (Reroute Node)".
  const result = explainGraph(
    graph([
      wired("1", "K2Node_Event", "Event Tick", [
        { pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] },
      ]),
      wired("2", "K2Node_IfThenElse", "Branch", [
        { pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] },
        { pin: "Condition", direction: "in", linkedTo: [{ node: "knot", pin: "OutputPin" }] },
      ]),
      wired("knot", "K2Node_Knot", "Reroute Node", [
        { pin: "InputPin", direction: "in", linkedTo: [{ node: "auth", pin: "ReturnValue" }] },
      ]),
      wired("auth", "K2Node_CallFunction", "Has Authority", []),
    ])
  );

  assert.deepEqual(result.chains[0].steps, ["Branch (Has Authority)"]);
});

test("a condition coming from the entry node is named by its parameter", () => {
  const result = explainGraph(
    graph([
      wired("1", "K2Node_FunctionEntry", "SetGameplayTagMC", [
        { pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] },
        { pin: "isAdding", direction: "out", linkedTo: [{ node: "2", pin: "Condition" }] },
      ]),
      wired("2", "K2Node_IfThenElse", "Branch", [
        { pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] },
        { pin: "Condition", direction: "in", linkedTo: [{ node: "1", pin: "isAdding" }] },
      ]),
    ])
  );

  assert.deepEqual(result.chains[0].steps, ["Branch (isAdding)"]);
});

test("nodes feeding a reached step are inputs, not dead logic", () => {
  // The inverted claim this replaced: Has Authority, the AND and Get isDead were all listed under
  // "not reached by any event chain (data nodes or dead logic)" for a function they entirely decide.
  const result = explainGraph(
    graph([
      wired("1", "K2Node_Event", "Event Tick", [
        { pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] },
      ]),
      wired("2", "K2Node_IfThenElse", "Branch", [
        { pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] },
        { pin: "Condition", direction: "in", linkedTo: [{ node: "auth", pin: "ReturnValue" }] },
      ]),
      wired("auth", "K2Node_CallFunction", "Has Authority", []),
      // Genuinely orphaned: wired to nothing at all.
      wired("orphan", "K2Node_CallFunction", "Print String", []),
    ])
  );

  assert.ok(!result.unreachable.includes("Has Authority"), "a branch condition is not dead logic");
  assert.deepEqual(result.unreachable, ["Print String"]);
});

test("a comparison names its operands, and says so when one is a literal", () => {
  // "float < float" is how every numeric gate in every project titles itself.
  const cmp = (title, links) =>
    explainGraph(
      graph([
        wired("1", "K2Node_Event", "Event Tick", [
          { pin: "then", direction: "out", linkedTo: [{ node: "2", pin: "execute" }] },
        ]),
        wired("2", "K2Node_IfThenElse", "Branch", [
          { pin: "execute", direction: "in", linkedTo: [{ node: "1", pin: "then" }] },
          { pin: "Condition", direction: "in", linkedTo: [{ node: "op", pin: "ReturnValue" }] },
        ]),
        wired("op", "K2Node_PromotableOperator", title, links),
        wired("hp", "K2Node_VariableGet", "Get Health", []),
        wired("max", "K2Node_VariableGet", "Get MaxHealth", []),
      ])
    ).chains[0].steps[0];

  assert.equal(
    cmp("float < float", [
      { pin: "A", direction: "in", linkedTo: [{ node: "hp", pin: "ReturnValue" }] },
      { pin: "B", direction: "in", linkedTo: [{ node: "max", pin: "ReturnValue" }] },
    ]),
    "Branch (Get Health < Get MaxHealth)"
  );

  // A literal typed into the pin has no link, so it is not in connectedPins at all. Naming the side
  // that is a variable is still the half a reader can act on.
  assert.equal(
    cmp("float >= float", [{ pin: "A", direction: "in", linkedTo: [{ node: "hp", pin: "ReturnValue" }] }]),
    "Branch (Get Health >= literal)"
  );

  // Nothing resolvable at all falls back rather than inventing structure.
  assert.equal(cmp("float > float", []), "Branch (float > float)");
});
