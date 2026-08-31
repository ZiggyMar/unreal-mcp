import test from "node:test";
import assert from "node:assert/strict";

import { trimFloatPadding, trimFloatPaddingIn } from "../dist/trimFloats.js";

/**
 * Unreal writes every float with six decimal places, and almost none of them carry information.
 * Measured on this project's largest Data Table read - DT_UniversalActions, nine rows of nested
 * CommonUI structs - the padding alone is 20% of the reply: 7,040 tokens down to 5,695.
 *
 * omitZeroDefault already trimmed trailing zeros, but only for a value that is a plain decimal on its
 * own, and its comment said why: "nothing inside a struct literal or an asset path is touched". That
 * was right at the time - a blind replace over a struct literal can reach into a quoted string - and
 * this is that decision revisited with the quoting handled rather than avoided.
 */

test("the padding goes and the number does not change", () => {
  assert.equal(trimFloatPadding("HoldTime=0.500000"), "HoldTime=0.5");
  assert.equal(trimFloatPadding("R=1.000000,G=1.000000"), "R=1,G=1");
  assert.equal(trimFloatPadding("Left=0.000000"), "Left=0");
  assert.equal(trimFloatPadding("ImageSize=(X=32.000000,Y=32.000000)"), "ImageSize=(X=32,Y=32)");
  assert.equal(trimFloatPadding("A=1.250000"), "A=1.25", "significant digits survive");
  assert.equal(trimFloatPadding("A=0.100000"), "A=0.1");
});

test("a quoted string is never edited", () => {
  // A struct literal contains strings - NSLOCTEXT("Key", "Id", "Confirm") - and a localisation key
  // or a display string could be "1.000000". Trimming inside quotes would be editing data rather
  // than formatting it, and nothing downstream could tell that had happened.
  assert.equal(
    trimFloatPadding('NSLOCTEXT("Key","1.000000","Confirm")'),
    'NSLOCTEXT("Key","1.000000","Confirm")'
  );
  assert.equal(trimFloatPadding('Name="v1.000000",Scale=2.000000'), 'Name="v1.000000",Scale=2');
});

test("an escaped quote does not end the quoted span", () => {
  // A naive scan for the next double quote would treat \\" as the end of the string and start
  // trimming inside it again.
  const value = 'Label="a \\" 1.000000 still inside",Scale=3.000000';
  assert.equal(trimFloatPadding(value), 'Label="a \\" 1.000000 still inside",Scale=3');
});

test("an unterminated quote leaves the rest alone rather than guessing", () => {
  assert.equal(trimFloatPadding('Label="unclosed 1.000000'), 'Label="unclosed 1.000000');
});

test("a number that is part of an identifier or a path is left alone", () => {
  assert.equal(trimFloatPadding("/Game/Foo1.000000/Bar"), "/Game/Foo1.000000/Bar");
  assert.equal(trimFloatPadding("Version=v1.000000"), "Version=v1.000000");
});

test("anything with no decimal point is returned untouched", () => {
  assert.equal(trimFloatPadding("Key=None,State=Enabled"), "Key=None,State=Enabled");
  assert.equal(trimFloatPadding("100"), "100");
  assert.equal(trimFloatPadding(""), "");
});

test("non-strings pass through", () => {
  // Row values arrive as whatever the bridge sent. A number or a null must not become "undefined".
  assert.equal(trimFloatPadding(42), 42);
  assert.equal(trimFloatPadding(null), null);
  assert.equal(trimFloatPadding(undefined), undefined);
});

test("a record is trimmed field by field, and returned as-is when nothing changed", () => {
  const values = { Where: "(X=1.500000,Y=0.000000)", Label: "Machine Gun", Cost: 300 };
  assert.deepEqual(trimFloatPaddingIn(values), { Where: "(X=1.5,Y=0)", Label: "Machine Gun", Cost: 300 });

  // Identity matters: the caller uses it to decide whether to rebuild the row at all.
  const untouched = { Label: "Machine Gun", Cost: 300 };
  assert.equal(trimFloatPaddingIn(untouched), untouched);
  assert.equal(trimFloatPaddingIn(undefined), undefined);
});

test("a trimmed value is still a value the engine accepts", () => {
  // The whole trade depends on this: a read that cannot be written back is not compaction, it is
  // corruption. Verified against the editor too - a row read as {"Where":"(X=1.5,Y=0,Z=32)",
  // "Rate":"0.5"} was handed straight back to set_data_table_row and came out identical.
  //
  // Here the check is the shape: what comes out is still a struct literal with the same members and
  // the same separators, differing only in trailing zeros.
  const before = "(X=1.500000,Y=0.000000,Z=32.000000)";
  const after = trimFloatPadding(before);
  assert.equal(after, "(X=1.5,Y=0,Z=32)");
  assert.equal(after.split(",").length, before.split(",").length, "same number of members");
  assert.match(after, /^\(.*\)$/, "still a struct literal");
});
