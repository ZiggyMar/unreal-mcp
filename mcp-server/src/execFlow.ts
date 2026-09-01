/**
 * Following execution through a Blueprint graph, including the wires that are not nodes.
 *
 * This lived in three copies - the graph reader, the quality checks, the authority guard - and all
 * three had the same hole, so it lives here once now.
 *
 * ## The hole
 *
 * Execution enters through a pin called execute / exec / in / then. Matching on the RECEIVING pin
 * is deliberate: enumerating every possible exec OUTPUT name breaks on the first node type nobody
 * thought of, and plugins add those constantly.
 *
 * A reroute node breaks it anyway. `K2Node_Knot` - the little dot you get from double-clicking a
 * wire, which is how anybody tidies a large graph - has pins named `InputPin` and `OutputPin`. It
 * matched nothing, so every chain that passed through one stopped dead, and everything downstream
 * was reported as dead logic. The tidier the Blueprint, the more of it disappeared.
 *
 * Found in a shipping game: a multicast event that pushes health to every client read as "nothing
 * wired to it", because the author had routed the wire around a comment box.
 *
 * ## Why knots are stepped over rather than followed
 *
 * A knot is a wire, not behaviour. Reporting it as a step would put "Reroute Node" in the middle of
 * a description of what a graph does, which is noise. So a knot is resolved to whatever it
 * eventually reaches, through as many chained knots as the author drew.
 *
 * Knots carry data as well as execution, and there is no flag saying which. The rule that settles
 * it: follow a knot only if the far end lands on an exec pin. A data knot's far end lands on
 * something like `Value`, and is correctly ignored.
 */

export interface FlowPin {
  pin: string;
  direction: string;
  linkedTo?: Array<{ node: string; pin: string }>;
}

export interface FlowNode {
  id: string;
  type: string;
  title?: string;
  connectedPins?: FlowPin[];
}

export const EXEC_INPUT = /^(execute|exec|in|then)$/i;

/**
 * Exec input pins that are NOT called "execute".
 *
 * Four names covered every node anyone had looked at, and a Timeline has none of them: its exec
 * inputs are Play, PlayFromStart, Stop, Reverse, ReverseFromEnd and SetNewTime. So every execution
 * wire INTO a timeline was invisible, and the consequences were not cosmetic:
 *
 *   - explain_graph reported "VacuumPushedMC [multicast]: nothing wired to it" for an event whose
 *     `then` goes straight into TL_VacuumPushed.PlayFromStart. Live logic, described as dead.
 *   - audit.ts builds liveNodeIds from these same chains, so everything downstream of a timeline
 *     was a dead-node finding.
 *
 * That is the failure this file's own traversal comment calls the worst possible one for a tool
 * whose job is to say what is wrong, arriving by a different door.
 *
 * Matched per node TYPE rather than by name alone, because "Play" and "Reset" are perfectly ordinary
 * names for a bool input on some other node, and a data pin counted as execution would invent a
 * chain that does not run.
 */
const TIMELINE_EXEC_INPUT = /^(play|playfromstart|stop|reverse|reversefromend|setnewtime)$/i;

/** Gate has Enter/Open/Close/Toggle; DoOnce and MultiGate have Reset. All are macro instances. */
const MACRO_EXEC_INPUT = /^(enter|open|close|toggle|reset)$/i;

/** Types arrive with or without the K2Node_ prefix depending on whether a reply has been compacted. */
function isType(node: { type?: string } | undefined, bare: string): boolean {
  const t = node?.type ?? "";
  return t === bare || t === `K2Node_${bare}`;
}

/** Does `pinName` name an execution input on `target`? */
export function isExecInput(target: { type?: string } | undefined, pinName: string): boolean {
  if (EXEC_INPUT.test(pinName)) return true;
  if (isType(target, "Timeline")) return TIMELINE_EXEC_INPUT.test(pinName);
  if (isType(target, "MacroInstance")) return MACRO_EXEC_INPUT.test(pinName);
  return false;
}

export const isKnot = (node: FlowNode | undefined): boolean => node?.type === "K2Node_Knot";

/**
 * The nodes execution reaches from `node`, with reroute nodes stepped over.
 *
 * `seen` guards against a knot wired in a circle, which the editor allows and which would otherwise
 * hang the traversal.
 */
export function execTargets<T extends FlowNode>(node: T, byId: Map<string, T>, seen = new Set<string>()): T[] {
  const out: T[] = [];
  for (const pin of node.connectedPins ?? []) {
    if (pin.direction !== "out") continue;
    for (const link of pin.linkedTo ?? []) {
      const target = byId.get(link.node);
      if (!target) continue;
      if (isKnot(target)) {
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        // Step over the wire and take whatever is on the other side of it.
        out.push(...execTargets(target, byId, seen));
        continue;
      }
      if (!isExecInput(target, link.pin)) continue;
      out.push(target);
    }
  }
  return out;
}

/**
 * Which nodes execution reaches `node` FROM, with reroutes stepped over. Used when inserting a
 * guard, where the question is what to reroute.
 */
export function execSources<T extends FlowNode>(
  targetId: string,
  nodes: T[],
  byId: Map<string, T>
): Array<{ fromNode: string; fromPin: string }> {
  const found: Array<{ fromNode: string; fromPin: string }> = [];
  for (const node of nodes) {
    if (isKnot(node)) continue; // a wire is never the thing to reroute; its source is
    for (const pin of node.connectedPins ?? []) {
      if (pin.direction !== "out") continue;
      for (const link of pin.linkedTo ?? []) {
        const direct = link.node === targetId && isExecInput(byId.get(link.node), link.pin);
        const viaKnot =
          isKnot(byId.get(link.node)) &&
          execTargets(byId.get(link.node) as T, byId).some((t) => t.id === targetId);
        if (direct || viaKnot) found.push({ fromNode: node.id, fromPin: pin.pin });
      }
    }
  }
  return found;
}
