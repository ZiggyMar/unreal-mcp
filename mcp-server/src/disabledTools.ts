/**
 * "Do this next" is worth nothing if the tool it names is switched off.
 *
 * Found once in the audit and then, on looking, in four more places. For every preset, for every
 * advice-giving tool the preset actually carries, which tools does that tool tell you to call that
 * the preset does not switch on:
 *
 *   diagnose / audit_project    call_parent_function, set_data_table_row
 *   diagnose / verify_feature   set_data_table_row
 *   diagnose / find_orphans     open_level
 *   feature  / verify_feature   set_data_table_row
 *   feature  / plan_feature     trace_function_calls
 *
 * The first version of that scan was wrong in a way worth recording: it compared every module
 * against every preset, including presets that do not contain the module's own tool, and produced a
 * list twice this long. Advice from a tool you cannot call is not a gap, it is nothing at all.
 *
 * `plan_feature` is the one that stings. It was taught to say "check the system still runs with
 * unreal_trace_function_calls before extending it" - the single most useful sentence it has, added
 * because extending a system nothing calls produces a feature that cannot work - and the preset it
 * lives in does not switch that tool on.
 *
 * The obvious repair is to put them in the presets. Measured on the audit, that costs 870 standing
 * tokens for three tools, on every request, to save one `enable_tools({tools:[...]})` of about a
 * hundred and fifty that most sessions never make. So instead the server says which named tools are
 * off, at the moment it names them, and only then.
 *
 * ## Why only the advice fields
 *
 * Scanning the whole reply would be simpler and wrong. `list_tools` names dozens of deliberately
 * disabled tools - that is its job - and `guide` quotes them in prose. A note listing all of those
 * would be noise attached to the one reply whose entire purpose is to describe what is off.
 *
 * So the fields are named: the ones that mean "your next move is this".
 */

export type IsEnabled = (toolName: string) => boolean | undefined;

/** Fields whose text is an instruction to act, rather than a description of something. */
const ADVICE_FIELDS = ["next", "nextAction", "fix", "blockers", "notes", "note", "remedy", "steps", "warning"];

/** Every `unreal_*` named in the advice parts of a reply, deduplicated and ordered. */
export function toolsNamedInAdvice(reply: unknown): string[] {
  const named = new Set<string>();

  const scan = (value: unknown, insideAdvice: boolean): void => {
    if (typeof value === "string") {
      if (insideAdvice) {
        for (const match of value.matchAll(/unreal_[a-z0-9_]+/g)) named.add(match[0]);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) scan(item, insideAdvice);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // Once inside an advice field, everything under it is advice - `blockers` is an array of
        // sentences, and `groups[].fix` is one level down from a field that is not advice itself.
        scan(child, insideAdvice || ADVICE_FIELDS.includes(key));
      }
    }
  };

  scan(reply, false);
  return [...named].sort();
}

export interface DisabledToolNote {
  toolsNotEnabled: string[];
  toolsNotEnabledNote: string;
}

/**
 * The note to attach, or nothing at all when every named tool is already callable.
 *
 * `isEnabled` returns undefined for a name this server does not have - a tool that was renamed, or
 * one quoted in prose that never existed. Those are not reported: "this tool is switched off" about
 * a tool that does not exist would send a caller to enable something they can never get.
 */
export function disabledToolNote(reply: unknown, isEnabled: IsEnabled): DisabledToolNote | undefined {
  const off = toolsNamedInAdvice(reply).filter((name) => isEnabled(name) === false);
  if (off.length === 0) return undefined;
  return {
    toolsNotEnabled: off,
    toolsNotEnabledNote:
      `${off.length} tool(s) named above are switched off in this session: ${off.join(", ")}. ` +
      `unreal_enable_tools({ tools: [${off.map((n) => `"${n}"`).join(", ")}] }) turns on exactly those, ` +
      `which costs far less than a whole group.`,
  };
}

/** Attach the note when there is one, and return the reply untouched when there is not. */
export function withDisabledToolNote<T>(reply: T, isEnabled: IsEnabled): T | (T & DisabledToolNote) {
  const note = disabledToolNote(reply, isEnabled);
  return note ? { ...reply, ...note } : reply;
}
