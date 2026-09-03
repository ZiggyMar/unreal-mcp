import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const node = (id, x, y, extra = {}) => ({ id, title: id, type: "CallFunction", x, y, ...extra });
const box = (id, x, y, width, height) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width, height });
const kinds = (r) => r.findings.map((f) => f.kind);

test("a chain that runs rightward reports nothing", () => {
  const r = reviewLayout([
    node("a", 0, 0, { pins: ["out then -> b.execute"] }),
    node("b", 300, 0, { pins: ["out then -> c.execute"] }),
    node("c", 600, 0),
  ]);
  assert.deepEqual(r.findings, []);
  assert.equal(r.stats.execWires, 2);
  assert.equal(r.stats.backwardWires, 0);
});

test("a chain that jumps left is reported, with how far", () => {
  // The measurable form of "reads like a book". The user's own graph has 306 exec wires and 0 of
  // these; the ones a model added had 4.
  const r = reviewLayout([
    node("a", 500, 0, { pins: ["out then -> b.execute"] }),
    node("b", 200, 0),
  ]);
  assert.deepEqual(kinds(r), ["backwardFlow"]);
  assert.match(r.findings[0].detail, /300 to its LEFT/);
  assert.equal(r.stats.backwardWires, 1);
});

test("data wires are not direction-checked", () => {
  // A Get feeding a node from below and to the left is normal and correct. Flagging those would
  // bury the execution-order findings that actually matter under noise.
  const r = reviewLayout([
    node("getter", 500, 100, { pins: ["out ReturnValue -> user.A"] }),
    node("user", 200, 0),
  ]);
  assert.deepEqual(kinds(r), []);
});

test("two nodes at the same coordinates are reported as hidden", () => {
  const r = reviewLayout([node("a", 100, 100), node("b", 100, 100)]);
  assert.deepEqual(kinds(r), ["stacked"]);
  assert.match(r.findings[0].detail, /exactly the same place/);
});

test("nodes near enough to overlap on screen are reported too", () => {
  const r = reviewLayout([node("a", 100, 100), node("b", 120, 110)]);
  assert.deepEqual(kinds(r), ["stacked"]);
  assert.match(r.findings[0].detail, /will overlap/);
});

test("nodes merely close together are left alone", () => {
  const r = reviewLayout([node("a", 100, 100), node("b", 400, 100)]);
  assert.deepEqual(kinds(r), []);
});

test("a wire crossing the canvas is reported", () => {
  const r = reviewLayout([node("a", 0, 0, { pins: ["out then -> b.execute"] }), node("b", 9000, 0)]);
  assert.ok(kinds(r).includes("longWire"));
  assert.match(r.findings.find((f) => f.kind === "longWire").detail, /custom event costs no wire/);
});

test("a node outside every comment box is reported", () => {
  const r = reviewLayout([box("box", 0, 0, 500, 500), node("inside", 100, 100), node("stray", 2000, 2000)]);
  const unboxed = r.findings.filter((f) => f.kind === "unboxed");
  assert.equal(unboxed.length, 1);
  assert.deepEqual(unboxed[0].nodes, ["stray"]);
});

test("containment needs the box's SIZE, and says nothing without it", () => {
  // The first version of this check compared against the box ORIGIN only, with an `&& true` filling
  // in for the missing extent - so `.some()` matched any box up-and-left of the node and the check
  // could never fire. A check that cannot fail reads as a clean bill of health, which is worse than
  // no check at all. Sizeless boxes now produce silence rather than false comfort.
  const sizeless = { id: "box", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0 };
  const r = reviewLayout([sizeless, node("stray", 5000, 5000)]);
  assert.deepEqual(
    r.findings.filter((f) => f.kind === "unboxed"),
    [],
    "with no dimensions, containment is unknowable and must not be guessed"
  );
  assert.equal(r.stats.commentBoxes, 1, "the box is still counted, it just cannot judge containment");
});

test("a graph with no boxes at all is not carpet-bombed with findings", () => {
  const r = reviewLayout([node("a", 0, 0), node("b", 400, 0), node("c", 800, 0)]);
  assert.deepEqual(kinds(r), []);
});

test("the Y band limits the audit to one system", () => {
  // Auditing a 982-node graph when the question is about one feature buries the answer.
  const all = [
    node("mine", 0, 10000, { pins: ["out then -> minetwo.execute"] }),
    node("minetwo", -500, 10000),
    node("theirs", 0, 0, { pins: ["out then -> theirstwo.execute"] }),
    node("theirstwo", -500, 0),
  ];
  const r = reviewLayout(all, { minY: 9000 });
  assert.equal(r.stats.nodes, 2);
  assert.equal(r.stats.backwardWires, 1, "only the in-band violation counts");
});

test("comment boxes are counted separately from real nodes", () => {
  const r = reviewLayout([box("b", 0, 0, 100, 100), node("a", 10, 10)]);
  assert.equal(r.stats.nodes, 1);
  assert.equal(r.stats.commentBoxes, 1);
});

test("an X band separates a system built beside other code, not just below it", () => {
  // A system built to the RIGHT of somebody's work shares its rows, so a Y band alone cannot tell
  // the two apart - scoping one returned twelve findings that all belonged to the other.
  const theirs = [node("t1", 0, 100, { pins: ["out then -> t2.execute"] }), node("t2", -400, 100)];
  const mine = [node("m1", 5000, 100, { pins: ["out then -> m2.execute"] }), node("m2", 5300, 100)];
  const r = reviewLayout([...theirs, ...mine], { minX: 4000 });
  assert.equal(r.stats.nodes, 2);
  assert.equal(r.stats.backwardWires, 0, "their backward wire is out of scope and must not be counted");
});

test("stats count only what is in scope, in both axes", () => {
  const all = [node("a", 0, 0), node("b", 5000, 0), node("c", 5000, 9000)];
  assert.equal(reviewLayout(all, { minX: 4000, maxY: 100 }).stats.nodes, 1);
});

test("a comment box with no text is reported", () => {
  // Half the convention is the box; the other half is what it says. A box that groups nodes without
  // naming them draws a rectangle and explains nothing.
  const untitled = { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, width: 500, height: 500 };
  const r = reviewLayout([untitled, node("inside", 100, 100)]);
  const found = r.findings.filter((f) => f.kind === "untitledBox");
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].nodes, ["b"]);
});

test("a titled box is accepted", () => {
  const titled = { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, width: 500, height: 500, text: "Vaccum" };
  const r = reviewLayout([titled, node("inside", 100, 100)]);
  assert.deepEqual(r.findings.filter((f) => f.kind === "untitledBox"), []);
});

test("whitespace is not a title", () => {
  const blank = { id: "b", title: "Comment", type: "EdGraphNode_Comment", x: 0, y: 0, width: 500, height: 500, text: "   \n  " };
  const r = reviewLayout([blank, node("inside", 100, 100)]);
  assert.equal(r.findings.filter((f) => f.kind === "untitledBox").length, 1);
});
