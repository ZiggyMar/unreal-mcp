import { toObjectPath } from "../dist/bridgeClient.js";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
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
  compactStructField,
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

test("only the four prefixes the bridge parses become descriptors", () => {
  // The list is the parser's list, read from MCPCommandHandler.cpp rather than assumed. An earlier
  // draft included softobject/softclass/interface, which would have printed "softobject:Foo" - a
  // string this same tool refuses if you hand it back. That is the mismatch this change removes,
  // recreated in the other direction.
  assert.equal(compactVariable(variable({ type: "Object", subType: "Texture2D" })).type, "object:Texture2D");
  assert.equal(compactVariable(variable({ type: "class", subType: "Actor" })).type, "class:Actor");
  assert.equal(compactVariable(variable({ type: "struct", subType: "Vector" })).type, "struct:Vector");

  const soft = compactVariable(variable({ type: "softobject", subType: "Texture2D" }));
  assert.equal(soft.type, "softobject", "the type is passed through, not dressed up");
  assert.equal(soft.subType, "Texture2D", "and the subtype stays beside it as an honest pair");
});

test("a byte with a subtype is an enum, which is what the write side calls it", () => {
  // The bridge parses "enum:<Name>" into PC_Byte with the UEnum as its subcategory, and the editor
  // produces the same form - so reading it back as "byte" plus a subtype describes a type no call
  // will accept. "byte:E_Rarity" is not a thing.
  assert.equal(compactVariable(variable({ type: "byte", subType: "E_Rarity" })).type, "enum:E_Rarity");
  assert.equal(compactVariable(variable({ type: "enum", subType: "E_Rarity" })).type, "enum:E_Rarity");
  // A plain byte has no subcategory and stays a plain byte.
  assert.equal(compactVariable(variable({ type: "byte" })).type, "byte");
});

test("a set is a set, not a scalar", () => {
  // The bridge used to answer isArray:false for a Set and for a Map alike, so a variable declared
  // "name<set>" read back as a plain "name" - and this bridge can CREATE sets. Both suffixes are
  // ones its parser strips, so both round-trip.
  assert.equal(compactVariable(variable({ type: "name", container: "set" })).type, "name<set>");
  assert.equal(compactVariable(variable({ type: "name", container: "array" })).type, "name[]");
  assert.equal(compactVariable(variable({ type: "name" })).type, "name", "absent means one value");
});

test("a map keeps its container on the row, because no descriptor spells it", () => {
  // Inventing "name<map>" would print a string the parser rejects. Dropping the fact would report a
  // map as a scalar. Neither is acceptable, so the fact moves next to the type instead.
  const out = compactVariable(variable({ type: "name", container: "map" }));
  assert.equal(out.type, "name");
  assert.equal(out.container, "map");
});

test("an older plugin's isArray is still understood", () => {
  // The plugin inside a running editor is routinely older than this server - which is what the
  // doctor's freshness check reports - and a reply that broke in the meantime would be a bad way to
  // find out.
  assert.equal(compactVariable(variable({ type: "int", isArray: true })).type, "int[]");
  assert.equal("isArray" in compactVariable(variable({ type: "int", isArray: true })), false);
});

test("a struct field is compacted for what a struct field actually has", () => {
  const out = compactStructField({
    name: "Category",
    type: "byte",
    subType: "E_UpgradeCategory",
    defaultValue: "None",
  });
  assert.deepEqual(out, { name: "Category", type: "enum:E_UpgradeCategory" });
});

test("an enum default is NOT treated as a zero", () => {
  // "NewEnumerator0" is Unreal's internal name for an entry, and it is tempting to read it as "index
  // zero, therefore the default". Reordering entries in the editor does not renumber those internal
  // names, so NewEnumerator0 can sit at index 3 and be a deliberate choice. Plausible, and wrong.
  const out = compactStructField({ name: "Category", type: "byte", subType: "E_X", defaultValue: "NewEnumerator0" });
  assert.equal(out.defaultValue, "NewEnumerator0");
});

test("dropping a field means removing it, not declining to re-add it", () => {
  // The bug this encodes, from find_references. The handler spread `...result` and then
  // conditionally re-added the compacted lists; skipping one did not remove it, because the RAW
  // uncompacted list from the bridge was already there from the spread. Asking for ONE direction
  // returned MORE than asking for both - 3,751 tokens against 2,859.
  //
  // The code read as correct. Measuring the change is what caught it, which is the argument for
  // measuring every compaction rather than reasoning about it.
  const fromBridge = { path: "/Game/X", referencedBy: [{ big: "raw" }], dependsOn: [{ big: "raw" }] };

  const wrong = { ...fromBridge, ...(false ? { referencedBy: [] } : {}) };
  assert.deepEqual(wrong.referencedBy, [{ big: "raw" }], "not re-adding leaves the original in place");

  const { referencedBy: _dropped, ...rest } = fromBridge;
  const right = { ...rest, ...(false ? { referencedBy: [] } : {}) };
  assert.equal("referencedBy" in right, false, "destructuring it out is what actually removes it");
  assert.equal(right.path, "/Game/X", "and everything else survives");
});

