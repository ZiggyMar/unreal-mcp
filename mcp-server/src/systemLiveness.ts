/**
 * Which function graphs nothing in the project appears to call.
 *
 * This exists because of the two most expensive mistakes this project has made, which were the same
 * mistake twice: work done on a system that was replaced and left on the canvas.
 *
 * The first was a skin system - diagnosed, modified, and abandoned midway, because a newer system
 * had taken over and nothing said so. The second the audit produced by itself: it flagged three
 * PlayerControllers for not calling their parent's BeginPlay, at its second-highest cost, and
 * following that advice would have been wrong in all three. What that parent chain sets is
 * MyRootLayout - written once and read by nothing across 181 Blueprints - and the function that
 * would consume it has a single call site which is itself dead. A replaced UI system, reported as a
 * missing call.
 *
 * Nothing in the audit consulted reachability at all. A finding in dead code was ranked exactly like
 * a finding in the code that runs.
 *
 * The liveness rule is the same fixpoint the bridge uses for `trace_function_calls`:
 *
 *   - a graph containing an event can fire, so it is live,
 *   - a function graph is live if some live graph calls it,
 *   - repeat until nothing new becomes live.
 *
 * WHAT THIS IS NOT. The bridge computes the same thing from `FunctionReference.GetMemberName()`,
 * which is exact. All that is available here is a node's DISPLAY title, and Unreal inserts spaces
 * into those - a graph called `SetInput` shows up on a node as "Set Input". So names are compared
 * with everything but letters and digits removed, and the answer is deliberately biased toward
 * saying LIVE: a graph is only called dead when no node anywhere in the project resembles its name.
 * Reporting live code as dead would send someone to delete something that runs, which is far worse
 * than missing a dead graph.
 *
 * It costs no extra calls. The audit already reads every graph of every Blueprint.
 */

export interface LivenessGraph {
  blueprint: string;
  graphName: string;
  nodes: Array<{ title?: string; type?: string }>;
  /** The Blueprint's parent class. Used only to skip interfaces; see below. */
  parentClass?: string;
}

export interface LivenessResult {
  /** "Blueprint.Graph" for every function graph nothing appears to reach. */
  dead: Set<string>;
  /** Every graph considered, so a caller can tell "not dead" from "not looked at". */
  considered: number;
  /** Graphs that can fire on their own and therefore seed the walk. */
  entryPoints: number;
}

/** Comparable form of a name: letters and digits only, lowercased. */
function normalise(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export function graphKey(blueprint: string, graphName: string): string {
  return `${blueprint}.${graphName}`;
}

/**
 * A graph that can start on its own.
 *
 * Event nodes are the honest test rather than the graph's name: ubergraphs are called EventGraph,
 * EventGraph_1 and so on, and a function graph can be named anything. A construction script and an
 * interface implementation are also called by the engine rather than by a node, so anything that is
 * not plainly a function graph is treated as an entry - biased, again, toward live.
 */
function isEntryGraph(graph: LivenessGraph): boolean {
  if (/^EventGraph/i.test(graph.graphName)) return true;
  if (/^(UserConstructionScript|ConstructionScript)$/i.test(graph.graphName)) return true;
  // OnRep_ functions are called by replication, not by a node.
  if (/^OnRep_/i.test(graph.graphName)) return true;
  return (graph.nodes ?? []).some((n) => {
    const type = String(n.type ?? "");
    return /K2Node_(Custom)?Event/i.test(type) || /^Event\s/i.test(String(n.title ?? ""));
  });
}

export function findDeadGraphs(graphs: LivenessGraph[]): LivenessResult {
  // Animation Blueprints are excluded whole, and it is not a judgement call.
  //
  // Their graphs are EVALUATED by the animation system, not called by a node: AnimGraph itself, one
  // graph per state, and one per transition rule. On the project this was measured against,
  // ABP_NewPlayer alone contributed 25 of 219 - Locomotion, Idle, Jump, and eighteen graphs all
  // called Transition - and every one of them was wrong. Across three anim blueprints it was 37.
  //
  // Detected by the presence of an AnimGraph rather than by parentClass, because the parent is often
  // a project's own C++ anim instance and matching names would miss it. Only an animation Blueprint
  // has one.
  const animBlueprints = new Set(
    graphs.filter((g) => /^AnimGraph$/i.test(g.graphName)).map((g) => g.blueprint)
  );

  const byKey = new Map<string, LivenessGraph>();
  // Normalised graph name -> the keys of every graph with that name, anywhere. Matching across
  // Blueprints rather than within one is deliberate: a call in a child reaches a function on its
  // parent, and the display title carries no owner.
  const byName = new Map<string, string[]>();

  for (const graph of graphs) {
    const key = graphKey(graph.blueprint, graph.graphName);
    // An INTERFACE's own graphs are declarations, not code. Nothing calls them by name - the
    // implementing Blueprint's copy is what runs - so every one of them looks abandoned and none of
    // them is. On the project this was measured against they were pure noise at the top of the list.
    if (/^Interface$/i.test(String(graph.parentClass ?? ""))) continue;
    if (animBlueprints.has(graph.blueprint)) continue;
    byKey.set(key, graph);
    if (isEntryGraph(graph)) continue;
    const name = normalise(graph.graphName);
    if (!name) continue;
    const list = byName.get(name) ?? [];
    list.push(key);
    byName.set(name, list);
  }

  // Every name any node mentions, from anywhere. Built once rather than per graph, because the
  // question "does anything at all call this" does not depend on where the call is.
  const calledFromLive = new Map<string, string[]>();
  for (const graph of graphs) {
    const key = graphKey(graph.blueprint, graph.graphName);
    const mentioned = new Set<string>();
    for (const node of graph.nodes ?? []) {
      const title = normalise(String(node.title ?? ""));
      if (title) mentioned.add(title);
    }
    calledFromLive.set(key, [...mentioned]);
  }

  const live = new Set<string>();
  for (const graph of graphs) {
    if (isEntryGraph(graph)) live.add(graphKey(graph.blueprint, graph.graphName));
  }
  const entryPoints = live.size;

  // Fixpoint. Bounded because `live` only grows and every round that adds nothing stops it.
  let grew = true;
  while (grew) {
    grew = false;
    for (const key of [...live]) {
      for (const mention of calledFromLive.get(key) ?? []) {
        for (const target of byName.get(mention) ?? []) {
          if (!live.has(target)) {
            live.add(target);
            grew = true;
          }
        }
      }
    }
  }

  const dead = new Set<string>();
  for (const key of byKey.keys()) {
    if (!live.has(key)) dead.add(key);
  }
  return { dead, considered: byKey.size, entryPoints };
}
