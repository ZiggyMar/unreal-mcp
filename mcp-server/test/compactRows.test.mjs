import { toObjectPath } from "../dist/bridgeClient.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  omitFalseFlags,
  omitDefault,
  compactVariable,
  compactBlueprintRow,
  pickFields,
  VARIABLE_FLAGS,
  asCountMap,
  compactAssetRef,
} from "../dist/compactRows.js";

/** A variable shaped exactly as the engine returns one. */
const variable = (over = {}) => ({
  name: "isAlive",
  type: "bool",
  isArray: false,
  defaultValue: "True",
  category: "Default",
  instanceEditable: false,
  blueprintReadOnly: false,
  replicated: false,
  ...over,
});

test("a flag that is false is dropped, and one that is true is kept", () => {
  // Measured on BP_Player: blueprintReadOnly was emitted 84 times and was false every time.
  const out = compactVariable(variable({ replicated: true }));
  assert.equal(out.isArray, undefined);
  assert.equal(out.blueprintReadOnly, undefined);
  assert.equal(out.instanceEditable, undefined);
  assert.equal(out.replicated, true, "a flag that carries a fact must survive");
});

test("nothing but the named flags is dropped", () => {
  // A blanket "drop every false boolean" would silently reshape any reply the engine later adds a
  // field to, and the caller would never learn which field went missing.
  const out = omitFalseFlags(variable({ someNewEngineFlag: false }), VARIABLE_FLAGS);
  assert.equal(out.someNewEngineFlag, false, "an unnamed flag is not this function's business");
});

test("the facts a variable actually carries are never touched", () => {
  const out = compactVariable(variable({ defaultValue: "0", type: "int" }));
  assert.equal(out.name, "isAlive");
  assert.equal(out.type, "int");
  assert.equal(out.defaultValue, "0", "a default of 0 is data, not an absent field");
});

test("a falsy value that is not the flag's false is left alone", () => {
  // defaultValue "0" and "" are real answers. Confusing them with an unset flag would report a
  // variable as having no default when it defaults to zero.
  const out = compactVariable(variable({ defaultValue: "" }));
  assert.equal("defaultValue" in out, true);
  assert.equal(out.defaultValue, "");
});

test("the default category is dropped and a real one is kept", () => {
  assert.equal(compactVariable(variable()).category, undefined);
  assert.equal(compactVariable(variable({ category: "Combat" })).category, "Combat");
});

test("omitDefault leaves a row alone when the field is absent or different", () => {
  assert.deepEqual(omitDefault({ a: 1 }, "b", "x"), { a: 1 });
  assert.deepEqual(omitDefault({ a: "y" }, "a", "x"), { a: "y" });
  assert.deepEqual(omitDefault({ a: "x" }, "a", "x"), {});
});

test("compaction never runs before a filter that reads the flags it removes", () => {
  // The ordering bug this guards: replicatedOnly filters on `replicated === true`, so compacting
  // first would leave every non-replicated variable without the field and the filter would still
  // work by luck - until someone wrote the filter as `!== false` and it silently matched everything.
  const vars = [variable({ name: "a", replicated: true }), variable({ name: "b" })];
  const filteredThenCompacted = vars.filter((v) => v.replicated === true).map(compactVariable);
  assert.equal(filteredThenCompacted.length, 1);
  assert.equal(filteredThenCompacted[0].name, "a");

  const compactedThenFiltered = vars.map(compactVariable).filter((v) => v.replicated !== false);
  assert.equal(compactedThenFiltered.length, 2, "this is the wrong order, and it is wrong by 2 to 1");
});

test("a Blueprint row drops the name and the repeated suffix", () => {
  // An Unreal object path is /Game/Folder/BP_Thing.BP_Thing, so a listing of 339 Blueprints carried
  // every name three times. Measured: `name` was 2,102 tokens of a 12,264-token reply, and the
  // suffix another 1,466.
  const out = compactBlueprintRow({
    name: "BP_Thing",
    path: "/Game/Folder/BP_Thing.BP_Thing",
    parentClass: "Actor",
  });
  assert.equal(out.name, undefined);
  assert.equal(out.path, "/Game/Folder/BP_Thing");
  assert.equal(out.parentClass, "Actor");
});

test("what makes the short path safe is that it expands again on the way out", () => {
  // Dropping the suffix was declined once, correctly: ten bridge sites resolve a path with
  // FindObject, StaticFindObject or GetAssetByObjectPath, none of which accept the package form.
  // It is taken now only because bridgeClient expands it back at the single boundary every command
  // crosses. This is the round trip, and if it ever stops holding the saving has to go back.
  const shortened = compactBlueprintRow({ name: "BP_Thing", path: "/Game/Folder/BP_Thing.BP_Thing" });
  assert.equal(toObjectPath(shortened.path), "/Game/Folder/BP_Thing.BP_Thing");
});

