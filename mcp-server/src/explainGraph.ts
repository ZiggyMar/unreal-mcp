import { execTargets } from "./execFlow.js";
import { ENTRY_TYPES } from "./entryTypes.js";

/**
 * Turn a graph into a paragraph.
 *
 * Measured on a real 104-node EventGraph from an eight-month-old project: the structural summary
 * costs **8,838 tokens**. That is larger than the entire `lazy` tool payload, and larger than the
 * whole context a 14B has on a 12 GB card. Two thirds of it is not information — 30% is 32-character
 * node GUIDs and 36% is JSON key names repeated once per pin.
 *
 * So a model asking "what does this Blueprint do" cannot afford to ask, and that is the real answer
 * to "can it handle large Blueprints": not by reading them.
 *
 * This reads the structure once and returns what the structure MEANS: each entry point and the
 * ordered chain of things it does. It is the difference between handing someone a wiring diagram
 * and telling them what the machine is for. A weak model can act on the second and drowns in the
 * first.
 *
 * It is deliberately lossy. Anything that needs exact pins or ids still calls
 * `read_blueprint_graph_summary` — for one chain, not the whole graph.
 */

export interface SummaryPinLink {
  node: string;
  pin: string;
}

export interface SummaryPin {
  pin: string;
  direction: string;
  linkedTo?: SummaryPinLink[];
}

export interface SummaryNode {
  id: string;
  type: string;
  title: string;
  connectedPins?: SummaryPin[];
}

export interface GraphSummary {
  path?: string;
  graphName?: string;
  nodes: SummaryNode[];
}

export interface ExplainedChain {
  /** The event or entry node this chain hangs off. */
  entry: string;
  /** Its node id, so a caller can ask the editor about that node without matching on the title. */
  entryId: string;
  /** What happens, in execution order. */
  steps: string[];
  /** True when the chain was cut short because it loops or branches beyond the step budget. */
  truncated: boolean;
  /** Every node this chain touched, so shared chains can be detected. */
  nodeIds: string[];
}

export interface GraphExplanation {
  path?: string;
  graphName?: string;
  nodeCount: number;
  chains: ExplainedChain[];
  /** Nodes not reachable from any entry point, grouped by title with a count. */
  unreachable: string[];
  text: string;
}

/**
 * Execution flows into a pin called "execute" (or "exec") on the receiving node. Following that,
 * rather than trying to enumerate every possible exec OUTPUT name, keeps this correct for node
 * types nobody has thought of yet: latent nodes, macros, and anything a plugin adds.
 */



/** Titles are shown to a reader, so strip the noise the editor adds for its own layout. */
const clean = (title: string) => title.replace(/\s+/g, " ").trim();

/** How many steps of a chain are PRINTED. Traversal itself is never capped - see below. */
const DEFAULT_MAX_STEPS_PER_CHAIN = 40;

export interface ExplainOptions {
  /** Steps per chain to print before saying how many more there are. Defaults to 40. */
  maxStepsPerChain?: number;
}

