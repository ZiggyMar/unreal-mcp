/**
 * Ask a review for one kind of finding.
 *
 * `unreal_audit_project` has taken a `check` since it was written - "pass its `check` to get one
 * kind of finding back in full" - and `unreal_review_blueprint`, which is the per-asset half of the
 * same job and the one the standing instructions put in step 6, never did. So a caller with a
 * specific question had two options: take everything, or narrow by graph and hope the finding lives
 * there.
 *
 * Measured on BP_Player: the whole review is 3,279 tokens. The seven multiplayer findings a
 * question like "what breaks in multiplayer here" is actually about are a fraction of that, and the
 * rest is cast warnings, long chains and per-frame work that the caller did not ask for.
 *
 * ## Filtering must not look like cleanliness
 *
 * This project has spent several commits on the difference between "nothing found" and "nothing
 * looked". A filtered review that simply returned fewer findings would be the same trap one level
 * down: a caller asking for `server-writes-unreplicated` on a Blueprint riddled with dead nodes
 * would see a short, clean-looking reply.
 *
 * So the counts describe the WHOLE review and the reply says what it withheld, and a `check` that
 * matched nothing is answered differently from one that is not a real check name at all - the same
 * distinction the audit draws with `checkNotFound`.
 */

export interface ReviewFinding {
  check?: string;
  [key: string]: unknown;
}

export interface ReviewLike {
  graphs?: Array<{ findings?: ReviewFinding[]; [key: string]: unknown }>;
  blueprint?: ReviewFinding[];
  fixes?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Every check name this review produced, so an unknown one can be told from an absent one. */
export function checksIn(review: ReviewLike): string[] {
  const names = new Set<string>();
  for (const graph of review.graphs ?? []) {
    for (const finding of graph.findings ?? []) if (finding.check) names.add(finding.check);
  }
  for (const finding of review.blueprint ?? []) if (finding.check) names.add(finding.check);
  return [...names].sort();
}

/**
 * Keep only findings of one kind, and say what that hid.
 *
 * Returns the review unchanged when no `check` is asked for, so the common path is untouched.
 */
export function filterReviewByCheck(review: ReviewLike, check: string | undefined): ReviewLike {
  const wanted = (check ?? "").trim();
  if (wanted.length === 0) return review;

  const present = checksIn(review);
  const before =
    (review.graphs ?? []).reduce((n, g) => n + (g.findings ?? []).length, 0) +
    (review.blueprint ?? []).length;

  const graphs = (review.graphs ?? [])
    .map((g) => ({ ...g, findings: (g.findings ?? []).filter((f) => f.check === wanted) }))
    // A graph with nothing left is not part of this answer. Its name is still in the review's own
    // cleanGraphs list when it had nothing wrong at all, so nothing is lost by dropping it here.
    .filter((g) => (g.findings as ReviewFinding[]).length > 0);
  const blueprint = (review.blueprint ?? []).filter((f) => f.check === wanted);

  const kept = graphs.reduce((n, g) => n + (g.findings as ReviewFinding[]).length, 0) + blueprint.length;

  // Only the fix text still being referred to. The rest describes findings that are no longer here.
  const fixes =
    review.fixes && typeof review.fixes === "object"
      ? Object.fromEntries(Object.entries(review.fixes).filter(([name]) => name === wanted))
      : review.fixes;

  return {
    ...review,
    graphs,
    blueprint,
    ...(fixes === undefined ? {} : { fixes }),
    filteredTo: wanted,
    // The number the summary above is about, restated so a filtered reply cannot be read as a whole
    // one. "3 of 22" is a different fact from "3".
    showing: `${kept} of ${before} finding(s); the rest are other kinds.`,
    ...(present.includes(wanted)
      ? {}
      : {
          checkNotFound:
            `No finding kind called "${wanted}" in this review. It found: ${present.join(", ") || "nothing"}. ` +
            `Nothing is being hidden by a filter that matched nothing - the list above is everything.`,
        }),
  };
}
