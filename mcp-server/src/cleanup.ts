/**
 * Acting on review findings, rather than only reporting them.
 *
 * The quality gate tells a model what is wrong. A capable model then fixes it. A weaker one reads
 * the findings, says "I have reviewed the Blueprint", and moves on — which is the failure the gate
 * was built to prevent, arriving one step later.
 *
 * So the safe subset is automated. What counts as safe is the whole design question here, and the
 * answer is deliberately narrow: only changes that cannot alter what the Blueprint DOES.
 *
 *   - **Dead nodes** are safe by construction. A node wired to nothing never executes and produces
 *     no value; deleting it cannot change behaviour.
 *   - **Comment boxes and layout** are cosmetic. The compiler never sees them.
 *
 * Everything else is left to the model, on purpose:
 *
 *   - Removing a leftover Print String means healing the execution chain around it. That is a
 *     behaviour-preserving edit only if done correctly, and a tool that gets it subtly wrong breaks
 *     a working graph while reporting success.
 *   - Renaming a placeholder variable needs a name, and choosing one is judgement.
 *   - An unhandled cast failure needs a decision about what should happen on failure. Wiring it to
 *     nothing to silence the warning would be worse than the warning.
 *
 * A cleanup tool that quietly changes behaviour is far more damaging than one that leaves work on
 * the table, because the person most likely to run it is the person least able to notice.
 */

import type { BridgeLike } from "./autoLayout.js";
import { autoLayoutGraph } from "./autoLayout.js";
import { reviewBlueprint } from "./review.js";

export interface CleanupOptions {
  /** Remove nodes connected to nothing. Defaults to true. */
  removeDeadNodes?: boolean;
  /** Lay the graph out and wrap execution chains in labelled comment boxes. Defaults to true. */
  labelSections?: boolean;
  /** Report what would change without changing it. Defaults to false. */
  dryRun?: boolean;
}

export interface CleanupReport {
  path: string;
  dryRun: boolean;
  scoreBefore: number;
  scoreAfter: number;
  deadNodesRemoved: number;
  graphsLaidOut: number;
  commentBoxesAdded: string[];
  /** Findings this deliberately did not touch, and why. */
  leftForYou: Array<{ check: string; count: number; why: string }>;
  failures: Array<{ what: string; error: string }>;
  nextAction: string;
}

/** Why each untouched finding is untouched. Stated per category, so it never reads as an oversight. */
const LEFT_ALONE: Record<string, string> = {
  "debug-print-left-in":
    "Removing a Print String means healing the execution chain around it. Do it deliberately: delete the node, " +
    "then reconnect the exec pin that fed it to the node it fed.",
  "placeholder-name":
    "Renaming needs a name, and choosing one is judgement. Pick something that says what the variable holds.",
  "unhandled-cast-failure":
    "This needs a decision about what should happen when the cast fails. Wiring it to nothing to silence the " +
    "warning would be worse than the warning.",
  "empty-event":
    "Either implement the event or remove it, and only you know which was intended.",
  "tick-heavy":
    "Moving work off Tick changes when it runs. That is a design change, not a cleanup.",
  "graph-too-large":
    "Splitting a graph into functions requires deciding where the seams are.",
  "long-exec-chain":
    "Extracting a function requires naming what it does.",
  "branch-dead-path":
    "An unwired branch path is often correct. Confirm the case is genuinely meant to do nothing.",
};

export async function cleanupBlueprint(
  bridge: BridgeLike,
  path: string,
  options: CleanupOptions = {}
): Promise<CleanupReport> {
  const removeDeadNodes = options.removeDeadNodes !== false;
  const labelSections = options.labelSections !== false;
  const dryRun = options.dryRun === true;

  const before = await reviewBlueprint(bridge, path);
  const report: CleanupReport = {
    path,
    dryRun,
    scoreBefore: before.score,
    scoreAfter: before.score,
    deadNodesRemoved: 0,
    graphsLaidOut: 0,
    commentBoxesAdded: [],
    leftForYou: [],
    failures: [],
    nextAction: "",
  };

  // --- what will be left alone, and why -------------------------------------------------------
  const untouched = new Map<string, number>();
  for (const graph of before.graphs) {
    for (const finding of graph.findings) {
      if (finding.check === "dead-node" && removeDeadNodes) continue;
      if (finding.check === "unlabelled-sections" && labelSections) continue;
      untouched.set(finding.check, (untouched.get(finding.check) ?? 0) + finding.nodeIds.length || 1);
    }
  }
  for (const [check, count] of untouched) {
    report.leftForYou.push({
      check,
      count,
      why: LEFT_ALONE[check] ?? "Not safe to change automatically without knowing what was intended.",
    });
  }

  if (dryRun) {
    const deadCount = before.graphs
      .flatMap((g) => g.findings)
      .filter((f) => f.check === "dead-node")
      .reduce((total, f) => total + f.nodeIds.length, 0);
    report.deadNodesRemoved = removeDeadNodes ? deadCount : 0;
    report.graphsLaidOut = labelSections ? before.graphs.length : 0;
    report.nextAction =
      `Dry run: nothing was changed. Re-run with dryRun false to remove ${deadCount} dead node(s)` +
      `${labelSections ? " and label the graph's sections" : ""}.`;
    return report;
  }

  // --- remove dead nodes ----------------------------------------------------------------------
  if (removeDeadNodes) {
    for (const graph of before.graphs) {
      const dead = graph.findings.filter((f) => f.check === "dead-node").flatMap((f) => f.nodeIds);
      for (const nodeId of dead) {
        try {
          await bridge.send("remove_node", { path, graphName: graph.graphName, nodeId });
          report.deadNodesRemoved++;
        } catch (err) {
          // One stubborn node must not abandon the rest of the cleanup.
          report.failures.push({
            what: `remove ${nodeId} from ${graph.graphName}`,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // --- lay out and label ----------------------------------------------------------------------
  if (labelSections) {
    for (const graph of before.graphs) {
      try {
        const layout = await autoLayoutGraph(bridge, path, graph.graphName, { addCommentBoxes: true });
        report.graphsLaidOut++;
        report.commentBoxesAdded.push(...layout.commentBoxesAdded);
      } catch (err) {
        report.failures.push({
          what: `lay out ${graph.graphName}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // --- did it actually help? ------------------------------------------------------------------
  // Re-reviewing rather than assuming: a cleanup that reports success without checking is the same
  // failure as a model that reads findings and declares victory.
  try {
    const after = await reviewBlueprint(bridge, path);
    report.scoreAfter = after.score;
    report.nextAction =
      after.score > before.score
        ? `Score ${before.score} -> ${after.score}. ${after.nextAction}`
        : after.nextAction;
  } catch (err) {
    report.failures.push({
      what: "re-review after cleanup",
      error: err instanceof Error ? err.message : String(err),
    });
    report.nextAction = "Cleanup ran, but the re-review failed, so the result is unconfirmed. Run unreal_review_blueprint.";
  }

  return report;
}
