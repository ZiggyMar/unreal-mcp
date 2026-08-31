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

  if (repeated === 0) return review as T & DedupedReview;

  const strip = (finding: FindingLike): FindingLike => {
    const { check, fix } = finding;
    if (typeof check !== "string" || typeof fix !== "string") return finding;
    if (fixes[check] !== fix) return finding; // varies from the map: keep this one's own text
    const { fix: _lifted, ...rest } = finding;
    return rest;
  };

  return {
    ...(review as object),
    fixes,
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
