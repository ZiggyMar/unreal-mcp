import { test } from "node:test";
import assert from "node:assert/strict";

import { dedupeRepeatedStructs, MARKER_PATTERN } from "../dist/dedupeStructs.js";

/** The shape the Data Table read hands in: a list of cell strings, put back in the same order. */
const onCells = (cells) =>
  dedupeRepeatedStructs(
    { cells },
    (t) => t.cells,
    (t, next) => ({ ...t, cells: next })
  );

/** A struct big enough to be worth a legend entry (>= 120 chars). */
const BRUSH =
  "(TintColor=(SpecifiedColor=(R=1,G=1,B=1,A=1),ColorUseRule=UseColor_Specified),DrawAs=NoDrawType," +
  "Tiling=NoTile,ImageType=NoImage,ImageSize=(X=32,Y=32),ResourceObject=None,ResourceName=\"\")";

test("a struct repeated across cells is written once and referenced", () => {
  const cells = [
    `(Key=A,OverrideBrush=${BRUSH})`,
    `(Key=B,OverrideBrush=${BRUSH})`,
    `(Key=C,OverrideBrush=${BRUSH})`,
  ];
  const out = onCells(cells);

  assert.ok(out.repeated, "a value seen three times should earn a legend entry");
  const [marker] = Object.keys(out.repeated);
  assert.equal(out.repeated[marker], BRUSH);
  for (const cell of out.rows.cells) assert.ok(cell.includes(marker), "every occurrence is replaced");

  // The whole point: substituting the legend gives back exactly what went in.
  const restored = out.rows.cells.map((c) => c.split(marker).join(out.repeated[marker]));
  assert.deepEqual(restored, cells);
});

test("it is a saving, not just a rewrite", () => {
  const cells = Array.from({ length: 10 }, (_, i) => `(Key=K${i},OverrideBrush=${BRUSH})`);
  const before = cells.join("").length;
  const out = onCells(cells);
  const after = out.rows.cells.join("").length + JSON.stringify(out.repeated).length;
  assert.ok(after < before * 0.5, `expected under half; got ${after} vs ${before}`);
});

test("a value seen twice is left alone, because the legend would cost more than it saves", () => {
  const out = onCells([`(Key=A,B=${BRUSH})`, `(Key=B,B=${BRUSH})`]);
  assert.equal(out.repeated, undefined);
});

test("short repeats are left alone", () => {
  const cells = Array.from({ length: 20 }, () => "(X=0,Y=0)");
  assert.equal(onCells(cells).repeated, undefined);
});

test("nothing repeated means nothing changed", () => {
  const cells = [`(Key=A,B=${BRUSH})`, "(Key=B)", "(Key=C)"];
  const out = onCells(cells);
  assert.equal(out.repeated, undefined);
  assert.deepEqual(out.rows.cells, cells);
});

test("a marker already present in the data does not collide", () => {
  // A row whose real content contains "@1@" must not have its meaning changed by the compaction.
  const cells = [
    `(Name="@1@",OverrideBrush=${BRUSH})`,
    `(Name="other",OverrideBrush=${BRUSH})`,
    `(Name="third",OverrideBrush=${BRUSH})`,
  ];
  const out = onCells(cells);
  const [marker] = Object.keys(out.repeated ?? {});
  assert.ok(marker, "should still compact");
  assert.notEqual(marker, "@1@", "must not reuse a marker the data already contains");

  const restored = out.rows.cells.map((c) => c.split(marker).join(out.repeated[marker]));
  assert.deepEqual(restored, cells, "the pre-existing @1@ survives untouched");
});

test("cell boundaries are never crossed", () => {
  // Two cells that would form a repeated group only if concatenated must not be merged.
  const half = "(AAAA=" + "z".repeat(70);
  const cells = [half, ")" + "y".repeat(70), half, ")" + "y".repeat(70), half];
  const out = onCells(cells);
  assert.equal(out.rows.cells.length, cells.length);
  if (out.repeated) {
    const restored = out.rows.cells.map((c) =>
      Object.entries(out.repeated).reduce((acc, [m, v]) => acc.split(m).join(v), c)
    );
    assert.deepEqual(restored, cells);
  }
});

test("the write guard recognises every marker shape the reader can produce", () => {
  assert.ok(MARKER_PATTERN.test("@1@"));
  assert.ok(MARKER_PATTERN.test("(Brush=@12@)"));
  assert.ok(MARKER_PATTERN.test("@@3@"), "the escalated prefix used after a collision");
  assert.ok(!MARKER_PATTERN.test("(Key=Gamepad_FaceButton_Bottom)"));
  assert.ok(!MARKER_PATTERN.test("email@example"));
});
