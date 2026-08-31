import test from "node:test";
import assert from "node:assert/strict";

import { describeConsoleResult } from "../dist/consoleCommand.js";

test("an unrecognised command is not allowed to look like a quiet success", () => {
  // The entire reason this module exists. `stat untis` runs nothing and prints nothing, which is
  // indistinguishable from `stat units` having had no visible effect - and a model that cannot tell
  // them apart goes off investigating a game that is fine.
  const report = describeConsoleResult("stat untis", { world: "pie", recognised: false });
  assert.match(report.next ?? "", /not a command the engine knows/i);
  assert.match(report.next ?? "", /nothing ran/i);
  assert.match(report.next ?? "", /DumpConsoleCommands/, "should name the way to find the real one");
});

test("the suggestion is built from the command that was typed", () => {
  const report = describeConsoleResult("showdbug abilitysystem", { recognised: false });
  assert.match(report.next ?? "", /"showdbug"/, "quote back what they actually typed");
  assert.match(report.next ?? "", /DumpConsoleCommands show/, "and a prefix short enough to match");
});

test("a command that ran silently says that is all that is known", () => {
  // Common and normal - most cvars say nothing. But "it worked" and "it produced no evidence that it
  // worked" are different claims, and only the second one is true here.
  const report = describeConsoleResult("r.ScreenPercentage 50", { world: "editor", recognised: true });
  assert.match(report.next ?? "", /Nothing here confirms an effect/i);
});

test("a command that answered is left alone", () => {
  const report = describeConsoleResult("stat fps", {
    world: "pie",
    recognised: true,
    log: ["FPS: 61.2"],
  });
  // The log IS the answer. Anything added here is paid for on every successful call.
  assert.equal(report.next, undefined);
  assert.deepEqual(report.log, ["FPS: 61.2"]);
});

test("output alone counts as an answer", () => {
  const report = describeConsoleResult("obj list class=Actor", {
    recognised: true,
    output: "Objects: 412",
  });
  assert.equal(report.next, undefined);
});

test("the bridge's own errors are passed through without a second opinion", () => {
  for (const reply of [
    { error: "refused", detail: "`quit` and `exit` close the editor" },
    { error: "no_world", detail: "No game is running." },
    { error: "missing_command", detail: "Pass `command`" },
  ]) {
    const report = describeConsoleResult("quit", reply);
    // Each of these already explains itself and says what to do instead. A second sentence on top is
    // noise, and the refusal one especially must not be dressed up as a console result.
    assert.equal(report.next, undefined, reply.error);
    assert.equal(report.recognised, undefined);
    assert.equal(report.detail, reply.detail);
  }
});

test("a truncated log keeps the true total", () => {
  // `obj list` prints thousands. "60 lines" and "the first 60 of 4,312" are different answers.
  const report = describeConsoleResult("obj list", {
    recognised: true,
    log: new Array(60).fill("x"),
    logLinesTotal: 4312,
  });
  assert.equal(report.logLinesTotal, 4312);
});
