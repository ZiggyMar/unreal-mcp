/**
 * The two ways a state machine breaks silently.
 *
 * Both look correct in the editor, which is why they survive: the graph is drawn, the arrows are
 * there, and nothing warns. They are only visible if something reads the machine and asks these two
 * questions, which nothing could do here until unreal_read_anim_blueprint existed.
 *
 * Scanned across the project this is developed on - six Anim Blueprints, twenty-one states - and it
 * is clean on both. That is worth stating rather than hiding: a check is not evidence of a bug, and
 * these exist because the failures are real and expensive elsewhere, not because this project has
 * them. The unit tests carry the positive cases the project does not.
 */

export interface AnimState {
  state: string;
  /** An array of transitions, or the string the reader uses when there are none. */
  transitions?: Array<{ to?: string; rule?: string }> | string;
}

export interface AnimStateMachine {
  stateMachine: string;
  states?: AnimState[];
}

export interface AnimBlueprintLike {
  stateMachines?: AnimStateMachine[];
}

export interface AnimFinding {
  check: string;
  severity: "warning" | "info";
  message: string;
  fix: string;
  observed?: string;
}

/**
 * A state with no way out.
 *
 * The animation enters it once and the character is stuck in that pose for the rest of the round.
 * It reads as "the death animation never ends" or "he is frozen after the dodge", and the state
 * machine looks finished because the state itself is wired to something - just not outward.
 *
 * An entry state that leads nowhere is a different thing from a machine with ONE state, which is a
 * perfectly ordinary way to play a single looping pose, so a single-state machine is left alone.
 */
export function findAnimStateMachineFaults(anim: AnimBlueprintLike, blueprintName: string): AnimFinding[] {
  const findings: AnimFinding[] = [];

  for (const machine of anim.stateMachines ?? []) {
    const states = machine.states ?? [];
    if (states.length <= 1) continue;

    for (const state of states) {
      if (typeof state.transitions === "string") {
        findings.push({
          check: "anim-state-no-exit",
          severity: "warning",
          message:
            `${blueprintName}: state "${state.state}" in ${machine.stateMachine} has no transitions out. ` +
            `Once the animation enters it, it never leaves.`,
          fix:
            `Add a transition out of "${state.state}", or delete the state if it is left over. This reads to a ` +
            `player as the character freezing in one pose, and the machine looks finished in the editor because ` +
            `the state IS wired - just not outward.`,
          observed: `${machine.stateMachine} has ${states.length} states, so this is not a single-pose machine.`,
        });
        continue;
      }

      // Two transitions out of one state, to the same place, on the same condition.
      //
      // Only the first can ever fire; the second is unreachable whatever happens at runtime. It is
      // almost always a duplicated transition whose rule was meant to be edited and was not - which
      // means the case the author added it for is not handled at all - and the editor draws two
      // arrows between the same pair of states without comment.
      //
      // Found on the project this is developed on: ABP_NewPlayer has AimingMovement -> Jump twice,
      // both on "Get IsInAir". One duplicate pair in 32 transitions, which is the frequency that
      // makes a check worth having: rare enough to mean something, common enough to happen.
      // Keyed with JSON rather than a separator character. A rule is a sentence with spaces in
      // it - "Get IsInAir", "AND Boolean Get isAiming float > float Get Speed" - so joining on a
      // space and splitting it back would report the destination as "Get" on every finding.
      const timesSeen = new Map<string, number>();
      for (const transition of state.transitions ?? []) {
        const key = JSON.stringify([transition.to ?? "?", transition.rule ?? ""]);
        timesSeen.set(key, (timesSeen.get(key) ?? 0) + 1);
      }
      for (const [key, count] of timesSeen) {
        if (count < 2) continue;
        const [to, rule] = JSON.parse(key) as [string, string];
        findings.push({
          check: "anim-duplicate-transition",
          severity: "warning",
          message:
            `${blueprintName}: "${state.state}" has ${count} transitions to "${to}" in ` +
            `${machine.stateMachine}, all on the same rule, so only the first can ever fire.`,
          fix:
            `Delete the extras, or give them the rules they were meant to have. A duplicated transition is ` +
            `usually a copy whose condition was never changed, which means the case it was added for is not ` +
            `handled anywhere.`,
          observed: `Rule on all ${count}: ${rule || "(none)"}.`,
        });
      }

      for (const transition of state.transitions ?? []) {
        if (!/^empty\b/i.test(String(transition.rule ?? ""))) continue;
        findings.push({
          check: "anim-transition-never-fires",
          severity: "warning",
          message:
            `${blueprintName}: the transition "${state.state}" -> "${transition.to ?? "?"}" in ` +
            `${machine.stateMachine} has an empty rule, so it can never fire.`,
          fix:
            `Give the transition a condition, or remove it. An empty rule graph draws exactly like a working ` +
            `transition and behaves like a wall, so the destination state is unreachable through this path.`,
        });
      }
    }
  }

  return findings;
}
