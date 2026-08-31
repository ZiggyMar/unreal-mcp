import test from "node:test";
import assert from "node:assert/strict";

import { interpretLiveCodingLog, hotReloadCpp, unavailableReport } from "../dist/liveCoding.js";

/**
 * The exact strings the engine emits, copied from
 * Engine/Source/Developer/Windows/LiveCoding/Private/LiveCodingModule.cpp (UE 5.6, ~line 920).
 *
 * They are quoted here rather than paraphrased because the whole hazard is that three of them share
 * a prefix. A test written against a paraphrase would pass while the real one failed.
 */
const ENGINE = {
  success: "Live coding succeeded",
  noChanges: "Live coding succeeded, no code changes detected",
  unsafe:
    "warning: Live coding succeeded, data type changes with re-instancing disabled is not supported and will likely lead to a crash",
  packaging:
    "warning: Live coding succeeded, data type changes may cause packaging to fail if assets reference the new or updated data types",
  failed: "error: Live coding failed, please see Live console for more information",
  cancelled: "error: Live coding canceled",
  noConsole:
    "error: Unable to start live coding session. Missing executable 'LiveCodingConsole.exe'. Use the LiveCoding.ConsolePath console variable to modify.",
};

test('"no code changes detected" is not reported as a successful patch', () => {
  // The whole reason this module orders its checks. "Live coding succeeded" is a PREFIX of the
  // no-changes line, so the naive substring test calls a compile that rebuilt nothing a win - and
  // that is the common case, because the usual cause is a file the model forgot to save.
  const report = interpretLiveCodingLog([ENGINE.noChanges]);
  assert.equal(report.outcome, "no-changes");
  assert.match(report.meaning, /compiled nothing|no changed/i);
  assert.match(report.next ?? "", /saved/i, "should name the usual cause");
});

test("a clean patch says so and asks for nothing further", () => {
  const report = interpretLiveCodingLog([ENGINE.success]);
  assert.equal(report.outcome, "patched");
  // A success reply is the one that happens most often and should be the cheapest. No next step, no
  // log echoed back: there is nothing for the caller to do.
  assert.equal(report.next, undefined);
  assert.equal(report.log, undefined);
});

test("the engine's re-instancing warning becomes its own outcome, not a footnote on success", () => {
  for (const line of [ENGINE.unsafe, ENGINE.packaging]) {
    const report = interpretLiveCodingLog([line]);
    assert.equal(report.outcome, "patched-but-unsafe", line);
    // The warning is the reason the outcome differs, so it has to survive into the reply.
    assert.ok(report.log?.some((l) => l.includes("data type changes")), "the warning must be quoted");
    assert.match(report.next ?? "", /UPROPERTY/, "should name what usually causes it");
  }
});

test("a failed compile says where the errors actually are", () => {
  const report = interpretLiveCodingLog([ENGINE.failed]);
  assert.equal(report.outcome, "compile-failed");
  // "please see Live console for more information" is useless to a model - that console is another
  // process. The reply has to name the call that does produce diagnostics.
  assert.match(report.next ?? "", /unreal_compile_cpp/);
});

test("a session that never started is a failure, not silence", () => {
  const report = interpretLiveCodingLog([ENGINE.noConsole]);
  assert.equal(report.outcome, "compile-failed");
  assert.ok(report.log?.[0].includes("LiveCodingConsole"), "the engine's own diagnosis must survive");
});

test("cancelled is its own outcome", () => {
  assert.equal(interpretLiveCodingLog([ENGINE.cancelled]).outcome, "cancelled");
});

test("an unrecognised log is admitted rather than guessed at", () => {
  const report = interpretLiveCodingLog(["something the engine has never said before"]);
  assert.equal(report.outcome, "unclear");
  assert.deepEqual(report.log, ["something the engine has never said before"]);
});

test("an empty log does not become a success", () => {
  // The dangerous default. Nothing logged means nothing is known, and the one outcome it must not
  // collapse to is the one that tells a caller to go and test their fix.
  const report = interpretLiveCodingLog([]);
  assert.equal(report.outcome, "unclear");
  assert.notEqual(report.outcome, "patched");
});

