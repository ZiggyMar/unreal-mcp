import { test } from "node:test";
import assert from "node:assert/strict";

import { findNiagaraFaults } from "../dist/niagaraAudit.js";

test("a system with no emitters is reported: it spawns and renders nothing", () => {
  const [finding] = findNiagaraFaults({ emitters: [] }, "NS_Broken");
  assert.equal(finding.check, "niagara-system-empty");
  assert.match(finding.message, /renders nothing/);
});

test("every emitter disabled is the same thing in practice", () => {
  const [finding] = findNiagaraFaults(
    { emitters: [{ emitter: "A", disabled: true }, { emitter: "B", disabled: true }] },
    "NS_Off"
  );
  assert.equal(finding.check, "niagara-all-emitters-disabled");
  assert.match(finding.observed, /A, B/, "it must name which ones, not just how many");
});

test("SOME emitters disabled is ordinary authoring and must not be reported", () => {
  // Measured on a real project: NS_Wind_Swirl has three of six disabled on purpose. A check that
  // fired on that would fire on every VFX project and be ignored on all of them - the same trap the
  // animation checks avoid by leaving single-state machines alone.
  const findings = findNiagaraFaults(
    {
      emitters: [
        { emitter: "A" },
        { emitter: "B", disabled: true },
        { emitter: "C", disabled: true },
      ],
    },
    "NS_Wind_Swirl"
  );
  assert.deepEqual(findings, []);
});

test("a healthy system produces nothing", () => {
  assert.deepEqual(findNiagaraFaults({ emitters: [{ emitter: "Main" }] }, "NS_Fine"), []);
});
