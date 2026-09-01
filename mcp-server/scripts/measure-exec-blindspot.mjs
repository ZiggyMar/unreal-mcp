#!/usr/bin/env node
// How much execution was invisible because an exec input pin was not called "execute"?
//
// execTargets accepted a target pin only if it matched /^(execute|exec|in|then)$/i. A Timeline has
// none of those - its exec inputs are Play, PlayFromStart, Stop, Reverse, ReverseFromEnd and
// SetNewTime - so every execution wire into a timeline was dropped. The chain stopped there and the
// nodes past it were reported as reached by nothing.
//
// That is not cosmetic. explain_graph described live logic as dead ("nothing wired to it"), and
// audit.ts builds liveNodeIds from the same chains, so everything downstream of a timeline was a
// dead-node finding.
//
// This counts the blind spot across the whole project rather than arguing about it: every exec link
// the old rule rejected and the new one accepts, and how many nodes hang off them.
//
// Run: node scripts/measure-exec-blindspot.mjs [pathPrefix]

import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { isExecInput, EXEC_INPUT } from "../dist/execFlow.js";

const prefix = process.argv[2] ?? "/Game/AntiVirusSquad";
const bridge = new UnrealBridgeClient();

const list = await bridge.send("list_blueprints", { pathPrefix: prefix, maxResults: 500 });
const paths = (list.blueprints ?? [])
  .map((b) => (typeof b === "string" ? b : b.path))
  .filter(Boolean);

console.log(`Scanning ${paths.length} Blueprint(s) under ${prefix}\n`);

let missedLinks = 0;
let graphsAffected = 0;
const byPinName = new Map();
const byNodeType = new Map();
const examples = [];

for (const path of paths) {
  let graphs;
  try {
    graphs = await bridge.send("list_blueprint_graphs", { path });
  } catch {
    continue;
  }
  for (const g of graphs.graphs ?? []) {
    const name = g.name;
    if (!name) continue;
    let summary;
    try {
      summary = await bridge.send("read_blueprint_graph_summary", { path, graphName: name });
    } catch {
      continue;
    }
    const nodes = summary.nodes ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let hitsHere = 0;
    for (const node of nodes) {
      for (const pin of node.connectedPins ?? []) {
        if (pin.direction !== "out") continue;
        for (const link of pin.linkedTo ?? []) {
          const target = byId.get(link.node);
          if (!target) continue;
          const wasSeen = EXEC_INPUT.test(link.pin);
          const isSeen = isExecInput(target, link.pin);
          if (!wasSeen && isSeen) {
            missedLinks++;
            hitsHere++;
            byPinName.set(link.pin, (byPinName.get(link.pin) ?? 0) + 1);
            const t = (target.type ?? "?").replace(/^K2Node_/, "");
            byNodeType.set(t, (byNodeType.get(t) ?? 0) + 1);
            if (examples.length < 8) {
              examples.push(
                `${path.split("/").pop()} / ${name}: ${node.title ?? node.id} -> ${target.title ?? target.id}.${link.pin}`
              );
            }
          }
        }
      }
    }
    if (hitsHere > 0) graphsAffected++;
  }
}

console.log(`  execution links previously invisible : ${missedLinks}`);
console.log(`  graphs affected                      : ${graphsAffected}\n`);

console.log("  by target pin name");
for (const [k, v] of [...byPinName].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(5)}  ${k}`);
}
console.log("\n  by target node type");
for (const [k, v] of [...byNodeType].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(5)}  ${k}`);
}
console.log("\n  examples");
for (const e of examples) console.log(`    ${e}`);
