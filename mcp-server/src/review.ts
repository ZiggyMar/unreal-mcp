import { reviewGraph, type QualityReport } from "./quality.js";
import { reviewStatePlacement, type StateFinding } from "./statePlacement.js";
import { reviewMultiplayer, type MpFinding } from "./multiplayer.js";
import type { BridgeLike } from "./autoLayout.js";
import type { ListBlueprintGraphsResult, ReadBlueprintGraphSummaryResult } from "./types.js";

export interface BlueprintReview {
  path: string;
  /** Lowest score across the reviewed graphs: a Blueprint is only as good as its worst graph. */
  score: number;
  summary: { errors: number; warnings: number; infos: number };
  graphs: QualityReport[];
  /**
   * The variables, handed back so a caller does not read them a second time. The whole-project
   * audit needs them for the checks that depend on how a variable replicates, and list_variables is
   * one bridge call per Blueprint - across a real project that is hundreds.
   */
  variables?: Array<{ name: string; type?: string; replicated?: boolean; repNotify?: string }>;
  /** What this Blueprint derives from, for the checks that compare a child against its parent. */
  parentClass?: string;
  /**
   * Findings about the Blueprint as a whole rather than about one graph: where its state lives, and
   * whether what the server writes will ever reach a client.
   *
   * Kept separate from `graphs` because they are not about a graph, and filing them under an
   * arbitrary one would be a lie. They briefly counted toward the score and drove `nextAction`
   * without appearing anywhere a caller could read them, which made the score unexplainable - a
   * number nobody can trace back to a reason is worse than no number at all.
   */
  blueprint: Array<{ check: string; severity: "warning" | "info"; message: string; fix: string; observed?: string }>;
  /** Raw graph nodes, only when asked for. See reviewBlueprint's includeGraphNodes. */
  graphNodes?: Array<{ graphName: string; nodes: unknown[] }>;
  /** The one thing most worth fixing next, or a note that nothing needs fixing. */
  nextAction: string;
}

/**
 * Review one graph, or every graph in a Blueprint.
 *
 * Composed from existing reads, so it costs one round trip per graph and changes nothing. The
 * summary is aggregated across graphs because the caller's real question is "is this Blueprint
 * done?", and that is answered by its worst graph, not its average one.
 */
export async function reviewBlueprint(
  bridge: BridgeLike,
  path: string,
  graphName?: string,
  options: { includeGraphNodes?: boolean } = {}
): Promise<BlueprintReview> {
  let graphNames: string[];
  if (graphName) {
    graphNames = [graphName];
  } else {
    const list = await bridge.send<ListBlueprintGraphsResult>("list_blueprint_graphs", { path });
    graphNames = (list.graphs ?? []).map((graph) => graph.name).filter(Boolean);
  }

  const reports: QualityReport[] = [];
  // Kept because the multiplayer check needs the graph AND the variables together: whether a write
  // is a bug depends on where it runs and on whether the thing written replicates.
  const allNodes: Array<{ id: string; type: string; title: string; connectedPins?: unknown[] }> = [];
  const graphNodes: Array<{ graphName: string; nodes: unknown[] }> = [];
  for (const name of graphNames) {
    const summary = await bridge.send<ReadBlueprintGraphSummaryResult>("read_blueprint_graph_summary", {
      path,
      graphName: name,
    });
    reports.push(reviewGraph(name, summary.nodes ?? []));
    allNodes.push(...(summary.nodes ?? []));
    // Handing the raw nodes back on request means a caller that needs them - the whole-project
    // audit - does not read every graph a second time. Off by default: an ordinary review has no
    // use for them and should not pay to carry them.
    if (options.includeGraphNodes) {
      graphNodes.push({ graphName: name, nodes: summary.nodes ?? [] });
    }
  }

  // Where the state lives, which no graph read can answer.
  //
  // This is one extra cheap call, and it buys the judgment that separates a Blueprint that works
  // from one a team can extend. It is allowed to fail silently: a review that refuses to run
  // because one optional check could not gather its data is worse than a review missing that check.
  let variables: BlueprintReview["variables"] = [];
  let parentClass = "";
  let stateFindings: StateFinding[] = [];
  let mpFindings: MpFinding[] = [];
  try {
    const state = await bridge.send<{
      parentClass?: string;
      variables?: Array<{ name: string; type?: string; subType?: string; replicated?: boolean; repNotify?: string }>;
    }>("list_variables", { path });
    stateFindings = reviewStatePlacement(state.parentClass ?? "", state.variables ?? []);
    mpFindings = reviewMultiplayer(allNodes as never, state.variables ?? []);
    variables = state.variables ?? [];
    parentClass = state.parentClass ?? "";
  } catch {
    stateFindings = [];
    mpFindings = [];
  }

  const summary = reports.reduce(
    (acc, report) => ({
      errors: acc.errors + report.summary.errors,
      warnings: acc.warnings + report.summary.warnings,
      infos: acc.infos + report.summary.infos,
    }),
    { errors: 0, warnings: 0, infos: 0 }
  );
  const extraFindings = [...stateFindings, ...mpFindings];
  summary.warnings += extraFindings.filter((f) => f.severity === "warning").length;
  summary.infos += extraFindings.filter((f) => f.severity === "info").length;
  const score = reports.length === 0 ? 100 : Math.min(...reports.map((report) => report.score));

  // One next action, not a list: a caller that is handed ten equal priorities picks none of them.
  const worst = reports
    .flatMap((report) => report.findings.map((finding) => ({ finding, graph: report.graphName })))
    .concat(
      // Misplaced state competes for the single next action on equal terms. It is a warning rather
      // than an error, so a broken graph still outranks it - you cannot judge the architecture of
      // something that does not run.
      extraFindings.map((finding) => ({
        finding: {
          check: finding.check,
          severity: finding.severity as "warning" | "info",
          message: finding.message,
          fix: finding.fix,
          nodeIds: [] as string[],
        },
        graph: "variables",
      }))
    )
    .sort((a, b) => {
      const rank = { error: 0, warning: 1, info: 2 } as const;
      return rank[a.finding.severity] - rank[b.finding.severity];
    })[0];

  const nextAction = worst
    ? `[${worst.graph}] ${worst.finding.message} ${worst.finding.fix}`
    : "Nothing to fix. This Blueprint passes every check.";

  return {
    path,
    score,
    summary,
    graphs: reports,
    // Only when the caller already asked for the raw nodes: an ordinary review has no use for the
    // variable list and should not pay to carry it.
    variables: options.includeGraphNodes ? variables : undefined,
    parentClass: options.includeGraphNodes ? parentClass : undefined,
    graphNodes: options.includeGraphNodes ? graphNodes : undefined,
    // `observed` rides along deliberately. It is the evidence a check gathered, and two of these
    // checks fire identically on a real bug and on a deliberate choice - dropping it here would have
    // handed the audit a verdict with none of the reasoning behind it.
    blueprint: extraFindings.map(({ check, severity, message, fix, ...rest }) => ({
      check,
      severity,
      message,
      fix,
      ...("observed" in rest && rest.observed ? { observed: rest.observed as string } : {}),
    })),
    nextAction,
  };
}
