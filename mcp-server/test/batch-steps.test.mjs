/**
 * The prefix mistake, and the one guard that stops this file becoming a lie.
 *
 * The interesting test here is the last one: COMPOSITE_TOOLS is a second copy of a list that already
 * exists in check-tool-parity.mjs, and a second copy that drifts would send somebody to a bridge
 * command that does not exist - the exact failure this module was written to prevent, reintroduced
 * by the prevention.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { checkBatchSteps, formatStepProblems, COMPOSITE_TOOLS } from "../dist/batchSteps.js";

const here = dirname(fileURLToPath(import.meta.url));

test("bridge command names pass untouched", () => {
  const steps = [
    { cmd: "create_blueprint", params: { path: "/Game/BP_X" } },
    { cmd: "add_variable", params: { name: "Health" } },
    { cmd: "compile_blueprint" },
  ];
  assert.deepEqual(checkBatchSteps(steps), []);
});

test("the unreal_ prefix is caught before anything is sent, and the fix is named", () => {
  const problems = checkBatchSteps([{ cmd: "unreal_add_variable" }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /"add_variable"/, "it must name the corrected spelling");
  assert.match(problems[0].message, /not the tool name/);
  assert.equal(problems[0].index, 0);
});

test("the step index is reported, so a long batch does not have to be re-read", () => {
  const problems = checkBatchSteps([
    { cmd: "create_blueprint" },
    { cmd: "add_component" },
    { cmd: "unreal_compile_blueprint" },
  ]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].index, 2);
  assert.match(problems[0].message, /step 2/);
});

test("a composite tool is refused with the right advice, not a spelling fix", () => {
  // Stripping the prefix off scaffold_blueprint produces a command that does not exist, so the
  // generic correction would send the caller somewhere worse than where they started.
  const problems = checkBatchSteps([{ cmd: "unreal_scaffold_blueprint" }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /composes from/);
  assert.match(problems[0].message, /already one call/);
  assert.doesNotMatch(problems[0].message, /use the bridge command/, "the spelling fix is wrong here");
});

test("every bad step is reported, not just the first", () => {
  const problems = checkBatchSteps([
    { cmd: "unreal_add_variable" },
    { cmd: "compile_blueprint" },
    { cmd: "unreal_explain_graph" },
  ]);
  assert.equal(problems.length, 2);
  assert.deepEqual(
    problems.map((p) => p.index),
    [0, 2]
  );
});

test("a missing cmd is a problem rather than a crash", () => {
  const problems = checkBatchSteps([{ params: {} }, { cmd: "   " }]);
  assert.equal(problems.length, 2);
  for (const p of problems) assert.match(p.message, /has no cmd/);
});

test("the formatted message says nothing was sent", () => {
  // A caller that thinks a partial batch ran will try to clean up work that never happened.
  const text = formatStepProblems(checkBatchSteps([{ cmd: "unreal_add_variable" }]));
  assert.match(text, /nothing was sent/);
  assert.match(text, /project is unchanged/);
});

test("COMPOSITE_TOOLS agrees with check-tool-parity's own list", () => {
  // Two copies of one fact. This is the test that keeps the second one honest.
  const parity = readFileSync(join(here, "..", "scripts", "check-tool-parity.mjs"), "utf8");
  const start = parity.indexOf("const compositeTools = new Set(");
  assert.ok(start > 0, "check-tool-parity.mjs no longer declares compositeTools the way this expects");
  const end = parity.indexOf("]);", start);
  const declared = new Set([...parity.slice(start, end).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));

  const missingHere = [...declared].filter((t) => !COMPOSITE_TOOLS.has(t));
  const extraHere = [...COMPOSITE_TOOLS].filter((t) => !declared.has(t));

  assert.deepEqual(
    { missingHere, extraHere },
    { missingHere: [], extraHere: [] },
    "batchSteps.ts and check-tool-parity.mjs disagree about which tools are composite"
  );
});
