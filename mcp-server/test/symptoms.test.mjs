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

test("a short word does not match inside an unrelated one", async () => {
  // Plain substring matching shipped first and produced confident nonsense on ordinary English:
  //
  //   "build a new weapon"   -> ui  (inside b-UI-ld)  -> widget tools
  //   "explain the chain"    -> ai  (inside ch-AI-n)  -> behaviour tree tools
  //   "change the flag"      -> hang, lag             -> crash and performance tools
  //   "the animal spawns"    -> anim                  -> animation tools
  //
  // Seventeen phrases were four characters or shorter and every one is a substring of common words.
  // This is the exact failure the module comment warns about, shipped in the same file.
  for (const said of ["build a new weapon", "explain the chain", "change the flag", "the animal spawns", "a monkey and a guide", "the status is fine"]) {
    const found = matchSymptoms(said);
    // An INTENT match is fine and often right - "change the flag" really is a change request, and
    // "build a new weapon" really is a build. What must not happen is a DOMAIN match on a fragment
    // of an unrelated word, which is what sent "build a new weapon" to the widget tools.
    const intentTools = [
      "unreal_plan_feature",
      "unreal_map_system",
      "unreal_find_in_data_tables",
      "unreal_search_project",
      "unreal_trace_variable",
      "unreal_find_source",
    ];
    const domain = (found?.tools ?? []).filter((t) => !intentTools.includes(t));
    assert.deepEqual(domain, [], `"${said}" matched ${JSON.stringify(found?.matched)}`);
  }
});

test("morphological variants still match", async () => {
  // A word boundary at the start with a free suffix, so the fix does not cost the endings that
  // matter: "crash" has to catch "crashes" and "crashing".
  for (const [said, expect] of [
    ["the game crashes on startup", "crash"],
    ["it keeps crashing", "crash"],
    ["the animation is wrong", "animation"],
    ["my keys dont work", "keys"],
    ["it is really laggy", "laggy"],
    ["the ui never appears", "ui"],
    ["the ai wont move", "ai"],
  ]) {
    const found = matchSymptoms(said);
    assert.ok(found, `"${said}" matched nothing`);
    assert.ok(found.matched.includes(expect), `"${said}" matched ${JSON.stringify(found.matched)}`);
  }
});

test("a request to build something is answered with tools that build", async () => {
  // The other half of what this project promises, and it landed badly: "add a new shop upgrade"
  // matched nothing at all, and "add a pause menu" returned list_widgets, review_blueprint and
  // audit_project - tools for finding what is BROKEN, handed to someone who wants something BUILT.
  // The subject was read correctly and the intent was not read at all.
  const found = matchSymptoms("add a new shop upgrade that increases fire rate");
  assert.equal(found.intent, "building");
  assert.equal(found.tools[0], "unreal_plan_feature");
  assert.ok(found.tools.includes("unreal_map_system"));
});

test("intent picks the approach and the subject still picks the domain", async () => {
  // "add a pause menu" should plan against what exists AND bring the widget tools, because the
  // subject is a menu. Dropping the domain would trade one half-answer for another.
  const found = matchSymptoms("add a pause menu");
  assert.equal(found.intent, "building");
  assert.equal(found.tools[0], "unreal_plan_feature");
  assert.ok(found.tools.includes("unreal_list_widgets"), "the domain survives the intent");
});

test("a bug report is not mistaken for a build request", async () => {
  for (const said of ["the game crashes on startup", "upgrades aren't showing up in the shop", "the jump key does nothing"]) {
    assert.equal(matchSymptoms(said).intent, "broken", said);
  }
});

test("a change request is not a build request and not a bug report", async () => {
  // The third thing this project promises - "I have a change request, it finds it and changes it" -
  // and the one that landed worst:
  //
  //   "change the player walk speed"                    -> nothing at all
  //   "rename FireRate to RateOfFire"                   -> nothing at all
  //   "the machine gun should cost 500 instead of 300"  -> nothing at all
  //   "make the health upgrade cost more"               -> read as BUILDING
  //
  // The last is the dangerous one: plan_feature would set about planning a health upgrade system
  // that already exists, because "make the" reads as a request to create something.
  for (const said of [
    "change the player walk speed",
    "rename FireRate to RateOfFire",
    "the machine gun should cost 500 instead of 300",
    "make the health upgrade cost more",
    "increase the max health to 200",
    "swap the icon on the damage upgrade",
  ]) {
    const found = matchSymptoms(said);
    assert.ok(found, `"${said}" matched nothing`);
    assert.equal(found.intent, "changing", `"${said}" was read as ${found.intent}`);
  }
});

test("change beats build when a sentence says both", async () => {
  // "Make a health upgrade" is building. "Make the health upgrade cost more" is a change, and only
  // the second half of the sentence says so - so change vocabulary is checked first.
  assert.equal(matchSymptoms("make a health upgrade").intent, "building");
  assert.equal(matchSymptoms("make the health upgrade cost more").intent, "changing");
});

test("a feature description is not mistaken for a change request", async () => {
  // "increases fire rate" describes what a new thing does; "increase the fire rate" asks to change
  // an existing one. Only the space tells them apart, which is why those markers are multi-word.
  assert.equal(matchSymptoms("add a new shop upgrade that increases fire rate").intent, "building");
  assert.equal(matchSymptoms("increase the fire rate").intent, "changing");
});

