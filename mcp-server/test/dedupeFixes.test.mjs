import test from "node:test";
import assert from "node:assert/strict";

import { dedupeFixes } from "../dist/dedupeFixes.js";

/**
 * A review of BP_Player returns 30 findings drawn from 8 distinct checks, and every one carried the
 * full fix text for its check. `unlabelled-sections` appears ten times, so its 187 characters of
 * advice were sent ten times.
 *
 *   fix text sent   5,680 chars
 *   distinct        1,408 chars
 *   repetition      4,272 chars   ~1,068 tokens, 20% of the reply
 *
 * The fix for a check does not vary by where it fired - that is what makes it a check - so the
 * repetition carries nothing. 5,398 -> 4,235 tokens on the real Blueprint.
 */

const review = (findings) => ({ path: "/Game/BP.BP", score: 70, graphs: [{ graphName: "EventGraph", findings }] });

test("a repeated fix is said once and keyed by check", () => {
  const out = dedupeFixes(
    review([
      { check: "dead-node", message: "3 dead", fix: "Remove them." },
      { check: "dead-node", message: "1 dead", fix: "Remove them." },
    ])
  );
  assert.deepEqual(out.fixes, { "dead-node": "Remove them." });
  assert.deepEqual(
    out.graphs[0].findings.map((f) => "fix" in f),
    [false, false],
    "and lifted off both findings"
  );
});

test("every finding can still reach its advice", () => {
  // The whole trade. Cheaper is only worth having if nothing is lost, and the lookup key is the
  // `check` each finding already carries.
  const out = dedupeFixes(
    review([
      { check: "dead-node", message: "a", fix: "Remove them." },
      { check: "dead-node", message: "b", fix: "Remove them." },
      { check: "tick-heavy", message: "c", fix: "Move it off Tick." },
      { check: "tick-heavy", message: "d", fix: "Move it off Tick." },
    ])
  );
  for (const finding of out.graphs[0].findings) {
    assert.ok(finding.fix ?? out.fixes[finding.check], `${finding.message} lost its advice`);
  }
});

test("a check whose advice varies keeps its own text", () => {
  // Two different pieces of advice under one key would be worse than the repetition this removes -
  // one of the two findings would silently be given the other's fix.
  const out = dedupeFixes(
    review([
      { check: "dead-node", message: "a", fix: "Remove them." },
      { check: "dead-node", message: "b", fix: "Remove them." },
      { check: "dead-node", message: "c", fix: "Actually, wire them up instead." },
    ])
  );
  assert.equal(out.fixes["dead-node"], "Remove them.");
  assert.equal(out.graphs[0].findings[2].fix, "Actually, wire them up instead.", "the odd one keeps its own");
  assert.equal("fix" in out.graphs[0].findings[0], false);
});

test("nothing repeated means nothing changed", () => {
  // A `fixes` map with one entry per finding is the same bytes plus a lookup, so it is not worth
  // making the caller do one. Identity is the assertion.
  const input = review([
    { check: "dead-node", message: "a", fix: "Remove them." },
    { check: "tick-heavy", message: "b", fix: "Move it off Tick." },
  ]);
  assert.equal(dedupeFixes(input), input);
});

test("blueprint-level findings are deduped with the graph ones", () => {
  // review.blueprint holds the findings that are about the asset rather than any graph, and they
  // draw on the same checks - so a fix repeated across the boundary is still a repeat.
  const out = dedupeFixes({
    graphs: [{ findings: [{ check: "state-on-actor", message: "a", fix: "Move it to the GameState." }] }],
    blueprint: [{ check: "state-on-actor", message: "b", fix: "Move it to the GameState." }],
  });
  assert.deepEqual(out.fixes, { "state-on-actor": "Move it to the GameState." });
  assert.equal("fix" in out.blueprint[0], false);
});

test("a review with nothing wrong is untouched", () => {
  const clean = { path: "/Game/BP.BP", score: 100, graphs: [], cleanGraphs: ["EventGraph"] };
  assert.equal(dedupeFixes(clean), clean);
  // Written first as `dedupeFixes({}) === (undefined ?? dedupeFixes({}))`, which compares two
  // separate empty objects and can never pass. The assertion meant is that the same object comes
  // back, unthrown.
  const empty = {};
  assert.equal(dedupeFixes(empty), empty, "an empty object comes back as itself");
});

test("findings without a check or a fix are left alone", () => {
  // Not every finding shape here is guaranteed - the blueprint-level ones carry an extra `observed`
  // field, and a future check could omit `fix` entirely. None of that should be dropped.
  const input = review([
    { check: "dead-node", message: "a", fix: "Remove them." },
    { check: "dead-node", message: "b", fix: "Remove them." },
    { message: "no check at all" },
    { check: "no-fix-check", message: "c" },
  ]);
  const out = dedupeFixes(input);
  assert.deepEqual(out.graphs[0].findings[2], { message: "no check at all" });
  assert.deepEqual(out.graphs[0].findings[3], { check: "no-fix-check", message: "c" });
});

test("unlabelled-sections loses its node ids, because nobody wraps a chain by id", () => {
  // Measured on BP_Player: eleven of these carried 145 node ids and 1,562 characters - 14% of the
  // whole reply - against 260 characters of ids for all sixteen warnings put together. The fix is
  // "run unreal_auto_layout_graph", which takes a graph, and the count is already in the message.
  const out = dedupeFixes(
    review([
      {
        check: "unlabelled-sections",
        severity: "info",
        message: "3 execution chains but only 0 comment box(es).",
        fix: "Run unreal_auto_layout_graph.",
        nodeIds: ["A1", "B2", "C3"],
      },
    ])
  );

  const finding = out.graphs[0].findings[0];
  assert.equal(finding.nodeIds, undefined, "the ids are dropped");
  assert.match(finding.message, /3 execution chains/, "the count survives, in the message");
});

test("every other check keeps its ids, because they name what to edit", () => {
  const out = dedupeFixes(
    review([
      { check: "dead-node", message: "3 dead", fix: "Remove them.", nodeIds: ["A1", "B2"] },
      { check: "long-exec-chain", message: "40 nodes", fix: "Extract it.", nodeIds: ["C3"] },
      { check: "debug-print-left-in", message: "2 prints", fix: "Remove them.", nodeIds: ["D4"] },
    ])
  );

  const ids = out.graphs[0].findings.map((f) => f.nodeIds);
  assert.deepEqual(ids, [["A1", "B2"], ["C3"], ["D4"]]);
});

test("a review with only unactionable ids is still rewritten, and nothing else is", () => {
  // The identity check above must not be so eager that it skips this: nothing repeats here, so the
  // early return would fire on the fix count alone.
  const input = review([
    { check: "unlabelled-sections", message: "2 chains", fix: "Lay it out.", nodeIds: ["A1"] },
    { check: "tick-heavy", message: "b", fix: "Move it off Tick.", nodeIds: ["B2"] },
  ]);
  const out = dedupeFixes(input);

  assert.notEqual(out, input, "it had ids to drop, so it is a new object");
  assert.equal(out.graphs[0].findings[0].nodeIds, undefined);
  assert.deepEqual(out.graphs[0].findings[1].nodeIds, ["B2"]);
  assert.equal(out.fixes, undefined, "nothing repeated, so no fixes map was invented");
  assert.equal(out.graphs[0].findings[1].fix, "Move it off Tick.", "its own fix text stays");
});
