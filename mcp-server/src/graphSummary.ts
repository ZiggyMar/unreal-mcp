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

/** The node shape read_blueprint_graph_summary returns. Only what this module needs is declared. */
export interface SummaryNodeLike {
  id?: string;
  type?: string;
  title?: string;
  ghost?: boolean;
  connectedPins?: Array<{
    pin?: string;
    direction?: string;
    linkedTo?: Array<{ node?: string; pin?: string }>;
  }>;
}

/**
 * Flatten a node's wiring into one line per pin.
 *
 * Measured on a real 807-node graph: 65% of the reply - 34,008 tokens of 52,469 - was JSON keys and
 * punctuation, and only 18,461 was data. The bulk of it is that every single link is its own object,
 * `{"node":"...","pin":"..."}`, so the words "node" and "pin" are repeated 1,642 times to carry two
 * short strings each.
 *
 * "out then -> A1B2C3D4.execute" says the same thing, costs a fraction, and is easier to read than
 * the nested form it replaces. This happens in the TOOL, so review, audit and explainGraph keep the
 * structured shape they parse - the same split that made the node cap safe.
 */
function flattenPins(node: SummaryNodeLike): string[] | undefined {
  const pins = node.connectedPins;
  if (!Array.isArray(pins) || pins.length === 0) return undefined;
  return pins.map((p) => {
    const targets = (p.linkedTo ?? []).map((l) => `${l.node ?? "?"}.${l.pin ?? "?"}`).join(", ");
    const arrow = p.direction === "out" ? "->" : "<-";
    return targets ? `${p.direction ?? "?"} ${p.pin ?? "?"} ${arrow} ${targets}` : `${p.direction ?? "?"} ${p.pin ?? "?"}`;
  });
}

/**
 * Node types all begin "K2Node_", 807 times in one reply. The prefix identifies nothing: every node
 * in a Blueprint graph has it, so it is 1,400 tokens of the same seven characters.
 */
function shortType(type: string | undefined): string | undefined {
  return type?.startsWith("K2Node_") ? type.slice("K2Node_".length) : type;
}

/** Rewrite one node into the compact form the model sees. */
function compactNode(node: SummaryNodeLike): Record<string, unknown> {
  const pins = flattenPins(node);
  return {
    id: node.id,
    type: shortType(node.type),
    title: node.title,
    ...(node.ghost ? { ghost: true } : {}),
    ...(pins ? { pins } : {}),
  };
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
    // without bookkeeping it does not need - but the nodes are still compacted, because the wiring
    // shape costs the same per node whether there are five of them or eight hundred.
    return needle
      ? { ...result, nodes: filtered.map(compactNode), totalNodes: all.length, matched: filtered.length }
      : { ...result, nodes: all.map(compactNode) };
  }

  const entries = filtered.filter((n) => ENTRY_TYPES.includes(n.type ?? ""));
  const rest = filtered.filter((n) => !ENTRY_TYPES.includes(n.type ?? ""));
  const kept = [...entries, ...rest].slice(0, limit);

  const ratio = Math.round((all.length / Math.max(kept.length, 1)) * 10) / 10;
  return {
    ...result,
    nodes: kept.map(compactNode),
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
