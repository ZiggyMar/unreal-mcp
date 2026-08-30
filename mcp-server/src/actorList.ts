/**
 * Keep a level listing inside a budget, and make the default reply answer a question worth asking.
 *
 * Measured on a real level rather than reasoned about: 889 actors returned 26,698 tokens, of which
 * 42% was JSON keys and punctuation. But the more interesting number is the per-class census in the
 * same reply - it describes the WHOLE level in 193 tokens. The tool's own description already said
 * the census exists "so a large level is legible without listing all of it", and then it listed 200
 * of them anyway. The dump was not answering a question; it was the absence of one.
 *
 * So the default is no longer a dump. Unfiltered, this returns the census plus the actors that carry
 * logic, and says how to ask for the rest. Filtered, it returns the actors, because at that point
 * the caller has asked something specific and deserves a real answer.
 *
 * Two things were checked and deliberately NOT done, because measuring said so:
 *
 * - Dropping `label` as derivable from `name`. It is not: only 12 of 889 actors matched, because
 *   UE's label counter and name counter disagree ("Brush0" is "Brush_0", "PlayerStart2" is
 *   "PlayerStart_1"). It looked redundant on the sample I first eyeballed and was not.
 * - Flattening each actor to one delimited line, the way graph pins were flattened. Pins read
 *   naturally as a sentence; an actor is four heterogeneous fields where position is the only clue
 *   to which is the label and which is the name, and getting that backwards renames the wrong actor.
 *
 * As with the graph cap, this is applied in the TOOL and not the bridge, so anything analysing a
 * level still sees every actor.
 */

export interface ActorLike {
  label?: string;
  name?: string;
  class?: string;
  location?: string;
  blueprint?: string;
  [key: string]: unknown;
}

export interface ActorListLike {
  actors?: ActorLike[];
  totalActors?: number;
  byClass?: unknown;
  [key: string]: unknown;
}

/**
 * How many actors come back when nobody asked for a specific kind.
 *
 * Small on purpose. This is the "show me around" reply, and the census beside it already covers the
 * whole level; anyone who wants actors passes a classFilter and gets them.
 */
export const DEFAULT_UNFILTERED_ACTORS = 40;

/** With a classFilter the caller asked something specific, so the budget is the engine's own cap. */
export const DEFAULT_FILTERED_ACTORS = 200;

export interface CapActorOptions {
  classFilter?: string;
  maxResults?: number;
}

/**
 * Which actors survive a cap.
 *
 * Actors with a Blueprint behind them are the ones with logic, and the tool description already
 * points at that field as the reason to read further. A level's remaining hundreds are dressing:
 * meshes, volumes and lights that matter enormously to how it looks and not at all to what it does.
 * After those, one actor of each remaining class, so nothing in the level is invisible - the class
 * census names it even when no instance is shown.
 */
function pickInteresting(actors: ActorLike[], limit: number): ActorLike[] {
  const withLogic = actors.filter((a) => a.blueprint);
  const rest = actors.filter((a) => !a.blueprint);

  // Round-robin by class, not the first N. A level with 500 BP_Grass and one BP_Boss would spend
  // every slot on grass and never mention the boss, which is the one actor anybody asked about.
  // Breadth first means every kind of logic in the level is named before any kind gets a second row.
  const byClass = new Map<string, ActorLike[]>();
  for (const a of withLogic) {
    const key = a.class ?? "";
    const bucket = byClass.get(key);
    if (bucket) bucket.push(a);
    else byClass.set(key, [a]);
  }

  const kept: ActorLike[] = [];
  const buckets = [...byClass.values()];
  for (let round = 0; kept.length < limit; round++) {
    let placed = false;
    for (const bucket of buckets) {
      if (kept.length >= limit) break;
      if (round < bucket.length) {
        kept.push(bucket[round]);
        placed = true;
      }
    }
    if (!placed) break;
  }

  // Then one actor of each class that has no logic at all, so nothing in the level is invisible.
  const seen = new Set(kept.map((a) => a.class));
  for (const actor of rest) {
    if (kept.length >= limit) break;
    if (seen.has(actor.class)) continue;
    seen.add(actor.class);
    kept.push(actor);
  }
  return kept;
}

/** Drop the class from each actor when every one of them shares it; say it once instead. */
function hoistSharedClass(actors: ActorLike[]): { actors: ActorLike[]; sharedClass?: string } {
  const classes = new Set(actors.map((a) => a.class));
  if (classes.size !== 1 || actors.length < 3) return { actors };
  const [sharedClass] = [...classes];
  if (!sharedClass) return { actors };
  return {
    sharedClass,
    actors: actors.map(({ class: _dropped, ...rest }) => rest),
  };
}

export function capActorList(result: ActorListLike, options: CapActorOptions = {}): ActorListLike {
  const all = result.actors ?? [];
  const filtered = Boolean(options.classFilter?.trim());
  const limit = Math.max(
    1,
    options.maxResults ?? (filtered ? DEFAULT_FILTERED_ACTORS : DEFAULT_UNFILTERED_ACTORS)
  );

  if (all.length <= limit) {
    const { actors, sharedClass } = hoistSharedClass(all);
    return { ...result, actors, ...(sharedClass ? { class: sharedClass } : {}) };
  }

  const kept = filtered ? all.slice(0, limit) : pickInteresting(all, limit);
  const { actors, sharedClass } = hoistSharedClass(kept);

  return {
    ...result,
    actors,
    ...(sharedClass ? { class: sharedClass } : {}),
    totalActors: result.totalActors ?? all.length,
    shown: kept.length,
    omitted: all.length - kept.length,
    truncated: true,
    next: filtered
      ? `${all.length} actors match this filter and ${kept.length} are shown. Narrow the filter, or ` +
        `raise \`maxResults\` if you genuinely need the rest.`
      : `This level has ${all.length} actors. Shown are the ${kept.length} that carry logic or are ` +
        `the only one of their class - the rest is dressing (meshes, lights, volumes). byClass above ` +
        `covers the whole level. To act on something specific, pass \`classFilter\`; it matches on the ` +
        `class name, e.g. "BP_", "Light", "PlayerStart".`,
  };
}
