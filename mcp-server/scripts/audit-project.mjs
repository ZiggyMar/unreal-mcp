#!/usr/bin/env node
// Audit every Blueprint in a project and rank what is worth fixing.
//
// The tools here answer questions one Blueprint at a time, which is the right shape for an agent
// mid-task and the wrong shape for the question people actually arrive with: *"my game has bugs and
// a deadline, where do I look?"*
//
// So this walks the whole project, runs every check that exists, and sorts the result by how much
// the finding is likely to cost. It reads nothing an agent would not read - the same index and graph
// summaries - so the cost is bounded and predictable rather than "read everything".
//
// Usage:
//   node scripts/audit-project.mjs [--prefix /Game] [--limit 200] [--json out.json]
//
// Ordering is deliberate and stated in the output, because a list of two hundred findings sorted by
// nothing is the same as no list.

import { writeFileSync } from "node:fs";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { reviewBlueprint } from "../dist/review.js";
import { explainGraph } from "../dist/explainGraph.js";
import { findServerOnlyCasts } from "../dist/multiplayer.js";

const bridge = new UnrealBridgeClient({
  host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
});

const valueOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PREFIX = valueOf("--prefix", "/Game");
const LIMIT = Number(valueOf("--limit", "200"));
const JSON_OUT = valueOf("--json", null);

/**
 * What a finding is likely to cost, which is not the same as how loud it is.
 *
 * A dead event is cosmetic until the day someone wires it. A server write that no client sees is a
 * bug report from a playtest that nobody can reproduce alone. The order here is the order a person
 * with two weeks before a showcase should work in.
 */
