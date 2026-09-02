/**
 * "Did you mean ...?" for a Blueprint or asset path that does not exist.
 *
 * Guessing a path is the most common way a call fails, and it is the one failure the server can
 * simply look up the answer to. Measured on this project, twice in three calls while doing ordinary
 * work: `/Game/Blueprints/Characters/BP_Player` and `/Game/AntiVirusSquad/_Core/GameModes/GM_Gameplay`
 * were both wrong, and both had a real asset one lookup away.
 *
 * What that costs without this:
 *
 *   failed call      147 tokens   (the not-found error, which is long because it teaches the fix)
 *   list_blueprints  104 tokens   (the lookup the error tells you to do)
 *   the real call     21 tokens
 *
 * Three round trips, and the two wasted ones are the expensive part - every round trip re-reads the
 * whole conversation. With the suggestion attached the model has the real path in hand after the
 * first failure, so the same work is two calls, and the second one succeeds.
 *
 * The suggestion is appended to the error the bridge already wrote rather than replacing it. That
 * error explains the path-repeats-the-name rule and the create-it-first case, neither of which a
 * name match can answer, and an error that gets shorter when it gets smarter is a bad trade.
 *
 * ONLY A REAL MATCH IS OFFERED. "Did you mean X?" about an unrelated asset is a confident falsehood
 * in the one place a model is already confused, which is worse than saying nothing - it would send
 * it down a second wrong path with more conviction than the first. So the leaf name has to actually
 * appear in the candidate's name, and when nothing matches this returns undefined and the original
 * error stands alone.
 */

/** A row as `list_blueprints` returns it, narrowed to what matching needs. */
export interface PathCandidate {
  name?: string;
  path?: string;
}

/** The `<something>_not_found: <path>` codes worth a lookup - the ones whose subject IS a path. */
const NOT_FOUND_RE = /\b(?:blueprint|asset|widget|level|map)_not_found:\s*([^\s,]+)/i;

/**
 * The asset name out of a path, with Unreal's `Folder/Name.Name` object suffix removed.
 *
 * `/Game/A/B/BP_Thing.BP_Thing` and `/Game/A/B/BP_Thing` both give `BP_Thing`, which matters because
 * the bridge echoes the path back in the object form even when the caller sent the short one.
 */
export function leafName(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const tail = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = tail.indexOf(".");
  return (dot >= 0 ? tail.slice(0, dot) : tail).trim();
}

/** The path a not-found error is complaining about, or undefined if it is not that kind of error. */
export function notFoundPath(errorText: string): string | undefined {
  const m = NOT_FOUND_RE.exec(errorText);
  // A path never ends in a dot, so a trailing one is the sentence's full stop that the bridge's
  // error text puts after it. `leafName` happens to survive this, which is exactly why it is worth
  // fixing here instead: the next caller of `notFoundPath` would not.
  return m ? m[1].replace(/[.,;]+$/, "") : undefined;
}

/**
 * Candidates whose name matches `needle`, best first.
 *
 * Exact-ignoring-case first, because that is the overwhelmingly common real case: the name was
 * right and the folders were wrong. Substring matches follow, so `Player` still finds `BP_Player`
 * when the caller half-remembered the name.
 */
export function rankCandidates(needle: string, candidates: PathCandidate[], limit = 3): string[] {
  const want = needle.toLowerCase();
  if (want.length === 0) return [];

  const exact: string[] = [];
  const partial: string[] = [];
  for (const c of candidates) {
    const path = c.path;
    if (!path) continue;
    const name = (c.name ?? leafName(path)).toLowerCase();
    if (name === want) exact.push(path);
    // Guard the substring arm against a needle so short that everything matches it. Two characters
    // would make "BP" suggest three unrelated Blueprints with a straight face.
    else if (want.length >= 3 && name.includes(want)) partial.push(path);
  }
  // An exact match ENDS it. When BP_Player exists, listing WBP_PlayerDeath and ABP_Player beside it
  // is noise wearing the costume of thoroughness - the caller named the thing correctly and only got
  // the folders wrong, which is the common case and is now answered with one path and no choosing.
  // Substring hits are the fallback for when nothing matched exactly, not a garnish on a hit.
  return (exact.length > 0 ? exact : partial).slice(0, limit);
}

/** The sentence to append, or undefined when nothing genuinely matches. */
export function suggestionLine(matches: string[]): string | undefined {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return `Did you mean \`${matches[0]}\`?`;
  return `Did you mean one of these? ${matches.map((m) => `\`${m}\``).join(", ")}`;
}
