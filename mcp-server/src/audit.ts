/**
 * Auditing a whole project, ranked by what a finding is likely to cost.
 *
 * Every other tool here answers a question about one Blueprint. That is the right shape for an
 * agent mid-task and the wrong shape for the question people actually arrive with:
 *
 *   "My game has bugs and a deadline. Where do I look?"
 *
 * This existed as a script first, which meant the model could not run it - the single most useful
 * thing in the project was available to a person at a terminal and to nobody else. It lives here so
 * both can use it.
 *
 * ## Ordering
 *
 * By likely cost, not by severity, and the two are not the same. A dead event is cosmetic until
 * someone wires it. A cast that fails on every client but the host is a bug report nobody can
 * reproduce alone, which is exactly how it survives to a showcase. The order below is the order to
 * work in with a limited afternoon.
 *
 * ## Cost of running it
 *
 * It reads what an agent would read anyway - the project index and one graph summary per graph -
 * so the bridge cost is bounded and predictable. The RESULT is deliberately small: counts, the
 * ranked groups, and a handful of examples each. A ranked list of eight hundred findings is the
 * same as no list.
 */

import type { BridgeLike } from "./autoLayout.js";
import { reviewBlueprint } from "./review.js";
import { findServerOnlyCasts } from "./multiplayer.js";
import { reviewSessions, type SessionGraph } from "./sessions.js";
import { findServerSideUi, findEmptyRepNotifies } from "./clientSync.js";
import { buildCallers, resolveServerAuthority, type AuthorityUnit } from "./authorityMap.js";
import { findUncalledParentEvents } from "./parentCalls.js";
import { explainGraph } from "./explainGraph.js";

/** What each finding is likely to cost, and why it sits where it does. */
export const FINDING_COST: Record<string, number> = {
  "cast-to-server-only-class": 100,
  "server-writes-unreplicated": 100,
  // Costs the most that any of these can cost: the game builds, hosts, searches, reports no error,
  // and the lobby list is empty. It cannot be reproduced on one machine.
  "session-lan-mismatch": 100,
  // Same tier as the casts that only fail on clients, and for the same reason: on a listen server
  // the host IS the server, so it works on the machine the developer is looking at.
  "server-event-touches-widget": 95,
  // The parent's work simply does not happen, on every machine, and nothing warns. The child's own
  // logic still works, which is what makes it survive.
  "parent-event-not-called": 95,
  "unhandled-cast-failure": 90,
  "level-sweep-every-frame": 85,
  "spawn-every-frame": 85,
  "state-outlives-owner": 80,
  "session-host-paths-disagree": 65,
  "session-host-without-search": 45,
  "cast-every-frame": 70,
  "repnotify-does-nothing": 60,
  "branch-dead-path": 60,
  "tick-heavy": 55,
  "level-sweep-maybe-repeating": 50,
  "replicated-set-without-server-event": 50,
  "empty-event": 40,
  "dead-node": 30,
  "debug-print-left-in": 25,
  "graph-too-large": 20,
  "long-exec-chain": 15,
  "placeholder-name": 10,
  "unlabelled-sections": 5,
};

const WHY_IT_COSTS: Record<string, string> = {
  "cast-to-server-only-class":
    "A GameMode exists only on the server. On every client the cast fails silently and every node after it never runs. Single-player testing cannot see it.",
  "server-writes-unreplicated":
    "Reads as 'it works for the host'. Nobody can reproduce it alone, which is why it survives to a showcase.",
  "unhandled-cast-failure":
    "A failed cast does not error. The chain simply stops, so the feature does not happen and there is nothing to search for.",
  "level-sweep-every-frame": "Walks every actor in the level, 60+ times a second.",
  "spawn-every-frame": "The most expensive thing a Blueprint can do, repeated per frame.",
  "state-outlives-owner": "Resets on death or respawn, so it looks correct until somebody dies.",
  "parent-event-not-called":
    "Adding an event to a child Blueprint silently replaces the parent's. Everything the parent set up is missing, on every machine, while the child's own logic still works - so the Blueprint looks correct.",
  "server-event-touches-widget":
    "A widget exists only on the machine that created it, so this updates the host's screen and nobody else's. The cast succeeds and nothing errors.",
  "repnotify-does-nothing":
    "Marking a variable RepNotify says the clients must react when it arrives. An empty one is usually the missing half of a feature - the half that works for everybody who is not hosting.",
  "session-lan-mismatch":
    "A LAN session is invisible to an online search and the reverse. Hosting succeeds, searching succeeds, the list is empty, and nothing anywhere reports an error.",
  "session-host-paths-disagree":
    "Menus grow more than one host button. Whichever one was pressed decides whether anybody can see the lobby, so the same build works and then does not.",
  "cast-every-frame": "Not free, and the answer does not change.",
  "branch-dead-path": "One side of a decision does nothing. Often correct; often the bug.",
  "tick-heavy": "Runs every frame whether or not anything changed.",
};

