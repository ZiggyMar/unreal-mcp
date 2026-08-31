/**
 * The three ways a Level Sequence looks correct and animates nothing.
 *
 * `read_level_sequence` reports these per sequence; this turns them into audit findings so that
 * "find every bug in my game" covers cinematics, which it did not. That is the same gap that was
 * closed for Animation Blueprints, Niagara and Data Assets before it - a sweep that stops at the
 * door of a whole asset family answers a narrower question than the one it was asked.
 *
 * All three failures share a shape, and it is why they are worth reporting at all: **none of them is
 * an error, and none is a warning.** The sequence opens, plays, and finishes. In the editor each is
 * visible only by scrolling to the row and noticing an absence - a binding with nothing under it, a
 * track with an empty timeline, a speaker icon that is off. "The cutscene plays but the door never
 * opens" is what they look like from outside.
 *
 * Kept as a pure function over the reply, so it can be tested without an editor.
 */

export interface SequenceReadReply {
  sequence?: string;
  bindings?: Array<{ name?: string; kind?: string; tracks?: string }>;
  sequenceTracks?: string;
  bindingsWithNoTracks?: number;
  tracksWithNoSections?: number;
  mutedTracks?: number;
}

export interface SequenceFinding {
  check: string;
  severity: string;
  message: string;
  fix: string;
}

/** Bindings whose `tracks` is the literal "none", named so the reply says which actors. */
function bindingsWithoutTracks(reply: SequenceReadReply): string[] {
  return (reply.bindings ?? [])
    .filter((b) => (b.tracks ?? "") === "none")
    .map((b) => b.name ?? "(unnamed)");
}

/** Track descriptions carrying a marker, across the bindings and the sequence's own tracks. */
function tracksMarked(reply: SequenceReadReply, marker: string): string[] {
  const out: string[] = [];
  for (const binding of reply.bindings ?? []) {
    for (const track of (binding.tracks ?? "").split(", ")) {
      if (track.includes(marker)) out.push(`${binding.name ?? "(unnamed)"}: ${track}`);
    }
  }
  for (const track of (reply.sequenceTracks ?? "").split(", ")) {
    if (track.includes(marker)) out.push(track);
  }
  return out;
}

export function findSequenceProblems(reply: SequenceReadReply): SequenceFinding[] {
  const findings: SequenceFinding[] = [];

  const muted = tracksMarked(reply, "(muted)");
  if (muted.length > 0) {
    findings.push({
      check: "sequence-track-muted",
      severity: "warning",
      message:
        `${muted.length} track(s) are muted, so they have keys and do not evaluate: ${muted.slice(0, 4).join("; ")}` +
        `${muted.length > 4 ? ` and ${muted.length - 4} more` : ""}.`,
      fix:
        "Muting is how you audition a change, and it is the state most often left behind afterwards. " +
        "Un-mute it in Sequencer, or delete the track if it is genuinely not wanted - a muted track " +
        "reads as working in every static view of the asset.",
    });
  }

  const empty = tracksMarked(reply, "(no sections)");
  if (empty.length > 0) {
    findings.push({
      check: "sequence-track-no-sections",
      severity: "warning",
      message:
        `${empty.length} track(s) have no sections, so there is nothing to evaluate: ${empty.slice(0, 4).join("; ")}` +
        `${empty.length > 4 ? ` and ${empty.length - 4} more` : ""}.`,
      fix:
        "The track is in the outliner with an empty timeline. Either key it, or remove it. A camera " +
        "cut track in this state is the usual reason a cutscene plays from the wrong angle.",
    });
  }

  const bare = bindingsWithoutTracks(reply);
  if (bare.length > 0) {
    findings.push({
      check: "sequence-binding-no-tracks",
      severity: "info",
      message:
        `${bare.length} actor(s) are bound into the sequence with nothing animating them: ` +
        `${bare.slice(0, 5).join(", ")}${bare.length > 5 ? ` and ${bare.length - 5} more` : ""}.`,
      fix:
        "Usually what is left after the tracks were deleted but the binding was not. Harmless to run, " +
        "and misleading to read: the actor appears in the sequence as though it takes part.",
    });
  }

  return findings;
}
