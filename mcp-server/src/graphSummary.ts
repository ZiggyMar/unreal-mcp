/**
 * Keep a graph summary inside a budget a model can actually afford.
 *
 * Measured against a real game rather than reasoned about: BP_Player's EventGraph is 807 nodes, and
 * reading it returned 126,477 tokens - 63% of a 200k context window, in a single call, from a
 * project whose stated premise is that the model should never receive a raw engine dump. Every
 * saving made on tool definitions is rounding error beside one call like that.
 *
 * Two things make the cap safe rather than lossy.
 *
 * First, it is applied in the TOOL and not in the bridge. review, audit and explainGraph all call
 * the bridge command directly and still receive every node, so the analysis stays correct while the
 * model gets a view it can afford. Capping in the bridge would have quietly corrupted those instead
 * - which is exactly the mistake explainGraph's own traversal cap had already made once, reporting
 * live nodes as dead.
 *
 * Second, entry points are never dropped. They are where reading a graph starts, and a cap that
 * removes them leaves the remainder unreadable - a list of function calls belonging to nothing.
 *
 * The honest framing for a caller: a truncated summary is not a smaller answer to the same question,
 * it is an answer to "show me around". When the question is specific, `match` answers it for a
 * fiftieth of the cost, and explain_graph answers "what does this DO" without listing nodes at all.
 */

/** The node shape read_blueprint_graph_summary returns. Only what the cap needs is declared. */
export interface SummaryNodeLike {
  id?: string;
  type?: string;
  title?: string;
}

export interface GraphSummaryLike {
  nodes?: SummaryNodeLike[];
  [key: string]: unknown;
}

/** Nodes a graph is read FROM. Losing these to a cap makes everything else unreadable. */
const ENTRY_TYPES = ["K2Node_Event", "K2Node_CustomEvent", "K2Node_FunctionEntry", "K2Node_Timeline"];

/**
 * Default node cap.
 *
 * Chosen from the measurement, not from taste. Nodes in a real graph cost roughly 160 tokens each
 * once their connected pins are included, so 60 lands near 10k - the same order as explain_graph,
 * which is the other way to orient in a big graph. An ordinary graph is well under this and is
 * returned whole; only the graphs that would have cost six figures are touched at all.
 */
export const DEFAULT_MAX_NODES = 60;

export interface CapOptions {
  match?: string;
  maxNodes?: number;
}

export function capGraphSummary(result: GraphSummaryLike, options: CapOptions = {}): GraphSummaryLike {
  const limit = Math.max(1, Math.min(options.maxNodes ?? DEFAULT_MAX_NODES, 5000));
  const all = result.nodes ?? [];
  const needle = (options.match ?? "").trim().toLowerCase();

  const filtered = needle
    ? all.filter((n) => `${n.title ?? ""} ${n.type ?? ""}`.toLowerCase().includes(needle))
    : all;

  if (filtered.length <= limit) {
    // Nothing was cut. Only say so when a filter was applied, so an ordinary small graph comes back
    // exactly as it always did rather than carrying bookkeeping it does not need.
    return needle ? { ...result, nodes: filtered, totalNodes: all.length, matched: filtered.length } : result;
  }

  const entries = filtered.filter((n) => ENTRY_TYPES.includes(n.type ?? ""));
  const rest = filtered.filter((n) => !ENTRY_TYPES.includes(n.type ?? ""));
  const kept = [...entries, ...rest].slice(0, limit);

  const ratio = Math.round((all.length / Math.max(kept.length, 1)) * 10) / 10;
  return {
    ...result,
    nodes: kept,
    totalNodes: all.length,
    ...(needle ? { matched: filtered.length } : {}),
    shown: kept.length,
    omitted: filtered.length - kept.length,
    truncated: true,
    next:
      `This graph has ${all.length} nodes and ${kept.length} are shown, entry points first. Reading ` +
      `all of them costs roughly ${ratio}x this reply. If you are looking for something specific, ` +
      `\`match\` takes a title or type substring and is far cheaper; unreal_explain_graph describes ` +
      `what the graph DOES without listing nodes; raise \`maxNodes\` only if you genuinely need the rest.`,
  };
}
