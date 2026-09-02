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
  runsOn?: string;
  /** Present only when the caller asked for withPinValues. */
  values?: Record<string, string>;
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
    // Where the event RUNS, when the bridge knows. A Server RPC and a Multicast are both a
    // CustomEvent with an ordinary one-line title, so without this the summary says "StartVaccum"
    // for an event whose full detail reads "Replicated From Client, Executes On Server" - and
    // whether a chain is server-only changes what every node after it means.
    //
    // The bridge has computed this all along and this function threw it away: compactNode rebuilds
    // each node from a fixed set of fields, so a field added upstream is silently dropped here. It
    // cost a real diagnosis - tracing one vacuum bug took eight calls and a detour through
    // read_node_detail to recover a fact the first reply already had.
    //
    // Emitted only for replicated events, so the common case still costs nothing.
    ...(node.runsOn ? { runsOn: node.runsOn } : {}),
    // Only when asked for, and the bridge only fills it for pins that are unwired and non-empty -
    // so a node with nothing set costs nothing here.
    ...(node.values ? { values: node.values } : {}),
    ...(pins ? { pins } : {}),
  };
}

export interface GraphSummaryLike {
  nodes?: SummaryNodeLike[];
  [key: string]: unknown;
}

/** Nodes a graph is read FROM. Losing these to a cap makes everything else unreadable. */
import { ENTRY_TYPES } from "./entryTypes.js";

/**
 * Default node cap.
 *
 * Chosen from the measurement, not from taste. Nodes in a real graph cost roughly 160 tokens each
 * once their connected pins are included, so 60 lands near 10k - the same order as explain_graph,
 * which is the other way to orient in a big graph. An ordinary graph is well under this and is
 * returned whole; only the graphs that would have cost six figures are touched at all.
 */
export const DEFAULT_MAX_NODES = 60;

/**
 * A neighbour of a match: id, type and title, and nothing else.
 *
 * The reason it carries no pins is the whole reason it is here. A caller who filtered to "Kronos
 * Match" gets a node whose wiring reads `in HostParams <- BE59B028.ReturnValue` - an id that is not
 * in the reply, because the node it names did not match. The link cannot be followed, so the filter
 * that was supposed to save a call has cost one.
 *
 * A title fixes that outright: "Make Kronos Host Params" is immediately the thing you wanted, and
 * you go straight to unreal_read_node_detail for its pin defaults. Carrying the neighbour's own
 * wiring as well would drag in a second ring of unresolvable ids and undo the saving, so it stops
 * at one hop.
 */
function asNeighbour(node: SummaryNodeLike): Record<string, unknown> {
  return {
    id: node.id,
    type: shortType(node.type),
    title: node.title,
    ...(node.runsOn ? { runsOn: node.runsOn } : {}),
    neighbour: true,
  };
}

/** Every node one link away from a match, in either direction, that is not itself a match. */
function neighboursOf(matches: SummaryNodeLike[], all: SummaryNodeLike[]): SummaryNodeLike[] {
  const matched = new Set(matches.map((n) => n.id).filter(Boolean));
  const wanted = new Set<string>();
  for (const node of matches) {
    for (const pin of node.connectedPins ?? []) {
      for (const link of pin.linkedTo ?? []) {
        // Both directions come free: the summary records a link on the pins at both of its ends,
        // so a match's own pin list already names everything touching it.
        if (link.node && !matched.has(link.node)) wanted.add(link.node);
      }
    }
  }
  return wanted.size === 0 ? [] : all.filter((n) => n.id && wanted.has(n.id));
}

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

  // A filter narrows to the nodes asked for and then puts back the ones they are wired to, so the
  // links in the reply resolve inside the reply.
  const near = needle ? neighboursOf(filtered, all) : [];

  if (filtered.length <= limit) {
    // Nothing was cut. Only say so when a filter was applied, so an ordinary small graph comes back
    // without bookkeeping it does not need - but the nodes are still compacted, because the wiring
    // shape costs the same per node whether there are five of them or eight hundred.
    return needle
      ? {
          ...result,
          nodes: [...filtered.map(compactNode), ...near.map(asNeighbour)],
          totalNodes: all.length,
          matched: filtered.length,
          ...(near.length > 0 ? { neighbours: near.length } : {}),
        }
      : { ...result, nodes: all.map(compactNode) };
  }

  const entries = filtered.filter((n) => ENTRY_TYPES.includes(n.type ?? ""));
  const rest = filtered.filter((n) => !ENTRY_TYPES.includes(n.type ?? ""));
  const kept = [...entries, ...rest].slice(0, limit);

  const ratio = Math.round((all.length / Math.max(kept.length, 1)) * 10) / 10;
  // Only what the surviving nodes actually link to. A neighbour of something the cap removed
  // explains nothing and is pure cost.
  //
  // Note the candidate pool is `near` PLUS the matches the cap cut. A link to a cut match dangles
  // exactly as badly as a link to a never-matched node - the reason it was dropped makes no
  // difference to a reader who cannot follow it.
  const keptIds = new Set(kept.map((n) => n.id).filter(Boolean));
  const linkedFromKept = new Set<string>();
  for (const k of kept) {
    for (const pin of k.connectedPins ?? []) {
      for (const link of pin.linkedTo ?? []) {
        if (link.node && !keptIds.has(link.node)) linkedFromKept.add(link.node);
      }
    }
  }
  // Only when a filter was used. Without one, `filtered` is the entire graph, so this would drag
  // every capped-away node back in as a neighbour - measured at 2,121 tokens to 3,879 on the 809-node
  // graph, an 83% rise on the commonest read of all, to fix dangling links in a reply that already
  // says `truncated` and tells the caller how to narrow. A caller who filtered asked a specific
  // question and needs the answer to hold together; a caller who did not is still getting oriented.
  const cutMatches = needle ? filtered.filter((n) => n.id && !keptIds.has(n.id)) : [];
  const keptNear = [...near, ...cutMatches].filter((n) => n.id && linkedFromKept.has(n.id));

  return {
    ...result,
    nodes: [...kept.map(compactNode), ...keptNear.map(asNeighbour)],
    totalNodes: all.length,
    ...(needle ? { matched: filtered.length } : {}),
    ...(keptNear.length > 0 ? { neighbours: keptNear.length } : {}),
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
