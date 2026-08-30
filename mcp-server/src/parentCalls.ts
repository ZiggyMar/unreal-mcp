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
  /**
   * What the two Blueprints show about whether the child actually depends on the parent's work.
   *
   * Separated from the conclusion for the same reason the replication check separates it: this
   * check fires identically on a certain bug and on a deliberate override, and the evidence is the
   * only thing that tells them apart.
   */
  observed?: string;
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

    // Does the child DEPEND on what the parent sets? This is the difference between a finding worth
    // acting on and one that might be deliberate, and it was learned by working both cases by hand
    // on a real game.
    //
    // BP_Player overrides BeginPlay without calling Parent, and BP_BaseCharacter's BeginPlay is the
    // only place VacuumableComp is ever set - while BP_Player reads it and calls two functions on
    // it. That is decisive: the component is None on the player and those calls do nothing.
    //
    // PC_Gameplay, PC_Lobby and PC_MainMenu do the same thing against PC_Base, whose BeginPlay
    // creates the root layout widget - and none of them reads MyRootLayout or anything else it
    // sets. There the omission may well be deliberate, and "fixing" it could add a second widget or
    // a duplicate input mapping. Same check, same shape, opposite right answer.
    const setByParent = new Set(
      parentChain.steps
        .map((step) => /^Set(?:\s+with\s+Notify)?\s+(.+)$/i.exec(String(step).trim())?.[1]?.trim().toLowerCase())
        .filter((name): name is string => !!name)
    );
    const readByChild = input.childNodeTitles
      .map((title) => /^Get\s+(.+)$/i.exec(String(title).trim())?.[1]?.trim())
      .filter((name): name is string => !!name && setByParent.has(name.toLowerCase()));
    const depended = [...new Set(readByChild)];

    const observed =
      depended.length > 0
        ? `${input.blueprint} reads ${depended.join(", ")}, which ${input.parentBlueprint}'s ${name} is ` +
          `what sets. Those reads get None. This one is a real bug, not a style choice.`
        : `Nothing in ${input.blueprint} reads what ${input.parentBlueprint}'s ${name} sets, so the ` +
          `override may be deliberate. Check what the parent does before adding the call - if it ` +
          `creates a widget or adds an input mapping, calling it could produce a second one.`;

    findings.push({
      check: "parent-event-not-called",
      severity: "error",
      observed,
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
