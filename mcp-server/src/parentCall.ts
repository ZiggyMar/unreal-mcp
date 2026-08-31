/**
 * Call the parent's version of an overridden event, first, without disturbing what already runs.
 *
 * This is the mechanical half of `parent-event-not-called`, the second most expensive finding this
 * project makes. Adding an event to a child Blueprint REPLACES the parent's rather than extending
 * it, and nothing anywhere warns: the parent's BeginPlay simply never happens, the Blueprint
 * compiles clean, and the symptom shows up somewhere else entirely.
 *
 * The audit already found it and already said what to do - "unreal_add_node with nodeType CallParent,
 * then wire it as the first thing this event runs". Two steps, and the second one is where it goes
 * wrong. "First" is not "append": the event's exec output already points at something, and an exec
 * output can hold exactly one link, so connecting the parent call to it silently displaces whatever
 * was there. Done naively the graph ends up running ONLY the parent call and nothing else, which is
 * a worse bug than the one being fixed and looks like a successful edit.
 *
 *     before:   Event BeginPlay ------------------> DoTheThing -> ...
 *     after:    Event BeginPlay -> Parent: BeginPlay -> DoTheThing -> ...
 *
 * So this is one call that knows the shape, the same argument `guardWithAuthority` makes for itself:
 * a general "insert a node" tool has to be told how to wire, and getting that wrong rearranges
 * somebody's graph quietly.
 *
 * Everything it uses - read the graph, add a node, connect two pins, compile - are commands the
 * bridge has had for a long time. Nothing here needs a plugin rebuild.
 */

import type { BridgeLike } from "./autoLayout.js";
import { execTargets, isKnot } from "./execFlow.js";

export interface ParentCallOptions {
  /** Report the exact edit without making it. */
  dryRun?: boolean;
  /** Compile afterwards to prove the graph still builds. Defaults to true. */
  compile?: boolean;
}

export interface ParentCallResult {
  path: string;
  graphName: string;
  functionName: string;
  eventNodeId?: string;
  eventTitle?: string;
  dryRun: boolean;
  /** Already there - nothing was changed, and that is a success, not a failure. */
  alreadyPresent: boolean;
  added: boolean;
  /** What the event used to run into, and now runs into second. */
  displaced?: { node: string; title: string };
  /**
   * The parent call was already in the graph and nothing ran it, so it was wired rather than
   * duplicated. Common: creating an override event adds the node, and the next thing to touch the
   * event's exec pin displaces it.
   */
  wasOrphaned?: boolean;
  errorsBefore?: number;
  errorsAfter?: number;
  introducedErrors?: boolean;
  verified: boolean;
  summary: string;
  next?: string;
}

interface SummaryNode {
  id: string;
  type: string;
  title: string;
  connectedPins?: Array<{ pin: string; direction: string; linkedTo?: Array<{ node: string; pin: string }> }>;
}

/** The exec output of an event node. K2 spells it "then"; a few nodes use "exec". */
const EXEC_OUTPUT = /^(then|exec)$/i;

/**
 * Does this node look like the override of `functionName`?
 *
 * Titles arrive as the editor renders them - "Event BeginPlay", "Event Tick" - and the function is
 * given as a person writes it. Compared on letters and digits only, because the editor inserts
 * spaces into names that do not have them, which is the same normalisation the dead-graph pass needs
 * for the same reason.
 */
function looksLikeEventFor(node: SummaryNode, functionName: string): boolean {
  if (!/^K2Node_(Event|CustomEvent)$/.test(node.type)) return false;
  const bare = functionName.replace(/^Receive/i, "");
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return flat(node.title).endsWith(flat(bare));
}

/** Is there already a Parent: <fn> call in this graph? */
function existingParentCall(nodes: SummaryNode[], functionName: string): SummaryNode | undefined {
  const bare = functionName.replace(/^Receive/i, "");
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return nodes.find(
    (n) => n.type === "K2Node_CallParentFunction" && flat(n.title).includes(flat(bare))
  );
}

