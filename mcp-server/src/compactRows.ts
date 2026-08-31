/**
 * Stop paying for fields that say nothing.
 *
 * A list of rows from the engine repeats the same keys once per row, and most of the values are the
 * default. Measured on a real Blueprint, BP_Player's 84 variables: 65% of the reply was structure
 * rather than data, and four boolean flags accounted for most of it -
 *
 *     isArray            83/84 false
 *     instanceEditable   81/84 false
 *     blueprintReadOnly  84/84 false
 *     replicated         69/84 false
 *
 * `blueprintReadOnly` was emitted eighty-four times to report nothing at all. Dropping the false
 * ones saves 1,791 tokens of 4,084 - 44% of the reply - without removing a single fact, because
 * absent and false are the same statement once the convention is stated.
 *
 * That last clause is the whole risk, and it is why the tools using this say so in their
 * descriptions. A model that reads a missing flag as "unknown" rather than "false" would go and ask
 * again, which costs more than the field ever did.
 *
 * As everywhere else in this server, this is applied in the TOOL layer. review and audit call the
 * bridge directly and still receive every field - which matters here more than usual, because the
 * replication checks in review are driven by exactly the flags this drops.
 */

export type Row = Record<string, unknown>;

/**
 * Drop the named boolean fields from a row when they are false.
 *
 * Only the named ones: a blanket "drop every false boolean" would quietly change the shape of any
 * reply the engine later adds a field to, and the caller would never know which.
 */
export function omitFalseFlags<T extends Row>(row: T, flags: readonly string[]): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (flags.includes(key) && value === false) continue;
    out[key] = value;
  }
  return out;
}

/** Drop a field when it holds the value the engine uses to mean "not set". */
export function omitDefault<T extends Row>(row: T, key: string, defaultValue: unknown): Row {
  if (!(key in row) || row[key] !== defaultValue) return row;
  const { [key]: _dropped, ...rest } = row;
  return rest;
}

/** The boolean fields on a Blueprint variable, all of which mean "no" when absent. */
export const VARIABLE_FLAGS = ["isArray", "instanceEditable", "blueprintReadOnly", "replicated"] as const;

/**
 * Compact one Blueprint variable for a model's eyes.
 *
 * `category` is dropped when it is "Default", which is what UE calls a variable nobody has filed
 * anywhere. A real category is a deliberate act by a human and is kept.
 */
export function compactVariable(variable: Row): Row {
  const withDescriptor = asTypeDescriptor(variable);
  const withoutZero = omitZeroDefault(withDescriptor);
  return omitDefault(omitFalseFlags(withoutZero, VARIABLE_FLAGS), "category", "Default");
}

/**
 * The prefixes the WRITE side actually parses, and no others.
 *
 * Read from the bridge rather than assumed: MCPCommandHandler.cpp accepts `object:`, `class:`,
 * `struct:` and `enum:`, and nothing else takes a subtype. An earlier draft of this list also had
 * `softobject`, `softclass` and `interface` - which would have printed `softobject:Foo`, a string
 * this tool would then refuse if it were handed back. That is precisely the mismatch this whole
 * change exists to remove, recreated in the other direction, so the list is now the parser's list.
 *
 * Anything outside it keeps `type` and `subType` as separate fields exactly as they arrived. An
 * honest pair beats a descriptor-shaped string that does not work.
 */
const DESCRIPTOR_HEADS = new Set(["object", "class", "struct"]);

/**
 * How a container reaches the type string.
 *
 * `[]` and `<set>` are the suffixes the bridge's parser strips, so both round-trip. A map has no
 * descriptor form at all, so it is left on the row as `container: "map"` rather than invented.
 */
const CONTAINER_SUFFIX: Record<string, string> = { array: "[]", set: "<set>" };

