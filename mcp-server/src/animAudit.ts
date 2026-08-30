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