const COST = {
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

const WHY_IT_COSTS = {
  "cast-to-server-only-class":
    "A GameMode exists only on the server. On every client the cast fails silently and every node after it never runs. Single-player testing cannot see it.",
  "server-writes-unreplicated":
    "Shows up as 'it works for the host'. Nobody can reproduce it alone, which is why it survives to a showcase.",
  "unhandled-cast-failure":
    "The classic silent nothing-happens. The chain simply stops, with no error and no clue.",
  "level-sweep-every-frame": "Walks every actor in the level, 60+ times a second.",
  "spawn-every-frame": "The most expensive thing a Blueprint can do, repeated per frame.",
  "state-outlives-owner": "Resets on death or respawn, so it looks correct until someone dies.",
  "cast-every-frame": "Not free, and the answer does not change.",
  "branch-dead-path": "One side of a decision does nothing. Often correct; often the bug.",
  "tick-heavy": "Runs every frame whether or not anything changed.",
};

const est = (value) => Math.round(JSON.stringify(value).length / 4);

async function main() {
  const started = Date.now();
  const ping = await bridge.send("ping", {});
  console.log(`auditing ${ping.project} on UE ${ping.engineVersion}, prefix ${PREFIX}\n`);

  const overview = await bridge.send("get_project_overview", {});
  console.log(
    `${overview.blueprintCount} Blueprints, ${overview.totalGraphs} graphs, ${overview.totalNodes} nodes\n`
  );

  const listed = await bridge.send("list_blueprints", { pathPrefix: PREFIX });
  const blueprints = (listed.blueprints ?? []).slice(0, LIMIT);

  const findings = [];
  const failures = [];

  // Which classes are server-only, asked once and cached.
  //
  // Answering this by name would be a guess: a project's GameModes are called things like
  // AVSBaseGameMode and GM_Gameplay, neither of which contains "GameModeBase". The engine knows its
  // own hierarchy, so ask it - once per distinct cast target, not once per cast.
  // Blueprint classes resolve by asset path; the name in a graph title ("Cast To GM_Gameplay") is
  // the asset name. Map one to the other from the listing already in hand rather than guessing.
  const pathOfBlueprint = new Map((listed.blueprints ?? []).map((x) => [x.name, x.path]));
  const serverOnlyCache = new Map();
  const isServerOnlyClass = (className) => serverOnlyCache.get(className) === true;
  const learnClass = async (className) => {
    if (serverOnlyCache.has(className)) return;
    try {
      const described = await bridge.send("describe_class", { className: pathOfBlueprint.get(className) ?? className });
      serverOnlyCache.set(className, described.serverOnly === true);
    } catch {
      // A cast target that cannot be resolved is not something to guess about.
      serverOnlyCache.set(className, false);
    }
  };
  let tokensRead = 0;
  let done = 0;

  for (const bp of blueprints) {
    const path = bp.path ?? bp;
    const name = bp.name ?? String(path).split("/").pop();
    done += 1;
    process.stdout.write(`\r  reviewing ${done}/${blueprints.length}  ${name.slice(0, 40).padEnd(40)}`);
    try {
      // includeGraphNodes: the cast check needs the same nodes the review just read. Without it
      // every graph is read twice, which took a 339-Blueprint audit from under a minute to twenty.
      const review = await reviewBlueprint(bridge, path, undefined, { includeGraphNodes: true });
      tokensRead += est(review);
      for (const graph of review.graphs ?? []) {
        for (const finding of graph.findings ?? []) {
          findings.push({
            blueprint: name,
            path,
            graph: graph.graphName,
            check: finding.check,
            severity: finding.severity,
            message: finding.message,
            fix: finding.fix,
            cost: COST[finding.check] ?? 1,
          });
        }
      }
      // Casting to a server-only class, which needs the graph and the owner's own class together.
      const ownerServerOnly = await (async () => {
        await learnClass(name);
        return isServerOnlyClass(name);
      })();
      for (const summary of review.graphNodes ?? []) {
        for (const node of summary.nodes ?? []) {
          const match = /^Cast To (.+)$/i.exec((node.title ?? "").trim());
          if (match) await learnClass(match[1].trim());
        }
        for (const finding of findServerOnlyCasts(summary.nodes ?? [], isServerOnlyClass, ownerServerOnly)) {
          findings.push({
            blueprint: name,
            path,
            graph: summary.graphName,
            check: finding.check,
            severity: finding.severity,
            message: finding.message,
            fix: finding.fix,
            cost: COST[finding.check] ?? 1,
          });
        }
      }

      for (const finding of review.blueprint ?? []) {
        findings.push({
          blueprint: name,
          path,
          graph: "(whole asset)",
          check: finding.check,
          severity: finding.severity,
          message: finding.message,
          fix: finding.fix,
          cost: COST[finding.check] ?? 1,
        });
      }
    } catch (err) {
      failures.push({ name, error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
  }
  process.stdout.write("\r" + " ".repeat(70) + "\r");

  findings.sort((a, b) => b.cost - a.cost);

  // Grouped by kind, because "seventeen Blueprints have the same problem" is one decision, not
  // seventeen.
  const byCheck = new Map();
  for (const finding of findings) {
    if (!byCheck.has(finding.check)) byCheck.set(finding.check, []);
    byCheck.get(finding.check).push(finding);
  }
  const groups = [...byCheck.entries()].sort((a, b) => (COST[b[0]] ?? 1) - (COST[a[0]] ?? 1));

  console.log(`${findings.length} finding(s) across ${blueprints.length} Blueprint(s)`);
  console.log(`~${tokensRead} tokens of reading, ${((Date.now() - started) / 1000).toFixed(0)}s\n`);
  console.log("Ordered by what it is likely to cost, not by how loud it is.\n");

  for (const [check, list] of groups) {
    const cost = COST[check] ?? 1;
    console.log(`${check}  (${list.length})  [cost ${cost}]`);
    if (WHY_IT_COSTS[check]) console.log(`  ${WHY_IT_COSTS[check]}`);
    for (const finding of list.slice(0, 6)) {
      console.log(`    ${finding.blueprint} / ${finding.graph}: ${finding.message.slice(0, 105)}`);
    }
    if (list.length > 6) console.log(`    ...and ${list.length - 6} more`);
    console.log("");
  }

  if (failures.length > 0) {
    console.log(`${failures.length} Blueprint(s) could not be reviewed:`);
    for (const failure of failures.slice(0, 8)) console.log(`  ${failure.name}: ${failure.error}`);
    console.log("");
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ project: ping.project, findings, failures }, null, 2));
    console.log(`written to ${JSON_OUT}`);
  }
}

main().catch((err) => {
  console.error(`audit failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
