import { FINDING_COST } from "./findingCost.js";
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
  /** Only the graphs that have something to say. See where this is built for why. */
  graphs: QualityReport[];
  /**
   * The graphs that were read and found clean, by name.
   *
   * Deliberately not omitted. "Checked and clean" and "never looked at" are different answers, and a
   * caller that cannot tell them apart will re-read graphs this tool already cleared.
   */
  cleanGraphs?: string[];
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
  /** Which listed graphs the engine says are dispatcher signatures, when the plugin reports it. */
  graphKinds?: Array<{ graphName: string; kind: string }>;
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
  let graphKinds: Array<{ graphName: string; kind: string }> = [];
  if (graphName) {
    graphNames = [graphName];
  } else {
    const list = await bridge.send<ListBlueprintGraphsResult>("list_blueprint_graphs", { path });
    graphNames = (list.graphs ?? []).map((graph) => graph.name).filter(Boolean);
    // The engine's own answer to "which of these are dispatcher signatures", carried through for the
    // audit. Absent on a plugin older than that change, which is why the caller keeps a fallback.
    graphKinds = (list.graphs ?? [])
      .filter((graph) => (graph as { kind?: string }).kind)
      .map((graph) => ({ graphName: graph.name, kind: (graph as { kind?: string }).kind as string }));
  }

  const reports: QualityReport[] = [];
  // Kept because the multiplayer check needs the graph AND the variables together: whether a write
  // is a bug depends on where it runs and on whether the thing written replicates.
  // Fetched BEFORE the graph loop, because one per-graph check needs it: a Blueprint Interface
  // declares signatures and its function graphs are empty by design, so "this function has no body"
  // is the whole point rather than a defect. Everything derived from it still happens after the
  // loop, where the node list it needs exists.
  let state: {
    parentClass?: string;
    variables?: Array<{ name: string; type?: string; subType?: string; replicated?: boolean; repNotify?: string }>;
  } = {};
  try {
    state = await bridge.send("list_variables", { path });
  } catch {
    /* the graph review is worth returning without it; the checks below handle an empty state */
  }
  const isInterface = /^interface$/i.test(state.parentClass ?? "");
  // Dispatcher signatures show up in the graph list looking exactly like unfinished functions.
  const delegateNames = new Set(
    (state.variables ?? []).filter((v) => /delegate/i.test(String(v.type ?? ""))).map((v) => v.name)
  );

  const allNodes: Array<{ id: string; type: string; title: string; connectedPins?: unknown[] }> = [];
  const graphNodes: Array<{ graphName: string; nodes: unknown[] }> = [];
  for (const name of graphNames) {
    const summary = await bridge.send<ReadBlueprintGraphSummaryResult>("read_blueprint_graph_summary", {
      path,
      graphName: name,
    });
    reports.push(reviewGraph(name, summary.nodes ?? [], { isInterface, delegateNames }));
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
      // Severity first, then what it actually costs you. Severity alone left the order within
      // "warning" to however the graphs happened to be read, which on BP_Player put a cost-40
      // unhandled cast ahead of four cost-55 tick findings - in the one field whose whole job is to
      // say what to do next. The audit has ranked by cost for a long time; this now uses the same
      // table, so the two tools cannot disagree about which finding matters most.
      const rank = { error: 0, warning: 1, info: 2 } as const;
      const bySeverity = rank[a.finding.severity] - rank[b.finding.severity];
      if (bySeverity !== 0) return bySeverity;
      return (FINDING_COST[b.finding.check] ?? 1) - (FINDING_COST[a.finding.check] ?? 1);
    })[0];

  const nextAction = worst
    ? `[${worst.graph}] ${worst.finding.message} ${worst.finding.fix}`
    : "Nothing to fix. This Blueprint passes every check.";

  return {
    path,
    score,
    summary,
    // Graphs with findings in full; graphs without them by name only.
    //
    // BP_Player has 60 graphs and 13 of them have anything to say. The other 47 each carried a
    // score, a summary of three zeroes and an empty findings array - 5,574 characters, 30% of the
    // reply, to report that nothing is wrong.
    //
    // They are NOT dropped. "Checked and clean" and "not checked" are different answers, and this
    // project has spent a lot of effort separating them everywhere else. The names keep the fact at
    // a quarter of the cost, and a caller can still see exactly what was looked at.
    graphs: reports.filter((r) => r.findings.length > 0),
    ...(reports.some((r) => r.findings.length === 0)
      ? { cleanGraphs: reports.filter((r) => r.findings.length === 0).map((r) => r.graphName) }
      : {}),
    // Only when the caller already asked for the raw nodes: an ordinary review has no use for the
    // variable list and should not pay to carry it.
    variables: options.includeGraphNodes ? variables : undefined,
    parentClass: options.includeGraphNodes ? parentClass : undefined,
    graphNodes: options.includeGraphNodes ? graphNodes : undefined,
    graphKinds: options.includeGraphNodes && graphKinds.length > 0 ? graphKinds : undefined,
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