/** A fake bridge that plays a scripted sequence of replies. */
function fakeBridge(script) {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push(cmd);
      const next = script.shift();
      assert.ok(next, `no scripted reply left for ${cmd}`);
      assert.equal(next.cmd, cmd, `expected ${next.cmd}, got ${cmd}`);
      return next.reply;
    },
  };
}

const NO_WAIT = { wait: async () => {}, now: () => 0 };

test("an editor without live coding gets the rebuild that does work, not a refusal", async () => {
  const bridge = fakeBridge([
    { cmd: "live_coding_status", reply: { available: false, why: "This engine build was compiled without live coding (WITH_LIVE_CODING=0)." } },
  ]);
  const report = await hotReloadCpp({ send: bridge.send, ...NO_WAIT });
  assert.equal(report.outcome, "unavailable");
  assert.match(report.meaning, /WITH_LIVE_CODING/);
  assert.match(report.next ?? "", /Close the editor/, "a refusal without the alternative is half an answer");
  // And it must not have tried to compile anyway.
  assert.deepEqual(bridge.calls, ["live_coding_status"]);
});

test("it polls until the compile finishes rather than reporting the first status it sees", async () => {
  const bridge = fakeBridge([
    { cmd: "live_coding_status", reply: { available: true, compiling: false, done: true } },
    { cmd: "live_coding_compile", reply: { started: true, result: "in-progress" } },
    { cmd: "live_coding_status", reply: { available: true, compiling: true, done: false } },
    { cmd: "live_coding_status", reply: { available: true, compiling: true, done: false } },
    { cmd: "live_coding_status", reply: { available: true, done: true, log: [ENGINE.success] } },
  ]);
  const report = await hotReloadCpp({ send: bridge.send, ...NO_WAIT });
  assert.equal(report.outcome, "patched");
  assert.equal(bridge.calls.filter((c) => c === "live_coding_status").length, 4);
});

test("a compile already running is joined, not fought with", async () => {
  // The human at the keyboard pressed Ctrl+Alt+F11 first. Starting a second compile returns
  // CompileStillActive and does nothing, so the useful move is to wait for theirs and say whose it was.
  const bridge = fakeBridge([
    { cmd: "live_coding_status", reply: { available: true, compiling: true, done: false } },
    { cmd: "live_coding_status", reply: { available: true, done: true, log: [ENGINE.success] } },
  ]);
  const report = await hotReloadCpp({ send: bridge.send, ...NO_WAIT });
  assert.equal(report.outcome, "patched");
  assert.ok(!bridge.calls.includes("live_coding_compile"), "must not start a second compile");
  assert.match(report.meaning, /already running/, "the caller should know it did not start this one");
});

test("giving up waiting is not the same as the compile stopping", async () => {
  let clock = 0;
  const bridge = fakeBridge([
    { cmd: "live_coding_status", reply: { available: true, compiling: false, done: true } },
    { cmd: "live_coding_compile", reply: { started: true, result: "in-progress" } },
    { cmd: "live_coding_status", reply: { available: true, compiling: true, done: false } },
  ]);
  const report = await hotReloadCpp(
    { send: bridge.send, wait: async () => { clock += 60_000; }, now: () => clock },
    { timeoutSeconds: 10 }
  );
  assert.equal(report.outcome, "still-running");
  // The distinction the word "timeout" usually destroys: the compile is fine, this call just stopped
  // watching it. A caller told "timed out" would assume it failed and start over.
  assert.match(report.meaning, /has not been stopped|still working/i);
  assert.match(report.next ?? "", /again/, "calling again should pick the same compile back up");
});

test("unavailableReport prefers the engine's own sentence over an invented one", () => {
  const withEnableError = unavailableReport({
    available: true,
    enableError: "Some modules have already been hot reloaded.",
  });
  assert.match(withEnableError.meaning, /already been hot reloaded/);
  const bare = unavailableReport({ available: false });
  assert.match(bare.meaning, /not available/i, "and still says something when the engine said nothing");
});
