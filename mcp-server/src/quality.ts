/**
 * Blueprint quality review.
 *
 * The premise of this file: a weak model does not fail because it lacks capability, it fails
 * because it has no feedback. It writes a graph, nothing objects, and it declares victory. A
 * strong model has the same problem in a smaller way. Compilation is the only signal either of
 * them gets, and compilation is a very low bar: a graph full of dead nodes, unhandled cast
 * failures, and leftover debug prints compiles perfectly.
 *
 * So this is the missing signal. Every check below is something a senior Unreal developer would
 * actually flag in review, computed from a single cheap graph read, and reported with the exact
 * fix. A model that runs it can self-correct; a model that never runs it still gets the findings,
 * because unreal_build_graph attaches them to its own result.
 *
 * Every check is deliberately conservative. A false positive teaches a model to distrust the
 * whole report, which is worse than a missed finding.
 */

import { execTargets as followExec } from "./execFlow.js";
import type { LayoutNode } from "./layout.js";
import { groupIntoChains, isEventNode } from "./layout.js";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  /** Stable machine-readable id, so a caller can suppress or count a category. */
  check: string;
  severity: Severity;
  /** What is wrong, in one sentence. */
  message: string;
  /** What to do about it, concretely enough to act on without further thought. */
  fix: string;
  /** Node ids this finding is about, so the caller can go straight there. */
  nodeIds: string[];
}

export interface QualityReport {
  graphName: string;
  nodeCount: number;
  /** 0-100 heuristic: 100 minus 8 per error, 4 per warning, 1 per info. Not a measure of correctness. */
  score: number;
  summary: { errors: number; warnings: number; infos: number };
  findings: Finding[];
}

/** Node counts above this in one graph are a structure problem, not a style preference. */
const GRAPH_TOO_LARGE = 60;
/** A single execution chain longer than this should be a function with a name. */
const CHAIN_TOO_LONG = 20;
/** An Event Tick chain longer than this is doing real per-frame work and deserves a second look. */
const TICK_CHAIN_HEAVY = 6;

const PLACEHOLDER_NAME = /^(new ?var|var|variable|temp|tmp|test|untitled|foo|bar|baz|thing|stuff|data|value)\s*\d*$/i;

function isComment(node: LayoutNode): boolean {
  return node.type === "EdGraphNode_Comment" || node.type.endsWith("_Comment");
}

function connectedPinNames(node: LayoutNode): Set<string> {
  return new Set((node.connectedPins ?? []).map((pin) => pin.pin.trim().toLowerCase()));
}

function hasAnyConnection(node: LayoutNode): boolean {
  return (node.connectedPins ?? []).some((pin) => (pin.linkedTo ?? []).length > 0);
}

/** Variable nodes carry the variable's name as their title; call nodes carry the function's. */
function variableName(node: LayoutNode): string | undefined {
  if (!/^K2Node_Variable(Get|Set)/.test(node.type)) return undefined;
  // Titles arrive as "Health", "Set Health", or "SET" depending on node and engine version.
  return node.title.replace(/^set\s+/i, "").trim();
}

