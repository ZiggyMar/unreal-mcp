/**
 * Answer a repeated identical call differently from the first one.
 *
 * The same failure has now been measured three separate times, with three unrelated tools:
 *
 * - `add_variable` called 20 times against a Blueprint that did not exist
 * - `doctor` called 19 times after the work was already finished
 * - `plan_feature` called 20 times with byte-identical arguments, never acting on the plan
 *
 * Each looked like a different bug and each was fixed as one - a better error message, a clearer
 * healthy verdict. None of those fixes generalised, because the real problem is not what any
 * individual tool said. It is that **a tool returns the same answer to the same question forever**,
 * so a model that has misread an answer once will misread it identically until something external
 * stops it. In a benchmark that is a step limit. In front of a user there is nothing.
 *
 * A person asked the same question three times in a row would say "you already asked me that". That
 * is all this does, and it costs nothing on the overwhelmingly common path where a call is not a
 * repeat.
 *
 * Deliberately not a refusal. The call still runs and still returns its real result, because a
 * repeat is sometimes legitimate - polling a compile, re-reading a graph after an edit. The caller
 * is told, and left to decide.
 */

export interface RepeatVerdict {
  /** How many times this exact call has now been made, including this one. */
  count: number;
  /** A sentence to append to the result, or null when there is nothing worth saying. */
  notice: string | null;
}

/**
 * Read-only tools that answer the same way until the project changes. A repeat of one of these is
 * far more likely to be a stuck loop than a legitimate re-check, so they are warned about sooner.
 */
const ADVISORY_TOOLS = new Set([
  "unreal_doctor",
  "unreal_plan_feature",
  "unreal_map_system",
  "unreal_project_health",
  "unreal_get_project_overview",
  "unreal_review_blueprint",
  "unreal_explain_graph",
  "unreal_search_project",
]);

export class RepeatGuard {
  private readonly seen = new Map<string, number>();

  /** Cheap, order-independent key for a call. */
  private static key(tool: string, args: unknown): string {
    let serialised: string;
    try {
      serialised = JSON.stringify(args, Object.keys((args as object) ?? {}).sort());
    } catch {
      serialised = String(args);
    }
    return `${tool}:${serialised}`;
  }

  record(tool: string, args: unknown): RepeatVerdict {
    // A kill switch, so the effect of this can be measured rather than assumed. It was added the
    // first time the numbers moved after wiring it in, because two changes had landed together and
    // "probably that one" is not a measurement.
    if (process.env.UNREAL_MCP_REPEAT_NOTICE === "off") return { count: 0, notice: null };
    const key = RepeatGuard.key(tool, args);
    const count = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, count);

    if (count < 2) return { count, notice: null };

    // An advisory tool gives the same answer until something changes, so the second identical call
    // is already a loop. A tool that does work might legitimately be retried once.
    const advisory = ADVISORY_TOOLS.has(tool);
    if (!advisory && count < 3) return { count, notice: null };

    const times = count === 2 ? "twice" : `${count} times`;
    return {
      count,
      notice:
        `NOTE: you have now made this exact call ${times}, with identical arguments, and received ` +
        `this same answer each time. Calling it again will return the same thing. Either act on ` +
        `what it says by calling a different tool, or, if the work is already done, stop and say so.`,
    };
  }

  /** Test seam: forget everything. */
  reset(): void {
    this.seen.clear();
  }
}
