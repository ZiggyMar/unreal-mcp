/**
 * Find the actors that have lost the partner they depend on.
 *
 * Levels are full of actors that only work in pairs: a nav link and the door it belongs to, a
 * trigger and the thing it triggers, a spawn point and its volume. Delete one half and the other
 * half stays behind, still ticking, still handling events, and pointing at nothing. Nothing warns,
 * because an actor with a null reference is a perfectly legal actor.
 *
 * The case that motivated this: a level had 25 nav links and 12 firewalls. Twenty-four paired off
 * two per firewall, all within 190 units. One sat 921 units from the nearest firewall - left behind
 * when a wall was deleted - and it still handled "smart link reached" by messaging a firewall that
 * no longer existed. An enemy that walked onto it waited for an event that could never arrive.
 *
 * Why it pairs by DISTANCE rather than by reading the reference property. The reference is the thing
 * that is broken, so it is the least reliable evidence available: a null tells you nothing about
 * what it was supposed to point at, and a stale one may still name an actor that was deleted.
 * Position survives both. Two actors that were placed together are still where they were placed.
 *
 * The threshold is inferred rather than guessed, because the right distance depends entirely on the
 * level and a wrong constant either misses every orphan or reports every actor.
 *
 * It is inferred by looking for the GAP, not by taking a multiple of the median, and that difference
 * was settled by the level rather than by argument. A first version used five times the median; on
 * the real level the median pairing distance was 204 units and the actual orphan sat at 921, so the
 * threshold landed at 1019 and the check reported a clean level while the bug it was written for sat
 * right there. The synthetic fixture had passed, because a fixture author puts the orphan somewhere
 * obvious.
 *
 * Real pairs cluster, and a leftover is separated from that cluster by a jump. So the distances are
 * sorted and the largest proportional step between neighbours is found: if something is standing
 * well clear of the pack, the threshold goes in the gap. If the distances form one smooth run - a
 * level with no orphan - there is no such step and nothing is reported.
 */

export interface BridgeLike {
  send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T>;
}

interface ActorEntry {
  label: string;
  name: string;
  class: string;
  location: string;
}

export interface Orphan {
  actor: string;
  location: string;
  nearestPartner: string;
  distance: number;
}

export interface OrphanReport {
  of: string;
  pairedWith: string;
  counted: { of: number; pairedWith: number };
  /** Distance from each actor to its nearest partner, ascending. The evidence for the threshold. */
  medianDistance: number;
  threshold: number;
  thresholdSource: "given" | "inferred";
  orphans: Orphan[];
  /** Partners that nothing paired to - the other half of the same mistake. */
  partnersWithNothing: string[];
  verdict: "clean" | "problems";
  next: string;
}

function parseLocation(text: string): [number, number, number] {
  const parts = String(text ?? "")
    .split(",")
    .map((n) => Number(n.trim()));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Put the threshold in the largest proportional gap between sorted distances.
 *
 * A floor of 50 units keeps a cluster sitting at 0-2 units apart from producing enormous ratios out
 * of rounding noise, and the 2.5x requirement means a level whose distances rise smoothly - which is
 * a level with no orphan in it - yields no threshold at all rather than an arbitrary cut.
 */
function inferThreshold(distances: number[]): number {
  const sorted = [...distances].sort((a, b) => a - b);
  if (sorted.length < 3) return Infinity;

  const FLOOR = 50;
  let bestRatio = 0;
  let cut = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const lower = Math.max(sorted[i - 1], FLOOR);
    const ratio = Math.max(sorted[i], FLOOR) / lower;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      // Geometric midpoint: sits proportionally between the two, which is the right kind of middle
      // for a scale where the interesting comparisons are ratios.
      cut = Math.sqrt(lower * Math.max(sorted[i], FLOOR));
    }
  }
  return bestRatio >= 2.5 ? cut : Infinity;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function actorsMatching(bridge: BridgeLike, filter: string): Promise<ActorEntry[]> {
  const listed = await bridge.send<{ actors?: ActorEntry[] }>("list_actors", {
    classFilter: filter,
    maxResults: 500,
  });
  // classFilter is a substring match on the class name, and the bridge still returns the whole
  // level when nothing matches, so the filter is applied again here rather than trusted.
  const needle = filter.toLowerCase();
  return (listed.actors ?? []).filter((a) => String(a.class ?? "").toLowerCase().includes(needle));
}

export async function findOrphans(
  bridge: BridgeLike,
  options: { of: string; pairedWith: string; maxDistance?: number }
): Promise<OrphanReport> {
  const [ofActors, partners] = await Promise.all([
    actorsMatching(bridge, options.of),
    actorsMatching(bridge, options.pairedWith),
  ]);

  const base: Omit<OrphanReport, "verdict" | "next"> = {
    of: options.of,
    pairedWith: options.pairedWith,
    counted: { of: ofActors.length, pairedWith: partners.length },
    medianDistance: 0,
    threshold: options.maxDistance ?? 0,
    thresholdSource: options.maxDistance === undefined ? "inferred" : "given",
    orphans: [],
    partnersWithNothing: [],
  };

  if (ofActors.length === 0 || partners.length === 0) {
    return {
      ...base,
      verdict: "clean",
      next:
        `Nothing to compare: found ${ofActors.length} actor(s) matching "${options.of}" and ` +
        `${partners.length} matching "${options.pairedWith}" in the open level. Check the class names, ` +
        `and remember this reads the OPEN level - call unreal_open_level first if you meant another.`,
    };
  }

  const nearest = ofActors.map((actor) => {
    const here = parseLocation(actor.location);
    let best = partners[0];
    let bestDistance = Infinity;
    for (const partner of partners) {
      const d = distance(here, parseLocation(partner.location));
      if (d < bestDistance) {
        bestDistance = d;
        best = partner;
      }
    }
    return { actor, partner: best, distance: bestDistance };
  });

  const med = median(nearest.map((n) => n.distance));
  const threshold = options.maxDistance ?? inferThreshold(nearest.map((n) => n.distance));

  const orphans = nearest
    .filter((n) => n.distance > threshold)
    .map((n) => ({
      actor: n.actor.label,
      location: n.actor.location,
      nearestPartner: n.partner.label,
      distance: Math.round(n.distance),
    }))
    .sort((a, b) => b.distance - a.distance);

  const claimed = new Set(nearest.filter((n) => n.distance <= threshold).map((n) => n.partner.label));
  const partnersWithNothing = partners.map((p) => p.label).filter((label) => !claimed.has(label));

  const problems = orphans.length > 0 || partnersWithNothing.length > 0;
  return {
    ...base,
    medianDistance: Math.round(med),
    threshold: Math.round(threshold),
    orphans,
    partnersWithNothing,
    verdict: problems ? "problems" : "clean",
    next: problems
      ? `${orphans.length} "${options.of}" actor(s) have no "${options.pairedWith}" near them, and ` +
        `${partnersWithNothing.length} "${options.pairedWith}" actor(s) have nothing paired to them. ` +
        `A leftover half still ticks and still handles events while pointing at nothing, which is why ` +
        `this fails silently. Compare against the median pairing distance of ${Math.round(med)} before ` +
        `acting: an outlier by that standard is usually a deletion nobody finished.`
      : `Every "${options.of}" has a "${options.pairedWith}" within ${Math.round(threshold)} units ` +
        `(median ${Math.round(med)}), and none is unpaired.`,
  };
}
