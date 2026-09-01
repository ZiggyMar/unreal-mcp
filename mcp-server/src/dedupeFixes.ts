/**
 * Say each fix once, not once per finding.
 *
 * A review of BP_Player returns 30 findings drawn from 8 distinct checks, and every one of them
 * carries the full fix text for its check. `unlabelled-sections` appears ten times, so its 187
 * characters of advice are sent ten times. Measured on the whole reply:
 *
 *   fix text sent   5,680 chars
 *   distinct        1,408 chars
 *   repetition      4,272 chars   ~1,068 tokens, 20% of the reply
 *
 * The fix for a check does not vary by where the check fired - that is what makes it a check - so
 * the repetition carries nothing. Each finding already names its `check`, which is the key.
 *
 * ## Why here and not in reviewBlueprint
 *
 * audit.ts reads `finding.fix` in twelve places, building its own grouped findings from the same
 * review. Stripping the field where the review is produced would break the audit; stripping it where
 * the review is SERIALISED does not touch it. That is this project's existing rule - compact in the
 * tool layer, never in the shared function - applied to the one place it had not been.
 *
 * ## What must not happen
 *
 * The advice must still be reachable, and reachable without guessing. So the map is emitted at the
 * top of the reply, the contract is stated on the tool, and a finding whose check somehow has no
 * entry keeps its own `fix` rather than losing it. Cheaper is only worth having if nothing is lost.
 */

interface FindingLike {
  check?: string;
  fix?: string;
  [key: string]: unknown;
}

interface GraphLike {
  findings?: FindingLike[];
  [key: string]: unknown;
}

export interface DedupedReview {
  /** Fix text by check name, said once. */
  fixes?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Lift repeated `fix` text out of a review's findings into one map keyed by check.
 *
 * Returns the review unchanged when there is nothing to gain - a single finding per check, or no
 * findings at all - because a `fixes` map with one entry per finding is the same bytes plus a
 * lookup.
 */
/**
 * Checks whose node ids identify something a caller would never act on one at a time.
 *
 * The test is whether the fix is a per-node edit. `dead-node` says "remove them with
 * unreal_remove_node" and needs every id; `long-exec-chain` says "extract the middle of it" and the
 * root id says which chain. `unlabelled-sections` says "run unreal_auto_layout_graph", which takes a
 * graph, not a node - so its ids are a list nobody can use, and its count is already in the message.
 */
const IDS_NOT_INDIVIDUALLY_ACTIONABLE = new Set(["unlabelled-sections"]);

export function dedupeFixes<T extends object>(review: T): T & DedupedReview {
  // Read structurally rather than by declared type. The review's own finding types are stricter than
  // anything this needs to know - it only looks at `check` and `fix` - and importing them here would
  // couple a presentation concern to the shape audit.ts depends on, which is the coupling this file
  // exists to avoid.
  const source = review as { graphs?: GraphLike[]; blueprint?: FindingLike[] };
  const graphs = Array.isArray(source.graphs) ? source.graphs : [];
  const blueprintFindings = Array.isArray(source.blueprint) ? source.blueprint : [];
  const all: FindingLike[] = [...graphs.flatMap((g) => (Array.isArray(g.findings) ? g.findings : [])), ...blueprintFindings];

  const fixes: Record<string, string> = {};
  let repeated = 0;
  for (const finding of all) {
    const { check, fix } = finding;
    if (typeof check !== "string" || typeof fix !== "string" || fix.length === 0) continue;
    if (fixes[check] === undefined) fixes[check] = fix;
    else if (fixes[check] === fix) repeated += fix.length;
    // A check whose fix text VARIES between findings is left alone entirely: the first one wins the
    // map slot and the others keep their own field below, because two different pieces of advice
    // under one key would be worse than the repetition this removes.
  }

  // Untouched means untouched, identically.
  //
  // A review with nothing repeated and no unactionable ids is returned as the very object that came
  // in, not a copy of it. That is asserted by a test, and it is worth asserting: a `fixes` map with
  // one entry per finding is the same bytes plus a lookup, and rebuilding an object to change
  // nothing is a cost with no reader.
  const hasIdsToDrop = all.some(
    (f) => typeof f.check === "string" && IDS_NOT_INDIVIDUALLY_ACTIONABLE.has(f.check) && "nodeIds" in f
  );
  if (repeated === 0 && !hasIdsToDrop) return review as T & DedupedReview;

  const strip = (finding: FindingLike): FindingLike => {
    let out = finding;

    // Node ids for a finding whose remedy is the whole graph.
    //
    // `unlabelled-sections` says "3 execution chains but only 0 comment box(es)" and its fix is
    // "run unreal_auto_layout_graph", which wraps every chain at once. It also listed the root id of
    // every chain. Measured on BP_Player: eleven of those findings carried 145 node ids and 1,562
    // characters - 14% of the whole reply - against 260 characters of ids for all sixteen WARNINGS
    // put together. The count is already in the message and nobody wraps a chain by id, so those
    // bytes bought a caller nothing.
    //
    // Only the ids are dropped, and only here, at serialisation. cleanup.ts reads
    // `finding.nodeIds.length` off the review internals to report what it left alone, and audit.ts
    // reads findings too; both call reviewBlueprint directly and still get every field.
    if (typeof out.check === "string" && IDS_NOT_INDIVIDUALLY_ACTIONABLE.has(out.check)) {
      const { nodeIds: _ids, ...rest } = out as FindingLike & { nodeIds?: unknown };
      out = rest;
    }

    // Lifting a fix into the map is only safe when the map is actually emitted, and it is emitted
    // only when something repeated. Stripping regardless deleted the advice outright the moment a
    // review had ids to drop and no repetition - the finding lost its `fix` and there was no `fixes`
    // map to look it up in. Caught by a test written for the ids, which is the argument for writing
    // the test for the case you think is boring.
    const { check, fix } = out;
    if (repeated === 0) return out;
    if (typeof check !== "string" || typeof fix !== "string") return out;
    if (fixes[check] !== fix) return out; // varies from the map: keep this one's own text
    const { fix: _lifted, ...withoutFix } = out;
    return withoutFix;
  };

  return {
    ...(review as object),
    // Only when something actually repeated. A `fixes` map holding one entry per finding is the
    // repetition it exists to remove, wearing a different key.
    ...(repeated > 0 ? { fixes } : {}),
    ...(graphs.length > 0
      ? {
          graphs: graphs.map((g) =>
            Array.isArray(g.findings) ? { ...g, findings: g.findings.map(strip) } : g
          ),
        }
      : {}),
    ...(blueprintFindings.length > 0 ? { blueprint: blueprintFindings.map(strip) } : {}),
  } as T & DedupedReview;
}
