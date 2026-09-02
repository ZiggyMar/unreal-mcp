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
  /** "server" | "all" | "owningClient"; the bridge emits it only for a replicated custom event. */
  runsOn?: string;
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
  /** "server" | "all" | "owningClient" for a replicated event; absent for an ordinary one. */
  runsOn?: string;
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
  /**
   * Only chains that mention this, in their entry name or any step. Case-insensitive substring.
   *
   * A big event graph explains 99 chains and a question is almost never about all of them.
   * Measured on BP_Player: 3,176 tokens for the whole thing, of which the fifteen vacuum chains
   * somebody asked for were 17%. Filtering after the fact - which is what a caller does with the
   * reply in hand - has already paid for the other 83%.
   */
  match?: string;
}

export function explainGraph(summary: GraphSummary, options: ExplainOptions = {}): GraphExplanation {
  const maxStepsPerChain = options.maxStepsPerChain ?? DEFAULT_MAX_STEPS_PER_CHAIN;
  const needle = (options.match ?? "").trim().toLowerCase();
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

  /**
   * Resolve a boolean expression to something readable, one or two levels deep.
   *
   * Stopping at the immediate source gives "Branch (AND Boolean)", which says a conjunction decides
   * this and not what it conjoins - true of every AND in every graph ever written. Two levels turn
   * that into "CheckGameplayTag AND NOT Get isDead", which is the actual rule. Depth is capped hard
   * because this is a cheap summary: a deeply nested expression collapses back to its operator name
   * rather than unrolling into something longer than the node dump it replaced.
   */
  const describeBool = (
    node: SummaryNode | undefined,
    depth: number,
    viaPin?: string
  ): string | undefined => {
    if (!node) return undefined;

    // A condition wired from the function's own entry node is a PARAMETER, and the parameter's name
    // is the whole answer. Reporting the entry's title instead gives "Branch (SetGameplayTagMC)",
    // which names the function you are already reading rather than the argument it branches on.
    if (ENTRY_TYPES.includes(node.type) && viaPin) {
      return viaPin;
    }

    // A knot is a wire somebody bent around a comment box, not a value. execTargets already steps
    // over them for execution; not doing the same for data produced "Branch (Reroute Node)", which
    // reports the tidying rather than the condition. Stepping through costs no depth, because a
    // reroute is not a level of logic.
    if (node.type === "K2Node_Knot") {
      const through = (node.connectedPins ?? []).find(
        (p) => p.direction === "in" && (p.linkedTo ?? []).length > 0
      )?.linkedTo?.[0];
      return through ? describeBool(byId.get(through.node), depth, through.pin) : undefined;
    }

    const title = clean(node.title);
    if (depth <= 0) return title;

    const operand = (pinName: string): string | undefined => {
      const pin = (node.connectedPins ?? []).find((p) => p.pin === pinName && p.direction === "in");
      const link = pin?.linkedTo?.[0];
      return link ? describeBool(byId.get(link.node), depth - 1, link.pin) : undefined;
    };

    if (/^NOT\b/i.test(title)) {
      const a = operand("A");
      return a ? `NOT ${a}` : title;
    }
    const infix = /^(AND|OR)\b/i.exec(title);
    if (infix) {
      const a = operand("A");
      const b = operand("B");
      return a && b ? `${a} ${infix[1].toUpperCase()} ${b}` : title;
    }

    // Comparisons title themselves by their operand TYPES - "float < float", "int >= int" - which
    // says a number decides this and not which number. Every gate in a health, timer or ammo check
    // reads that way, so a chain full of them carries no information at all.
    //
    // One side is often a literal typed into the pin, and a literal has no link, so it is not in
    // connectedPins and cannot be recovered here. Naming the side that IS a variable is still most
    // of the answer: "Get Health < literal" tells a reader what to go and watch.
    const compare = /^\s*\S+\s*(<=|>=|==|!=|<|>)\s*\S+\s*$/.exec(title);
    if (compare) {
      const a = operand("A");
      const b = operand("B");
      if (a && b) return `${a} ${compare[1]} ${b}`;
      if (a) return `${a} ${compare[1]} literal`;
      if (b) return `literal ${compare[1]} ${b}`;
    }
    return title;
  };

  /**
   * What a Branch tests, in the graph's own words.
   *
   * Without this a chain reads "Branch -> Branch -> Add Force", which names the shape of the logic
   * and none of its content. That cost a real debugging session: the vacuum drag in a shipped
   * project applies its force behind a second Branch whose condition is `Has Authority`, so it never
   * runs on a client - and this explanation, the cheap read models are told to prefer, did not
   * contain the word "authority" anywhere in the chain. The expensive node-and-pin read had to be
   * done anyway, which is the one outcome this tool exists to avoid.
   */
  const conditionOf = (node: SummaryNode): string | undefined => {
    if (node.type !== "K2Node_IfThenElse") return undefined;
    const condition = (node.connectedPins ?? []).find(
      (p) => p.pin === "Condition" && p.direction === "in"
    );
    const source = condition?.linkedTo?.[0];
    if (!source) return undefined;
    return describeBool(byId.get(source.node), 2, source.pin) ?? source.pin;
  };

  /**
   * Every node feeding a pin of `target`, transitively - the data behind one step.
   *
   * Used to tell a step's inputs apart from dead logic. They look identical to a walker that only
   * follows exec links, and calling them the same thing is actively misleading: the old output
   * listed `Has Authority`, `AND Boolean` and `Get isDead` under "not reached by any event chain
   * (data nodes or dead logic)" for a function whose entire behaviour those three decide. A reader
   * takes that as permission to ignore them.
   */
  const collectDataInputs = (target: SummaryNode, into: Set<string>): void => {
    for (const pin of target.connectedPins ?? []) {
      if (pin.direction !== "in") continue;
      for (const link of pin.linkedTo ?? []) {
        if (into.has(link.node)) continue;
        const source = byId.get(link.node);
        if (!source) continue;
        into.add(link.node);
        collectDataInputs(source, into);
      }
    }
  };
  const feedsSomethingReached = new Set<string>();

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
        const condition = conditionOf(node);
        steps.push(condition ? `${clean(node.title)} (${condition})` : clean(node.title));
        collectDataInputs(node, feedsSomethingReached);
        next.push(...nextFrom(node));
      }
      frontier = next;
    }

    chains.push({
      entry: clean(entry.title),
      entryId: entry.id,
      ...(entry.runsOn ? { runsOn: entry.runsOn } : {}),
      steps,
      // Now a statement about the rendered line rather than about how far the analysis got.
      truncated: steps.length > maxStepsPerChain,
      nodeIds: [...seenInChain],
    });
  }

  // Only what is genuinely unreached. A node that feeds a pin of something on a chain is that
  // step's input, not dead logic, and lumping the two together inverted the meaning of the most
  // important nodes in a graph: the conditions. Those are now named in the chain itself, and
  // excluded from this list, so what remains is what the list always claimed to be.
  const unreachableCounts = new Map<string, number>();
  for (const node of behavioural) {
    if (visited.has(node.id) || feedsSomethingReached.has(node.id)) continue;
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

/**
 * Where a chain RUNS, on the line that says what it does.
 *
 * This is the tool a model is told to read first, and it described a Server RPC exactly the way it
 * described an ordinary event: "StartVaccum -> Branch (Get isAlive) -> ...". Whether that chain is
 * server-only is not a detail of one node, it is the frame for every node after it - a Multicast
 * called from it reaches everyone, the same call from a client reaches nobody, and a variable
 * written on it needs replication to be seen anywhere else.
 *
 * Four characters on the chains that have it, nothing on the ones that do not.
 */
function runsOnTag(runsOn: string | undefined): string {
  if (runsOn === "server") return " [server]";
  if (runsOn === "all") return " [multicast]";
  if (runsOn === "owningClient") return " [owning client]";
  return "";
}

  // Filtered here, not in the traversal. `visited` is built from every chain, so narrowing the walk
  // would make the unreachable list wrong - it would report everything outside the filter as dead
  // logic, which is the worst possible way to answer a narrower question.
  const shownChains = needle
    ? chains.filter(
        (chain) =>
          chain.entry.toLowerCase().includes(needle) ||
          chain.steps.some((step) => step.toLowerCase().includes(needle))
      )
    : chains;
  const hiddenByMatch = chains.length - shownChains.length;

  const lines: string[] = [];
  lines.push(
    `${summary.graphName ?? "Graph"}: ${nodes.length} nodes, ${chains.length} entry point(s).` +
      // Said on the header line, because a filtered answer that does not admit it is filtered reads
      // as the whole graph - and the next question ("so nothing else touches this?") would then be
      // answered wrongly by silence.
      (hiddenByMatch > 0
        ? ` Showing the ${shownChains.length} that mention "${options.match}"; ${hiddenByMatch} other chain(s) not listed.`
        : "")
  );
  for (const chain of shownChains) {
    if (chain.steps.length === 0) {
      lines.push(`- ${chain.entry}${runsOnTag(chain.runsOn)}: nothing wired to it.`);
      continue;
    }
    const shownSteps = chain.steps.slice(0, maxStepsPerChain);
    lines.push(
      `- ${chain.entry}${runsOnTag(chain.runsOn)} -> ${shownSteps.join(" -> ")}` +
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
  // Suppressed when filtering. This list is about the WHOLE graph, and printed beneath a handful
  // of matched chains it reads as "these are the dead nodes of what you asked about" - which it
  // is not, and which would be a confident wrong answer rather than a smaller right one.
  if (!needle && unreachable.length > 0) {
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
