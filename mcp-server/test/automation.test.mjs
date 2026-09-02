import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAutomationRun, parseAutomationList, runIsComplete } from "../dist/automation.js";

// Copied from a real run against a live editor, not invented.
const PASSING = `
[2026.09.02-03.41.14:243][351]LogAutomationCommandLine: Display: Found 1 automation tests based on 'System.Mass.EntityView.Invalidate'
[2026.09.02-03.41.14:247][351]LogAutomationController: Display: Test Started. Name={Invalidate} Path={System.Mass.EntityView.Invalidate}
[2026.09.02-03.41.14:352][353]LogAutomationController: Display: Test Completed. Result={Success} Name={Invalidate} Path={System.Mass.EntityView.Invalidate}
[2026.09.02-03.41.14:352][353]LogAutomationController: BeginEvents: System.Mass.EntityView.Invalidate
[2026.09.02-03.41.14:352][353]LogAutomationController: EndEvents: System.Mass.EntityView.Invalidate
[2026.09.02-03.41.14:353][353]LogAutomationCommandLine: Display: ...Automation Test Queue Empty 1 tests performed.
`;

const FAILING = `
[2026.09.02-03.50.00:100][10]LogAutomationCommandLine: Display: Found 2 automation tests based on 'MyGame'
[2026.09.02-03.50.00:200][10]LogAutomationController: Display: Test Completed. Result={Success} Name={Alpha} Path={MyGame.Alpha}
[2026.09.02-03.50.00:300][11]LogAutomationController: Display: Test Completed. Result={Fail} Name={Beta} Path={MyGame.Beta}
[2026.09.02-03.50.00:301][11]LogAutomationController: BeginEvents: MyGame.Beta
[2026.09.02-03.50.00:301][11]LogAutomationController: Error: Expected 3 items but found 0
[2026.09.02-03.50.00:302][11]LogAutomationController: EndEvents: MyGame.Beta
[2026.09.02-03.50.00:303][11]LogAutomationCommandLine: Display: ...Automation Test Queue Empty 2 tests performed.
`;

test("a clean run counts the pass and finishes", () => {
  const run = parseAutomationRun(PASSING);
  assert.equal(run.passed, 1);
  assert.equal(run.failed, 0);
  assert.equal(run.complete, true);
  assert.equal(run.found, 1);
  assert.equal(run.performed, 1);
});

test("a failure is named and carries the engine's own message", () => {
  const run = parseAutomationRun(FAILING);
  assert.equal(run.passed, 1);
  assert.equal(run.failed, 1);
  assert.equal(run.failures[0].path, "MyGame.Beta");
  assert.deepEqual(run.failures[0].events, ["Error: Expected 3 items but found 0"]);
});

test("passing tests are counted, never listed", () => {
  // 5,000 test names is ~30k tokens to answer a question nobody asked. The failures are the answer.
  const run = parseAutomationRun(FAILING);
  assert.equal(run.failures.length, 1);
  assert.ok(!JSON.stringify(run).includes("MyGame.Alpha"));
});

test("a verdict that is not Success is not a pass", () => {
  // The failure mode that makes a test runner worse than no test runner: an engine version adds a
  // result word this was not written against, and everything silently starts passing.
  const run = parseAutomationRun(
    "LogAutomationController: Display: Test Completed. Result={Skipped} Name={X} Path={A.X}\n"
  );
  assert.equal(run.passed, 0);
  assert.equal(run.failed, 1);
});

test("a run with no terminal line is incomplete, not clean", () => {
  // A timed-out run and a clean run both show zero failures. Reporting the first as the second is
  // the one way this tool could do real harm.
  const cut = PASSING.split("...Automation Test Queue Empty")[0];
  const run = parseAutomationRun(cut);
  assert.equal(run.complete, false);
  assert.equal(run.failed, 0);
  assert.equal(runIsComplete(cut), false);
});

test("the list is filtered and says what it left out", () => {
  const text = `
LogAutomationController: 4957 tests available on ABC
LogAutomationCommandLine: Display: \t'System.Mass.EntityView.Invalidate'
LogAutomationCommandLine: Display: \t'System.Mass.Execution.EmptyArray'
LogAutomationCommandLine: Display: \t'Editor.Something.Else'
`;
  const all = parseAutomationList(text);
  assert.equal(all.total, 4957, "the engine's own count, not the number of lines printed");
  assert.equal(all.names.length, 3);

  const filtered = parseAutomationList(text, "EntityView");
  assert.deepEqual(filtered.names, ["System.Mass.EntityView.Invalidate"]);
});

test("the list caps and reports the overflow rather than dropping it silently", () => {
  const text = Array.from({ length: 10 }, (_, i) => `LogAutomationCommandLine: Display: \t'A.Test${i}'`).join("\n");
  const listed = parseAutomationList(text, undefined, 4);
  assert.equal(listed.names.length, 4);
  assert.equal(listed.omitted, 6);
});

test("interleaved lines from other systems are skipped, not treated as failures", () => {
  // This reads a log other subsystems write to at the same time.
  const noisy = FAILING.replace(
    "LogAutomationController: BeginEvents: MyGame.Beta",
    "LogShaderCompilers: Display: Compiling 4 shaders\nLogAutomationController: BeginEvents: MyGame.Beta"
  );
  const run = parseAutomationRun(noisy);
  assert.equal(run.failed, 1);
  assert.equal(run.passed, 1);
});