test("a zero default is dropped in bulk and kept when one property was asked for", () => {
  // Found by running a change request end to end rather than by measuring a reply. "Make the
  // countdown 5 seconds instead of 10" starts by reading the current value, and
  // read_class_defaults with match:"CountdownTime" answered:
  //
  //     {"name":"CountdownTime","type":"int32"}
  //
  // No value, because the value was 0 and zero defaults are omitted. "Absent means the type's zero"
  // is a fine contract across 167 properties, where the omission is most of the saving. It is the
  // wrong answer to a question about ONE property by name: whoever asked is usually about to change
  // it, and needs to see what it is now rather than infer it from a convention.
  //
  // The compaction itself is unchanged - this is about WHEN it applies. Both call sites use the same
  // rule, and this pins the two halves of it.
  const bulk = compactVariable(variable({ name: "CountdownTime", type: "int", defaultValue: "0" }));
  assert.equal("defaultValue" in bulk, false, "in bulk, absent still means the type's zero");

  // What the targeted path does: compact everything, then put the default back.
  const raw = { name: "CountdownTime", type: "int", defaultValue: "0" };
  const row = compactVariable(variable(raw));
  const targeted = "defaultValue" in row ? row : { ...row, defaultValue: raw.defaultValue };
  assert.equal(targeted.defaultValue, "0", "a targeted read says what the value actually is");
  assert.equal(targeted.type, "int", "and keeps every other compaction");
});

test("restoring the default does not undo the type descriptor or the flags", () => {
  // The targeted path must put back ONE thing. If it fell back to the raw row it would reintroduce
  // subType, isArray and the false flags - which is a different reply shape for the same tool
  // depending on whether a filter was passed.
  const raw = { name: "Meshes", type: "Object", subType: "SkeletalMesh", isArray: true, defaultValue: "None", instanceEditable: false };
  const row = compactVariable(raw);
  const targeted = "defaultValue" in row ? row : { ...row, defaultValue: raw.defaultValue };
  assert.equal(targeted.type, "object:SkeletalMesh[]");
  assert.equal("subType" in targeted, false);
  assert.equal("isArray" in targeted, false);
  assert.equal("instanceEditable" in targeted, false);
  assert.equal(targeted.defaultValue, "None");
});

test("all three property readers drop a value the type already implies", async () => {
  // list_variables, read_class_defaults and read_asset_properties all read the editable properties
  // of an object, and for a long time the third returned them verbatim while the other two dropped a
  // category of "Default" and a value that is the type's zero.
  //
  // Measured across this project's 41 Data Assets: 269 of 413 properties carried a zero value. The
  // saving is modest - about 955 tokens, 6% - because dropping "value":"None" removes 16 characters
  // and not the whole entry. A first estimate said 5,669 by counting whole entries as savable, which
  // is the wrong arithmetic and worth recording as such.
  //
  // The consistency is the point. Three tools describing one convention two different ways is this
  // repo's most repeated defect, and a caller who learns "absent means zero" from one of them
  // reasonably expects it from the others.
  const source = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
  const readers = ["read_asset_properties", "read_class_defaults"];
  for (const reader of readers) {
    const start = source.indexOf(`bridge.send("${reader}"`);
    assert.ok(start > 0, `${reader} sends its bridge command`);
    const body = source.slice(start, start + 2500);
    assert.match(body, /omitZeroDefault\(/, `${reader} drops a zero value`);
    assert.match(body, /omitDefault\(row, "category", "Default"\)/, `${reader} drops a Default category`);
    assert.match(body, /trimFloatPadding\(/, `${reader} trims float padding`);
    assert.match(body, /const targeted = /, `${reader} keeps values for a targeted question`);
  }
});

test("picking columns keeps every row and reports names that match nothing", () => {
  // The change-request question is usually about one field - "what does everything cost", "which
  // rows have no UpgradeClass" - and answering it meant pulling every field of every row. On
  // DT_UniversalActions that is 5,472 tokens to read nine rows, almost all of it four nested
  // CommonUI struct literals nobody asked about. Two named columns: 229 tokens.
  //
  // A view, not a filter: every row still comes back, carrying less.
  const rows = [
    { Cost: "300", Label: "Machine Gun", Brush: "(a huge struct literal)" },
    { Cost: "150", Label: "Bullet Size", Brush: "(another huge one)" },
  ];
  const picked = pickFields(rows, ["Cost"]);
  assert.deepEqual(picked.rows, [{ Cost: "300" }, { Cost: "150" }]);
  assert.deepEqual(picked.unknown, []);
});

test("a column that does not exist is named, not answered with empty rows", () => {
  // Asking for "Cost" on a table whose column is "Price" must not come back as every row present
  // and nothing in any of them - that reads as "no row has a cost" rather than "there is no such
  // column", and the caller would draw the wrong conclusion about their own data.
  const picked = pickFields([{ Price: "300" }, { Price: "150" }], ["Cost", "Price"]);
  assert.deepEqual(picked.rows, [{ Price: "300" }, { Price: "150" }]);
  assert.deepEqual(picked.unknown, ["Cost"]);
});

test("asking for no columns changes nothing", () => {
  const rows = [{ Cost: "300" }];
  assert.equal(pickFields(rows, []).rows, rows, "an empty list is not a request to drop everything");
});
