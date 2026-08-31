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
import { auditDataTables } from "./dataTableAudit.js";
import { reviewBlueprint } from "./review.js";
import { findServerOnlyCasts } from "./multiplayer.js";
import { reviewSessions, type SessionGraph } from "./sessions.js";
import { findServerSideUi, findEmptyRepNotifies } from "./clientSync.js";
import { buildCallers, resolveServerAuthority, type AuthorityUnit } from "./authorityMap.js";
import { findUncalledParentEvents } from "./parentCalls.js";
import { findDeadGraphs, type LivenessGraph } from "./systemLiveness.js";
import { findAnimStateMachineFaults } from "./animAudit.js";
import { findNiagaraFaults } from "./niagaraAudit.js";
import { explainGraph } from "./explainGraph.js";

/** What each finding is likely to cost, and why it sits where it does. */
export const FINDING_COST: Record<string, number> = {
  "cast-to-server-only-class": 100,
  "server-writes-unreplicated": 100,
  // A handle, not state. Deliberately far cheaper than the check above, because the commonest case
  // is not a bug at all: an object reference to an Actor that replicates itself. Costing it at 100
  // put correct code at the top of the audit, where a model acts on it first.
  "server-writes-unreplicated-handle": 15,
  // A state nothing leaves freezes the character in one pose for the rest of the round, and the
  // machine looks finished in the editor because the state IS wired - just not outward.
  "anim-state-no-exit": 80,
  // A system that can render nothing, spawned by a Blueprint that looks correct.
  // A name typed as text that names nothing. The Blueprint compiles and the call does nothing.
  "row-name-not-in-table": 85,
  "timer-target-missing": 85,
  // A call whose only job is to use an asset, running with that asset pin empty. Priced just under
  // the two above because those are always a defect and this one has a rare honest form: an author
  // who has wired the node and has not yet picked the asset. Everything else about it is the same
  // shape - it compiles, it runs, it reports success, and it does nothing.
  "asset-pin-empty": 80,
  "niagara-system-empty": 60,
  "niagara-all-emitters-disabled": 60,
  // Draws exactly like a working transition and behaves like a wall.
  "anim-transition-never-fires": 70,
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
  "server-writes-unreplicated-handle":
    "Usually fine: if the referenced Actor replicates itself, clients already see it and the variable is just the server's handle. Worth one look, not a rewrite.",
  "anim-state-no-exit":
    "The character enters the pose and stays in it. Reads as 'he freezes after the dodge', and nothing warns.",
  "row-name-not-in-table":
    "The lookup returns an empty struct and the Row Found pin is usually unwired, so nothing reports it.",
  "timer-target-missing":
    "The timer runs at its interval forever and calls nothing. Nothing warns, at compile time or at runtime.",
  "niagara-system-empty":
    "The spawn call succeeds and nothing appears. Reads as 'the effect doesn't play', with no error to search for.",
  "niagara-all-emitters-disabled":
    "Same as an empty system in practice: it spawns, and renders nothing.",
  "anim-transition-never-fires":
    "An empty rule graph draws like a working transition. The destination state is simply unreachable through it.",
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
  /**
   * Evidence, kept apart from the conclusion.
   *
   * Some checks fire identically on a certain bug and on a deliberate choice - the same shape of
   * override is a real defect in one Blueprint and the author's intent in the next. This carries
   * what the assets actually show so the reader can tell which, instead of being handed a verdict.
   */
  observed?: string;
}

export interface AuditGroup {
  check: string;
  count: number;
  cost: number;
  why?: string;
  examples: Array<{ blueprint: string; graph: string; message: string; observed?: string }>;
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
  /**
   * Data Table rows whose asset reference is empty while sibling rows fill it in.
   *
   * Kept out of `groups` on purpose: those are per-Blueprint findings ranked by cost, and a table
   * row is neither a Blueprint nor a graph. Filing it under one would be a lie of the same kind the
   * review already refuses to tell.
   */
  dataTableNulls: Array<{ table: string; rowName: string; field: string }>;
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
  /**
   * One check name, returned in full instead of raising detail for everything above it.
   *
   * The natural next move after an audit is "tell me more about that one", and the only lever was
   * `detailedGroups`, which is positional: to see the 13th kind you asked for the first thirteen.
   * Measured on the real project, that is 2,350 tokens to 4,303 - nearly double, and twelve of the
   * thirteen groups it returns in full are ones you did not ask for.
   */
  check?: string;
}

