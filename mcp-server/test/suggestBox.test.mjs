import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewLayout } from "../dist/layoutReview.js";

const box = (id, x, y, w, h, text) => ({ id, title: "Comment", type: "EdGraphNode_Comment", x, y, width: w, height: h, text });
const ev = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CustomEvent", x, y, pins });
const fn = (id, x, y, pins = []) => ({ id, title: id, type: "K2Node_CallFunction", x, y, pins });
const suggestion = (r) => r.findings.find((f) => f.kind === "unboxed")?.suggest;

// A box far away, so the unboxed check runs at all - it stays silent when no box carries dimensions.
const anchor = box("anchor", -90000, -90000, 100, 100, "Anchor");

test("a cluster with room gets a rectangle ready to draw", () => {
  const r = reviewLayout([
    anchor,
    ev("ApplyTicketSkin", 0, 0, ["out then -> a.execute"]),
    fn("a", 300, 0, ["out then -> b.execute"]),
    fn("b", 600, 0),
  ]);
  const s = suggestion(r);
  assert.ok(s, "a safe box should be offered");
  assert.equal(s.text, "ApplyTicketSkin");
  // It must actually contain the cluster, node bodies included.
  assert.ok(s.x < 0 && s.y < 0);
  assert.ok(s.x + s.width > 600 + 260, "wide enough for the last node's body");
});

test("no box is offered when it would capture somebody else's node", () => {
  // A box drawn a little too wide adopts a node belonging to another system. That was a live bug
  // here in the tidier, in the other direction.
  const r = reviewLayout([
    anchor,
    ev("Alpha", 0, 0, ["out then -> a.execute"]),
    fn("a", 300, 0, ["out then -> b.execute"]),
    fn("b", 600, 0),
    // A stranger sitting just past the cluster, in its own box so it is not part of the finding.
    box("theirs", 700, -400, 400, 900, "Theirs"),
    fn("stranger", 750, 0),
  ]);
  assert.equal(suggestion(r), undefined);
});

test("no box is offered when it would half-overlap an existing box", () => {
  // Two boxes sharing a region both claim the same nodes, and dragging either corrupts the other.
  //
  // The first version of this test put the box where shrinking the padding got around it, and the
  // suggestion was correct to shrink. This one sits on the right margin every padding needs, holds
  // none of the cluster's nodes, and so cannot be avoided at any size.
  const r = reviewLayout([
    box("near", 700, -50, 900, 200, "Near"),
    ev("Alpha", 0, 0, ["out then -> a.execute"]),
    fn("a", 300, 0, ["out then -> b.execute"]),
    fn("b", 600, 0),
  ]);
  assert.equal(suggestion(r), undefined);
});

test("nesting inside a bigger box is allowed, not treated as a clash", () => {
  // 104 nested pairs in this project - an outer box naming the system, inner ones naming its parts.
  const r = reviewLayout([
    box("outer", -5000, -5000, 20000, 20000, "Everything"),
    ev("Alpha", 0, 0, ["out then -> a.execute"]),
    fn("a", 300, 0, ["out then -> b.execute"]),
    fn("b", 600, 0),
  ]);
  // The nodes sit inside `outer`, so they are not unboxed at all - and that is the point: nesting
  // is never the thing that blocks a suggestion.
  assert.deepEqual(r.findings.filter((f) => f.kind === "unboxed"), []);
});

test("a cluster with no entry event gets no box, because it has no name", () => {
  // An untitled box groups nodes while explaining nothing, which this file reports as a fault in
  // its own right. Offering one would be suggesting the next finding.
  const r = reviewLayout([anchor, fn("a", 0, 0, ["out then -> b.execute"]), fn("b", 300, 0), fn("c", 600, 0)]);
  assert.equal(suggestion(r), undefined);
});

test("a cluster covering several systems gets no single box", () => {
  // Three entry points is three systems sitting together. One box round all of them would claim a
  // system that does not exist - the same mistake as naming a cluster after its first event.
  const r = reviewLayout([
    anchor,
    ev("CE_ServerSound", 0, 0),
    ev("CE_MC_Sound", 200, 0),
    ev("CE_ClientSound", 400, 0),
  ]);
  assert.equal(suggestion(r), undefined);
});

test("padding shrinks rather than giving up", () => {
  // A tight box is still a box; no box at all leaves the nodes loose forever, which is the fault
  // being reported. This gap fits at reduced padding but not at full.
  const r = reviewLayout([
    box("left", -1000, -600, 880, 1200, "Left"),
    ev("Alpha", 0, 0, ["out then -> a.execute"]),
    fn("a", 300, 0),
  ]);
  const s = suggestion(r);
  assert.ok(s, "it should find a tighter fit");
  assert.ok(s.x >= -120, `padding should have shrunk, got x ${s.x}`);
});

test("a suggested box never overlaps the boxes it was measured against", () => {
  const nodes = [
    box("a", -3000, -3000, 500, 500, "A"),
    box("b", 2000, 2000, 500, 500, "B"),
    ev("Alpha", 0, 0, ["out then -> n.execute"]),
    fn("n", 300, 0),
  ];
  const s = suggestion(reviewLayout(nodes));
  assert.ok(s);
  for (const b of nodes.filter((n) => n.type === "EdGraphNode_Comment")) {
    const overlaps = s.x < b.x + b.width && b.x < s.x + s.width && s.y < b.y + b.height && b.y < s.y + s.height;
    assert.ok(!overlaps, `suggested box overlaps ${b.text}`);
  }
});
