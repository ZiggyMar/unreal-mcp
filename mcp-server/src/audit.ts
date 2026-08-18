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

/** What each finding is likely to cost, and why it sits where it does. */
export const FINDING_COST: Record<string, number> = {
  "cast-to-server-only-class": 100,
  "server-writes-unreplicated": 100,
  "unhandled-cast-failure": 90,
  "level-sweep-every-frame": 85,
  "spawn-every-frame": 85,
  "state-outlives-owner": 80,
  "cast-every-frame": 70,
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
  fix: string;
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
}

export async function auditProject(bridge: BridgeLike, options: AuditOptions = {}): Promise<AuditResult> {
  const pathPrefix = options.pathPrefix ?? "/Game";
  const limit = Math.max(1, Math.min(options.limit ?? 150, 2000));
  const examplesPerGroup = Math.max(1, Math.min(options.examplesPerGroup ?? 3, 10));

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
  const learn = async (className: string) => {
    if (serverOnly.has(className)) return;
    try {
      const described = await bridge.send<{ serverOnly?: boolean }>("describe_class", {
        className: pathOfBlueprint.get(className) ?? className,
      });
      serverOnly.set(className, described.serverOnly === true);
    } catch {
      serverOnly.set(className, false);
    }
  };
  const isServerOnlyClass = (className: string) => serverOnly.get(className) === true;

  const findings: AuditFinding[] = [];
  const unreadable: Array<{ name: string; error: string }> = [];

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

  // Grouped by kind, because "seventeen Blueprints have the same problem" is one decision to make,
  // not seventeen.
  const byCheck = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const list = byCheck.get(finding.check) ?? [];
    list.push(finding);
    byCheck.set(finding.check, list);
  }

  const groups: AuditGroup[] = [...byCheck.entries()]
    .map(([check, list]) => ({
      check,
      count: list.length,
      cost: FINDING_COST[check] ?? 1,
      why: WHY_IT_COSTS[check],
      examples: list.slice(0, examplesPerGroup).map((f) => ({
        blueprint: f.blueprint,
        graph: f.graph,
        message: f.message,
      })),
      fix: list[0].fix,
    }))
    .sort((a, b) => b.cost - a.cost || b.count - a.count);

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
