import test from "node:test";
import assert from "node:assert/strict";

import { normaliseEngineType, normaliseFieldTypes, typeHint } from "../dist/engineTypes.js";

/**
 * Found by asking what a model would naturally send, rather than by reading the code.
 * unreal_add_variable accepts 20 of 26 obvious spellings - int, int32, integer, bool, boolean,
 * Float, String all work - and refused exactly six:
 *
 *   FString  FText  FName  FVector  FRotator   (and a bare asset class name)
 *
 * Those five are not typos. They are how Unreal itself spells them, and they are what a model has in
 * front of it after unreal_find_source hands back a header. The join that broke is C++ to Blueprint:
 * read a native class, go to declare a matching variable, spell the type the way the source spells
 * it, and get refused.
 */

test("the C++ spelling of a core type is accepted", () => {
  for (const [cpp, token] of [
    ["FString", "string"],
    ["FText", "text"],
    ["FName", "name"],
    ["FVector", "vector"],
    ["FRotator", "rotator"],
    ["FTransform", "transform"],
  ]) {
    assert.equal(normaliseEngineType(cpp), token);
  }
});

test("a container suffix rides along", () => {
  // The suffix is this layer's own notation and the base name is the part being translated, so
  // FVector[] has to become vector[] rather than being left alone or losing its suffix.
  assert.equal(normaliseEngineType("FVector[]"), "vector[]");
  assert.equal(normaliseEngineType("FString<set>"), "string<set>");
});

test("a spelling that already worked is untouched", () => {
  // The point is to add accepted spellings, not to change what the 20 working ones mean.
  for (const t of ["int", "float", "bool", "byte", "string", "vector", "transform"]) {
    assert.equal(normaliseEngineType(t), t);
  }
  assert.equal(normaliseEngineType("Float"), "float", "case is normalised for a known token");
});

test("a prefixed type passes through exactly", () => {
  // object:/class:/struct:/enum: carry their own meaning and the class name after the colon is not
  // this function's business - "object:FStruct" must not have its F eaten.
  for (const t of ["object:StaticMesh", "class:BP_Enemy", "struct:S_Item", "enum:E_State", "object:FStruct"]) {
    assert.equal(normaliseEngineType(t), t);
  }
});

test("an unknown F-name is left alone rather than guessed at", () => {
  // FMyGameplayStruct is a real struct and belongs as struct:MyGameplayStruct, but stripping the F
  // blindly would also turn FooBar into ooBar. Only the engine's own core types are listed, and they
  // are a closed set.
  assert.equal(normaliseEngineType("FMyGameplayStruct"), "FMyGameplayStruct");
  assert.equal(normaliseEngineType("FooBar"), "FooBar");
});

test("field lists are rewritten in place", () => {
  const fields = [
    { name: "Origin", type: "FVector" },
    { name: "Label", type: "FText" },
    { name: "Count", type: "int" },
  ];
  assert.deepEqual(normaliseFieldTypes(fields), [
    { name: "Origin", type: "vector" },
    { name: "Label", type: "text" },
    { name: "Count", type: "int" },
  ]);
  assert.equal(normaliseFieldTypes(undefined), undefined, "an absent list is not an error");
});

test("a bare class name gets a hint naming both readings, and is not guessed", () => {
  // StaticMesh could mean object:StaticMesh or class:StaticMesh, and those are different types - one
  // is an instance, one is the type itself. Guessing would be wrong half the time and silent when it
  // was, so this names both and decides neither.
  const hint = typeHint("StaticMesh");
  assert.match(hint, /object:StaticMesh/);
  assert.match(hint, /class:StaticMesh/);
  assert.match(hint, /cannot\s+choose for you/);
  assert.equal(normaliseEngineType("StaticMesh"), "StaticMesh", "and it is passed through, not rewritten");
});

test("nothing that already works carries a hint", () => {
  // A hint attached to a working call is a token cost for a situation that is not happening, and a
  // hint on a correct call teaches the wrong lesson.
  for (const t of ["int", "FVector", "object:StaticMesh", "struct:S_Item", "float"]) {
    assert.equal(typeHint(t), undefined, `${t} needs no hint`);
  }
});

test("a lowercase typo gets no invented hint", () => {
  // "flaot" is a typo, and the bridge's own error already lists every supported form - which is the
  // right answer to a typo. The hint exists only for the one case the bridge cannot diagnose: a
  // capitalised bare word that is one prefix away from correct.
  assert.equal(typeHint("flaot"), undefined);
  assert.equal(typeHint(""), undefined);
});
