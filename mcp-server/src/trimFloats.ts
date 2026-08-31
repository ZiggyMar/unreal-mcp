/**
 * Unreal writes every float with six decimal places. Almost none of them carry information.
 *
 * `ExportTextItem` produces `HoldTime=0.500000`, `R=1.000000`, `Margin=(Left=0.000000,Top=0.000000,
 * Right=0.000000,Bottom=0.000000)`. Measured on this project's largest Data Table read -
 * DT_UniversalActions, nine rows of CommonUI input data - the padding alone is **20% of the reply**:
 * 27,209 characters down to 21,830, about 1,345 tokens on a single call.
 *
 * `omitZeroDefault` already trims trailing zeros, but only for a value that is a plain decimal on its
 * own, and its comment says why: "nothing inside a struct literal or an asset path is touched". That
 * was the right call at the time - a blind global replace over a struct literal can reach into a
 * quoted string - and this is that decision revisited with the quoting handled rather than avoided.
 *
 * ## What makes it safe
 *
 * Two guards, and both are needed:
 *
 * 1. **Quoted spans are skipped entirely.** A struct literal contains strings -
 *    `NSLOCTEXT("Key", "Id", "Confirm")` - and a localisation key or a display string could be
 *    `"1.000000"`. Trimming inside quotes would edit data rather than formatting.
 * 2. **A number preceded by a letter, digit or underscore is left alone**, so `v1.000000` in an
 *    identifier or a path segment is not touched.
 *
 * ## What it does not change
 *
 * The value still parses. `HoldTime=0.5` and `R=1` are what ImportText accepts for a float either
 * way, so a value read here can still be written straight back - which the chain trial checks.
 * Precision is not lost: only zeros after the last significant digit are removed, so 0.100000 becomes
 * 0.1 and 1.500000 becomes 1.5, and a number with no fractional part left drops the point entirely.
 */

/** `123.4500` -> `123.45`, `1.000000` -> `1`, `0.000000` -> `0`. Not preceded by an identifier char. */
const PADDED_FLOAT = /(?<![A-Za-z0-9_.])(-?\d+)\.(\d*?)0+(?![0-9])/g;

function trimOutsideQuotes(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const quote = text.indexOf('"', i);
    if (quote === -1) {
      out += text.slice(i).replace(PADDED_FLOAT, (_m, whole, frac) => (frac ? `${whole}.${frac}` : whole));
      break;
    }
    // Everything up to the quote is fair game.
    out += text.slice(i, quote).replace(PADDED_FLOAT, (_m, whole, frac) => (frac ? `${whole}.${frac}` : whole));

    // Copy the quoted span verbatim, honouring backslash escapes so an escaped quote does not end it.
    let j = quote + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === '"') break;
      j += 1;
    }
    // An unterminated quote means the rest of the string is inside it, and is copied untouched.
    const end = j >= text.length ? text.length : j + 1;
    out += text.slice(quote, end);
    i = end;
  }
  return out;
}

/** Trim float padding in one value, leaving anything that is not a string alone. */
export function trimFloatPadding<T>(value: T): T {
  if (typeof value !== "string") return value;
  // Cheap reject: no six-zero run and no ".0" at all means nothing to do.
  if (!value.includes(".")) return value;
  return trimOutsideQuotes(value) as unknown as T;
}

/** Trim every string value in a flat record of field values. */
export function trimFloatPaddingIn(values: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!values || typeof values !== "object") return values;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    const trimmed = trimFloatPadding(raw);
    if (trimmed !== raw) changed = true;
    out[key] = trimmed;
  }
  return changed ? out : values;
}
