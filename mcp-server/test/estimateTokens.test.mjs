import test from "node:test";
import assert from "node:assert/strict";

import { estimateTokens } from "../scripts/lib/mcpStdio.mjs";

// Every token figure this repo publishes comes out of this function, so the way it fails matters as
// much as the way it works.
//
// It took a character count and was named for the thing you want measured. estimateTokens(replyText)
// therefore returned NaN - and NaN is the worst possible failure for a measurement helper, because it
// does not throw, it has a value, it lines up in a column, and a table full of "NaN tok" reads as a
// run that happened. It cost a wrong reading here before the output was looked at closely.
//
// It now takes either. These tests exist so that stays true: the repair is one line and a future
// tidy-up could undo it without any other test noticing.

test("a string and its length give the same answer", () => {
  const text = "x".repeat(400);
  assert.equal(estimateTokens(text), 100);
  assert.equal(estimateTokens(text.length), 100);
  assert.equal(estimateTokens(text), estimateTokens(text.length));
});

test("no input this helper accepts can produce NaN", () => {
  // The whole point. A measurement that silently produces NaN is worse than one that throws.
  for (const input of ["", "short", "x".repeat(10_000), 0, 1, 999_999]) {
    const result = estimateTokens(input);
    assert.ok(Number.isFinite(result), `estimateTokens(${JSON.stringify(input).slice(0, 20)}) was ${result}`);
  }
});

test("the published figures still come out of it unchanged", () => {
  // The `search` profile is 1,536 tool-definition tokens, and that number is quoted in the workflow
  // guide, registered in check-claims.mjs and re-measured by check:profiles on every run. If the
  // divisor ever moves, every one of those goes with it - so the constant is pinned here too, where
  // a change to it is a deliberate act rather than a side effect.
  assert.equal(estimateTokens(6144), 1536, "the chars-per-token divisor moved");
});