export interface AuditFinding {
  blueprint: string;
  path: string;
  graph: string;
  check: string;
  severity: string;
  message: string;
  fix: string;
  cost: number;
}

export interface AuditGroup {
  check: string;
  count: number;
  cost: number;
  why?: string;
  examples: Array<{ blueprint: string; graph: string; message: string }>;
  /** Absent when detail was elided for budget. Absent does NOT mean "no fix is known". */
  fix?: string;
  /** True when the explanation, examples and fix were dropped to keep the reply small. */
  detailElided?: boolean;
}

export interface AuditResult {
  project?: string;
  blueprintsScanned: number;
  blueprintsWithFindings: number;
  findingCount: number;
  /** Ranked by cost, most expensive first. */
  groups: AuditGroup[];
  /** The Blueprints worth opening first, by accumulated cost. */
  worstBlueprints: Array<{ name: string; cost: number; findings: number }>;
  unreadable: Array<{ name: string; error: string }>;
  truncated: boolean;
  nextAction: string;
}

export interface AuditOptions {
  pathPrefix?: string;
  /** How many Blueprints to look at. Bounded on purpose; a whole project can be thousands. */
  limit?: number;
  /** Examples reported per finding kind. */
  examplesPerGroup?: number;
  /**
   * How many groups come back with their explanation and fix attached.
   *
   * Beyond this, groups return name, count and cost only. Nobody works on the thirteenth most
   * expensive category today, and carrying its prose costs the caller tokens on every call - on the
   * real project the explanations were most of the reply. Detailed at the top and terse below is
   * what a plan looks like; uniform detail is what a list looks like.
   */
  detailedGroups?: number;
}

