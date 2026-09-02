/**
 * Variables marked Replicated on an Actor that does not replicate.
 *
 * Ticking "Replicated" on a variable does nothing unless the Actor itself replicates. The editor
 * lets you do both independently, shows no warning, and the variable keeps its little replication
 * icon - so the Blueprint reads as networked and is not. Every value stays local to whichever
 * machine changed it, which looks correct to whoever is hosting and to anyone testing alone.
 *
 * Measured on a real project: 19 Blueprints declare at least one replicated variable and two of them
 * do not replicate.
 *
 *   BP_PlaceableBase   parent Actor                 bReplicates false   4 replicated variables
 *   BP_Turret          parent BP_PlaceableBase_C    bReplicates false   9 replicated variables
 *
 * Thirteen variables that cannot reach a client, and the second Blueprint inherits the flag from the
 * first - so the fix is one checkbox on the base, not two.
 *
 * ## Why this is not noisy
 *
 * There is no reading in which it is intentional. A variable is marked Replicated to send it
 * somewhere; an Actor that does not replicate sends nothing. Unlike an unhandled cast or a long
 * chain, the two settings contradict each other inside one asset, which is the same standard the
 * GameMode pawn check is held to.
 *
 * The controls matter as much as the finding: BP_Player and BP_FireWall both replicate and both
 * declare replicated variables, and BP_FireWall's parent is a plain Actor - so this is not simply
 * flagging everything whose parent is Actor.
 */

export interface ReplicationSubject {
  name: string;
  /** The effective bReplicates for the class, as the editor reports it. */
  replicates?: boolean;
  /** Names of variables marked Replicated or RepNotify. */
  replicatedVariables: string[];
  /** Parent class name, so an inherited flag can be blamed on the asset that owns it. */
  parentClass?: string;
}

export interface ReplicationFlagFinding {
  check: "replicated-vars-on-non-replicating-actor";
  severity: "warning";
  blueprint: string;
  message: string;
  observed: string;
  fix: string;
}

export function findReplicationFlagFaults(subjects: ReplicationSubject[]): ReplicationFlagFinding[] {
  // A parent that has the same fault owns the fix: fixing BP_PlaceableBase fixes BP_Turret with it,
  // and telling somebody to tick the box on both would be telling them to do it twice.
  const faulty = new Set(
    subjects.filter((s) => s.replicates === false && s.replicatedVariables.length > 0).map((s) => s.name)
  );

  const findings: ReplicationFlagFinding[] = [];
  for (const subject of subjects) {
    if (subject.replicates !== false) continue;
    const vars = subject.replicatedVariables;
    if (vars.length === 0) continue;

    const parent = (subject.parentClass ?? "").replace(/_C$/, "");
    const inherited = parent.length > 0 && faulty.has(parent);
    const shown = vars.slice(0, 5);

    findings.push({
      check: "replicated-vars-on-non-replicating-actor",
      severity: "warning",
      blueprint: subject.name,
      message:
        `${subject.name} marks ${vars.length} variable(s) Replicated and the Actor itself does not ` +
        `replicate, so none of them ever reach a client. The host sees every change and nobody else ` +
        `does, which is indistinguishable from working when you test alone.`,
      observed:
        `bReplicates is false; ${shown.join(", ")}${vars.length > shown.length ? `, and ${vars.length - shown.length} more` : ""} ` +
        `are marked Replicated.` +
        (inherited ? ` The flag is inherited from ${parent}, which has the same problem.` : ""),
      fix: inherited
        ? `Fix ${parent} rather than this: tick "Replicates" in its Class Defaults and every child ` +
          `inherits it, including this one. Fixing both would be doing it twice.`
        : `Tick "Replicates" in Class Defaults, or drop the replication flags from the variables if ` +
          `this Actor is genuinely local. Marking both ways round is the only combination that cannot ` +
          `be right.`,
    });
  }
  return findings;
}
