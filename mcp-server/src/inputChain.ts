/**
 * "I pressed the key and nothing happened. Why?"
 *
 * A press that does nothing is the most common runtime dead end, and the honest answer used to stop
 * at a shrug: either the input is not reaching the game, or the thing it triggers needs something
 * that is not there. True, and it leaves the caller to open the graph and walk branches by hand.
 *
 * That hand-walk happened three times in one session on one ability - holding the vacuum did
 * nothing, and finding out why meant reading the input node, following exec pins, reading each
 * Branch, and chasing what fed its condition, one call at a time. Every step of that is mechanical,
 * which is the definition of something a tool should do.
 *
 * So when a press moves nothing, the chain between the input and the end is walked and every gate on
 * it is named, along with what its condition reads. The caller then has something to watch rather
 * than something to guess at.
 *
 * Pure on purpose: the walking is the part with the bugs, and it is tested against node shapes
 * rather than against a running editor.
 */

/** A node as unreal_read_node_detail returns it. Only the fields the walk needs. */
export interface ChainNode {
  id: string;
  type: string;
  title?: string;
  pins?: Array<{
    name: string;
    direction: string;
    category?: string;
    linkedTo?: Array<{ node: string; pin: string }>;
  }>;
}

export interface Gate {
  /** The branch node, so a caller can go straight to it. */
  nodeId: string;
  /** What decides it, in the words the graph uses - "Get isAlive", "Has Authority", "Can Aim". */
  reads: string;
  /** How far along the chain it sits, counting from the input node. */
  step: number;
}

/** First line only: node titles carry the target class on a second line, which is noise here. */
const firstLine = (title: string | undefined): string => (title ?? "").split("\n")[0].trim();

/**
 * A name with the spacing and case taken out, for matching a CALL to the EVENT it calls.
 *
 * The editor writes a call node's title as a display name - "Start Vaccum" - while the event is
 * named StartVaccum. Matching them literally fails on every real graph, which is how the first
 * version found no gates on a chain with two while its own unit test passed: the test used the same
 * spelling on both sides, and no project does.
 */
const loose = (name: string): string => name.replace(/[\s_]+/g, "").toLowerCase();

/**
 * Walk the execution chain from `startId`, naming every Branch on it and what its condition reads.
 *
 * Only the `then` path is followed. A Branch's `else` is the path taken when the gate FAILS, and
 * following both would report the chain that runs when the ability does not - which is the opposite
 * of the question being asked.
 */
export interface WalkResult {
  gates: Gate[];
  /**
   * The node the walk wanted next and did not have.
   *
   * The caller reads nodes over a wire and cannot read the whole graph, so the walk will run out.
   * Saying WHERE turns that into one more targeted read instead of a guess: the first attempt at
   * this read a large arbitrary slice of the graph and still stopped one node short, reporting one
   * gate on a chain with two - and the gate it named was true, so the report exonerated the thing
   * that was actually stopping it.
   */
  needs?: string;
}

/** Convenience for callers that already hold the whole graph and only want the gates. */
export function gatesAlongChain(
  startId: string,
  nodesById: Map<string, ChainNode>,
  maxSteps = 40,
  eventEntries: Map<string, string> = new Map()
): Gate[] {
  return walkChain(startId, nodesById, maxSteps, eventEntries).gates;
}

export function walkChain(
  startId: string,
  nodesById: Map<string, ChainNode>,
  maxSteps = 40,
  /**
   * Custom event name -> the id of that event's node, so a CALL can be followed into the body.
   *
   * Without this the walk stops at the call and finds nothing, which is exactly wrong for the case
   * that matters: an ability's gates almost always live inside a server RPC, not in the input chain
   * that asks for it. Pressing the vacuum calls StartVaccum, and `isAlive` and `Can Aim` are inside
   * StartVaccum - so the first version reported "no gates" about a chain with two.
   */
  eventEntries: Map<string, string> = new Map()
): WalkResult {
  const gates: Gate[] = [];
  const seen = new Set<string>();
  let current: string | undefined = startId;

  for (let step = 0; current && step < maxSteps; step++) {
    if (seen.has(current)) {
      // A loop in the exec graph. Rare, but a Sequence feeding back would hang the walk.
      break;
    }
    seen.add(current);
    const node: ChainNode | undefined = nodesById.get(current);
    if (!node) {
      // Ran out of graph rather than out of chain. Say which node was wanted.
      return { gates, needs: current };
    }

    // A call to a custom event in this graph continues INTO it. Calling an event does not link to
    // its body in the exec graph - the body is its own entry point - so following the link alone
    // walks past the gates rather than through them.
    if (node.type === "K2Node_CallFunction") {
      const wanted = loose(firstLine(node.title));
      let target: string | undefined;
      for (const [name, id] of eventEntries) {
        if (loose(name) === wanted) {
          target = id;
          break;
        }
      }
      if (target && !seen.has(target)) {
        if (!nodesById.has(target)) {
          return { gates, needs: target };
        }
        current = target;
        continue;
      }
    }

    if (node.type === "K2Node_IfThenElse") {
      const condition = (node.pins ?? []).find((p) => p.name === "Condition" && p.direction === "in");
      const source = condition?.linkedTo?.[0];
      const sourceNode = source ? nodesById.get(source.node) : undefined;
      gates.push({
        nodeId: node.id,
        // The condition's own node title is the readable answer: "Get isAlive", "Has Authority".
        // Falling back to the pin name keeps the gate reported even when its source was not read.
        reads: sourceNode ? firstLine(sourceNode.title) : source ? source.pin : "an unread condition",
        step,
      });
    }

    // `then` on a Branch, `then` on a call, `Then 0` on a Sequence: the first exec output that
    // goes anywhere is the path the ability takes when its gate passes.
    const next = (node.pins ?? []).find(
      (p) => p.direction === "out" && p.category === "exec" && p.name !== "else" && (p.linkedTo ?? []).length > 0
    );
    current = next?.linkedTo?.[0]?.node;
  }

  return { gates };
}

/**
 * The sentence a caller reads when their press did nothing.
 *
 * Names the gates in order, because order is the whole point: the first one that is false is the
 * one that stopped it, and the ones after it were never reached.
 */
export function describeGates(inputAction: string, gates: Gate[]): string | undefined {
  if (gates.length === 0) {
    return undefined;
  }
  const named = gates.map((g) => g.reads).filter((r, i, all) => all.indexOf(r) === i);
  return (
    `"${inputAction}" runs through ${gates.length} gate(s) before anything happens: ${named.join(" -> ")}. ` +
    `Watch those with unreal_verify_runtime - the FIRST one that is false is the one that stopped it, ` +
    `and everything after it never ran.`
  );
}