/** Every node execution reaches from here, following exec links through reroutes. */
function chainFrom(start: SummaryNode, byId: Map<string, SummaryNode>): SummaryNode[] {
  const out: SummaryNode[] = [];
  const seen = new Set<string>([start.id]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: SummaryNode[] = [];
    for (const node of frontier) {
      for (const target of execTargets(node, byId)) {
        if (seen.has(target.id)) continue;
        seen.add(target.id);
        out.push(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return out;
}

async function compileErrorCount(bridge: BridgeLike, path: string): Promise<number | undefined> {
  try {
    const result = await bridge.send<{ errors?: unknown[] }>("compile_blueprint", { path });
    return Array.isArray(result.errors) ? result.errors.length : 0;
  } catch {
    return undefined;
  }
}

export async function callParentFirst(
  bridge: BridgeLike,
  path: string,
  graphName: string,
  functionName: string,
  options: ParentCallOptions = {}
): Promise<ParentCallResult> {
  const dryRun = options.dryRun === true;

  const summary = await bridge.send<{ nodes: SummaryNode[] }>("read_blueprint_graph_summary", {
    path,
    graphName,
  });
  const nodes = summary.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const event = nodes.find((n) => looksLikeEventFor(n, functionName));
  if (!event) {
    const events = nodes.filter((n) => /^K2Node_(Event|CustomEvent)$/.test(n.type)).map((n) => n.title);
    throw new Error(
      `event_not_found: ${graphName} has no event that looks like an override of "${functionName}". ` +
        (events.length > 0
          ? `Events in this graph: ${events.join(", ")}.`
          : `This graph has no event nodes at all - a parent call belongs in the graph that overrides the event.`)
    );
  }

  // Is a parent call already RUNNING, as opposed to merely present?
  //
  // The first version of this asked only whether the node existed, and a trial caught it saying
  // "already calls the parent" about a graph that read:
  //
  //     Event BeginPlay -> Print String -> Print String        (Parent: BeginPlay, orphaned)
  //
  // Creating an override event in a child makes the editor add the parent call for you, and then
  // anything that wires the event's `then` to something else displaces it - which is the very bug
  // this tool exists to fix, and the trial's own setup did it by accident. A node that exists and is
  // never reached does nothing at all. Presence is not effect, and a check that confuses the two
  // reports the bug as already fixed.
  const existing = existingParentCall(nodes, functionName);
  const reachedNow = existing ? chainFrom(event, byId).some((n) => n.id === existing.id) : false;

  if (existing && reachedNow) {
    // Genuinely done. Running this twice is safe, and a caller acting on a stale audit should be
    // told the work is finished rather than given a second node that runs the parent twice.
    return {
      path,
      graphName,
      functionName,
      eventNodeId: event.id,
      eventTitle: event.title,
      dryRun,
      alreadyPresent: true,
      added: false,
      verified: true,
      summary: `${graphName} already runs the parent's ${functionName} ("${existing.title}"). Nothing changed.`,
    };
  }

  // What the event runs into today. That link is what has to be preserved, and it is the whole
  // reason this is a tool rather than two calls.
  const currentTargets = execTargets(event, byId);
  const displacedNode = currentTargets.find((n) => !isKnot(n));

  const result: ParentCallResult = {
    path,
    graphName,
    functionName,
    eventNodeId: event.id,
    eventTitle: event.title,
    dryRun,
    alreadyPresent: false,
    added: false,
    verified: false,
    ...(displacedNode ? { displaced: { node: displacedNode.id, title: displacedNode.title } } : {}),
    summary: "",
  };

  if (dryRun) {
    // Says WIRE when the node is already there, because "would add" would be a description of a
    // different edit than the one about to happen - and a dry run whose wording does not match the
    // real thing is worse than no dry run.
    const act = existing ? "Would wire the existing" : "Would add";
    result.wasOrphaned = existing ? true : undefined;
    result.summary = displacedNode
      ? `${act} "Parent: ${functionName}" and run it between ${event.title} and ${displacedNode.title}.`
      : `${act} "Parent: ${functionName}" as the only thing ${event.title} runs.`;
    return result;
  }

  const errorsBefore = options.compile === false ? undefined : await compileErrorCount(bridge, path);

  let parentId: string | undefined;
  if (existing) {
    // It is there, just orphaned. Wire that one - adding a second would leave the graph with a node
    // nothing runs AND a node that does, which is worse than what it started with.
    parentId = existing.id;
    result.wasOrphaned = true;
  } else {
    const created = await bridge.send<{ id?: string; nodeId?: string }>("add_node", {
      path,
      graphName,
      nodeType: "CallParent",
      functionName,
      // Beside the event rather than at the origin, so the graph is readable before
      // auto_layout_graph ever runs. A node landing on top of another is a tax on every later reader.
      x: 300,
      y: 0,
    });
    parentId = created.id ?? created.nodeId;
  }
  if (!parentId) {
    throw new Error(`no node id for the CallParent node in ${graphName}`);
  }

  // Order matters. Wire the parent call to the old target FIRST: if the second connection fails, the
  // graph still has the original chain reachable from the parent node rather than orphaned.
  if (displacedNode) {
    await bridge.send("connect_pins", {
      path,
      graphName,
      sourceNodeId: parentId,
      sourcePin: "then",
      targetNodeId: displacedNode.id,
      targetPin: "execute",
    });
  }

  await bridge.send("connect_pins", {
    path,
    graphName,
    sourceNodeId: event.id,
    sourcePin: "then",
    targetNodeId: parentId,
    targetPin: "execute",
  });

  result.added = true;

  const errorsAfter = options.compile === false ? undefined : await compileErrorCount(bridge, path);
  result.errorsBefore = errorsBefore;
  result.errorsAfter = errorsAfter;
  if (errorsBefore !== undefined && errorsAfter !== undefined) {
    // "It compiles" is not the claim. "It is no worse than before this edit" is, because a Blueprint
    // that was already failing would otherwise make every edit look like the one that broke it.
    result.introducedErrors = errorsAfter > errorsBefore;
  }

  // Re-read and check the wire actually landed. An edit tool that reports success without looking is
  // how a working project gets broken quietly.
  const after = await bridge.send<{ nodes: SummaryNode[] }>("read_blueprint_graph_summary", {
    path,
    graphName,
  });
  const afterNodes = after.nodes ?? [];
  const afterById = new Map(afterNodes.map((n) => [n.id, n]));
  const afterEvent = afterById.get(event.id);
  const reachedFirst = afterEvent ? execTargets(afterEvent, afterById).some((n) => n.id === parentId) : false;
  result.verified = reachedFirst && result.introducedErrors !== true;

  const verb = result.wasOrphaned ? "now runs the Parent: " : "now runs Parent: ";
  result.summary = reachedFirst
    ? displacedNode
      ? `${event.title} ${verb}${functionName} first, then ${displacedNode.title}.` +
        (result.wasOrphaned ? " The node was already in the graph with nothing running it." : "")
      : `${event.title} ${verb}${functionName}.` +
        (result.wasOrphaned ? " The node was already in the graph with nothing running it." : "")
    : `The node was added but ${event.title} does not reach it. The graph has been left as it is - read it before editing further.`;

  if (!reachedFirst) {
    result.next =
      "unreal_read_blueprint_summary on this graph will show where the node ended up. Nothing was rolled back, " +
      "because a half-rewired chain is worse than one extra unconnected node.";
  } else if (result.introducedErrors) {
    result.next = `This edit added compile errors (${errorsBefore} -> ${errorsAfter}). Read them with unreal_compile_blueprint.`;
  }

  return result;
}

export { EXEC_OUTPUT };
