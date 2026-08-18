import { reviewGraph, type QualityReport } from "./quality.js";
import type { BridgeLike } from "./autoLayout.js";
import type { ListBlueprintGraphsResult, ReadBlueprintGraphSummaryResult } from "./types.js";

export interface BlueprintReview {
  path: string;
  /** Lowest score across the reviewed graphs: a Blueprint is only as good as its worst graph. */
  score: number;
  summary: { errors: number; warnings: number; infos: number };
  graphs: QualityReport[];
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
  graphName?: string
): Promise<BlueprintReview> {
  let graphNames: string[];
  if (graphName) {
    graphNames = [graphName];
  } else {
    const list = await bridge.send<ListBlueprintGraphsResult>("list_blueprint_graphs", { path });
    graphNames = (list.graphs ?? []).map((graph) => graph.name).filter(Boolean);
  }

  const reports: QualityReport[] = [];
  for (const name of graphNames) {
    const summary = await bridge.send<ReadBlueprintGraphSummaryResult>("read_blueprint_graph_summary", {
      path,
      graphName: name,
    });
    reports.push(reviewGraph(name, summary.nodes ?? []));
  }

  const summary = reports.reduce(
    (acc, report) => ({
      errors: acc.errors + report.summary.errors,
      warnings: acc.warnings + report.summary.warnings,
      infos: acc.infos + report.summary.infos,
    }),
    { errors: 0, warnings: 0, infos: 0 }
  );
  const score = reports.length === 0 ? 100 : Math.min(...reports.map((report) => report.score));

  // One next action, not a list: a caller that is handed ten equal priorities picks none of them.
  const worst = reports
    .flatMap((report) => report.findings.map((finding) => ({ finding, graph: report.graphName })))
    .sort((a, b) => {
      const rank = { error: 0, warning: 1, info: 2 } as const;
      return rank[a.finding.severity] - rank[b.finding.severity];
    })[0];

  const nextAction = worst
    ? `[${worst.graph}] ${worst.finding.message} ${worst.finding.fix}`
    : "Nothing to fix. This Blueprint passes every check.";

  return { path, score, summary, graphs: reports, nextAction };
}
