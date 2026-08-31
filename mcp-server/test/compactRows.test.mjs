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
  asTypeDescriptor,
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

test("a default that is the type's zero is dropped, and the tool says so", () => {
  // This reverses an earlier decision in this file, which read "a default of 0 is data, not an
  // absent field". That was right about the danger and wrong about the remedy: the danger is a
  // reader unable to tell "no default" from "not reported", and the remedy is to state the contract
  // rather than to keep paying for it. Measured on a real 86-variable Blueprint, 53 of the defaults
  // were zeros - "()" on every delegate, "None" on every object reference - about 1,060 characters
  // spent repeating what the type had already said.
  //
  // unreal_list_variables now states it outright: no `defaultValue` means the type's zero.
  for (const zero of ["0", "", "()", "None", "False", "0.0", "0.000000"]) {
    const out = compactVariable(variable({ defaultValue: zero, type: "int" }));
    assert.equal("defaultValue" in out, false, `${JSON.stringify(zero)} should be dropped`);
  }
  // And a default somebody actually chose survives, which is the whole point of dropping the others.
  assert.equal(compactVariable(variable({ defaultValue: "True", type: "bool" })).defaultValue, "True");
  assert.equal(compactVariable(variable({ defaultValue: "100.000000", type: "float" })).defaultValue, "100");
});

test("the zero list is a decision per value, not a falsy check", () => {
  // The protection the reversed test was really providing. omitFalseFlags must never reach
  // defaultValue, and a value that merely LOOKS empty to JavaScript is not automatically a zero:
  // "0.0.0" and "none" are not, and treating them as such would delete real data.
  for (const kept of ["0.0.0", "none", "NONE", "false", "(0)", "0,0,0"]) {
    const out = compactVariable(variable({ defaultValue: kept }));
    assert.equal(out.defaultValue, kept, `${JSON.stringify(kept)} is not a zero`);
  }
});

test("float padding is trimmed without changing the number", () => {
  // The engine writes 100.000000 and a reader wants 100. Trailing zeros after a decimal point carry
  // nothing, and only a plain decimal is touched - a struct literal or an asset path is left alone.
  const cases = [
    ["100.000000", "100"],
    ["0.100000", "0.1"],
    ["-2.500000", "-2.5"],
    ["1500.000000", "1500"],
  ];
  for (const [raw, want] of cases) {
    assert.equal(compactVariable(variable({ defaultValue: raw })).defaultValue, want, raw);
  }
  const structLiteral = "(X=1.000000,Y=2.000000)";
  assert.equal(compactVariable(variable({ defaultValue: structLiteral })).defaultValue, structLiteral);
});

test("type, subType and isArray become the descriptor the write side accepts", () => {
  // This began as a token saving and was really a correctness problem: reading a variable answered
  // in one language and creating one took another, inside the same tool surface, with the model
  // expected to translate. Every read-then-recreate was a chance to get it wrong.
  const cases = [
    [{ type: "Object", subType: "SkeletalMesh", isArray: true }, "object:SkeletalMesh[]"],
    [{ type: "Object", subType: "WB_Pause_C" }, "object:WB_Pause_C"],
    [{ type: "struct", subType: "TimerHandle" }, "struct:TimerHandle"],
    [{ type: "name", isArray: true }, "name[]"],
    [{ type: "int" }, "int"],
    // No subType to attach, so the engine's own spelling is passed through rather than guessed at.
    [{ type: "mcdelegate" }, "mcdelegate"],
  ];
  for (const [input, want] of cases) {
    const out = compactVariable(variable(input));
    assert.equal(out.type, want, JSON.stringify(input));
    assert.equal("subType" in out, false, "subType is carried by the descriptor now");
    assert.equal("isArray" in out, false, "and so is isArray, via the []");
  }
});

test("name and type stay adjacent, because that is the pair every reader looks for", () => {
  const out = compactVariable(
    variable({ type: "int", replicated: true, repNotify: "OnRep_X", defaultValue: "7" })
  );
  // Rebuilding the row from a destructure pushes type to the end unless it is put back deliberately.
  assert.deepEqual(Object.keys(out).slice(0, 2), ["name", "type"]);
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

test("a type the reply prints is a type the filter accepts", () => {
  // The round trip that would otherwise fail silently. The reply says "object:SkeletalMesh[]"; a
  // caller pastes that back as `match`; the raw row spells it "Object" plus a separate subType, so
  // nothing matches and the list comes back empty as though the variable did not exist.
  const row = variable({ name: "AvailableMeshes", type: "Object", subType: "SkeletalMesh", isArray: true });
  const printed = compactVariable(row).type;
  assert.equal(printed, "object:SkeletalMesh[]");
  const haystack = `${row.name} ${row.type} ${row.subType} ${asTypeDescriptor(row).type} ${row.category}`.toLowerCase();
  for (const needle of ["object:skeletalmesh", "object:skeletalmesh[]", "skeletalmesh"]) {
    assert.ok(haystack.includes(needle), `filtering by ${needle} must find what the reply showed`);
  }
});
