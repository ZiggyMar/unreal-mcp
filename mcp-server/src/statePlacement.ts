/**
 * Is this state in the right place?
 *
 * The handbook has a table saying where each kind of state belongs, and a table is advice. This
 * project has now measured, three times in a row, that a weak model does not act on advice — it
 * acts on what it is offered and on what objects afterwards. So the table is also a check.
 *
 * This is the judgment that separates a Blueprint that works from one a team can extend, and it is
 * the single most expensive thing to retrofit. A pawn is destroyed on death and respawn, so
 * anything that has to outlive the body does not belong on the body. Score on a Character is a bug
 * that appears the first time somebody dies, weeks after it was written, in a place nobody
 * associates with the cause.
 *
 * Deliberately conservative, for the reason quality.ts states: a false positive teaches a caller to
 * distrust the whole report. Only names whose meaning is unambiguous are flagged, and everything is
 * a warning rather than an error, because there are real designs where the unusual answer is right.
 */

export interface StateFinding {
  check: string;
  severity: "warning" | "info";
  message: string;
  fix: string;
  variable: string;
}

/** Classes whose instances are destroyed and recreated while the player keeps playing. */
const TRANSIENT_OWNERS = /^(A?Character|A?Pawn|.*Character|.*Pawn)$/i;

/**
 * Blueprint variables are CamelCase, so a plain word boundary is the wrong tool: `\bteam\b` does not
 * match `TeamIndex`, and `team` without boundaries matches `TeammateMeshes`. Splitting on the
 * lowercase-to-uppercase transition first turns `TeamIndex` into `Team Index` and `TeammateMeshes`
 * into `Teammate Meshes`, after which ordinary word matching means what it looks like it means.
 */
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .toLowerCase();

/**
 * State that must survive the pawn.
 *
 * Kept to names whose meaning is not in doubt. "Health" is deliberately absent: health while alive
 * genuinely belongs on the body, and flagging it would be the false positive that discredits the
 * rest.
 */
const OUTLIVES_THE_BODY: Array<{ pattern: RegExp; what: string; home: string }> = [
  { pattern: /\bscores?\b/, what: "a score", home: "PlayerState" },
  { pattern: /\bkills?\b/, what: "a kill count", home: "PlayerState" },
  { pattern: /\bdeaths?\b/, what: "a death count", home: "PlayerState" },
  { pattern: /\b(player )?name\b/, what: "a player name", home: "PlayerState" },
  { pattern: /\bteams?\b/, what: "a team", home: "PlayerState" },
  { pattern: /\branks?\b/, what: "a rank", home: "PlayerState" },
  {
    pattern: /\b(coins?|currency|credits?|gems?)\b/,
    what: "a currency",
    home: "PlayerState, or the GameInstance if it survives level loads",
  },
  {
    pattern: /\b(unlocked|unlocks|unlockables?|progress|progression|save data|save game)\b/,
    what: "progression",
    home: "the GameInstance or a SaveGame object",
  },
  {
    pattern: /\b(settings|options|preferences)\b/,
    what: "player settings",
    home: "the GameInstance or a SaveGame object",
  },
];

export interface VariableInfo {
  name: string;
  type?: string;
}

/**
 * @param parentClass the Blueprint's parent, which decides what "the right place" even means
 * @param variables   the Blueprint's own variables
 */
export function reviewStatePlacement(parentClass: string, variables: VariableInfo[]): StateFinding[] {
  const findings: StateFinding[] = [];
  if (!TRANSIENT_OWNERS.test(parentClass ?? "")) return findings;

  for (const variable of variables ?? []) {
    const spaced = words(variable.name);
    const match = OUTLIVES_THE_BODY.find((entry) => entry.pattern.test(spaced));
    if (!match) continue;
    findings.push({
      check: "state-outlives-owner",
      severity: "warning",
      variable: variable.name,
      message:
        `"${variable.name}" looks like ${match.what}, and it lives on ${parentClass}, which is ` +
        `destroyed and recreated when the player dies or respawns.`,
      fix:
        `Move it to ${match.home}. State that has to outlive the body does not belong on the body - ` +
        `this reads as correct until the first respawn, and then silently resets.`,
    });
  }

  return findings;
}
