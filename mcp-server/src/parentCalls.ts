/**
 * A child Blueprint that overrides an event and never calls the parent's version.
 *
 * When you add `Event BeginPlay` to a child Blueprint, the parent's `Event BeginPlay` does not run
 * unless you explicitly place a `Parent: BeginPlay` node. Nothing warns you. The child's own logic
 * works perfectly, so the Blueprint looks correct, and everything the parent set up is simply
 * missing.
 *
 * The one that produced this check:
 *
 *     BP_BaseCharacter.BeginPlay   Add Component by Class -> Set VacuumableComp
 *     BP_Player.BeginPlay          overrides it, no Parent: BeginPlay
 *
 * VacuumableComp was therefore null on every player on every machine, and the log filled with
 * "Accessed None trying to read property VacuumableComp" 54 times a session. The feature that
 * component drives - being vacuumed by another player - could never work, and nothing about the
 * child's graph looked wrong.
 *
 * ## Why this is worth reporting even though overriding is legal
 *
 * Deliberately replacing a parent's behaviour is a real thing people do. The signal is not the
 * override; it is the override of a parent implementation that *does work*, in a project that
 * otherwise remembers to call parents. So the report always names what the parent does, because
 * that is the sentence a human needs to decide - and a check that reported the override alone would
 * be noise on every well-written child Blueprint.
 */

export interface ParentCallChain {
  entry: string;
  nodeIds: string[];
  steps: string[];
}

export interface ParentCallFinding {
  check: string;
  severity: string;
  message: string;
  fix: string;
}

/** Events where losing the parent's work is silent and expensive. */
const LIFECYCLE = /^Event (BeginPlay|EndPlay|Possessed|UnPossessed|OnPossess|Destroyed|PostInitializeComponents)$/i;

/**
 * Steps that are not "work" in any sense worth preserving. A parent whose whole implementation is a
 * debug print is not a reason to send anybody anywhere.
 */
const INERT = /^(print string|print text|comment|sequence|reroute node)$/i;

const isRealWork = (steps: string[]) => steps.some((step) => !INERT.test(step.trim()));

export interface OverrideCheckInput {
  blueprint: string;
  parentBlueprint: string;
  /** The child's chains, and every node title in the child's event graph. */
  childChains: ParentCallChain[];
  childNodeTitles: string[];
  /** The parent's chains, so the report can say what is being skipped. */
  parentChains: ParentCallChain[];
}

export function findUncalledParentEvents(input: OverrideCheckInput): ParentCallFinding[] {
  const findings: ParentCallFinding[] = [];

  // "Parent: BeginPlay" is how the editor titles the call, whichever graph it sits in - a child may
  // route the parent call through a different chain, and that still counts.
  const parentCalls = new Set(
    input.childNodeTitles
      .map((title) => /^Parent:\s*(.+)$/i.exec(String(title).trim())?.[1]?.trim().toLowerCase())
      .filter((name): name is string => !!name)
  );

  for (const childChain of input.childChains) {
    const name = childChain.entry.trim();
    if (!LIFECYCLE.test(name)) continue;

    const bare = name.replace(/^Event\s+/i, "").trim();
    if (parentCalls.has(bare.toLowerCase())) continue;

    const parentChain = input.parentChains.find((chain) => chain.entry.trim().toLowerCase() === name.toLowerCase());
    if (!parentChain || !isRealWork(parentChain.steps)) continue;

    const what = parentChain.steps.slice(0, 4).join(" -> ");
    findings.push({
      check: "parent-event-not-called",
      severity: "error",
      message:
        `${input.blueprint} overrides ${name} but never calls Parent: ${bare}, so ${input.parentBlueprint}'s ` +
        `${name} never runs - including ${what}. Nothing warns about this, and the child's own logic works, ` +
        `so the Blueprint looks correct while everything the parent set up is missing.`,
      fix:
        `Add a Parent: ${bare} node in ${input.blueprint} and run it first in that chain - right-click the ` +
        `${name} node and choose "Add call to parent function". If the parent's version is genuinely meant ` +
        `to be replaced, that is fine, but check what it does first: ${what}.`,
    });
  }

  return findings;
}
