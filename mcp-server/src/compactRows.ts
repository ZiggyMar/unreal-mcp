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
