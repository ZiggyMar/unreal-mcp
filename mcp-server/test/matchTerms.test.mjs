import { test } from "node:test";
import assert from "node:assert/strict";

import { matchTerms, matchesAllTerms } from "../dist/matchTerms.js";

test("a space no longer means no match", () => {
  // Measured before the change: list_blueprints match "shop upgrade" returned 0 and "ShopUpgrade"
  // returned 7; list_variables match "vacuum charge" returned 0 and "VacuumCharge" returned 3.
  // Asset names contain no spaces, so the most natural query was the one guaranteed to fail.
  const haystack = "BP_ShopUpgrade /Game/Upgrades/BP_ShopUpgrade Actor";
  assert.equal(matchesAllTerms(haystack, matchTerms("shop upgrade")), true);
  assert.equal(matchesAllTerms(haystack, matchTerms("ShopUpgrade")), true);
});

test("order does not matter, because the two phrasings are one request", () => {
  const haystack = "BP_ShopUpgrade /Game/Upgrades/BP_ShopUpgrade Actor";
  assert.equal(matchesAllTerms(haystack, matchTerms("upgrade shop")), true);
});

test("it is a superset: nothing that matched before stops matching", () => {
  // If the whole phrase appeared literally then each of its words appears too. That property is
  // what makes this safe to apply to every filter at once rather than one at a time.
  const haystack = "AC_InteractionTrace_Shop /Game/Shop/AC_InteractionTrace_Shop ActorComponent";
  assert.equal(matchesAllTerms(haystack, matchTerms("interactiontrace")), true);
  assert.equal(matchesAllTerms(haystack, matchTerms("shop")), true);
});

test("every term has to be there, or it is not a match", () => {
  const haystack = "BP_ShopUpgrade /Game/Upgrades/BP_ShopUpgrade Actor";
  assert.equal(matchesAllTerms(haystack, matchTerms("shop vacuum")), false);
  assert.equal(matchesAllTerms(haystack, matchTerms("zzz nothing")), false);
});

test("no filter matches everything, which is what an absent match means", () => {
  assert.deepEqual(matchTerms(undefined), []);
  assert.deepEqual(matchTerms("   "), []);
  assert.equal(matchesAllTerms("anything at all", []), true);
});

test("case and repeated whitespace are not the caller's problem", () => {
  assert.equal(matchesAllTerms("BP_ShopUpgrade", matchTerms("  SHOP   upgrade ")), true);
});

test("a two-word class name is why this matters for widgets", () => {
  // list_widgets was the only list tool with no way to narrow: WBP_MorrisPopUp is 87 widgets and
  // 2,654 tokens. A person asks for "size box" and the class is SizeBox - the exact shape that
  // returned nothing before terms, and now returns 12 of 87 for 460 tokens.
  assert.equal(matchesAllTerms("TimerSizeBox SizeBox", matchTerms("size box")), true);
  assert.equal(matchesAllTerms("CanvasPanel_0 CanvasPanel", matchTerms("size box")), false);
});
