import { test } from "node:test";
import assert from "node:assert/strict";

// The scope label is produced by the sweep in index.ts, which needs a bridge. What CAN be asserted
// here is the reason it exists: the same measurement genuinely differs by which graphs are counted,
// so a figure without its scope is a figure that will be misquoted.
import { measureStyle } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const fn = (id, x, y) => ({ id, title: id, type: "CallFunction", x, y });

/** An EventGraph-shaped graph: systems in boxes. */
const boxed = [box("b", -100, -100, 1200, 600, "Firing"), fn("a", 0, 0), fn("b1", 300, 0), fn("c", 600, 0)];
/** A function-graph-shaped one: a few nodes, no box. */
const bare = [fn("x", 0, 0), fn("y", 300, 0), fn("z", 600, 0)];

test("including unboxed graphs really does move the nodes-in-a-box figure", () => {
  // Measured on the project: 54% over EventGraphs, 41% once function graphs are counted, because
  // they are small, single-purpose and rarely boxed. Both are true of what they measured - which is
  // exactly why the number cannot travel without saying which.
  const a = measureStyle(boxed);
  const both = [measureStyle(boxed), measureStyle(bare)];
  const pct = (s) => Math.round((100 * s.reduce((t, x) => t + x.nodesInBoxes, 0)) / s.reduce((t, x) => t + x.nodes, 0));
  assert.equal(pct([a]), 100);
  assert.ok(pct(both) < pct([a]), "adding unboxed graphs must lower it, or the scope label is pointless");
});

test("a bare graph contributes nodes but no boxes", () => {
  const s = measureStyle(bare);
  assert.equal(s.nodes, 3);
  assert.equal(s.boxes, 0);
  assert.equal(s.nodesInBoxes, 0);
});