export async function auditProject(bridge: BridgeLike, options: AuditOptions = {}): Promise<AuditResult> {
  const pathPrefix = options.pathPrefix ?? "/Game";
  const limit = Math.max(1, Math.min(options.limit ?? 150, 2000));
  const examplesPerGroup = Math.max(1, Math.min(options.examplesPerGroup ?? 3, 10));
  const detailedGroups = Math.max(1, Math.min(options.detailedGroups ?? 4, 30));
  const wantedCheck = (options.check ?? "").trim().toLowerCase();

  const listed = await bridge.send<{
    // parentClass rides along for free and is what lets the liveness pass skip interfaces, whose
    // graphs are declarations rather than code and would otherwise all look abandoned.
    blueprints?: Array<{ name: string; path: string; parentClass?: string }>;
  }>("list_blueprints", {
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
  /** Every graph of every Blueprint, kept so liveness costs no extra reads. */
  const allGraphs: LivenessGraph[] = [];
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

      for (const graph of review.graphNodes ?? []) {
        allGraphs.push({
          blueprint: bp.name,
          graphName: graph.graphName,
          nodes: (graph.nodes ?? []) as Array<{ title?: string; type?: string }>,
          parentClass: bp.parentClass,
        });
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
          ...((finding as { observed?: string }).observed ? { observed: (finding as { observed?: string }).observed } : {}),
          fix: finding.fix,
          cost: FINDING_COST[finding.check] ?? 1,
        });
      }
    } catch (err) {
      // One unreadable Blueprint must not cost the caller the audit.
      unreadable.push({ name: bp.name, error: err instanceof Error ? err.message.slice(0, 140) : String(err) });
    }
  }

  // Animation. list_blueprints returns Blueprint assets, and an AnimBlueprint is a different class,
  // so until now this audit could not see a single state machine in the project - "find every bug"
  // stopped at the door of the half where "the character is not animating" is usually answered.
  try {
    const animAssets = await bridge.send<{ assets?: Array<{ name: string; path: string }> }>("list_assets", {
      className: "AnimBlueprint",
      maxResults: 200,
    });
    for (const asset of animAssets.assets ?? []) {
      try {
        const anim = await bridge.send<Record<string, unknown>>("read_anim_blueprint", { path: asset.path });
        for (const finding of findAnimStateMachineFaults(anim, asset.name)) {
          findings.push({
            blueprint: asset.name,
            path: asset.path,
            graph: "AnimGraph",
            check: finding.check,
            severity: finding.severity,
            message: finding.message,
            ...(finding.observed ? { observed: finding.observed } : {}),
            fix: finding.fix,
            cost: FINDING_COST[finding.check] ?? 1,
          });
        }
      } catch (err) {
        unreadable.push({
          name: asset.name,
          error: err instanceof Error ? err.message.slice(0, 140) : String(err),
        });
      }
    }
  } catch {
    // An older bridge has no read_anim_blueprint. The rest of the audit is still worth returning,
    // and a hard failure here would make upgrading the server a prerequisite for auditing at all.
  }

  // Names typed as text, checked against whether the thing they name exists. Deliberately no MCP
  // tool of its own: it belongs in "find every bug", and a separate tool would cost every session
  // ~330 tokens of definition for a check nobody calls directly.
  try {
    const broken = await bridge.send<{
      broken?: Array<{
        blueprint: string;
        graph: string;
        check: string;
        message: string;
        fix: string;
        nodeId?: string;
      }>;
      namesChecked?: number;
      namesFromVariables?: number;
    }>("find_broken_names", { pathPrefix });
    for (const finding of broken.broken ?? []) {
      findings.push({
        blueprint: finding.blueprint,
        path: pathOfBlueprint.get(finding.blueprint) ?? pathPrefix,
        graph: finding.graph,
        check: finding.check,
        severity: "warning",
        // The node id when the check has one, because "somewhere in this graph" is a search and
        // "this node" is an edit.
        message: finding.nodeId
          ? `${finding.blueprint} ${finding.message} (node ${finding.nodeId})`
          : `${finding.blueprint} ${finding.message}`,
        fix: finding.fix,
        cost: FINDING_COST[finding.check] ?? 1,
      });
    }
  } catch {
    // An older bridge has no find_broken_names; the rest of the audit still stands.
  }

  // VFX. Same reasoning as the animation pass: a NiagaraSystem is not a Blueprint, so list_blueprints
  // never returned one and the audit could not see a single effect in the project.
  try {
    const vfx = await bridge.send<{ assets?: Array<{ name: string; path: string }> }>("list_assets", {
      className: "NiagaraSystem",
      maxResults: 200,
    });
    for (const asset of vfx.assets ?? []) {
      try {
        const system = await bridge.send<Record<string, unknown>>("read_niagara_system", { path: asset.path });
        for (const finding of findNiagaraFaults(system, asset.name)) {
          findings.push({
            blueprint: asset.name,
            path: asset.path,
            graph: "(system)",
            check: finding.check,
            severity: finding.severity,
            message: finding.message,
            ...(finding.observed ? { observed: finding.observed } : {}),
            fix: finding.fix,
            cost: FINDING_COST[finding.check] ?? 1,
          });
        }
      } catch (err) {
        unreadable.push({ name: asset.name, error: err instanceof Error ? err.message.slice(0, 140) : String(err) });
      }
    }
  } catch {
    // An older bridge has no read_niagara_system; the rest of the audit is still worth returning.
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
        ...(finding.observed ? { observed: finding.observed } : {}),
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
      // Asking for one check means that one, wherever it ranks - and only that one. Everything else
      // stays a count, which is what makes this cheaper than reaching the same group by rank.
      const detailed = wantedCheck ? check.toLowerCase() === wantedCheck : index < detailedGroups;
      return {
        check,
        count: list.length,
        cost: FINDING_COST[check] ?? 1,
        why: detailed ? WHY_IT_COSTS[check] : undefined,
        examples: detailed
          ? list.slice(0, wantedCheck ? Math.max(examplesPerGroup, 25) : examplesPerGroup).map((f) => ({
              blueprint: f.blueprint,
              graph: f.graph,
              message: f.message,
              // Only when a check has evidence to add. Two checks fire identically on a real bug and
              // on a deliberate choice, and this is the field that tells them apart - dropping it
              // here would leave the reader with the conclusion and none of the reasoning.
              ...(f.observed ? { observed: f.observed } : {}),
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

  // A named check that matched nothing. Left until here so the names come from what this run
  // actually found, rather than from a hardcoded list that could drift from it.
  const checkNames = groups.map((g) => g.check);
  const checkMissed = wantedCheck.length > 0 && !checkNames.some((c) => c.toLowerCase() === wantedCheck);

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

  // Data Tables are swept too, because "my game has bugs, where do I look" is exactly the question
  // this tool answers and the most expensive bug it has seen was not in a graph at all: a row's
  // class reference cleared to None, resolved to null by the engine and silently ignored by the
  // thing that consumed it. An audit that reads only Blueprints looks straight past it.
  const dataTableNulls: AuditResult["dataTableNulls"] = [];
  try {
    const tables = await auditDataTables(bridge, { pathPrefix: options.pathPrefix });
    for (const n of tables.nullReferences) {
      dataTableNulls.push({ table: n.table, rowName: n.rowName, field: n.field });
    }
  } catch {
    /* a bridge too old to read Data Tables must not lose the Blueprint half of the audit */
  }

  // Function graphs nothing in any Blueprint appears to call.
  //
  // Its own section, deliberately, and NOT an annotation on individual findings. The reason is the
  // blind spot it shares with the bridge's own reachability: neither can see a call from C++, a
  // delegate bound at runtime, or an interface dispatch. Marking a finding "this is in a replaced
  // system" on that evidence would be a confident wrong steer, which is worse than the silence it
  // replaced. As a list to go and look at, it is exactly what was missing - the two most expensive
  // mistakes this project has made were both work done on a system that had been replaced and left
  // on the canvas, and nothing anywhere said so.
  //
  // Costs no extra calls: every graph was already read for the checks above.
  const liveness = findDeadGraphs(allGraphs);
  const possiblyReplaced =
    liveness.dead.size === 0
      ? undefined
      : {
          count: liveness.dead.size,
          ofGraphs: liveness.considered,
          // Grouped, not listed. Twelve graph names out of 180 is the weakest thing this could
          // return: "GS_Gameplay.ShowCountdown" is a name, and "GS_Gameplay: 15 of 26 uncalled" is a
          // system that was replaced. The ratio carries its own confidence too - one stray helper in
          // forty is housekeeping, fifteen in twenty-six is not - and it costs fewer tokens than the
          // list it replaces.
          worst: liveness.byBlueprint.slice(0, 8).map((b) => `${b.blueprint}: ${b.dead} of ${b.of}`),
          note:
            "Function graphs no Blueprint node appears to call. A place to look, not a verdict. Blind " +
            "to calls from C++, to delegates bound at runtime, to interface dispatch, and to Set Timer " +
            "by Function Name, whose target is a string in a pin rather than a node - so a graph listed " +
            "here may still run. unreal_trace_function_calls on one name confirms or clears it, and it " +
            "does follow timers. Worth checking before fixing anything inside one: work on a system " +
            "that was replaced and left on the canvas is the most expensive wasted effort there is.",
        };

  const worst = groups[0];
  // A null reference leads, whatever the graph findings say. It is not a matter of taste: those are
  // things that make a Blueprint worse, and this is a thing that does not happen at all at runtime,
  // with no error to notice.
  const nextAction =
    dataTableNulls.length > 0
      ? `Start with ${dataTableNulls.length} empty Data Table reference(s), beginning with ` +
        `${dataTableNulls[0].table} row "${dataTableNulls[0].rowName}" (${dataTableNulls[0].field}). ` +
        `The engine resolves an empty reference to null and whatever consumes it silently does ` +
        `nothing - no error, no log. Fix with unreal_set_data_table_row.` +
        (worst ? ` Then ${worst.check} (${worst.count} found).` : "")
      : worst
        ? `Start with ${worst.check} (${worst.count} found). ${worst.fix}`
        : "Nothing found worth reporting. Either the project is in good shape or the prefix matched nothing.";

  return {
    ...(checkMissed
      ? {
          checkNotFound:
            `No finding kind called "${options.check}". This run found: ${checkNames.join(", ")}. ` +
            `Every group below is counted only, because the one you named is not among them.`,
        }
      : {}),
    ...(possiblyReplaced ? { possiblyReplaced } : {}),
    blueprintsScanned: blueprints.length,
    blueprintsWithFindings: costByBlueprint.size,
    findingCount: findings.length,
    groups,
    worstBlueprints,
    unreadable,
    dataTableNulls,
    truncated: all.length > blueprints.length,
    nextAction,
  };
}
