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
  /**
   * Where the dead graphs are concentrated, worst first.
   *
   * The useful unit is the Blueprint, not the graph. "GS_Gameplay.ShowCountdown" is a name;
   * "GS_Gameplay: 15 of 26 uncalled" is a system that was replaced, and the second is what somebody
   * acts on. A ratio also carries its own confidence: one uncalled helper in forty is ordinary
   * housekeeping, and fifteen in twenty-six is not.
   */
  byBlueprint: Array<{ blueprint: string; dead: number; of: number }>;
  /**
   * DELIBERATELY ABSENT: "the same function name is dead in several Blueprints".
   *
   * It was built, measured, and removed. The idea was that one name dead in several places names a
   * replaced FEATURE rather than a graph, and on this project two entries did exactly that -
   * CountdownUpdated and PlayerJoined, each uncalled across GM_Gameplay, GM_TutGameplay, GS_Gameplay
   * and GS_TutGameplay.
   *
   * The other four were engine-called overrides. BP_GetDesiredFocusTarget appeared in eleven
   * unrelated widgets, GetPrimaryGamepadFocusWidget in five, GetPressProgress in four: all CommonUI
   * virtuals, invoked by the framework and never by a node. There is no way from a graph name to
   * tell a C++ override from an abandoned function, so the signal was mostly noise presented as the
   * strongest thing in the reply, which is the worst combination available.
   *
   * The per-Blueprint ratio below already surfaces what the good entries pointed at: GS_Gameplay and
   * GS_TutGameplay are near the top of it on their own.
   */
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

  // Interface FUNCTION NAMES, gathered from the interface Blueprints before they are skipped.
  //
  // An implementation lives in the implementing Blueprint and is invoked by interface dispatch, so
  // no node anywhere calls it by name and every implementation of every interface looked abandoned.
  // Measured: EnemyScalePriority was flagged in five gameplay Blueprints at once and is declared by
  // an interface in all five. Any graph whose name an interface declares is left alone.
  const interfaceFunctions = new Set(
    graphs
      .filter((g) => /^Interface$/i.test(String(g.parentClass ?? "")))
      .map((g) => normalise(g.graphName))
      .filter(Boolean)
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
    if (interfaceFunctions.has(normalise(graph.graphName))) continue;
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

  const deadPerBlueprint = new Map<string, number>();
  const totalPerBlueprint = new Map<string, number>();
  for (const key of byKey.keys()) {
    const blueprint = byKey.get(key)!.blueprint;
    totalPerBlueprint.set(blueprint, (totalPerBlueprint.get(blueprint) ?? 0) + 1);
    if (dead.has(key)) deadPerBlueprint.set(blueprint, (deadPerBlueprint.get(blueprint) ?? 0) + 1);
  }
  // Below this many graphs a proportion is noise rather than a signal.
  //
  // Sorting purely by ratio put "W_ExperienceList: 3 of 4" and "W_ChangeLog_Item: 2 of 3" at the top
  // of the real project - Lyra sample widgets whose handful of graphs are CommonUI overrides the
  // framework calls and no node does. Three quarters of four graphs is not evidence of anything.
  // With the floor in place the list is GS_TutGameplay 13 of 19, GS_Gameplay 15 of 26, WBP_HUD 8 of
  // 14: actual systems, in the project's own code.
  const ENOUGH_GRAPHS_TO_MEAN_SOMETHING = 8;

  const byBlueprint = [...deadPerBlueprint.entries()]
    .map(([blueprint, n]) => ({ blueprint, dead: n, of: totalPerBlueprint.get(blueprint) ?? n }))
    .filter((b) => b.of >= ENOUGH_GRAPHS_TO_MEAN_SOMETHING)
    // By proportion, then by count. A Blueprint that is mostly dead is a replaced system; a big one
    // with a few strays is just a big one, and sorting on the raw count puts the big ones on top.
    .sort((a, b) => b.dead / b.of - a.dead / a.of || b.dead - a.dead);

  return { dead, considered: byKey.size, entryPoints, byBlueprint };
}
