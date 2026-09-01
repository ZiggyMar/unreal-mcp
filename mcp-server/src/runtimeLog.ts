/**
 * What went wrong when you pressed Play.
 *
 * Everything else in this project reads the graph. This reads what the engine said while the game
 * was actually running, which is the only place a whole class of Unreal bug ever appears:
 *
 *     Blueprint Runtime Error: "Accessed None trying to read (real) property VacuumableComp
 *     in BP_BaseCharacter_C". Node: RemovePlayer Graph: EventGraph Blueprint: BP_Player
 *
 * Nothing static can find that. The reference is valid in the editor, the cast compiles, and the
 * node is wired correctly - it is null at runtime because of when it runs, or because it was only
 * ever set on one machine. The engine says so precisely, in a log that scrolls past faster than
 * anyone can read.
 *
 * ## Why the log file and not the editor
 *
 * The editor writes every message to Saved/Logs before anything else happens, so this needs no
 * plugin support, survives an editor that is mid-crash, and can read the session that already
 * happened - which is the situation people are actually in when they ask. "I pressed play and a
 * crap ton of errors showed up" is always past tense.
 *
 * ## Why it groups
 *
 * One null dereference on Tick produces the same line thousands of times. Ungrouped, the log is a
 * wall. Grouped, it is usually four or five real problems: a real project's last session had 2,074
 * error and warning lines and eleven distinct causes.
 */

import { readFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export interface RuntimeIssue {
  /** How many times this happened. */
  count: number;
  severity: "error" | "warning";
  /** The engine's log category, e.g. LogBlueprint. */
  category: string;
  message: string;
  /** Filled in for Blueprint runtime errors, which name the exact node. */
  blueprint?: string;
  graph?: string;
  node?: string;
  property?: string;
  fix?: string;
  /** True when the reference was set and its actor was destroyed, rather than never set. */
  destroyed?: boolean;
}

export interface RuntimeLogSummary {
  /** True when the report covers only the most recent Play In Editor session. */
  lastSessionOnly: boolean;
  linesScanned: number;
  errorCount: number;
  warningCount: number;
  /** Problems in this project's own content, most frequent first. */
  issues: RuntimeIssue[];
  /** Engine and third-party noise, counted but not detailed. */
  noise: Array<{ count: number; message: string }>;
  nextAction: string;
}

export interface RuntimeLogResult extends RuntimeLogSummary {
  logFile: string;
}

const LINE = /^\[[\d.\-:]+\]\[\s*\d+\](\w+):\s+(Error|Warning):\s+(.*)$/;

/** A Blueprint runtime error names the exact node. That is the whole reason this is worth parsing. */
const ACCESSED_NONE =
  /Accessed None trying to read \((\w+)\) property (\S+) in (.+?)".*?Node:\s+(.*?)\s+Graph:\s+(.*?)\s+Function:.*?Blueprint:\s+(\S+)/;

/**
 * The other shape: the reference WAS valid and the object behind it has been destroyed.
 *
 *   Attempted to access BP_PingActor_C_1 via property VanPing, but BP_PingActor_C_1 is not valid
 *   (pending kill or garbage). Node: Destroy Actor Graph: EventGraph ... Blueprint: BP_DataDropOffStation
 *
 * Unparsed, this arrived as `8x ? ?` - a count with nothing to act on, which is the shape of finding
 * this project keeps removing. It reads as the same bug as a null property and it is not: nothing
 * failed to be set, something was destroyed and is still being reached for, so the fix is different.
 */
const PENDING_KILL =
  /Attempted to access (\S+) via property (\S+), but .*?is not valid \(pending kill or garbage\).*?Node:\s+(.*?)\s+Graph:\s+(.*?)\s+Function:.*?Blueprint:\s+(\S+)/;

/**
 * Lines that are true of a working editor and are not this project's problem.
 *
 * Kept short and specific on purpose. A filter that hides too much turns a diagnostic tool into one
 * that says everything is fine.
 */
const NOISE = [
  /^\[Callstack\]/,
  /Steam API is not initialized/i,
  /Ensure Steam is running/i,
  /No paths for game module/i,
];

const normalise = (message: string) =>
  message
    .replace(/0x[0-9a-fA-F]+/g, "0xADDR")
    .replace(/\b\d{4,}\b/g, "N")
    // Spawned actors are numbered: BP_PingActor_C_1, BP_PingActor_C_2. One bug in one node reported
    // once per instance reads as several bugs, and the counts that would have made it obvious get
    // split up - the ping actor arrived as separate 8x and 6x rows for the same Destroy Actor.
    .replace(/(_C)_\d+\b/g, "$1_N")
    .trim();

/** What to do about the kinds this can recognise. Generic advice would be worse than none. */
function adviseFor(message: string, parsed: RuntimeIssue): string | undefined {
  if (parsed.destroyed) {
    return (
      `${parsed.property} pointed at an actor that has since been destroyed, and ${parsed.node} in ` +
      `${parsed.blueprint} still reaches for it. This is NOT the same as a reference that was never ` +
      `set: something did set it, and then the actor was destroyed while the reference was kept. ` +
      `Clear the reference where the actor is destroyed, or gate the access on Is Valid - and if the ` +
      `node is Destroy Actor, check whether it can run twice.`
    );
  }
  if (parsed.property) {
    return (
      `${parsed.property} is null when ${parsed.node} runs in ${parsed.blueprint}. Either it is never set on ` +
      `that machine - a component or reference set on the server does not exist on a client unless it ` +
      `replicates - or it runs before whatever sets it. Find which of those it is before adding an Is Valid ` +
      `check, because a validity check hides the cause rather than fixing it.`
    );
  }
  if (/no longer exists on node.*refresh node/i.test(message)) {
    return `A node's signature changed underneath it. unreal_refresh_blueprint does the right-click Refresh Nodes repair on the named asset.`;
  }
  if (/ProxyFactoryClass null in K2Node_AsyncAction/i.test(message)) {
    return `An async node whose backing class no longer exists, usually left behind when template content was deleted. Open the named graph and delete the node.`;
  }
  if (/unable to determine expected signature/i.test(message)) {
    return `A Create Event node with nothing connected to its delegate pin. Connect it or delete it.`;
  }
  return undefined;
}

export interface RuntimeLogOptions {
  /** Read the whole log rather than only the most recent Play In Editor session. */
  wholeLog?: boolean;
  /** Include warnings. Off by default: there are usually thousands, and errors come first. */
  includeWarnings?: boolean;
  /** How many distinct problems to detail. */
  limit?: number;
  /** Read a specific file instead of deriving it from the project. */
  logFile?: string;
}

/** Derives Saved/Logs/<Project>.log from the .uproject the editor reports. */
export function logFileFor(projectFile: string): string {
  return join(dirname(projectFile), "Saved", "Logs", basename(projectFile).replace(/\.uproject$/i, ".log"));
}

/** The marker the engine writes when somebody presses Play. */
const PIE_START = /Creating play world package|LogPlayLevel: PlayLevel|PIE: New page: PIE session/;

export function summariseRuntimeLog(text: string, options: RuntimeLogOptions = {}): RuntimeLogSummary {
  const allLines = text.split(/\r?\n/);

  // The last time somebody pressed Play. Everything before belongs to an earlier attempt, and
  // reporting that as current is how an already-fixed bug gets fixed twice.
  let start = 0;
  let lastSessionOnly = false;
  if (!options.wholeLog) {
    for (let i = allLines.length - 1; i >= 0; i -= 1) {
      if (PIE_START.test(allLines[i])) {
        start = i;
        lastSessionOnly = true;
        break;
      }
    }
  }
  const lines = allLines.slice(start);

  const groups = new Map<string, RuntimeIssue>();
  const noise = new Map<string, { count: number; message: string }>();
  let errorCount = 0;
  let warningCount = 0;

  for (const line of lines) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, category, verbosity, rawMessage] = match;
    const severity = verbosity.toLowerCase() as "error" | "warning";
    if (severity === "error") errorCount += 1;
    else warningCount += 1;
    if (severity === "warning" && !options.includeWarnings) continue;

    const message = normalise(rawMessage);
    if (NOISE.some((pattern) => pattern.test(rawMessage))) {
      const entry = noise.get(message) ?? { count: 0, message };
      entry.count += 1;
      noise.set(message, entry);
      continue;
    }

    const key = `${category}|${message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    const issue: RuntimeIssue = { count: 1, severity, category, message };
    const none = ACCESSED_NONE.exec(rawMessage);
    const destroyed = PENDING_KILL.exec(rawMessage);
    if (none) {
      issue.property = none[2];
      issue.node = none[4];
      issue.graph = none[5];
      issue.blueprint = none[6];
    } else if (destroyed) {
      issue.property = destroyed[2];
      issue.node = destroyed[3];
      issue.graph = destroyed[4];
      issue.blueprint = destroyed[5];
      // Marked so the advice can tell the two apart. Both read as "a reference was no good"; only
      // one of them is a thing that was never set.
      issue.destroyed = true;
    }
    issue.fix = adviseFor(rawMessage, issue);
    groups.set(key, issue);
  }

  const issues = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, Math.max(1, options.limit ?? 15));
  const worst = issues[0];

  return {
    lastSessionOnly,
    linesScanned: lines.length,
    errorCount,
    warningCount,
    issues,
    noise: [...noise.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    nextAction: worst
      ? `${worst.count}x ${worst.blueprint ? `${worst.blueprint} / ${worst.node}` : worst.message.slice(0, 90)}. ${worst.fix ?? ""}`.trim()
      : "No errors in the last Play In Editor session.",
  };
}

/** Reads the log the editor is writing for the project it currently has open. */
export async function readRuntimeLogForProject(
  projectFile: string,
  options: RuntimeLogOptions = {}
): Promise<RuntimeLogResult> {
  const logFile = options.logFile ?? logFileFor(projectFile);
  const text = await readFile(logFile, "utf8").catch((err: unknown) => {
    throw new Error(
      `log_unreadable: could not read ${logFile} (${err instanceof Error ? err.message : String(err)}). ` +
        `The editor writes it while running; if the path is wrong, pass logFile.`
    );
  });
  return { logFile, ...summariseRuntimeLog(text, options) };
}
