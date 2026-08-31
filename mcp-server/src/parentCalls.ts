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
  /**
   * The graph these chains came from, so the fix can name it.
   *
   * Passed rather than assumed. The audit already stamps "EventGraph" on the finding it builds from
   * this, and a fix text that guessed a different name than the finding reports would be two answers
   * to one question - the class of disagreement this project keeps finding and removing.
   */
  graph: string;
  /** The child's chains, and every node title in the child's event graph. */
  childChains: ParentCallChain[];
  childNodeTitles: string[];
  /** The parent's chains, so the report can say what is being skipped. */
  parentChains: ParentCallChain[];
}

export function findUncalledParentEvents(input: OverrideCheckInput): ParentCallFinding[] {
  const findings: ParentCallFinding[] = [];

  // "Parent: BeginPlay" is how the editor titles the call, and a child may route it through a
  // different chain than the one that overrides the event - that still counts, so every chain is
  // searched rather than just the matching one.
  //
  // What does NOT count is a parent call sitting in the graph that nothing runs, and this used to
  // count it. The scan was over childNodeTitles - every node in the graph, reached or not - so an
  // orphaned "Parent: BeginPlay" suppressed the finding entirely.
  //
  // That is not a corner case, it is the common one. Creating an override event makes the editor add
  // the parent call for you; the next thing to touch the event's exec pin displaces it, silently.
  // The graph then contains the node, runs none of it, and this check called that fixed. Found by
  // building unreal_call_parent_function, which had the identical bug in its own "is it already
  // there" test, and by a trial whose fixture reproduced the displacement by accident.
  //
  // Chains are what execution reaches. Titles are what exists. They are not the same question.
  const parentCalls = new Set(
    input.childChains
      .flatMap((chain) => chain.steps)
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

    // Three situations, not two.
    //
    // The first version of this split on "does the child read what the parent sets", and that
    // conflates a parent which SETS THINGS NOBODY READS with one which SETS NOTHING AT ALL. The
    // second is not evidence of anything: a parent EndPlay that clears a timer, or a BeginPlay that
    // only adds a widget to the viewport, sets no variables, so the test is vacuously true and
    // concluding "the override is probably deliberate" from it is unfounded. A test in this repo
    // caught exactly that - parent EndPlay doing Clear and Invalidate Timer by Handle, told not to
    // inherit cleanup, which is the one thing you always want to inherit.
    const parentSetsNothing = setByParent.size === 0;

    const observed =
      depended.length > 0
        ? `${input.blueprint} reads ${depended.join(", ")}, which ${input.parentBlueprint}'s ${name} is ` +
          `what sets. Those reads get None. This one is a real bug, not a style choice.`
        : parentSetsNothing
          ? `${input.parentBlueprint}'s ${name} sets no variables at all - it does side-effect work ` +
            `(${what}). So "nothing reads it" proves nothing here, and side effects like clearing a ` +
            `timer or registering input are usually meant to be inherited.`
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
      // The fix follows the EVIDENCE, and it did not used to.
      //
      // `observed` above already worked out whether the child depends on what the parent sets. The
      // fix text ignored it and said "add the node, then wire it" either way - so the two fields of
      // one finding contradicted each other, and the actionable one was the wrong one. A model reads
      // `fix` and acts.
      //
      // Measured on the real project this is developed against: PC_Lobby, PC_Gameplay and
      // PC_MainMenu all skip PC_Base's BeginPlay, and following the old fix text would have been a
      // mistake in all three. What that chain sets is MyRootLayout - written once, and across 181
      // Blueprints read by NOTHING - and the function that would consume it, PushAVSWidget, has one
      // call site which is itself dead. It is a replaced UI system, not a missing call. Adding the
      // parent call would not fix a bug; it would put an unused widget back on screen.
      //
      // So when nothing reads what the parent sets, the fix leads with verifying rather than acting,
      // and names the cheapest way to settle it. When something does read it, the call is the
      // answer and the fix says so plainly. Same finding, same cost, opposite instruction.
      fix:
        depended.length > 0 || parentSetsNothing
          ? `unreal_call_parent_function on ${input.blueprint}, graphName "${input.graph}", functionName ` +
            `"${bare}". One call: it adds the node and wires it FIRST, keeping whatever ${name} already ran. ` +
            `(Doing it by hand is add_node plus connect_pins, and an exec output holds one link - so ` +
            `connecting the parent call displaces the existing chain instead of preceding it.) ` +
            (depended.length > 0
              ? `${input.blueprint} reads ${depended.join(", ")}, so this is a real defect rather than a style choice.`
              : `The parent does ${what} and sets nothing, so there is no state to duplicate by calling it.`)
          : `Check before adding it. Nothing in ${input.blueprint} reads what ` +
            `${input.parentBlueprint}'s ${name} sets, and an override that skips a parent on purpose ` +
            `looks exactly like this. The parent does: ${what}. unreal_trace_variable on what that ` +
            `chain sets settles it in one call - written there and read nowhere means adding the call ` +
            `revives a replaced system rather than fixing a bug. If it IS wanted, ` +
            `unreal_call_parent_function does it in one call, wired first.`,
    });
  }

  return findings;
}