export function explainGraph(summary: GraphSummary, options: ExplainOptions = {}): GraphExplanation {
  const maxStepsPerChain = options.maxStepsPerChain ?? DEFAULT_MAX_STEPS_PER_CHAIN;
  const nodes = summary.nodes ?? [];
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // Comment boxes are layout, not behaviour. They matter to a human reading the graph and not at
  // all to a description of what it does. Reroute nodes are the same: a knot is a wire somebody
  // bent around a comment box, and listing "Reroute Node (x7)" under possible dead logic is noise
  // at the top of exactly the list that is supposed to be signal.
  const behavioural = nodes.filter(
    (node) => node.type !== "EdGraphNode_Comment" && node.type !== "K2Node_Knot"
  );

  const entries = behavioural.filter((node) => ENTRY_TYPES.includes(node.type));
  const visited = new Set<string>();

  // Reroute nodes are stepped over by execTargets: they are wires, not behaviour, and treating them
  // as nodes truncated every chain drawn by somebody who tidies their graphs.
  const nextFrom = (node: SummaryNode): SummaryNode[] =>
    execTargets(node, byId).filter((target) => target.type !== "EdGraphNode_Comment");

  const chains: ExplainedChain[] = [];
  for (const entry of entries) {
    visited.add(entry.id);
    const steps: string[] = [];

    // Breadth-first along execution, so a branch reads as two steps rather than losing one arm
    // entirely. Depth would silently drop the second half of every Branch.
    //
    // The traversal runs to completion and is NOT capped. It used to stop at 40 steps, which was
    // meant to bound the printed output and instead corrupted the analysis: `visited` never learned
    // about anything past step 40, so every node beyond it was reported as "not reached by any event
    // chain" - dead logic - when it was plainly live. audit.ts builds liveNodeIds from these chains,
    // so the same cap turned a long graph into a page of false dead-node findings, which is the
    // worst possible failure for a tool whose job is to tell you what is actually wrong.
    //
    // Nothing can run away here: seenInChain makes every node visitable once, so this is O(nodes)
    // whatever the graph looks like. The cap belongs on the printing, and that is where it now is.
    let frontier = nextFrom(entry);
    const seenInChain = new Set<string>([entry.id]);
    while (frontier.length > 0) {
      const next: SummaryNode[] = [];
      for (const node of frontier) {
        if (seenInChain.has(node.id)) continue;
        seenInChain.add(node.id);
        visited.add(node.id);
        steps.push(clean(node.title));
        next.push(...nextFrom(node));
      }
      frontier = next;
    }

    chains.push({
      entry: clean(entry.title),
      entryId: entry.id,
      steps,
      // Now a statement about the rendered line rather than about how far the analysis got.
      truncated: steps.length > maxStepsPerChain,
      nodeIds: [...seenInChain],
    });
  }

  // Anything never reached is either dead logic or a pure data node feeding something else. Both
  // are worth mentioning once, by name, rather than listing every instance.
  const unreachableCounts = new Map<string, number>();
  for (const node of behavioural) {
    if (visited.has(node.id)) continue;
    const title = clean(node.title);
    unreachableCounts.set(title, (unreachableCounts.get(title) ?? 0) + 1);
  }
  const unreachable = [...unreachableCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([title, count]) => (count > 1 ? `${title} (x${count})` : title));

  // Entry points that converge on the same nodes.
  //
  // This is the single most useful thing a description can add that a node list cannot, and it was
  // added after it caught a mistake in the making: a real Blueprint had Event Begin Play and Event
  // Tick running into ONE shared caching chain, so the obvious fix - delete the part that only makes
  // sense on the server - would have silently broken BeginPlay as well.
  //
  // Two chains printed one after another look independent. Saying they are not is cheap here and
  // expensive to discover by hand.
  const reachCount = new Map<string, number>();
  for (const chain of chains) {
    for (const id of chain.nodeIds) reachCount.set(id, (reachCount.get(id) ?? 0) + 1);
  }
  const sharedWith = new Map<string, string[]>();
  for (const chain of chains) {
    const shared = chain.nodeIds.filter((id) => (reachCount.get(id) ?? 0) > 1);
    if (shared.length === 0) continue;
    const others = chains
      .filter((other) => other !== chain && other.nodeIds.some((id) => shared.includes(id)))
      .map((other) => other.entry);
    if (others.length > 0) sharedWith.set(chain.entry, others);
  }

  const lines: string[] = [];
  lines.push(`${summary.graphName ?? "Graph"}: ${nodes.length} nodes, ${chains.length} entry point(s).`);
  for (const chain of chains) {
    if (chain.steps.length === 0) {
      lines.push(`- ${chain.entry}: nothing wired to it.`);
      continue;
    }
    const shownSteps = chain.steps.slice(0, maxStepsPerChain);
    lines.push(
      `- ${chain.entry} -> ${shownSteps.join(" -> ")}` +
        // Naming the number matters: "...(more)" gave no way to tell a chain two steps too long
        // from one ten times too long, and no way to know what to raise the cap to.
        (chain.steps.length > shownSteps.length
          ? ` -> ...(${chain.steps.length - shownSteps.length} more steps)`
          : "")
    );
  }
  // Reported once per pair rather than once per chain, so two entry points sharing a chain produce
  // one sentence and not two.
  const alreadySaid = new Set<string>();
  for (const [entry, others] of sharedWith) {
    for (const other of others) {
      const key = [entry, other].sort().join(" | ");
      if (alreadySaid.has(key)) continue;
      alreadySaid.add(key);
      lines.push(`Note: ${entry} and ${other} run into the same nodes - changing one changes both.`);
    }
  }
  if (unreachable.length > 0) {
    // Capped: a long tail of pure data nodes is normal and listing all of it would undo the point
    // of this tool.
    const shown = unreachable.slice(0, 12);
    lines.push(
      `Not reached by any event chain (data nodes or dead logic): ${shown.join(", ")}` +
        `${unreachable.length > shown.length ? `, and ${unreachable.length - shown.length} more` : ""}.`
    );
  }

  return {
    path: summary.path,
    graphName: summary.graphName,
    nodeCount: nodes.length,
    chains,
    unreachable,
    text: lines.join("\n"),
  };
}