/**
 * Collapse `type` + `subType` + `isArray` into the one descriptor the WRITE side already speaks.
 *
 * This started as a token saving and turned out to be a correctness problem. Reading a variable gave:
 *
 *   {"type":"Object","subType":"SkeletalMesh","isArray":true}
 *
 * and creating the same variable takes `"object:SkeletalMesh[]"` - the compact descriptor documented
 * on add_variable and create_function. Two languages for one idea, inside one tool surface, with the
 * model expected to translate between them. Every round trip - read a variable, recreate it on
 * another Blueprint - was a chance to get the translation wrong, and nothing would have caught it
 * except the create failing.
 *
 * So the read now answers in the language the write accepts. 56 characters become 23, and a value
 * copied out of one call can be pasted into the next.
 *
 * A bare type is passed through exactly as it came rather than being guessed at, and a subtype this
 * cannot spell as a descriptor keeps `type` and `subType` side by side - see DESCRIPTOR_HEADS.
 */
export function asTypeDescriptor(variable: Row): Row {
  const { type, subType, isArray, container, ...rest } = variable;
  if (typeof type !== "string") return variable;

  // `container` is what the bridge sends now; `isArray` is what an older plugin sends. Both are
  // read, because the plugin inside a running editor is often older than this server - that gap is
  // exactly what the doctor's freshness check exists to report, and a reply that broke while it
  // lasted would be a bad way to find out.
  const containerName =
    typeof container === "string" ? container : isArray === true ? "array" : undefined;

  const lower = type.toLowerCase();
  const hasSub = typeof subType === "string" && subType.length > 0;

  let descriptor: string | undefined;
  if (hasSub && DESCRIPTOR_HEADS.has(lower)) {
    descriptor = `${lower}:${subType}`;
  } else if (hasSub && (lower === "byte" || lower === "enum")) {
    // A Blueprint enum is byte-typed with the UEnum as its subcategory - the bridge says so where it
    // parses `enum:`, and the editor itself produces that form. So the honest descriptor for a byte
    // WITH a subtype is `enum:<Name>`; `byte:<Name>` is not a thing the parser takes.
    descriptor = `enum:${subType}`;
  } else if (!hasSub) {
    descriptor = type;
  }

  if (descriptor === undefined) {
    // A subtype this cannot spell as a descriptor: keep both fields exactly as they came, and keep
    // the container beside them rather than folding it into a string that would not parse.
    return {
      ...variable,
      ...(containerName === undefined ? {} : { container: containerName }),
    };
  }

  if (containerName !== undefined) {
    const suffix = CONTAINER_SUFFIX[containerName];
    if (suffix) {
      descriptor += suffix;
    } else {
      // A map. No suffix exists, so say so on the row instead of dropping the fact.
      const { name: mapName, ...mapRest } = rest as Row;
      return {
        ...(mapName === undefined ? {} : { name: mapName }),
        type: descriptor,
        container: containerName,
        ...mapRest,
      };
    }
  }

  // isArray is now carried by the "[]", so it must not also be spelled out - that would be the same
  // fact twice, which is the thing this whole file exists to remove.
  //
  // `name` first and `type` immediately after it, because that is the order the pair is read in.
  // Rebuilding from a destructure would otherwise push `type` to the end, behind whichever flags
  // happened to survive, and split the one pairing every reader looks for.
  const { name, ...others } = rest as Row;
  return { ...(name === undefined ? {} : { name }), type: descriptor, ...others };
}

/**
 * Values that mean "this variable was never given a default".
 *
 * Deliberately a fixed list rather than a falsy check. `omitFalseFlags` must never eat a
 * `defaultValue`, and the difference between "the engine reported nothing" and "the engine reported
 * the zero for this type" has to stay a decision made here, on purpose, per value.
 */
const ZERO_DEFAULTS = new Set(["", "()", "None", "0", "False", "0.0"]);

