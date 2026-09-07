/**
 * The one mistake every caller of `run_batch` is going to make.
 *
 * `steps` takes BRIDGE command names - `add_variable`, `compile_blueprint` - because a step is
 * re-entered through the bridge's own dispatcher. But the model has just spent the whole session
 * calling `unreal_add_variable` and `unreal_compile_blueprint`, and 142 tool definitions have taught
 * it that things on this surface are spelled with that prefix. It will type the prefix. The tool
 * description says not to, and descriptions are not where habits come from.
 *
 * Unhandled, that costs a round trip to the editor and comes back `unknown_cmd: unreal_add_variable`,
 * which reads as "that command does not exist" rather than "drop five characters". A weak model then
 * tries a different command instead of the same one spelled right - the exact failure the node
 * catalog's didYouMean was built to stop, in a new place.
 *
 * So it is caught here, before anything is sent, and the reply is the corrected call rather than a
 * diagnosis. Rejecting rather than silently fixing is deliberate: a batch is a list of writes to
 * somebody's project, and quietly running something the caller did not literally ask for is the
 * wrong instinct when the fix is one obvious edit they can confirm.
 *
 * The other half is composite tools. `unreal_scaffold_blueprint` and `unreal_add_event_handler` are
 * not single bridge commands at all - they are several, sequenced on this side - so no amount of
 * prefix-stripping makes them steps. Naming them specifically is worth more than a generic
 * "unknown command", because the answer is not a spelling fix, it is "call that tool normally; it is
 * already one call".
 */

/**
 * Tools with no single bridge command behind them.
 *
 * Kept in sync with `compositeTools` in scripts/check-tool-parity.mjs by the test that reads both -
 * a second copy that drifts would send people to a command that does not exist, which is the thing
 * this file exists to prevent.
 */
export const COMPOSITE_TOOLS = new Set([
  "review_layout",
  "tidy_layout",
  "trace_input",
  "run_tests",
  "document_asset",
  "call_tool",
  "verify_runtime",
  "read_runtime_errors",
  "auto_layout_graph",
  "review_blueprint",
  "doctor",
  "enable_tools",
  "session_changes",
  "map_system",
  "plan_feature",
  "cleanup_blueprint",
  "add_event_handler",
  "scaffold_blueprint",
  "scaffold_widget",
  "explain_graph",
  "audit_project",
  "guard_with_authority",
  "list_tools",
  "guide",
  "find_source",
  "verify_feature",
  "check_data_tables",
  "find_in_data_tables",
  "find_orphans",
  "compile_cpp",
  "hot_reload_cpp",
  "call_parent_function",
  "epic",
]);

export interface BatchStep {
  cmd: string;
  params?: Record<string, unknown>;
}

export interface StepProblem {
  index: number;
  cmd: string;
  message: string;
}

/**
 * Check the steps a caller supplied, without sending anything.
 *
 * Returns the problems found, most useful first. An empty array means the batch is worth sending -
 * it does NOT mean every command exists, because only the editor knows that. This catches the
 * mistakes that are decidable from the string alone.
 */
export function checkBatchSteps(steps: BatchStep[]): StepProblem[] {
  const problems: StepProblem[] = [];

  steps.forEach((step, index) => {
    const cmd = typeof step?.cmd === "string" ? step.cmd.trim() : "";

    if (!cmd) {
      problems.push({ index, cmd: String(step?.cmd ?? ""), message: `step ${index} has no cmd.` });
      return;
    }

    if (!cmd.startsWith("unreal_")) return;

    const bare = cmd.slice("unreal_".length);

    if (COMPOSITE_TOOLS.has(bare)) {
      problems.push({
        index,
        cmd,
        message:
          `step ${index}: "${cmd}" is not a bridge command - it is a tool this server composes from ` +
          `several of them, so it cannot be a batch step. Call ${cmd} on its own; it is already one ` +
          `call, and it opens its own transaction.`,
      });
      return;
    }

    problems.push({
      index,
      cmd,
      message:
        `step ${index}: use the bridge command "${bare}", not the tool name "${cmd}". steps are ` +
        `re-entered through the bridge, so they are spelled without the unreal_ prefix.`,
    });
  });

  return problems;
}

/** One block a caller can act on, rather than a list they have to read twice. */
export function formatStepProblems(problems: StepProblem[]): string {
  const lines = problems.map((p) => `  - ${p.message}`);
  return (
    `${problems.length} step${problems.length === 1 ? "" : "s"} cannot run as written, so nothing ` +
    `was sent and the project is unchanged:\n${lines.join("\n")}`
  );
}
