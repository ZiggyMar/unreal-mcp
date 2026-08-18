import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveMode, policyFor, allPolicies, DEFAULT_MODE } from "../dist/mode.js";

test("the default is standard, and an unset variable is not an error", () => {
  const { policy, warning } = resolveMode(undefined);
  assert.equal(policy.mode, "standard");
  assert.equal(policy.mode, DEFAULT_MODE);
  assert.equal(warning, undefined);
});

test("an unknown mode falls back to standard and says so, rather than failing to start", () => {
  const { policy, warning } = resolveMode("cheapest");
  assert.equal(policy.mode, "standard");
  assert.match(warning, /unknown UNREAL_MCP_MODE/);
  assert.match(warning, /fast, standard, max/);
});

test("modes are case and whitespace tolerant", () => {
  assert.equal(resolveMode("  MAX ").policy.mode, "max");
  assert.equal(resolveMode("Fast").policy.mode, "fast");
});

test("THE FLOOR NEVER MOVES: every mode lays the graph out", () => {
  // This is the load-bearing property of the whole design. A mode that produced worse Blueprints
  // to save tokens would be a trap, because whoever picks the cheap mode is usually least able to
  // spot the difference. Cheap changes the paperwork, never the artefact.
  for (const policy of allPolicies()) {
    assert.equal(policy.autoLayout, true, `${policy.mode} skips layout, which changes the output quality`);
  }
});

test("cost rises monotonically from fast to max", () => {
  const fast = policyFor("fast");
  const standard = policyFor("standard");
  const max = policyFor("max");

  const reviewCost = { none: 0, summary: 1, full: 2 };
  assert.ok(reviewCost[fast.attachReview] < reviewCost[standard.attachReview]);
  assert.ok(reviewCost[standard.attachReview] < reviewCost[max.attachReview]);

  assert.equal(fast.commentBoxes, false);
  assert.equal(max.commentBoxes, true);
  assert.equal(fast.verboseBuildResult, false);
  assert.equal(max.verboseBuildResult, true);
});

test("fast tells the caller what it gave up, so quality is a choice and not a surprise", () => {
  const fast = policyFor("fast");
  assert.match(fast.description, /unreal_review_blueprint/);
  assert.match(fast.description, /not attached automatically/);
});

test("standard still carries the one thing that stops a model declaring false victory", () => {
  // The score plus a single next action is about thirty tokens. Dropping it by default would save
  // almost nothing and remove the only unprompted feedback a weak model ever gets.
  assert.equal(policyFor("standard").attachReview, "summary");
});

test("max caps its findings, so a pathological graph cannot flood the response", () => {
  const max = policyFor("max");
  assert.ok(max.maxFindings > 0);
  assert.ok(max.maxFindings <= 50);
});

test("every mode explains itself in one line", () => {
  for (const policy of allPolicies()) {
    assert.ok(policy.description.length > 40, `${policy.mode} has no usable description`);
    assert.ok(policy.description.startsWith(policy.mode), "the description should name its own mode");
  }
});
