import test from "node:test";
import assert from "node:assert/strict";

import { matchSymptoms, SYMPTOMS } from "../dist/symptoms.js";

/**
 * The premise of this project is that you describe a bug in plain language and the model finds it.
 * Measured against the entry point for that - `unreal_list_tools({match})` on the `search` profile -
 * every word a person would use returned nothing:
 *
 *   "upgrade" 0, "shop" 0, "missing" 0, "not showing" 0, "bug" 0
 *
 * while "upgrades aren't showing up in the shop" is a REAL bug in this project: DT_Upgrades has two
 * rows whose UpgradeClass is null, which unreal_check_data_tables reports in one call.
 */

test("the sentence this whole index exists for reaches the tool that finds the bug", () => {
  // Verified end to end against the editor: 3 calls, 2,715 tokens from this sentence to
  // check_data_tables naming DT_Upgrades rows Weapon_MachineGun and Vacuum_VirusController with a
  // null UpgradeClass - which is exactly why those upgrades cannot appear in a shop.
  const found = matchSymptoms("upgrades aren't showing up in the shop");
  assert.ok(found, "the report has to match something");
  assert.equal(found.tools[0], "unreal_check_data_tables");
});

test("contractions match, because that is how people negate", () => {
  // The first version of the table had "not showing" and "doesn't show" and missed "aren't showing"
  // - the exact sentence quoted at the top of the module as its reason for existing. A symptom table
  // that only knows the formal spellings knows the wrong half of the language.
  for (const said of [
    "the upgrades aren't showing",
    "the upgrades are not showing",
    "upgrades don't show up",
    "the shop is empty",
    "no items in the shop",
  ]) {
    const found = matchSymptoms(said);
    assert.ok(found, `"${said}" should match something`);
    assert.equal(found.tools[0], "unreal_check_data_tables", `"${said}" should reach the data table check`);
  }
});

test("a description of the failure outranks a noun naming the subject", () => {
  // "enemies don't take damage" matched the `enemy` entry first and led with read_behavior_tree,
  // when the useful answer is trace_variable. The subject being an enemy is the least informative
  // word in that sentence, so the entries are ordered failure-first.
  const found = matchSymptoms("enemies dont take damage");
  assert.equal(found.tools[0], "unreal_trace_variable");

  const crash = matchSymptoms("the game crashes when I open the menu");
  assert.equal(crash.tools[0], "unreal_read_runtime_errors", "crash beats menu");
});

test("an ambiguous sentence returns both readings rather than guessing", () => {
  // "enemies don't take damage" is a fair question about either the AI or the damage number. This is
  // a keyword table; it cannot disambiguate, and one that pretended to would be wrong confidently.
  const found = matchSymptoms("enemies dont take damage");
  assert.ok(found.because.length >= 2, "both readings carry their reason");
  assert.ok(found.tools.includes("unreal_read_behavior_tree"), "and the other reading is still offered");
});

test("the answer stays short enough to be a suggestion", () => {
  // Two entries of three tools each cost 667 tokens on "the game crashes when I open the menu", for
  // a sentence whose first three words already said where to look. A list long enough to need
  // reading is not a suggestion.
  for (const said of ["the game crashes when I open the menu", "enemies dont take damage", "the ui is slow and laggy"]) {
    const found = matchSymptoms(said);
    if (!found) continue;
    assert.ok(found.tools.length <= 4, `"${said}" returned ${found.tools.length} tools`);
    assert.ok(found.matched.length <= 2, `"${said}" matched ${found.matched.length} entries`);
  }
});

test("text that means nothing here matches nothing, rather than something plausible", () => {
  // A wrong suggestion at the moment the caller has nothing else to go on is worse than none. The
  // reply for this case names the three project-wide diagnostics instead.
  assert.equal(matchSymptoms("asdfqwer"), undefined);
  assert.equal(matchSymptoms(""), undefined);
  assert.equal(matchSymptoms("   "), undefined);
});

test("matching is case-insensitive on the caller's side", () => {
  assert.ok(matchSymptoms("The Game CRASHES On Startup"));
});

test("every phrase is lowercase, or it can never fire", () => {
  // Matching lowercases the caller's text and compares against these verbatim, so a capital letter
  // here is an entry that silently never matches.
  for (const entry of SYMPTOMS) {
    for (const phrase of entry.says) {
      assert.equal(phrase, phrase.toLowerCase(), `"${phrase}" would never match`);
    }
  }
});

test("no entry recommends a tool that is true of every symptom", () => {
  // The temptation is to map everything to search_project, which is true of any bug report and
  // therefore worth nothing. It appears only where finding an asset by its contents IS the answer.
  const generic = SYMPTOMS.filter((e) => e.tools[0] === "unreal_search_project");
  assert.ok(generic.length <= 1, "search_project leads at most one entry");
});

test("every entry says why, in the caller's terms", () => {
  for (const entry of SYMPTOMS) {
    assert.ok(entry.because.length > 40, `"${entry.says[0]}" needs a reason a person can act on`);
    assert.ok(entry.tools.length > 0);
  }
});
