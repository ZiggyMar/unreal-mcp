/**
 * `match` filters, made to work with the way a person writes a name.
 *
 * Every large read here takes a `match`, and the standing instructions tell every model to use it -
 * "the difference is 1,691 tokens against 218, not a trim". It was a plain substring test, and asset
 * names contain no spaces, so the most natural query silently matched nothing:
 *
 *   list_blueprints  match "shop upgrade"   ->  0        match "ShopUpgrade"   ->  7
 *   list_variables   match "vacuum charge"  ->  0        match "VacuumCharge"  ->  3
 *
 * An empty result is indistinguishable from "this project has none", so the failure is silent and
 * the caller may conclude the opposite of the truth - which is worse than the wasted call.
 *
 * ## Every term must be present, in any order
 *
 * Splitting on whitespace and requiring all terms turns "shop upgrade" into "shop AND upgrade",
 * which finds BP_ShopUpgrade. It is a strict SUPERSET of what the substring test matched: if the
 * whole phrase appeared literally then each of its words appears too, so nothing that matched before
 * stops matching. That is what makes this safe to apply everywhere at once.
 *
 * Order is not required, because "upgrade shop" and "shop upgrade" are the same request and a filter
 * that honoured one and not the other would be a second trap beside the first.
 *
 * ## Why not fix it in the bridge instead
 *
 * `search_project` has the same problem and is C++ - a rebuild before anyone benefits. These filters
 * are in the tool layer and reach everyone now. Same split this project has made before: the bridge
 * stays faithful, the tool layer accommodates. `search_project`'s description says outright that a
 * space matches nothing there, because that one is still true.
 */

/** Split a query into the terms every candidate has to contain. Empty when there is no filter. */
export function matchTerms(match: string | undefined): string[] {
  return (match ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/**
 * Does `haystack` contain every term?
 *
 * The haystack is lowercased by the caller when it is built once and tested many times; this
 * lowercases defensively because a caller that forgets would otherwise get silent misses, which is
 * the exact failure this file exists to remove.
 */
export function matchesAllTerms(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack.toLowerCase();
  return terms.every((term) => hay.includes(term));
}