export function reviewGraph(graphName: string, allNodes: LayoutNode[]): QualityReport {
  const nodes = allNodes.filter((node) => !isComment(node));
  const commentBoxes = allNodes.filter(isComment);
  const findings: Finding[] = [];

  // --- What runs every frame -------------------------------------------------------------------
  //
  // The checks below are the difference between a graph that works and one a team can live with,
  // and they are the ones a model is least likely to get right on its own. Each is named in the
  // handbook's performance section; each was seen in a real eight-month-old project on the first
  // afternoon anyone looked.
  //
  // All of them ask the same question - "does this run every frame?" - so reachability from Tick is
  // computed once here rather than three times below.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Shared with the graph reader, so "does this run every frame" cannot answer differently from
  // "what runs here" - and so reroute nodes are stepped over in both.
  const execTargets = (node: LayoutNode): LayoutNode[] => followExec(node, byId);

  const tickEvent = nodes.find((node) => isEventNode(node) && /\bTick\b/i.test(node.title ?? ""));
  const runsEveryFrame = new Set<string>();
  if (tickEvent) {
    const queue = [tickEvent];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || runsEveryFrame.has(current.id)) continue;
      runsEveryFrame.add(current.id);
      queue.push(...execTargets(current));
    }
    runsEveryFrame.delete(tickEvent.id);
  }

  const inTick = (node: LayoutNode) => runsEveryFrame.has(node.id);
  const titleOf = (node: LayoutNode) => node.title ?? "";

  // --- Walking the level, repeatedly. ---
  // GetAllActorsOfClass iterates every actor in the level. Once at BeginPlay is ordinary; once per
  // frame is the single most common cause of a Blueprint project losing its framerate for reasons
  // nobody can find.
  const actorSweeps = nodes.filter((node) => /GetAllActorsOf/i.test(titleOf(node)));
  const sweepsInTick = actorSweeps.filter(inTick);
  if (sweepsInTick.length > 0) {
    findings.push({
      check: "level-sweep-every-frame",
      severity: "error",
      message: `${sweepsInTick.length} Get All Actors Of Class call(s) run every frame from Event Tick.`,
      fix:
        "This walks every actor in the level, 60+ times a second. Do it once on BeginPlay and store the " +
        "result in a variable, or replace it with an overlap event, a dispatcher, or a list the actors " +
        "add themselves to when they spawn.",
      nodeIds: sweepsInTick.map((node) => node.id),
    });
  } else if (actorSweeps.length > 0 && nodes.some((node) => /Set Timer/i.test(titleOf(node)))) {
    // A timer is not Tick, but it repeats, and a level sweep on a repeating path costs the same
    // thing slightly less often. This is where the real project's cost actually was: a timer
    // started a scan event, and the scan walked every actor in the level.
    //
    // Phrased as a question rather than an accusation, and only info, because proving the timer
    // drives THIS chain needs the timer's function-name pin value - which a graph summary
    // deliberately omits. Saying "these two things are here, check whether they are connected" is
    // honest; asserting it would be a guess dressed as a finding.
    findings.push({
      check: "level-sweep-maybe-repeating",
      severity: "info",
      message:
        `This graph both sets a timer and calls Get All Actors Of Class ${actorSweeps.length} time(s).`,
      fix:
        "If the timer drives the chain that sweeps, the whole level is being walked on every tick of " +
        "that timer. Gather the actors once and store them, or have actors register themselves as " +
        "they spawn, and keep the timer for the cheap part.",
      nodeIds: actorSweeps.map((node) => node.id),
    });
  } else if (actorSweeps.length > 2) {
    findings.push({
      check: "level-sweep-repeated",
      severity: "info",
      message: `${actorSweeps.length} Get All Actors Of Class calls in one graph.`,
      fix:
        "Each one walks the whole level. If they are looking for the same thing, do it once and store " +
        "the result; if they run on a timer, consider having the actors register themselves instead.",
      nodeIds: actorSweeps.map((node) => node.id),
    });
  }

  // --- Casting every frame instead of once. ---
  const castsInTick = nodes.filter((node) => /^K2Node_DynamicCast/.test(node.type) && inTick(node));
  if (castsInTick.length > 0) {
    findings.push({
      check: "cast-every-frame",
      severity: "warning",
      message: `${castsInTick.length} cast(s) run every frame from Event Tick.`,
      fix:
        "A cast is not free and the answer does not change. Cast once on BeginPlay, store the result in " +
        "a variable of that type, and read the variable here. If the target can change, cast when it " +
        "changes rather than when it is used.",
      nodeIds: castsInTick.map((node) => node.id),
    });
  }

  // --- Spawning and destroying every frame. ---
  const spawnsInTick = nodes.filter(
    (node) => /(SpawnActor|Spawn Actor|DestroyActor|Destroy Actor)/i.test(titleOf(node)) && inTick(node)
  );
  if (spawnsInTick.length > 0) {
    findings.push({
      check: "spawn-every-frame",
      severity: "error",
      message: `${spawnsInTick.length} spawn/destroy call(s) run every frame from Event Tick.`,
      fix:
        "Creating and destroying actors every frame is the most expensive thing a Blueprint can do. " +
        "Spawn on the event that actually causes it, or keep a pool of actors and reuse them.",
      nodeIds: spawnsInTick.map((node) => node.id),
    });
  }

  // --- Dead nodes: wired to nothing, doing nothing, but shipped anyway. ---
  // Events are excluded, and the reason is the whole safety argument for automatic cleanup.
  //
  // An unconnected Event node satisfies "connected to nothing", but deleting one is not the same as
  // deleting a stray expression. On a Blueprint whose PARENT is also a Blueprint, an empty override
  // event suppresses the parent's implementation - so removing it restores parent behaviour, which
  // is a behaviour change, which is exactly what cleanup promises never to do.
  //
  // Found on real code: cleanup reported "2 dead nodes will be removed" and, in the same result,
  // "2 empty events - only you know which was intended". They were the same two nodes. The tool
  // refused to decide and then decided anyway.
  //
  // They are still reported, by the empty-event check, which cleanup leaves alone.
  const dead = nodes.filter((node) => !hasAnyConnection(node) && !isEventNode(node));
  if (dead.length > 0 && nodes.length > 1) {
    findings.push({
      check: "dead-node",
      severity: "warning",
      message: `${dead.length} node(s) are not connected to anything and will never run.`,
      fix: "Remove them with unreal_remove_node, or wire them into the graph if they were meant to be used.",
      nodeIds: dead.map((node) => node.id),
    });
  }

  // --- Casts whose failure path is unhandled: the classic silent-nothing-happens bug. ---
  const unhandledCasts = nodes.filter((node) => {
    if (!/^K2Node_DynamicCast/.test(node.type)) return false;
    const pins = connectedPinNames(node);
    // Only connected pins are reported, so a missing "cast failed" means it is wired to nothing.
    return !pins.has("cast failed") && !pins.has("castfailed");
  });
  if (unhandledCasts.length > 0) {
    findings.push({
      check: "unhandled-cast-failure",
      severity: "warning",
      message: `${unhandledCasts.length} Cast node(s) leave the "Cast Failed" path unhandled.`,
      fix:
        "Wire Cast Failed to something that handles the miss, even if that is only a Print String during " +
        "development. An unhandled cast failure is silent: the rest of the chain simply never runs, which is " +
        "the single hardest Blueprint bug for a beginner to diagnose.",
      nodeIds: unhandledCasts.map((node) => node.id),
    });
  }

  // --- Debug output left in. ---
  const prints = nodes.filter((node) => /^print\s*string$/i.test(node.title.trim()));
  if (prints.length > 0) {
    findings.push({
      check: "debug-print-left-in",
      severity: "warning",
      message: `${prints.length} Print String node(s) are still in this graph.`,
      fix:
        "Remove them before calling the feature done, or confirm they are deliberate developer output. " +
        "Print String ships in development builds and is the most common thing left behind in AI-authored graphs.",
      nodeIds: prints.map((node) => node.id),
    });
  }

  // --- Placeholder names. A graph full of NewVar is not a finished graph. ---
  const placeholders = nodes.filter((node) => {
    const name = variableName(node);
    return name !== undefined && PLACEHOLDER_NAME.test(name);
  });
  if (placeholders.length > 0) {
    const names = [...new Set(placeholders.map((node) => variableName(node)!))];
    findings.push({
      check: "placeholder-name",
      severity: "warning",
      message: `Variables with placeholder names are in use: ${names.join(", ")}.`,
      fix:
        "Rename them to say what they hold. A human inheriting this Blueprint reads the variable names first, " +
        "and a name like NewVar costs them the time it takes to trace every use.",
      nodeIds: placeholders.map((node) => node.id),
    });
  }

  const chains = groupIntoChains(nodes);

  // --- Unlabelled sections. ---
  if (chains.length >= 2 && commentBoxes.length < chains.length) {
    findings.push({
      check: "unlabelled-sections",
      severity: "info",
      message: `${chains.length} execution chains but only ${commentBoxes.length} comment box(es).`,
      fix:
        "Run unreal_auto_layout_graph, which wraps each execution chain in a comment box titled after its " +
        "event. A reader should be able to see the graph's structure without tracing a single wire.",
      nodeIds: chains.map((chain) => chain.rootId),
    });
  }

  // --- Per-frame work. ---
  for (const chain of chains) {
    const root = nodes.find((node) => node.id === chain.rootId);
    if (!root || !/tick/i.test(root.title)) continue;
    if (chain.nodeIds.length > TICK_CHAIN_HEAVY) {
      findings.push({
        check: "tick-heavy",
        severity: "warning",
        message: `Event Tick runs ${chain.nodeIds.length} nodes every frame.`,
        fix:
          "Move what can be event-driven onto the event that actually changes the value, or onto a timer with " +
          "an interval. Per-frame work is the first thing a performance pass deletes, and the easiest to avoid " +
          "writing in the first place.",
        nodeIds: [chain.rootId],
      });
    }
  }

  // --- Structure: graphs and chains that should have been functions. ---
  if (nodes.length > GRAPH_TOO_LARGE) {
    findings.push({
      check: "graph-too-large",
      severity: "warning",
      message: `This graph has ${nodes.length} nodes, past the point where it can be read at a glance.`,
      fix:
        "Extract coherent sections into named functions with unreal_create_function and call them from here. " +
        "The EventGraph should read as a table of contents, not as the whole implementation.",
      nodeIds: [],
    });
  }
  for (const chain of chains) {
    if (chain.nodeIds.length <= CHAIN_TOO_LONG) continue;
    findings.push({
      check: "long-exec-chain",
      severity: "info",
      message: `The "${chain.title}" chain is ${chain.nodeIds.length} nodes long.`,
      fix:
        "Extract the middle of it into a named function. A long chain hides what it does behind the effort of " +
        "reading all of it; a function name states it.",
      nodeIds: [chain.rootId],
    });
  }

  // --- Branches with a dead path. ---
  const halfBranches = nodes.filter((node) => {
    if (!/^K2Node_IfThenElse/.test(node.type)) return false;
    const pins = connectedPinNames(node);
    return pins.has("true") !== pins.has("false");
  });
  if (halfBranches.length > 0) {
    findings.push({
      check: "branch-dead-path",
      severity: "info",
      message: `${halfBranches.length} Branch node(s) have only one of True/False wired.`,
      fix:
        "Confirm the unwired path is meant to do nothing. It often is, but it is also how a missing case hides " +
        "in plain sight.",
      nodeIds: halfBranches.map((node) => node.id),
    });
  }

  // --- Events that lead nowhere. ---
  const emptyEvents = nodes.filter((node) => {
    if (!isEventNode(node)) return false;
    return !(node.connectedPins ?? []).some((pin) => pin.direction === "out" && (pin.linkedTo ?? []).length > 0);
  });
  if (emptyEvents.length > 0) {
    findings.push({
      check: "empty-event",
      severity: "warning",
      message: `${emptyEvents.length} event node(s) have nothing wired to their output.`,
      fix:
        "Either implement the event or remove it. An empty event reads as an intention that was never finished, " +
        "and a reader cannot tell which.",
      nodeIds: emptyEvents.map((node) => node.id),
    });
  }

  const summary = {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    infos: findings.filter((f) => f.severity === "info").length,
  };
  const score = Math.max(0, 100 - summary.errors * 8 - summary.warnings * 4 - summary.infos * 1);

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));

  return { graphName, nodeCount: nodes.length, score, summary, findings };
}
