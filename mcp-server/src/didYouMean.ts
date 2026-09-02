/**
 * Re-ranking the bridge's near-miss suggestions, and dropping the ones that are not near misses.
 *
 * The plugin answers a name it cannot resolve with a `didYouMean` list, which is the most useful
 * self-correction signal in the system. It ranks by shared prefix, and measured against a live
 * editor that produces answers that are actively worse than none:
 *
 *   SpawnActor                  -> Spawn (a ThirdParty tutorial conveyor Blueprint)
 *                                  Spawn (UMG.Viewport)
 *                                  SpawnActorFromClass          <- the right answer, ranked third
 *   ApplyRootMotionRadialForce  -> Apply (VariantManagerBlueprintLibrary)
 *
 * `SpawnActorFromClass` is what the caller wanted and it sits behind two unrelated five-letter
 * functions that happen to start with the same five letters. `Apply` shares five characters out of
 * twenty-six and is not a near miss by any reading; offering it to somebody who is already lost is
 * the confident-falsehood failure this project keeps finding, wearing the costume of helpfulness.
 *
 * ## Containment beats prefix
 *
 * The rule that fixes both cases is that a candidate CONTAINING what was asked for is a better
 * answer than one that merely starts the same way. `SpawnActorFromClass` contains `SpawnActor`;
 * `Spawn` does not. Among containing candidates the shortest wins, because it is the least
 * embellished version of the thing asked for.
 *
 * ## Silence is a valid answer
 *
 * When nothing scores well enough the list is emptied and the bridge's error stands on its own.
 * That is the point rather than a shortfall: `unreal_find_node` does proper word matching and is
 * one call away, and sending a caller to `Apply` costs a round trip AND the credibility of every
 * other suggestion this system makes.
 *
 * Done here rather than in the C++ that generates the list, for the reason engineTypes.ts records
 * about the same choice: the resolver would be the tidier place and only reaches somebody who has
 * rebuilt their plugin, while this layer reaches everyone now.
 */

/** One entry as the plugin emits it. Extra fields are preserved; only ranking looks at these. */
export interface Suggestion {
  functionName?: string;
  className?: string;
  [key: string]: unknown;
}

/**
 * How close a candidate is to what was asked for, or null when it is not a near miss at all.
 *
 * Higher is better. The bands are deliberately far apart so a containing match can never be
 * outranked by a prefix match, however long the shared prefix happens to be.
 */
export function score(wanted: string, candidate: string): number | null {
  const w = wanted.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (w.length === 0 || c.length === 0) return null;
  if (c === w) return 3000;

  // The candidate is what was asked for plus something: SpawnActor -> SpawnActorFromClass. The
  // shortest such candidate is the closest, so length is subtracted rather than added.
  if (c.includes(w)) return 2000 - c.length;

  // What was asked for contains the candidate: a caller who typed more than the real name. Only
  // when the candidate is most of the query, which is what stops `Apply` answering for
  // `ApplyRootMotionRadialForce` - five characters of twenty-six is not a near miss.
  if (w.includes(c)) return c.length >= w.length * 0.6 ? 1000 - (w.length - c.length) : null;

  // Neither contains the other, so fall back to shared prefix - but only a substantial one. This is
  // the band the plugin ranks everything in, and the threshold is what makes it mean something.
  let shared = 0;
  while (shared < w.length && shared < c.length && w[shared] === c[shared]) shared += 1;
  return shared >= w.length * 0.6 ? shared : null;
}

/**
 * The suggestions worth showing, best first, or an empty array when none of them are.
 *
 * Ties are broken by the order the plugin sent them, so a genuinely equal pair stays in the
 * engine's own preference order rather than an arbitrary one invented here.
 */
export function rankSuggestions(wanted: string, suggestions: Suggestion[], limit = 5): Suggestion[] {
  if (!Array.isArray(suggestions)) return [];
  const scored: Array<{ item: Suggestion; s: number; i: number }> = [];
  suggestions.forEach((item, i) => {
    const name = typeof item?.functionName === "string" ? item.functionName : undefined;
    if (!name) return;
    const s = score(wanted, name);
    if (s !== null) scored.push({ item, s, i });
  });
  scored.sort((a, b) => (b.s === a.s ? a.i - b.i : b.s - a.s));
  return scored.slice(0, limit).map((x) => x.item);
}

/** The name a `<something>_not_found: <name>` error is about, for use as the ranking target. */
export function notFoundSubject(errorText: string): string | undefined {
  const m = /_not_found:\s*([^\s{,]+)/.exec(errorText);
  return m ? m[1] : undefined;
}

/**
 * Re-rank a `didYouMean` array inside the context the bridge attached to a failure.
 *
 * Returns the context unchanged when there is nothing to rank, so this is safe to call on every
 * error. When ranking empties the list the key is REMOVED rather than left as `[]`: an empty array
 * still costs tokens and still invites the reader to look for an answer that is not there.
 */
export function rankContextSuggestions(
  errorText: string,
  context: Record<string, unknown>
): Record<string, unknown> {
  const list = context.didYouMean;
  if (!Array.isArray(list) || list.length === 0) return context;
  const wanted = notFoundSubject(errorText);
  if (!wanted) return context;

  const ranked = rankSuggestions(wanted, list as Suggestion[]);
  if (ranked.length === list.length && ranked.every((r, i) => r === list[i])) return context;

  const next = { ...context };
  if (ranked.length === 0) delete next.didYouMean;
  else next.didYouMean = ranked;
  return next;
}