/**
 * Drop a default that is the type's zero, because the type already says what it is.
 *
 * Measured on a real 86-variable Blueprint: 53 of the defaults were zeros - "()" on every delegate,
 * "None" on every object reference, "0" and "False" on the rest - about 1,060 characters spent
 * repeating what "mcdelegate" and "object:WB_Pause_C" had already said. The 33 that survive are the
 * ones somebody chose: 100.0 health, 1500.0 push speed, True.
 *
 * The contract is stated on the tool rather than left to be inferred, because silence that means two
 * things is the failure this project keeps finding: **a variable with no `defaultValue` has its
 * type's zero value.** One sentence of standing context, ~265 tokens saved per call.
 *
 * A float default keeps its meaning and loses its padding - the engine writes 100.000000 and a reader
 * wants 100. Trailing zeros after a decimal point carry nothing, and trimming them cannot change the
 * number.
 */
export function omitZeroDefault(variable: Row): Row {
  const value = variable.defaultValue;
  if (typeof value !== "string") return variable;
  if (ZERO_DEFAULTS.has(value) || /^0\.0+$/.test(value)) {
    const { defaultValue: _dropped, ...rest } = variable;
    return rest;
  }
  // 100.000000 -> 100, 0.100000 -> 0.1. Only a plain decimal number, so nothing inside a struct
  // literal or an asset path is touched.
  if (/^-?\d+\.\d+$/.test(value)) {
    const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
    return { ...variable, defaultValue: trimmed };
  }
  return variable;
}

/**
 * Compact one field of a user-defined struct.
 *
 * The same shape as a Blueprint variable and the same three problems, found by checking whether the
 * read and the write of each pair in this surface speak the same language:
 *
 *   {"name":"Category","type":"byte","subType":"E_UpgradeCategory","isArray":false,"defaultValue":"NewEnumerator0"}
 *
 * `add_struct_field` takes `"enum:E_UpgradeCategory"`. Nothing in that row is the string it wants.
 *
 * A struct field has no category and none of the variable flags, so this is deliberately not
 * compactVariable: running a row through checks for fields it cannot have reads as though they might
 * be there.
 */
export function compactStructField(field: Row): Row {
  return omitZeroDefault(asTypeDescriptor(field));
}

/**
 * Compact one row of a Blueprint listing.
 *
 * `name` is dropped because it is exactly the last segment of `path`, which already spells it out
 * twice: an Unreal object path is /Game/Folder/BP_Thing.BP_Thing, so a listing of 339 Blueprints
 * carried every name three times over. Measured: `path` was 7,076 tokens of a 12,264-token reply and
 * `name` another 2,102 for nothing new.
 *
 * The larger saving next door is now taken as well: the object suffix goes, so a row reads
 * /Game/Folder/BP_Thing. That was declined once, correctly - five tools had been verified to accept
 * the shorter form, and five of eighty-eight is not evidence about the other eighty-three, while a
 * path that always works is worth more than 1,466 tokens.
 *
 * What changed is that the objection was settled rather than weighed. Auditing how the bridge
 * resolves a path, rather than sampling tools: 23 sites use LoadBlueprintByPath, 8 StaticLoadObject
 * and 14 LoadObject, all of which take either form - and TEN do not, six FindObject, three
 * StaticFindObject, and GetAssetByObjectPath, which keys the asset registry by object path and would
 * simply miss. So the short form really would have broken things, in ten specific places.
 *
 * bridgeClient now expands a package path back to an object path on the way out, at the single
 * boundary every command crosses. The path a caller pastes is long again by the time anything
 * resolves it, so "a path that always works" and the 1,466 tokens are no longer a trade.
 */
export function compactBlueprintRow(row: Row): Row {
  const { name: _dropped, path, ...rest } = row;
  if (typeof path !== "string") return { ...rest, ...(path === undefined ? {} : { path }) };
  const lastSlash = path.lastIndexOf("/");
  const leaf = path.slice(lastSlash + 1);
  const dot = leaf.indexOf(".");
  // Only when the suffix really is the name repeated. Anything else is left exactly as it came.
  const shortened = dot > 0 && leaf.slice(dot + 1) === leaf.slice(0, dot) ? path.slice(0, lastSlash + 1 + dot) : path;
  return { path: shortened, ...rest };
}

