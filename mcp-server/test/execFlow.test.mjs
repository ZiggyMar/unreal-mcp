import { test } from "node:test";
import assert from "node:assert/strict";

import { execTargets, execSources } from "../dist/execFlow.js";
import { explainGraph } from "../dist/explainGraph.js";

const n = (id, type, title, pins = []) => ({ id, type, title, connectedPins: pins });
const out = (pin, ...links) => ({ pin, direction: "out", linkedTo: links.map(([node, p]) => ({ node, pin: p })) });
const map = (nodes) => new Map(nodes.map((x) => [x.id, x]));

test("a reroute node is stepped over, not stopped at", () => {
  // K2Node_Knot pins are InputPin/OutputPin, which matched no exec name, so every chain drawn by
  // somebody who tidies their graphs was truncated at the first reroute - and everything after it
  // was reported as dead logic. Found in a shipping game, on a multicast that pushes health to
  // clients: it read as "nothing wired to it" because the wire went around a comment box.
  const nodes = [
    n("ev", "K2Node_CustomEvent", "UpdateHealthMC", [out("then", ["knot", "InputPin"])]),
    n("knot", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["work", "execute"])]),
    n("work", "K2Node_CallFunction", "Set Scalar Parameter Value"),
  ];
  const reached = execTargets(nodes[0], map(nodes));
  assert.deepEqual(reached.map((x) => x.title), ["Set Scalar Parameter Value"]);
});

test("several reroutes in a row are all stepped over", () => {
  const nodes = [
    n("ev", "K2Node_Event", "Event BeginPlay", [out("then", ["k1", "InputPin"])]),
    n("k1", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["k2", "InputPin"])]),
    n("k2", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["work", "execute"])]),
    n("work", "K2Node_CallFunction", "Print String"),
  ];
  const result = explainGraph({ graphName: "EventGraph", nodes });
  assert.match(result.text, /Event BeginPlay -> Print String/);
  assert.deepEqual(result.unreachable, [], "the wire itself is not dead logic");
});

test("a reroute carrying data is not mistaken for execution", () => {
  // Knots carry data too, and nothing on them says which. The far end settles it: a data knot lands
  // on a pin like Value, and following it would make everything look reachable from everything.
  const nodes = [
    n("get", "K2Node_VariableGet", "Get Health", [out("Health", ["knot", "InputPin"])]),
    n("knot", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["use", "Value"])]),
    n("use", "K2Node_CallFunction", "Set Scalar Parameter Value"),
  ];
  assert.deepEqual(execTargets(nodes[0], map(nodes)), []);
});

test("a reroute wired in a circle terminates", () => {
  const nodes = [
    n("ev", "K2Node_Event", "Event BeginPlay", [out("then", ["k1", "InputPin"])]),
    n("k1", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["k2", "InputPin"])]),
    n("k2", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["k1", "InputPin"])]),
  ];
  assert.deepEqual(execTargets(nodes[0], map(nodes)), []);
});

test("the source to reroute through a guard is the real node, not the wire", () => {
  // Rewiring the knot would leave the true source pointing at a guard it never reaches.
  const nodes = [
    n("ev", "K2Node_Event", "Event BeginPlay", [out("then", ["knot", "InputPin"])]),
    n("knot", "K2Node_Knot", "Reroute Node", [out("OutputPin", ["cast", "execute"])]),
    n("cast", "K2Node_DynamicCast", "Cast To GM_Gameplay"),
  ];
  assert.deepEqual(execSources("cast", nodes, map(nodes)), [{ fromNode: "ev", fromPin: "then" }]);
});

test("a filtered explanation does not carry notes about chains it withheld", async () => {
  // I added `match` to explain_graph earlier and narrowed only the chain text. Measured afterwards
  // on BP_Player's event graph: match "vacuum" showed 15 chains and still returned 25 entryIds and
  // 10 shared-node notes, and match "zzzznope" showed nothing and still returned all 25 and all 10 -
  // 516 tokens describing exactly what the caller had excluded.
  //
  // Filtering half a reply is worse than not filtering it, because the caller cannot tell which half
  // they are holding.
  const nodes = [
    n("a", "K2Node_Event", "Alpha", [out("then", ["shared", "execute"])]),
    n("b", "K2Node_Event", "Beta", [out("then", ["shared", "execute"])]),
    n("c", "K2Node_Event", "Gamma", [out("then", ["own", "execute"])]),
    n("shared", "K2Node_CallFunction", "Shared Thing", []),
    n("own", "K2Node_CallFunction", "Gamma Only", []),
  ];

  const all = explainGraph({ graphName: "EventGraph", nodes });
  assert.equal((all.text.match(/^Note: /gm) ?? []).length, 1, "Alpha and Beta share a node");
  assert.equal(all.shownEntries.length, 3);

  // Filtered to a chain that shares nothing: the note about the other two must not come along.
  const gamma = explainGraph({ graphName: "EventGraph", nodes }, { match: "Gamma" });
  assert.deepEqual(gamma.shownEntries, ["Gamma"]);
  assert.equal((gamma.text.match(/^Note: /gm) ?? []).length, 0, "that note is about two hidden chains");

  // Filtered to one HALF of a sharing pair: the warning still earns its place, because reaching
  // outside what you are looking at is exactly when it matters.
  const alpha = explainGraph({ graphName: "EventGraph", nodes }, { match: "Alpha" });
  assert.deepEqual(alpha.shownEntries, ["Alpha"]);
  assert.equal((alpha.text.match(/^Note: /gm) ?? []).length, 1);
});
