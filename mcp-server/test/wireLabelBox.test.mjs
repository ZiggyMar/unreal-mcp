import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({
  id, type: "EdGraphNode_Comment", title: "Comment", x, y, width: w, height: h, text,
});
const knot = (id, x, y) => ({ id, title: "Reroute Node", type: "K2Node_Knot", x, y, pins: [] });
const fn = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x, y, pins });
const kinds = (r) => r.findings.map((f) => f.kind);

test("a knot-only box PAIRED with one of the same x and width is a wire label", () => {
  // Measured in BP_Player. "Is Vacuuming Data" and "Is Not Vacuuming Data" share an x and a width,
  // stacked inside "Set Vacuuming Data VFX" - one label per branch of a condition, each drawn round
  // the reroute on that path. Calling the knot-only one empty advised deleting half the pair.
  const nodes = [
    box("labelA", 0, 0, 400, 128, "Is Vacuuming Data"),
    knot("k0", 60, 60),
    fn("spawn", 120, 70),
    box("labelB", 0, 208, 400, 128, "Is Not Vacuuming Data"),
    knot("k1", 60, 260),
    box("other", 2000, 0, 600, 400, "Real System"),
    fn("a", 2100, 60, ["out then -> b.execute"]),
    fn("b", 2400, 60),
  ];
  assert.ok(!kinds(reviewLayout(nodes)).includes("emptyBox"));
});

test("a LONE knot-only box is still reported empty", () => {
  // The original measurement stands: a knot is a bend in a wire, and a box round one on its own
  // describes no system. Only the paired case is exempt.
  const nodes = [
    box("lonely", 0, 0, 800, 400, "Leftover"),
    knot("k1", 100, 100),
    box("other", 3000, 0, 600, 400, "Real System"),
    fn("a", 3100, 60, ["out then -> b.execute"]),
    fn("b", 3400, 60),
  ];
  assert.ok(kinds(reviewLayout(nodes)).includes("emptyBox"));
});

test("a box holding nothing at all is still reported", () => {
  // "DebugDamage" in the same graph: 624x544 with no node of any kind inside. That one is debris.
  const nodes = [
    box("dead", 0, 0, 624, 544, "DebugDamage"),
    box("other", 2000, 0, 600, 400, "Real System"),
    fn("a", 2100, 60, ["out then -> b.execute"]),
    fn("b", 2400, 60),
  ];
  const r = reviewLayout(nodes);
  const f = r.findings.find((x) => x.kind === "emptyBox");
  assert.ok(f, "expected DebugDamage to be reported");
  assert.match(f.detail, /DebugDamage/);
});

test("a box with a knot AND a real node is not empty either", () => {
  // The other half of the pair - "Is Vacuuming Data" also contains a SpawnActor, which is why it
  // never tripped the check. It must stay silent for the same reason after the fix.
  const nodes = [
    box("label", 0, 0, 400, 128, "Is Vacuuming Data"),
    knot("k1", 60, 60),
    fn("spawn", 120, 70),
    box("other", 2000, 0, 600, 400, "Real System"),
    fn("a", 2100, 60, ["out then -> b.execute"]),
    fn("b", 2400, 60),
  ];
  assert.ok(!kinds(reviewLayout(nodes)).includes("emptyBox"));
});
