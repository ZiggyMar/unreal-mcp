import { test } from "node:test";
import assert from "node:assert/strict";

import { RepeatGuard } from "../dist/repeatGuard.js";

test("the first call is never flagged", () => {
  const guard = new RepeatGuard();
  assert.equal(guard.record("unreal_doctor", {}).notice, null);
});

test("an advisory tool is flagged on the second identical call", () => {
  // Advisory tools answer the same way until the project changes, so a second identical call is
  // already a loop rather than a retry.
  const guard = new RepeatGuard();
  guard.record("unreal_plan_feature", { request: "add a shield" });
  const second = guard.record("unreal_plan_feature", { request: "add a shield" });
  assert.equal(second.count, 2);
  assert.match(second.notice ?? "", /twice/);
  assert.match(second.notice ?? "", /same/i);
});

test("a tool that does work gets one free retry", () => {
  // A write can legitimately be retried once - a timeout is not a rollback, and this project tells
  // callers to re-read and retry. Flagging that as a loop would contradict its own advice.
  const guard = new RepeatGuard();
  const args = { path: "/Game/X.X", variableName: "Health", type: "float" };
  assert.equal(guard.record("unreal_add_variable", args).notice, null);
  assert.equal(guard.record("unreal_add_variable", args).notice, null);
  assert.ok(guard.record("unreal_add_variable", args).notice, "a third identical write should be flagged");
});

test("different arguments are different calls", () => {
  const guard = new RepeatGuard();
  guard.record("unreal_explain_graph", { path: "/Game/A.A" });
  assert.equal(guard.record("unreal_explain_graph", { path: "/Game/B.B" }).notice, null);
});

test("argument order does not make a repeat look new", () => {
  // A model rarely emits keys in a stable order, and a guard fooled by key order would never fire
  // on the loops it exists for.
  const guard = new RepeatGuard();
  guard.record("unreal_doctor", { a: 1, b: 2 });
  const second = guard.record("unreal_doctor", { b: 2, a: 1 });
  assert.equal(second.count, 2, "the same arguments in a different order should count as a repeat");
});

test("the notice says what to do, not just that something is wrong", () => {
  // The measured failure mode is a model that has nothing to do next. A notice that only says
  // "you repeated yourself" leaves it exactly where it was.
  const guard = new RepeatGuard();
  guard.record("unreal_doctor", {});
  const notice = guard.record("unreal_doctor", {}).notice ?? "";
  assert.match(notice, /different tool|stop/i);
});

test("the kill switch silences it entirely", () => {
  // Present so the effect of this can be A/B measured rather than assumed - which is how it was
  // established that it does not change a 7B's behaviour at all.
  const previous = process.env.UNREAL_MCP_REPEAT_NOTICE;
  process.env.UNREAL_MCP_REPEAT_NOTICE = "off";
  try {
    const guard = new RepeatGuard();
    guard.record("unreal_doctor", {});
    assert.equal(guard.record("unreal_doctor", {}).notice, null);
  } finally {
    if (previous === undefined) delete process.env.UNREAL_MCP_REPEAT_NOTICE;
    else process.env.UNREAL_MCP_REPEAT_NOTICE = previous;
  }
});
