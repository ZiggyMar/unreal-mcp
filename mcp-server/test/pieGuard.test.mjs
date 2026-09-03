import { test } from "node:test";
import assert from "node:assert/strict";

import { pieGuardMessage, shouldRefuse } from "../dist/pieGuard.js";

test("nothing is refused when the server never started PIE", () => {
  // The belief gates the check. Without it every compile would pay a pie_status round trip for a
  // situation that is not happening.
  assert.equal(shouldRefuse(false, { running: true }), false);
});

test("a stale belief does not refuse - the editor decides", () => {
  // Someone clicked Stop in the editor. A guard that refuses on a ten-minute-old memory blocks real
  // work and cannot be argued with.
  assert.equal(shouldRefuse(true, { running: false }), false);
});

test("an unreachable editor does not refuse", () => {
  // pie_status threw, so nothing is known. Firing here would block work for a reason that has
  // nothing to do with PIE.
  assert.equal(shouldRefuse(true, undefined), false);
});

test("a confirmed running session refuses", () => {
  assert.equal(shouldRefuse(true, { running: true }), true);
});

test("`running` missing is treated as not running, never as running", () => {
  // A reply shape that does not say must not be read as the dangerous case: refusing on absence
  // would break every caller the moment the reply changed.
  assert.equal(shouldRefuse(true, {}), false);
});

test("the refusal names the tool, the asset, and what would happen", () => {
  const text = pieGuardMessage("unreal_compile_blueprint", "/Game/BP_Thing", {
    running: true,
    worlds: [{ role: "Authority" }],
  });
  assert.match(text, /unreal_compile_blueprint refused/);
  assert.match(text, /\/Game\/BP_Thing/);
  assert.match(text, /crashes the editor/);
  // It must say nothing changed: after a refusal the caller has to know whether to re-check state.
  assert.match(text, /Nothing was changed/);
  assert.match(text, /unreal_stop_pie/);
});

test("two worlds are reported as two, because that is the case that crashed", () => {
  const text = pieGuardMessage("unreal_compile_blueprint", "/Game/BP_Thing", {
    running: true,
    worlds: [{ role: "Authority" }, { role: "Client0" }],
  });
  assert.match(text, /2 PIE worlds are running \(Authority, Client0\)/);
  assert.match(text, /instances in them/);
});

test("one world reads as singular", () => {
  const text = pieGuardMessage("unreal_save_blueprint", "/Game/BP_Thing", {
    running: true,
    worlds: [{ role: "Standalone" }],
  });
  assert.match(text, /a PIE session is running/);
  assert.match(text, /instances in it/);
});

test("a reply with no worlds still produces a usable refusal", () => {
  // The guard must not depend on `worlds` being present - it is the reason to refuse, not the proof.
  const text = pieGuardMessage("unreal_compile_blueprint", "/Game/BP_Thing", { running: true });
  assert.match(text, /a PIE session is running/);
  assert.match(text, /Nothing was changed/);
});