/**
 * Keep only the named fields on each row.
 *
 * Competing servers expose this on every action. Costed here and deliberately not: an extra
 * parameter on all 96 tools is roughly 40 tokens each, ~3,800 tokens of standing context, against
 * reads that are already 1-3.7k. Universally that trade is a loss. On the three largest row-shaped
 * reads it pays, so it lives there and nowhere else.
 *
 * An unknown field name is left out rather than raising: the caller asked for a view, and failing a
 * whole read because one name was wrong turns a cheap question into no answer at all. The reply
 * reports which names matched nothing, so a typo is visible instead of silently narrowing the view.
 */
export function pickFields<T extends Row>(rows: T[], fields: string[]): { rows: Row[]; unknown: string[] } {
  const wanted = fields.map((f) => f.trim()).filter(Boolean);
  if (wanted.length === 0) return { rows, unknown: [] };

  const present = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) present.add(key);

  return {
    rows: rows.map((row) => {
      const out: Row = {};
      for (const field of wanted) {
        if (field in row) out[field] = row[field];
      }
      return out;
    }),
    unknown: wanted.filter((f) => !present.has(f)),
  };
}

/**
 * Turn `[{k: "Actor", v: 70}, ...]` into `{Actor: 70, ...}`.
 *
 * get_project_overview's parent-class census was an array of objects, so the words "parentClass" and
 * "count" were spelled out once per entry - 79 times on the project this is developed against, for
 * about 475 tokens of a 926-token field. The names and the numbers are the whole content; the keys
 * are punctuation with a salary.
 *
 * This repo has made exactly this finding before, about the word "node" appearing 1,642 times in one
 * graph reply. It is the same shape in a different place, and worth a shared function so the next one
 * is a one-line change rather than a rediscovery.
 *
 * A duplicate key keeps the LARGER count rather than the last one written. Two rows with the same
 * name should not happen, and silently halving a census if it ever did would be worse than the
 * duplication this replaces.
 */
export function asCountMap<T extends Row>(rows: T[] | undefined, keyField: string, countField: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows ?? []) {
    const key = row[keyField];
    const count = row[countField];
    if (typeof key !== "string" || typeof count !== "number") continue;
    out[key] = Math.max(out[key] ?? 0, count);
  }
  return out;
}

/**
 * Compact one asset reference from find_references.
 *
 * The rows arrived as {package, assetName, assetClass}, and two of the three fields were free:
 *
 *   {"package":"/Game/.../PC_Gameplay","assetName":"PC_Gameplay","assetClass":"Blueprint"}
 *
 * `assetName` is the last segment of `package`, which is the same redundancy compactBlueprintRow
 * already removes from a Blueprint listing. `assetClass` is "Blueprint" on nearly every row of a
 * Blueprint's dependency list, which is what omitDefault exists for - it is kept whenever it is
 * anything else, because a Texture or a DataTable among the dependencies is the interesting case.
 *
 * Measured on a real Blueprint with 116 references: 3,736 tokens, of which the two derivable fields
 * were about 1,475.
 */
export function compactAssetRef(row: Row): Row | string {
  const pkg = row.package;
  const { assetName, ...rest } = row;
  // Only when it really is derivable. A name that is not the package's last segment is telling you
  // something, and dropping it would be a lie rather than a saving.
  const derivable =
    typeof pkg === "string" && typeof assetName === "string" && pkg.slice(pkg.lastIndexOf("/") + 1) === assetName;
  const kept = omitDefault(derivable ? rest : row, "assetClass", "Blueprint");

  // A row with nothing left but its package IS its package. Wrapping one value in an object spends
  // the word "package" once per row - 116 times on a real Blueprint, for about 375 tokens - to say
  // what position already says.
  //
  // The array ends up mixed: plain strings for the ordinary case, objects for a row that still has
  // something to add. That is worth being explicit about rather than tidy, because the objects are
  // exactly the interesting rows - a Texture or a DataTable among the dependencies is what somebody
  // is looking for, and it now stands out instead of hiding in a uniform list.
  const keys = Object.keys(kept);
  return keys.length === 1 && keys[0] === "package" && typeof kept.package === "string" ? kept.package : kept;
}
