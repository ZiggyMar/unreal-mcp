#!/usr/bin/env node
// Audit every Blueprint in a project and rank what is worth fixing.
//
// A thin terminal front end over src/audit.ts, which is also what the `unreal_audit_project` tool
// calls. One implementation, two ways in.
//
// It was a script first, and that is worth naming as a mistake: the most useful thing in the
// project was available to a person at a terminal and to nobody else, while the whole point is that
// an agent does this work for you.
//
// Usage:
//   node scripts/audit-project.mjs [--prefix /Game] [--limit 400] [--json out.json]
//
// Ordering is by likely cost rather than severity, and is stated in the output, because a list of
// eight hundred findings sorted by nothing is the same as no list.

import { writeFileSync } from "node:fs";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { auditProject } from "../dist/audit.js";

const bridge = new UnrealBridgeClient({
  host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
});

const valueOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

async function main() {
  const started = Date.now();
  const ping = await bridge.send("ping", {});
  const prefix = valueOf("--prefix", "/Game");
  console.log(`auditing ${ping.project ?? "(unnamed project)"} on UE ${ping.engineVersion ?? "?"}, prefix ${prefix}`);

  const overview = await bridge.send("get_project_overview", {}).catch(() => null);
  if (overview) {
    console.log(`${overview.blueprintCount} Blueprints, ${overview.totalGraphs} graphs, ${overview.totalNodes} nodes`);
  }
  console.log("");

  const result = await auditProject(bridge, {
    pathPrefix: prefix,
    limit: Number(valueOf("--limit", "400")),
    examplesPerGroup: Number(valueOf("--examples", "6")),
  });

  console.log(
    `${result.findingCount} finding(s) across ${result.blueprintsWithFindings} of ` +
      `${result.blueprintsScanned} Blueprint(s), in ${((Date.now() - started) / 1000).toFixed(0)}s`
  );
  console.log("");
  console.log("Ordered by what it is likely to cost, not by how loud it is.");
  console.log("");

  for (const group of result.groups) {
    console.log(`${group.check}  (${group.count})  [cost ${group.cost}]`);
    if (group.why) console.log(`  ${group.why}`);
    for (const example of group.examples) {
      console.log(`    ${example.blueprint} / ${example.graph}: ${example.message.slice(0, 105)}`);
    }
    if (group.count > group.examples.length) console.log(`    ...and ${group.count - group.examples.length} more`);
    console.log("");
  }

  if (result.worstBlueprints.length > 0) {
    console.log("Worth opening first, by accumulated cost:");
    for (const bp of result.worstBlueprints) {
      console.log(`  ${bp.name.padEnd(30)} cost ${String(bp.cost).padStart(5)}  (${bp.findings} findings)`);
    }
    console.log("");
  }

  if (result.unreadable.length > 0) {
    console.log(`${result.unreadable.length} Blueprint(s) could not be read:`);
    for (const bad of result.unreadable.slice(0, 8)) console.log(`  ${bad.name}: ${bad.error}`);
    console.log("");
  }

  if (result.truncated) {
    console.log("More Blueprints exist than were scanned. Raise --limit to cover the rest.");
    console.log("");
  }
  console.log(`Next: ${result.nextAction}`);

  const jsonOut = valueOf("--json", null);
  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(result, null, 2));
    console.log("");
    console.log(`written to ${jsonOut}`);
  }
}

main().catch((err) => {
  console.error(`audit failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
