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
