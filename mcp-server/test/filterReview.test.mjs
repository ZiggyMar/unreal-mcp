import { test } from "node:test";
import assert from "node:assert/strict";

import { filterReviewByCheck, checksIn } from "../dist/filterReview.js";

const REVIEW = {
  score: 62,
  summary: { errors: 0, warnings: 9, infos: 13 },
  graphs: [
    { graphName: "A", findings: [{ check: "dead-node" }, { check: "tick-heavy" }] },
    { graphName: "B", findings: [{ check: "dead-node" }] },
  ],
  blueprint: [{ check: "server-writes-unreplicated" }, { check: "name-has-stray-whitespace" }],
  cleanGraphs: ["C"],
  fixes: { "dead-node": "delete it", "tick-heavy": "move it off Tick", "server-writes-unreplicated": "replicate it" },
};

test("no check asked for leaves the review exactly as it was", () => {
  assert.equal(filterReviewByCheck(REVIEW, undefined), REVIEW);
  assert.equal(filterReviewByCheck(REVIEW, "   "), REVIEW);
});

test("one kind comes back, and graphs with nothing left are dropped", () => {
  const out = filterReviewByCheck(REVIEW, "dead-node");
  assert.equal(out.graphs.length, 2, "both graphs have a dead-node");
  assert.deepEqual(out.blueprint, []);
  const out2 = filterReviewByCheck(REVIEW, "tick-heavy");
  assert.equal(out2.graphs.length, 1, "only graph A has one");
  assert.equal(out2.graphs[0].graphName, "A");
});

test("a filtered reply cannot be read as a clean one", () => {
  // This project has spent several commits on "nothing found" versus "nothing looked". A filter that
  // just returned fewer findings would be the same trap one level down.
  const out = filterReviewByCheck(REVIEW, "server-writes-unreplicated");
  assert.equal(out.score, 62, "the score still describes the whole review");
  assert.deepEqual(out.summary, REVIEW.summary, "so do the counts");
  assert.match(out.showing, /1 of 5 finding/);
  assert.equal(out.filteredTo, "server-writes-unreplicated");
});

test("a kind that did not fire is told apart from a kind that does not exist", () => {
  const out = filterReviewByCheck(REVIEW, "branch-decides-nothing");
  assert.match(out.checkNotFound, /No finding kind called "branch-decides-nothing"/);
  // It has to name what DID fire, or the caller cannot tell a typo from a clean result.
  assert.match(out.checkNotFound, /dead-node/);
  assert.match(out.checkNotFound, /tick-heavy/);
});

test("only the fix text still being referred to survives", () => {
  const out = filterReviewByCheck(REVIEW, "dead-node");
  assert.deepEqual(Object.keys(out.fixes), ["dead-node"]);
});

test("checksIn lists every kind the review produced, sorted", () => {
  assert.deepEqual(checksIn(REVIEW), [
    "dead-node",
    "name-has-stray-whitespace",
    "server-writes-unreplicated",
    "tick-heavy",
  ]);
});
