/**
 * The C++ spelling of a type, translated to the token the bridge takes.
 *
 * Found by asking what a model would naturally send. `unreal_add_variable` accepts 20 of 26 obvious
 * spellings - `int`, `int32`, `integer`, `bool`, `boolean`, `Float`, `String` all work - and refuses
 * exactly six:
 *
 *   FString  FText  FName  FVector  FRotator   (and a bare asset class name)
 *
 * Those six are not typos. They are how Unreal itself spells them, and they are what a model has in
 * front of it after unreal_find_source hands back a header. So the join that breaks is C++ to
 * Blueprint: read a native class, go to declare a matching variable, and spell the type the way the
 * source you just read spells it.
 *
 * ## Why here and not in ResolvePinType
 *
 * The engine-side resolver is where `int32` and `integer` are already handled, and adding six lines
 * there would be the tidier place. It is also C++, so it only reaches a user who has rebuilt the
 * plugin. This layer reaches everyone now, and normalising input in the tool layer is the same rule
 * this project already applies to compaction: the bridge stays faithful, the tool layer does the
 * accommodating.
 *
 * ## What is deliberately NOT translated
 *
 * A bare class name. `StaticMesh` could mean `object:StaticMesh` or `class:StaticMesh`, and those
 * are different things - one is an instance, one is the type itself. Guessing would be wrong half
 * the time and silent when it was. It gets a hint on the error instead, which teaches without
 * deciding.
 *
 * Container spellings are the exception, added later: `TArray<FVector>` becomes `vector[]` and
 * `TMap<FName,int32>` becomes `map<name,int32>`. Those ARE translated rather than hinted because
 * nothing about them is ambiguous - the guess that stops a bare class name being rewritten has no
 * equivalent for a container.
 *
 * An unknown F-name is left alone too. `FMyGameplayStruct` is a real struct and belongs as
 * `struct:MyGameplayStruct`, but stripping the F blindly would also turn `FooBar` into `ooBar`. Only
 * the engine's own core types are listed, and they are a closed set.
 */

/** C++ spellings of the core types, lowercased, mapped to what the bridge understands. */
const CPP_SPELLINGS: Record<string, string> = {
  fstring: "string",
  ftext: "text",
  fname: "name",
  fvector: "vector",
  fvector3d: "vector",
  frotator: "rotator",
  ftransform: "transform",
  // Not in the supported list, but unambiguous and cheap to accept rather than refuse.
  ubool: "bool",
  uint8: "byte",
};

/** Types the bridge takes as-is, so a spelling that already works is never touched. */
const ALREADY_FINE = new Set([
  "bool",
  "byte",
  "int",
  "int64",
  "float",
  "double",
  "string",
  "name",
  "text",
  "vector",
  "rotator",
  "transform",
]);

/** Prefixed forms carry their own meaning and must pass through untouched. */
const PREFIXED = /^(object|class|struct|enum|softobject|softclass|interface):/i;

/**
 * Rewrite a type into what the bridge accepts, or return it unchanged.
 *
 * Container suffixes ride along: `FVector[]` becomes `vector[]`, because the suffix is the tool
 * layer's own notation and the base name is the part being translated.
 */
export function normaliseEngineType(type: string): string {
  if (typeof type !== "string") return type;
  const trimmed = type.trim();
  if (trimmed.length === 0 || PREFIXED.test(trimmed)) return trimmed;

  // C++ container spellings, which the suffix handling below cannot reach: it splits `FVector[]`,
  // this splits `TArray<FVector>`. Measured on a live editor - `TArray<FName>` is refused outright,
  // and it is the spelling sitting in front of anyone who just read a header through
  // unreal_find_source, which is the same join this whole file exists to close.
  //
  // TRANSLATED rather than hinted, unlike a bare class name. There is nothing to guess here: a
  // TArray is an array and a TMap is a map. The ambiguity that stops `StaticMesh` being rewritten -
  // object or class - has no equivalent, so the call can simply succeed.
  //
  // Recursive, so the container spelling and the element spelling are fixed together rather than
  // costing two round trips to discover one at a time.
  const cppContainer = /^T(Array|Set|Map)\s*<(.+)>$/i.exec(trimmed);
  if (cppContainer) {
    const kind = cppContainer[1].toLowerCase();
    const inner = cppContainer[2];
    if (kind !== "map") {
      const element = normaliseEngineType(inner);
      return kind === "array" ? `${element}[]` : `${element}<set>`;
    }
    // Split on the top-level comma only, so TMap<FName, TArray<int32>> survives.
    let depth = 0;
    let split = -1;
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === "<") depth += 1;
      else if (inner[i] === ">") depth -= 1;
      else if (inner[i] === "," && depth === 0) {
        split = i;
        break;
      }
    }
    // No comma means it is not a map after all. Left alone for the bridge to refuse by its own
    // rules, which say a map needs a key and a value - a better error than anything guessed here.
    if (split < 0) return trimmed;
    const key = normaliseEngineType(inner.slice(0, split));
    const value = normaliseEngineType(inner.slice(split + 1));
    return `map<${key},${value}>`;
  }

  // Split off a container suffix so the base name can be looked up on its own.
  const container = /(\[\]|<set>|<map>)$/.exec(trimmed);
  const suffix = container ? container[1] : "";
  const base = suffix ? trimmed.slice(0, -suffix.length) : trimmed;

  const lower = base.toLowerCase();
  if (ALREADY_FINE.has(lower)) return `${lower}${suffix}`;
  const mapped = CPP_SPELLINGS[lower];
  return mapped ? `${mapped}${suffix}` : trimmed;
}

/** Apply the rewrite to a list of {name, type} field definitions. */
export function normaliseFieldTypes<T extends { type?: string }>(fields: T[] | undefined): T[] | undefined {
  if (!Array.isArray(fields)) return fields;
  return fields.map((f) => (typeof f.type === "string" ? { ...f, type: normaliseEngineType(f.type) } : f));
}

/**
 * A hint for a type the bridge refused, or nothing when there is nothing useful to add.
 *
 * The bridge's own error already lists every supported form, which is the right answer for a typo.
 * It is not the right answer for `StaticMesh`, where the caller is one prefix away and the list does
 * not say which prefix. Naming both is the honest version: this is the one case where the tool knows
 * what was probably meant and cannot know which of two things it was.
 */
export function typeHint(type: string): string | undefined {
  if (typeof type !== "string") return undefined;
  const base = type.trim().replace(/(\[\]|<set>|<map>)$/, "");
  if (base.length === 0 || PREFIXED.test(base)) return undefined;
  if (ALREADY_FINE.has(base.toLowerCase()) || CPP_SPELLINGS[base.toLowerCase()]) return undefined;
  // A capitalised bare word is almost always a class or struct someone forgot to prefix.
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(base)) return undefined;
  return (
    `"${base}" has no prefix, so the bridge cannot tell what kind of type it is. ` +
    `For a reference to an asset or actor of that class use "object:${base}"; for the class itself ` +
    `(a "which class should I spawn" variable) use "class:${base}"; for a USTRUCT use ` +
    `"struct:${base}"; for a UENUM use "enum:${base}". These are different types and this cannot ` +
    `choose for you.`
  );
}
