/**
 * "When X happens, do these things" — without the caller ever naming a pin.
 *
 * Benchmarking a local 7B found the exact boundary where a cheap model stops working: it creates
 * assets and adds variables reliably, and then fails to wire a graph. Not because it lacks the
 * concept — it knows an event should lead to a print — but because `build_graph` asks it to get
 * node refs, execution pin names, and a nested JSON shape all correct in one shot, and any one of
 * those going wrong fails the whole call.
 *
 * That is a tooling problem, not a model problem. The sequence is the *only* thing the caller
 * actually knows and the only thing worth asking for:
 *
 *     event "BeginPlay" -> [ PrintString("hello"), DestroyActor() ]
 *
 * so this takes exactly that and does the rest: places the event, places each call, chains the
 * execution pins in order, applies parameter defaults, and compiles. There is no pin name, no ref,
 * and no connection array in the input, which means there is nothing in the input to get wrong.
 *
 * Deliberately narrow: a linear chain off one event. Branches, loops and data wiring still need
 * `build_graph`, and pretending otherwise would produce a tool that half-works on the cases people
 * care most about. A stronger model can use `build_graph` directly; this exists so a weaker one is
 * not stuck at the first graph it tries to build.
 */

import type { BridgeLike } from "./autoLayout.js";
import type { BuildGraphResult, FindNodeResult } from "./types.js";

export interface HandlerAction {
  /** Function to call, e.g. "PrintString". Resolved against the live engine if the class is unknown. */
  function: string;
  /** Owning class, e.g. "KismetSystemLibrary". Looked up when omitted. */
  className?: string;
  /** Values for the call's input pins, by pin name. Near-miss names are resolved by the bridge. */
  params?: Record<string, string>;
}

export interface EventHandlerOptions {
  /** Compile afterwards. Defaults to true. */
  compile?: boolean;
}

export interface EventHandlerResult {
  path: string;
  graphName: string;
  event: string;
  actionsPlaced: number;
  nodeIds: Record<string, string>;
  resolvedFunctions: Array<{ requested: string; usedClass: string }>;
  compiled?: unknown;
  pinNamesCorrected?: string[];
  note: string;
}

/** Events that are overridable engine events rather than custom ones the caller invents. */
const KNOWN_EVENTS: Record<string, string> = {
  beginplay: "ReceiveBeginPlay",
  begin_play: "ReceiveBeginPlay",
  receivebeginplay: "ReceiveBeginPlay",
  tick: "ReceiveTick",
  receivetick: "ReceiveTick",
  destroyed: "ReceiveDestroyed",
  actorbeginoverlap: "ReceiveActorBeginOverlap",
  beginoverlap: "ReceiveActorBeginOverlap",
  actorendoverlap: "ReceiveActorEndOverlap",
  endoverlap: "ReceiveActorEndOverlap",
  hit: "ReceiveHit",
};

function normalise(name: string): string {
  return name.toLowerCase().replace(/[\s_]/g, "");
}

/**
 * Work out whether this is an engine event or a custom one, and what the engine calls it.
 * A caller saying "BeginPlay" means ReceiveBeginPlay; a caller saying "OnPickedUp" means a custom
 * event. Making them say which is asking them to know something they have no reason to know.
 */
export function resolveEvent(event: string): { nodeType: "Event" | "CustomEvent"; eventName: string } {
  const known = KNOWN_EVENTS[normalise(event)];
  if (known) return { nodeType: "Event", eventName: known };
  return { nodeType: "CustomEvent", eventName: event };
}

export async function addEventHandler(
  bridge: BridgeLike,
  path: string,
  graphName: string,
  event: string,
  actions: HandlerAction[],
  options: EventHandlerOptions = {}
): Promise<EventHandlerResult> {
  if (actions.length === 0) {
    throw new Error("no actions given: an event handler that does nothing is not worth building");
  }

  const { nodeType, eventName } = resolveEvent(event);
  const resolvedFunctions: Array<{ requested: string; usedClass: string }> = [];

  // Resolve every function against the live engine BEFORE building anything, so a wrong name fails
  // the call rather than leaving half a handler in the graph.
  const resolvedActions: Array<HandlerAction & { className: string }> = [];
  for (const action of actions) {
    let className = action.className;
    if (!className) {
      const found = await bridge.send<FindNodeResult>("find_node", { query: action.function, maxResults: 10 });
      const exact = (found.hits ?? []).find((hit) => hit.functionName === action.function);
      if (!exact) {
        const near = (found.hits ?? []).slice(0, 3).map((h) => h.functionName);
        throw new Error(
          `function_not_found: "${action.function}" is not in this engine's catalog.` +
            (near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "")
        );
      }
      // The catalog reports a full path; the node builder wants the short class name.
      className = exact.className.split(/[./]/).pop() ?? exact.className;
    }
    resolvedFunctions.push({ requested: action.function, usedClass: className });
    resolvedActions.push({ ...action, className });
  }

  // Build the whole chain in one atomic call: if any part fails, nothing lands.
  const nodes: Array<Record<string, unknown>> = [{ ref: "evt", nodeType, eventName }];
  const connections: Array<{ from: string; to: string }> = [];
  const pinDefaults: Array<{ node: string; pin: string; value: string }> = [];

  resolvedActions.forEach((action, index) => {
    const ref = `a${index}`;
    nodes.push({ ref, nodeType: "CallFunction", functionName: action.function, className: action.className });
    // Chain execution: the event into the first action, then each action into the next. This is
    // the part the caller would otherwise have to get right, and the part they most often do not.
    const previous = index === 0 ? "evt" : `a${index - 1}`;
    connections.push({ from: `${previous}.then`, to: `${ref}.execute` });
    for (const [pin, value] of Object.entries(action.params ?? {})) {
      pinDefaults.push({ node: ref, pin, value: String(value) });
    }
  });

  const result = await bridge.send<BuildGraphResult & { pinNamesCorrected?: string[] }>("build_graph", {
    path,
    graphName,
    nodes,
    connections,
    pinDefaults,
    compile: options.compile !== false,
  });

  const nodeIds: Record<string, string> = {};
  for (const [ref, info] of Object.entries(result.nodes ?? {})) {
    nodeIds[ref] = typeof info === "string" ? info : (info as { id: string }).id;
  }

  return {
    path,
    graphName,
    event: eventName,
    actionsPlaced: resolvedActions.length,
    nodeIds,
    resolvedFunctions,
    compiled: result.compile,
    pinNamesCorrected: result.pinNamesCorrected,
    note:
      "The execution chain was wired for you in the order given. For branches, loops, or wiring one " +
      "node's output into another's input, use unreal_build_graph.",
  };
}
