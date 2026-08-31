import test from "node:test";
import assert from "node:assert/strict";

import { findSequenceProblems } from "../dist/sequenceAudit.js";

/** The shape read_level_sequence actually returns, reduced. */
const healthy = {
  sequence: "LS_Intro",
  bindings: [
    { name: "CameraActor", tracks: "3DTransform, CameraComponent" },
    { name: "BP_Door", tracks: "3DTransform" },
  ],
  sequenceTracks: "CameraCut, Fade",
};

test("a sequence where everything animates produces nothing", () => {
  assert.deepEqual(findSequenceProblems(healthy), []);
});

test("a muted track is reported, because muting is the state most often left behind", () => {
  const report = findSequenceProblems({
    ...healthy,
    bindings: [{ name: "BP_Door", tracks: "3DTransform (muted)" }],
  });
  const finding = report.find((f) => f.check === "sequence-track-muted");
  assert.ok(finding, "a muted track has keys and does not evaluate");
  assert.match(finding.message, /BP_Door: 3DTransform \(muted\)/, "and names which one");
  assert.match(finding.fix, /audition/i, "the fix says why it happens, not just what to do");
});

test("a track with no sections is reported separately from a muted one", () => {
  // Different causes and different fixes: one has keys and is switched off, the other has no keys at
  // all. Collapsing them into "track does nothing" would lose the only thing that tells them apart.
  const report = findSequenceProblems({
    ...healthy,
    bindings: [{ name: "BP_Door", tracks: "3DTransform (no sections)" }],
  });
  assert.ok(report.find((f) => f.check === "sequence-track-no-sections"));
  assert.equal(report.find((f) => f.check === "sequence-track-muted"), undefined);
});

test("the sequence's own tracks count too, not just the ones under an actor", () => {
  // A camera cut track with no sections is the usual reason a cutscene plays from the wrong angle,
  // and it belongs to the sequence rather than to any binding - so a check that only walked bindings
  // would miss the most consequential case.
  const report = findSequenceProblems({
    ...healthy,
    sequenceTracks: "CameraCut (no sections), Fade",
  });
  const finding = report.find((f) => f.check === "sequence-track-no-sections");
  assert.ok(finding);
  assert.match(finding.message, /CameraCut/);
});

test("an actor bound with nothing animating it is info, not a warning", () => {
  // Harmless to run and misleading to read. It is the residue of deleting tracks, and pricing it
  // like a broken track would put leftovers above things that actually stop working.
  const report = findSequenceProblems({
    sequence: "LS_Intro",
    bindings: [{ name: "BP_Unused", tracks: "none" }, { name: "CameraActor", tracks: "3DTransform" }],
  });
  const finding = report.find((f) => f.check === "sequence-binding-no-tracks");
  assert.ok(finding);
  assert.equal(finding.severity, "info");
  assert.match(finding.message, /BP_Unused/);
  assert.doesNotMatch(finding.message, /CameraActor/, "the one that does animate is not a finding");
});

test("a track that is both muted and empty is reported by both checks", () => {
  // They are two separate facts about the same track, and fixing one does not fix the other:
  // un-muting an empty track still evaluates nothing.
  const report = findSequenceProblems({
    bindings: [{ name: "BP_Door", tracks: "3DTransform (no sections) (muted)" }],
  });
  assert.ok(report.find((f) => f.check === "sequence-track-muted"));
  assert.ok(report.find((f) => f.check === "sequence-track-no-sections"));
});

test("many bad tracks are summarised rather than listed in full", () => {
  // A sequence mid-rework can have dozens. The audit's job is to say what is wrong and how much,
  // not to reproduce the outliner.
  const bindings = Array.from({ length: 9 }, (_, i) => ({ name: `Actor${i}`, tracks: "3DTransform (muted)" }));
  const finding = findSequenceProblems({ bindings }).find((f) => f.check === "sequence-track-muted");
  assert.match(finding.message, /9 track\(s\)/);
  assert.match(finding.message, /and 5 more/);
});

test("an empty reply is not a finding", () => {
  // A sequence with no bindings at all is empty, not broken, and this must not invent three findings
  // out of three absent fields.
  assert.deepEqual(findSequenceProblems({}), []);
  assert.deepEqual(findSequenceProblems({ sequence: "LS_Empty", bindings: [] }), []);
});