export async function auditProject(bridge: BridgeLike, options: AuditOptions = {}): Promise<AuditResult> {
  const pathPrefix = options.pathPrefix ?? "/Game";
  const limit = Math.max(1, Math.min(options.limit ?? 150, 2000));
  const examplesPerGroup = Math.max(1, Math.min(options.examplesPerGroup ?? 3, 10));
  const detailedGroups = Math.max(1, Math.min(options.detailedGroups ?? 4, 30));

  const listed = await bridge.send<{ blueprints?: Array<{ name: string; path: string }> }>("list_blueprints", {
    pathPrefix,
  });
  const all = listed.blueprints ?? [];
  const blueprints = all.slice(0, limit);

  // Which classes are server-only, asked once per distinct name and cached. Answering by name would
  // be a guess: a project's GameModes are called things like AVSBaseGameMode and GM_Gameplay,
  // neither of which contains "GameModeBase".
  const pathOfBlueprint = new Map(all.map((bp) => [bp.name, bp.path]));
  const serverOnly = new Map<string, boolean>();
  const widgetClasses = new Map<string, boolean>();
  const learn = async (className: string) => {
    if (serverOnly.has(className) && widgetClasses.has(className)) return;
    try {
      const described = await bridge.send<{ serverOnly?: boolean; ancestry?: string[] }>("describe_class", {
        className: pathOfBlueprint.get(className) ?? className,
      });
      serverOnly.set(className, described.serverOnly === true);
      // Widget classes are called all sorts of things - W_, WB_, WBP_, or nothing at all - so this
      // is answered from the ancestry and never from the name.
      widgetClasses.set(className, (described.ancestry ?? []).some((a) => /UserWidget/i.test(a)));
    } catch {
      serverOnly.set(className, false);
      widgetClasses.set(className, false);
    }
  };
  const isServerOnlyClass = (className: string) => serverOnly.get(className) === true;

  const findings: AuditFinding[] = [];
  const unreadable: Array<{ name: string; error: string }> = [];
  const sessionGraphs: SessionGraph[] = [];
  const units: AuthorityUnit[] = [];
  // Kept per Blueprint so a child can be compared against its parent afterwards: the parent has not
  // necessarily been read at the moment the child is.
  const eventGraphs = new Map<
    string,
    { parentClass: string; chains: Array<{ entry: string; steps: string[]; nodeIds: string[] }>; titles: string[] }
  >();
  const uiCandidates: Array<{
    blueprint: string;
    path: string;
    graphName: string;
    unitKey: string;
    chain: { entryId: string; entry: string; nodeIds: string[] };
    nodesById: Map<string, { id: string; type: string; title?: string }>;
  }> = [];

  for (const bp of blueprints) {
    try {
      const review = await reviewBlueprint(bridge, bp.path, undefined, { includeGraphNodes: true });

      for (const graph of review.graphs ?? []) {
        for (const finding of graph.findings ?? []) {
          findings.push({
            blueprint: bp.name,
            path: bp.path,
            graph: graph.graphName,
            check: finding.check,
            severity: finding.severity,
            message: finding.message,
            fix: finding.fix,
            cost: FINDING_COST[finding.check] ?? 1,
          });
        }
      }

      await learn(bp.name);
      const ownerIsServerOnly = isServerOnlyClass(bp.name);
      for (const graph of review.graphNodes ?? []) {
        const nodes = (graph.nodes ?? []) as Array<{ title?: string }>;
        for (const node of nodes) {
          const match = /^Cast To (.+)$/i.exec(String(node.title ?? "").trim());
          if (match) await learn(match[1].trim());
        }
        for (const finding of findServerOnlyCasts(graph.nodes as never, isServerOnlyClass, ownerIsServerOnly)) {
          findings.push({
            blueprint: bp.name,
            path: bp.path,
            graph: graph.graphName,
            check: finding.check,
            severity: finding.severity,
            message: finding.message,
            fix: finding.fix,
            cost: FINDING_COST[finding.check] ?? 1,
          });
        }
      }

      for (const graph of review.graphNodes ?? []) {
        const nodes = (graph.nodes ?? []) as SessionGraph["nodes"];
        sessionGraphs.push({
          blueprint: bp.name,
          path: bp.path,
          graphName: graph.graphName,
          nodes,
          // Abandoned menu code is the normal state of a shipping project's lobby, and reporting
          // flags on nodes that never run would bury the one that does.
          liveNodeIds: new Set(explainGraph({ nodes } as never).chains.flatMap((c) => c.nodeIds)),
        });
      }

      // Both of these need things the per-graph checks do not have: the replication mode of an
      // event, and whether a RepNotify function has a body. Asked for lazily, and only when a graph
      // has already shown it might matter.
      const variables = (review.variables ?? []) as Array<{ name: string; repNotify?: string }>;
      const graphIsEmpty = (functionName: string): boolean | undefined => {
        const graph = (review.graphNodes ?? []).find((g) => g.graphName === functionName);
        if (!graph) return undefined;
        const nodes = (graph.nodes ?? []) as Array<{ connectedPins?: Array<{ linkedTo?: unknown[] }> }>;
        return nodes.every((n) => (n.connectedPins ?? []).every((pin) => (pin.linkedTo ?? []).length === 0));
      };
      for (const finding of findEmptyRepNotifies(variables, graphIsEmpty)) {
        findings.push({
          blueprint: bp.name,
          path: bp.path,
          graph: "(whole asset)",
          check: finding.check,
          severity: finding.severity,
          message: finding.message,
          fix: finding.fix,
          cost: FINDING_COST[finding.check] ?? 1,
        });
      }

      const eventGraph = (review.graphNodes ?? []).find((g) => /^EventGraph$/i.test(g.graphName));
      if (eventGraph) {
        const evNodes = (eventGraph.nodes ?? []) as Array<{ id: string; title?: string }>;
        eventGraphs.set(bp.name, {
          parentClass: (review.parentClass ?? "").replace(/_C$/, ""),
          chains: explainGraph({ nodes: evNodes } as never).chains.map((c) => ({
            entry: c.entry,
            steps: c.steps,
            nodeIds: c.nodeIds,
          })),
          titles: evNodes.map((n) => String(n.title ?? "")),
        });
      }

      // Collected here and judged after the loop: whether a chain runs on the server can depend on
      // a Server RPC in a different Blueprint, which has not necessarily been read yet.
      for (const graph of review.graphNodes ?? []) {
        const nodes = (graph.nodes ?? []) as SessionGraph["nodes"];
        const explained = explainGraph({ nodes } as never);
        for (const chain of explained.chains) {
          // A function graph is one unit named after the graph; an event graph holds one unit per
          // event. Callers write the bare name, so the editor's "Event " prefix comes off.
          const isEventGraph = /^EventGraph$/i.test(graph.graphName);
          const name = isEventGraph ? chain.entry.replace(/^Event\s+/i, "").trim() : graph.graphName;
          const chainNodes = nodes.filter((n) => chain.nodeIds.includes(n.id) || n.id === chain.entryId);
          const entryNode = nodes.find((n) => n.id === chain.entryId);
          units.push({
            key: `${bp.name}::${name}`,
            blueprint: bp.name,
            name,
            entryId: chain.entryId,
            entryType: entryNode?.type,
            nodes: chainNodes as never,
          });
          uiCandidates.push({
            blueprint: bp.name,
            path: bp.path,
            graphName: graph.graphName,
            unitKey: `${bp.name}::${name}`,
            chain: { entryId: chain.entryId, entry: chain.entry, nodeIds: chain.nodeIds },
            nodesById: new Map(nodes.map((n) => [n.id, n])) as never,
          });
        }
      }

      for (const finding of review.blueprint ?? []) {
        findings.push({
          blueprint: bp.name,
          path: bp.path,
          graph: "(whole asset)",
          check: finding.check,
          severity: finding.severity,
          message: finding.message,
          fix: finding.fix,
          cost: FINDING_COST[finding.check] ?? 1,
        });
      }
    } catch (err) {
      // One unreadable Blueprint must not cost the caller the audit.
      unreadable.push({ name: bp.name, error: err instanceof Error ? err.message.slice(0, 140) : String(err) });
    }
  }

  // A child against its parent. Both have to have been read, which is why this waits until here.
  for (const [name, child] of eventGraphs) {
    const parent = eventGraphs.get(child.parentClass);
    if (!parent) continue;
    for (const finding of findUncalledParentEvents({
      blueprint: name,
      parentBlueprint: child.parentClass,
      childChains: child.chains,
      childNodeTitles: child.titles,
      parentChains: parent.chains,
    })) {
      findings.push({
        blueprint: name,
        path: (blueprints.find((b) => b.name === name) ?? { path: pathPrefix }).path,
        graph: "EventGraph",
        check: finding.check,
        severity: finding.severity,
        message: finding.message,
        fix: finding.fix,
        cost: FINDING_COST[finding.check] ?? 1,
      });
    }
  }

  // Authority is a project-wide question: the Server RPC that puts a chain on the server is
  // routinely in a different Blueprint, reached through an interface message.
  const unitIndex = new Map(units.map((u) => [u.key, u]));
  const callers = buildCallers(units);
  const netModeCache = new Map<string, boolean>();
  // One lookup instead of a scan: this is asked once per unit met on every backward walk, and a
  // linear search here turned the whole audit quadratic.
  const ownerOfUnit = new Map<string, (typeof uiCandidates)[number]>();
  for (const candidate of uiCandidates) if (!ownerOfUnit.has(candidate.unitKey)) ownerOfUnit.set(candidate.unitKey, candidate);

  const isServerRpc = async (unit: AuthorityUnit): Promise<boolean> => {
    // Only a custom event can be a Server RPC. Asking the editor about a function entry or an
    // overridden engine event is a bridge call whose answer is already known.
    if (unit.entryType && unit.entryType !== "K2Node_CustomEvent") return false;
    const cached = netModeCache.get(unit.key);
    if (cached !== undefined) return cached;
    const owner = ownerOfUnit.get(unit.key);
    let server = false;
    if (owner) {
      const detail = await bridge
        .send<{ title?: string }>("read_blueprint_node_detail", {
          path: owner.path,
          graphName: owner.graphName,
          nodeId: unit.entryId,
        })
        .catch(() => undefined);
      server = /executes on server/i.test(detail?.title ?? "");
    }
    netModeCache.set(unit.key, server);
    return server;
  };

  for (const candidate of uiCandidates) {
    const found = await findServerSideUi([candidate.chain], candidate.nodesById as never, {
      authorityOf: async () => resolveServerAuthority(candidate.unitKey, unitIndex, callers, isServerRpc),
      isWidgetClass: async (className) => {
        await learn(className);
        return widgetClasses.get(className) === true;
      },
    }).catch(() => []);
    for (const finding of found) {
      findings.push({
        blueprint: candidate.blueprint,
        path: candidate.path,
        graph: candidate.graphName,
        check: finding.check,
        severity: finding.severity,
        message: finding.message,
        fix: finding.fix,
        cost: FINDING_COST[finding.check] ?? 1,
      });
    }
  }

  // Whether hosting and searching agree is a question about the PROJECT, not about any one
  // Blueprint - which is why no per-Blueprint check could ever have found it.
  try {
    const session = await reviewSessions(sessionGraphs, async (path, graphName, nodeId) => {
      const detail = await bridge.send<{ node?: { pins?: unknown[] }; pins?: unknown[] }>(
        "read_blueprint_node_detail",
        { path, graphName, nodeId }
      );
      return ((detail.node?.pins ?? detail.pins ?? []) as Array<{ name?: string; defaultValue?: unknown }>).filter(
        (p) => p && typeof p === "object"
      );
    });
    for (const finding of session.findings) {
      findings.push({
        blueprint: "(project)",
        path: pathPrefix,
        graph: "(sessions)",
        check: finding.check,
        severity: finding.severity,
        message: finding.message,
        fix: finding.fix,
        cost: FINDING_COST[finding.check] ?? 1,
      });
    }
  } catch {
    // A project with no session nodes is the common case; never let this cost the audit.
  }

  // Grouped by kind, because "seventeen Blueprints have the same problem" is one decision to make,
  // not seventeen.
  const byCheck = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const list = byCheck.get(finding.check) ?? [];
    list.push(finding);
    byCheck.set(finding.check, list);
  }

  const groups: AuditGroup[] = [...byCheck.entries()]
    .map(([check, list]) => ({ check, list }))
    .sort((a, b) => (FINDING_COST[b.check] ?? 1) - (FINDING_COST[a.check] ?? 1) || b.list.length - a.list.length)
    .map(({ check, list }, index) => {
      const detailed = index < detailedGroups;
      return {
        check,
        count: list.length,
        cost: FINDING_COST[check] ?? 1,
        why: detailed ? WHY_IT_COSTS[check] : undefined,
        examples: detailed
          ? list.slice(0, examplesPerGroup).map((f) => ({
              blueprint: f.blueprint,
              graph: f.graph,
              message: f.message,
            }))
          : [],
        // Undefined, not "". An empty string reads as "there is no fix for this", which is the
        // opposite of true: every one of these checks has a fix and it was dropped for budget.
        // Saying so explicitly is what makes raising detailedGroups an obvious move rather than a
        // guess.
        fix: detailed ? list[0].fix : undefined,
        ...(detailed ? {} : { detailElided: true }),
      };
    });

  const costByBlueprint = new Map<string, { cost: number; findings: number }>();
  for (const finding of findings) {
    const entry = costByBlueprint.get(finding.blueprint) ?? { cost: 0, findings: 0 };
    entry.cost += finding.cost;
    entry.findings += 1;
    costByBlueprint.set(finding.blueprint, entry);
  }
  const worstBlueprints = [...costByBlueprint.entries()]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  const worst = groups[0];
  const nextAction = worst
    ? `Start with ${worst.check} (${worst.count} found). ${worst.fix}`
    : "Nothing found worth reporting. Either the project is in good shape or the prefix matched nothing.";

  return {
    blueprintsScanned: blueprints.length,
    blueprintsWithFindings: costByBlueprint.size,
    findingCount: findings.length,
    groups,
    worstBlueprints,
    unreadable,
    truncated: all.length > blueprints.length,
    nextAction,
  };
}
