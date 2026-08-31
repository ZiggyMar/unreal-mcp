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
  return omitDefault(omitFalseFlags(variable, VARIABLE_FLAGS), "category", "Default");
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