test("a suffix that is not the name repeated is left alone", () => {
  // Only the exact /Path/Name.Name shape is redundant. Anything else is somebody's real path and
  // shortening it would be corruption, not compaction.
  const out = compactBlueprintRow({ name: "X", path: "/Game/Folder/BP_Thing.SomethingElse" });
  assert.equal(out.path, "/Game/Folder/BP_Thing.SomethingElse");
});

test("a field view keeps only what was asked for", () => {
  const rows = [
    { path: "/Game/A.A", parentClass: "Actor", extra: 1 },
    { path: "/Game/B.B", parentClass: "Pawn", extra: 2 },
  ];
  const { rows: out, unknown } = pickFields(rows, ["path"]);
  assert.deepEqual(out, [{ path: "/Game/A.A" }, { path: "/Game/B.B" }]);
  assert.deepEqual(unknown, []);
});

test("a name that matches nothing is reported, not silently dropped", () => {
  // Failing the whole read because one name was wrong turns a cheap question into no answer. But
  // saying nothing would let a typo quietly narrow the view to fields the caller never chose, which
  // reads as "the project has no parent classes" rather than "you spelled it wrong".
  const { rows, unknown } = pickFields([{ path: "/Game/A.A", parentClass: "Actor" }], ["path", "parentclass"]);
  assert.deepEqual(rows, [{ path: "/Game/A.A" }]);
  assert.deepEqual(unknown, ["parentclass"], "case matters, and the caller should be told");
});

test("an empty field list returns the rows untouched", () => {
  const rows = [{ path: "/Game/A.A", parentClass: "Actor" }];
  assert.deepEqual(pickFields(rows, []).rows, rows);
});

test("a field absent from one row but present in another is not reported unknown", () => {
  // Sparse rows are normal here: compaction drops flags that are false and fields that are default,
  // so a field genuinely present in the data may be missing from any given row.
  const { unknown } = pickFields([{ path: "a" }, { path: "b", replicated: true }], ["replicated"]);
  assert.deepEqual(unknown, []);
});

test("a census is a map, not a list of two-key objects", () => {
  // get_project_overview's parent-class breakdown was [{parentClass, count}, ...], so the words
  // "parentClass" and "count" were spelled out once per entry - 79 times on the real project, about
  // 475 tokens of a 926-token field. The names and the numbers are the whole content.
  const out = asCountMap(
    [
      { parentClass: "Actor", count: 70 },
      { parentClass: "Interface", count: 8 },
    ],
    "parentClass",
    "count"
  );
  assert.deepEqual(out, { Actor: 70, Interface: 8 });
});

test("a duplicated census key keeps the larger count, not the last one", () => {
  // Two rows with one name should not happen. If it ever does, silently halving a census is worse
  // than the duplication this replaces.
  const out = asCountMap(
    [
      { parentClass: "Actor", count: 70 },
      { parentClass: "Actor", count: 3 },
    ],
    "parentClass",
    "count"
  );
  assert.deepEqual(out, { Actor: 70 });
});

test("a malformed census row is skipped rather than poisoning the map", () => {
  const out = asCountMap(
    [{ parentClass: "Actor", count: 70 }, { parentClass: "Broken" }, { count: 5 }],
    "parentClass",
    "count"
  );
  assert.deepEqual(out, { Actor: 70 });
});

test("an asset reference drops the name the package already carries", () => {
  // find_references rows arrived as {package, assetName, assetClass} and two of the three were free:
  // assetName is the package's last segment, and assetClass is "Blueprint" on nearly every row of a
  // Blueprint's dependency list. Measured on a real Blueprint with 116 references: about 1,475
  // tokens of 3,736.
  const out = compactAssetRef({
    package: "/Game/Folder/PC_Gameplay",
    assetName: "PC_Gameplay",
    assetClass: "Blueprint",
  });
  // Nothing left but the package, so the row IS the package. Wrapping one value in an object
  // spends the word "package" once per row to say what position already says.
  assert.equal(out, "/Game/Folder/PC_Gameplay");
});

test("a class that is not Blueprint is the interesting case, and survives", () => {
  // A Texture or a DataTable among the dependencies is exactly what somebody is looking for.
  const out = compactAssetRef({
    package: "/Game/Art/T_Icon",
    assetName: "T_Icon",
    assetClass: "Texture2D",
  });
  assert.deepEqual(out, { package: "/Game/Art/T_Icon", assetClass: "Texture2D" });
});

test("a name that is not derivable from the package is kept", () => {
  // Only drop what can be reconstructed exactly. A name that differs from the package's last segment
  // is telling you something, and dropping it would be a lie rather than a saving.
  const out = compactAssetRef({
    package: "/Game/Folder/Container",
    assetName: "SomethingElse",
    assetClass: "Blueprint",
  });
  assert.equal(out.assetName, "SomethingElse");
});