test("a change request is pointed at every substrate, not just one", async () => {
  // A cost lives in a Data Table, a walk speed on a component, a hard limit in C++ - and the person
  // asking for the change is exactly the one who does not know which.
  const found = matchSymptoms("change the player walk speed");
  assert.ok(found.tools.includes("unreal_find_in_data_tables"), "Data Tables");
  assert.ok(found.tools.includes("unreal_search_project"), "Blueprints");
  assert.ok(found.tools.includes("unreal_find_source"), "C++");
});

test("the change advice does not repeat the claim that was wrong", async () => {
  // The first version said search_project "covers Data Table rows and Blueprint contents at once".
  // It does not, and that was written as advice before being tried: searching it for a real row name
  // in this project returns zero hits. Finding that out is what produced find_in_data_tables.
  const found = matchSymptoms("change the player walk speed");
  const why = found.because.join(" ");
  assert.ok(!/search_project[^.]*Data Table/.test(why), "search_project is not claimed to cover tables");
  assert.match(why, /find_in_data_tables/, "the tool that does cover them is named");
  assert.match(why, /list_components/, "and component properties are separated from class defaults");
});

test("a rename is routed to the tools that rename, not to four ways of finding it", async () => {
  // "Rename FireRate to RateOfFire" is the sentence this whole index was built against. It was
  // routed correctly as a change, handed four tools that FIND things, and advice naming
  // set_data_table_row and set_class_default - none of which renames anything. The answer was:
  // here is how to locate it, and then nothing.
  //
  // That gap was real until rename_variable and rename_asset existed. Then they were built and this
  // file was not updated, so the routing still said the same thing while the tool it should have
  // named sat one directory away. Building a capability and not telling the router leaves it
  // unreachable for exactly the caller it was built for.
  const found = matchSymptoms("rename FireRate to RateOfFire");
  assert.equal(found.intent, "changing");
  assert.equal(found.tools[0], "unreal_rename_variable", "the commonest case leads");
  assert.ok(found.tools.includes("unreal_rename_asset"));
  assert.match(found.because.join(" "), /rebinds the references/);
});

test("a removal is routed to the tools that refuse when something still uses it", async () => {
  for (const said of ["delete the old health variable", "get rid of the unused sphere component", "remove the debug function"]) {
    const found = matchSymptoms(said);
    assert.equal(found.intent, "changing", said);
    assert.ok(
      ["unreal_remove_variable", "unreal_remove_function", "unreal_remove_component"].includes(found.tools[0]),
      `"${said}" led with ${found.tools[0]}`
    );
  }
});

test("a value change still routes to the finders", async () => {
  // The rename and remove routes are checked first, so this is the case that proves they did not
  // swallow the general one.
  const found = matchSymptoms("the machine gun should cost 500 instead of 300");
  assert.equal(found.tools[0], "unreal_find_in_data_tables");
});

test("every intent list names only tools that exist", async () => {
  // check:symptoms asserts this against the registry. Repeated here because that guard had to be
  // widened twice - first to look at the intent lists at all, then to FIND them rather than be told
  // their names, after RENAME_TOOLS and REMOVE_TOOLS were added and it silently checked two of four.
  const fs = await import("node:fs");
  const source = fs.readFileSync(new URL("../src/symptoms.ts", import.meta.url), "utf8");
  const lists = [...source.matchAll(/const ([A-Z_]*TOOLS)\s*=\s*\[/g)].map((m) => m[1]);
  assert.ok(lists.length >= 4, `expected at least four intent lists, found ${lists.join(", ")}`);
});

test("a C++ change is told how to make the edit real", async () => {
  // The one substrate where finding the value is not the end of the job. A Blueprint change is live
  // the moment it compiles; a C++ change sits in a file the running editor has never read - so a
  // model that edits the header and reports the work done has left the editor running the old code,
  // which looks exactly like the change not working.
  //
  // find_source was routed from the start. compile_cpp and hot_reload_cpp were not, and their own
  // descriptions say the right thing - "this is the step that makes a native fix real" - while
  // nothing pointed a caller at them.
  for (const said of ["I edited the header file", "recompile the C++", "the native class needs a hot reload"]) {
    const found = matchSymptoms(said);
    assert.ok(found, `"${said}" matched nothing`);
    assert.ok(found.tools.includes("unreal_hot_reload_cpp"), `"${said}" -> ${found.tools.join(", ")}`);
  }

  // And a CHANGE phrased around C++ takes the change route, so the advice has to carry it instead.
  const change = matchSymptoms("change the walk speed in the C++ class");
  assert.match(change.because.join(" "), /hot_reload_cpp/);
});

test("a phrase with punctuation is matched as a substring", async () => {
  // "c++" is three characters, so the short-word rule would have demanded a word boundary - and
  // /\bc\+\+\b/ never matches "C++ class", because the boundary after "+" needs a word character and
  // a space is not one. The rule exists to stop "ai" matching "chain"; that reasoning only applies
  // to letters, and a token with punctuation in it is already distinctive.
  const found = matchSymptoms("the value lives in C++ somewhere");
  assert.ok(found, "c++ matched nothing");
  assert.ok(found.matched.includes("c++"));
});

test("the short-word rule still holds for letters", async () => {
  // The punctuation exception must not reopen what it was carved out of.
  const domain = (t) =>
    (matchSymptoms(t)?.tools ?? []).filter(
      (x) => !["unreal_plan_feature", "unreal_map_system", "unreal_find_in_data_tables", "unreal_search_project", "unreal_trace_variable", "unreal_find_source"].includes(x)
    );
  assert.deepEqual(domain("explain the chain"), [], "ai must not match inside chain");
  assert.deepEqual(domain("change the flag"), [], "lag must not match inside flag");
});
