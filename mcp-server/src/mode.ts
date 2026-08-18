/**
 * How much to spend on a build.
 *
 * The complaint behind this is specific and fair: building one system should not cost 500k tokens.
 * The same feature written in C++ costs maybe 20k, and the difference is not intelligence, it is
 * that a Blueprint tool can be chatty in ways a text editor cannot.
 *
 * But cheap must not mean bad. The rule here is that **the floor never moves**: every mode places
 * whole graphs atomically, lays them out so they read left to right, compiles, and refuses to
 * silently do the wrong thing. What the modes change is how much *extra* work and *extra* reporting
 * happens on top - the polish and the paperwork, not the correctness.
 *
 * That distinction is the whole design. A mode that produced worse Blueprints to save tokens would
 * be a trap, because the person choosing "fast" is usually the person least able to spot the
 * difference.
 */

export type Mode = "fast" | "standard" | "max";

export interface ModePolicy {
  mode: Mode;
  /** Tidy the graph after building. On in every mode: an unreadable graph is not cheaper, it is worse. */
  autoLayout: boolean;
  /** Wrap execution chains in labelled comment boxes. Costs extra calls to the editor. */
  commentBoxes: boolean;
  /** How much of the quality review to attach to a build response, unasked. */
  attachReview: "none" | "summary" | "full";
  /** Cap on findings included when attachReview is "full". */
  maxFindings: number;
  /** Include per-node detail in build responses, rather than just the ref-to-id map. */
  verboseBuildResult: boolean;
  /** One line the model can relay, so the user knows what they are getting. */
  description: string;
}

const POLICIES: Record<Mode, ModePolicy> = {
  // Everything still gets built correctly, compiled, and laid out. What you give up is the
  // unrequested review attached to every build and the per-node echo.
  fast: {
    mode: "fast",
    autoLayout: true,
    commentBoxes: false,
    attachReview: "none",
    maxFindings: 0,
    verboseBuildResult: false,
    description:
      "fast: correct, compiled, laid-out graphs with minimal reporting. Call unreal_review_blueprint " +
      "yourself before claiming a feature is done - in this mode it is not attached automatically.",
  },
  // The default. A build tells you its score and the single most useful next action, which is
  // about thirty tokens and is what stops a model declaring victory on broken work.
  standard: {
    mode: "standard",
    autoLayout: true,
    commentBoxes: false,
    attachReview: "summary",
    maxFindings: 0,
    verboseBuildResult: false,
    description:
      "standard: graphs are laid out, and every build reports a quality score and the single most " +
      "important thing to fix next.",
  },
  // Everything, for when the output matters more than the budget.
  max: {
    mode: "max",
    autoLayout: true,
    commentBoxes: true,
    attachReview: "full",
    maxFindings: 20,
    verboseBuildResult: true,
    description:
      "max: labelled comment boxes per execution chain, the full review with every finding and its " +
      "fix, and per-node detail. Costs more tokens per build and produces work that reads as authored.",
  },
};

export const DEFAULT_MODE: Mode = "standard";

export function resolveMode(raw: string | undefined): { policy: ModePolicy; warning?: string } {
  const value = (raw ?? DEFAULT_MODE).trim().toLowerCase();
  if (value in POLICIES) {
    return { policy: POLICIES[value as Mode] };
  }
  return {
    policy: POLICIES[DEFAULT_MODE],
    warning: `unknown UNREAL_MCP_MODE "${raw}", using "${DEFAULT_MODE}". Valid: fast, standard, max.`,
  };
}

export function policyFor(mode: Mode): ModePolicy {
  return POLICIES[mode];
}

/** Every mode, for tools and docs that need to explain the choice. */
export function allPolicies(): ModePolicy[] {
  return [POLICIES.fast, POLICIES.standard, POLICIES.max];
}
