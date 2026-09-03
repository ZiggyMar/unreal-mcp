import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const ev = (id, x, y, next) => ({ id, title: id, type: "CustomEvent", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });
const fn = (id, x, y, next) => ({ id, title: id, type: "CallFunction", x, y, pins: next ? [`out then -> ${next}.execute`] : [] });

/** Four separated systems and one existing box, the shape verified end to end against an editor. */
function graph() {
  const nodes = [box("existing", -4000, -4000, 300, 200, "Existing")];
  let row = 0;
  for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
    nodes.push(ev(`CE_${name}`, 0, row, `${name}0`));
    for (let k = 0; k < 4; k++) nodes.push(fn(`${name}${k}`, 300 + k * 300, row, k < 3 ? `${name}${k + 1}` : undefined));
    row += 1500;
  }
  return nodes;
}

/**
 * The end-to-end result, kept as a unit test.
 *
 * Applying every suggestion verbatim against a real editor produced two boxes each holding exactly
 * its own five nodes, with no partial overlap and no new findings. That is the promise `suggest`
 * makes - "pass this straight to add_comment_box" - and it had never been checked by drawing one.
 */
test("applying every suggestion leaves no box holding a foreign node", () => {
  const nodes = graph();
  const drawn = (reviewLayout(nodes).findings ?? []).filter((f) => f.kind === "unboxed").flatMap((f) => f.suggest ?? []);
  assert.ok(drawn.length >= 2, `expected boxes to draw, got ${drawn.length}`);

  const real = nodes.filter((n) => n.type !== "EdGraphNode_Comment");
  const holds = (b, n) => n.x >= b.x && n.x <= b.x + b.width && n.y >= b.y && n.y <= b.y + b.height;
  for (const b of drawn) {
    const inside = real.filter((n) => holds(b, n));
    assert.ok(inside.length > 0, `"${b.text}" holds nothing`);
    // Every node it holds must belong to the system it names.
    const stem = b.text.replace(/\s+/g, "");
    assert.ok(inside.every((n) => n.id.includes(stem)), `"${b.text}" holds a foreign node: ${inside.map((n) => n.id).join(",")}`);
  }
});

test("suggested boxes never partially overlap each other or an existing box", () => {
  const nodes = graph();
  const drawn = (reviewLayout(nodes).findings ?? []).filter((f) => f.kind === "unboxed").flatMap((f) => f.suggest ?? []);
  const existing = nodes.filter((n) => n.type === "EdGraphNode_Comment");
  const all = [...existing, ...drawn];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const p = all[i], q = all[j];
      const ov = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
      const nest = (p.x >= q.x && p.y >= q.y && p.x + p.width <= q.x + q.width && p.y + p.height <= q.y + q.height)
                || (q.x >= p.x && q.y >= p.y && q.x + q.width <= p.x + p.width && q.y + q.height <= p.y + p.height);
      assert.ok(!ov || nest, `partial overlap between ${p.text} and ${q.text}`);
    }
  }
});

test("re-reviewing after applying them reports those systems as boxed", () => {
  // The suggestions must actually resolve the finding that produced them, or the loop never closes.
  const nodes = graph();
  const drawn = (reviewLayout(nodes).findings ?? []).filter((f) => f.kind === "unboxed").flatMap((f) => f.suggest ?? []);
  const applied = [...nodes, ...drawn.map((b, i) => box(`new${i}`, b.x, b.y, b.width, b.height, b.text))];
  const still = (reviewLayout(applied).findings ?? []).filter((f) => f.kind === "unboxed");
  const names = JSON.stringify(still.map((f) => f.detail));
  for (const b of drawn) assert.ok(!names.includes(b.text), `"${b.text}" is still reported unboxed after drawing its box`);
});
