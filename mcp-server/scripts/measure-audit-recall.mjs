#!/usr/bin/env node
// Of the bugs the GAME actually hits, how many does static analysis find first?
//
// Runtime errors are the only ground truth this project has. A finding from the audit is an opinion
// about what might go wrong; a line in the PIE log is a thing that DID. So the log is a labelled
// test set, and the honest question is how much of it the static checks already cover.
//
// This exists because of one miss. review_blueprint returned 35 findings for PC_Gameplay and not
// one of them was the null GM_Gameplay read the game logs twice a session - the check looked at
// Cast nodes and this project caches the GameMode in a variable. That gap was invisible until the
// two sources were put side by side, which nothing did.
//
// Measured against auditProject, NOT reviewBlueprint. The first version of this script used review,
// and that was wrong in a way worth recording: the multiplayer checks - cast-to-server-only-class,
// reads-server-only-variable, server-writes-unreplicated - run only in the audit. Reviewing each
// Blueprint therefore scored the audit's best checks as absent and reported a recall the tooling
// was never going to hit. A harness that measures the wrong surface is worse than no harness,
// because its number gets believed.
//
// A miss here is not automatically a defect. Whether an array Get is in range depends on what is in
// the array, and no static check can know that. The number is a place to look, not a score.
//
// Run: node scripts/measure-audit-recall.mjs [pathPrefix]

import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { summariseRuntimeLog, logFileFor } from "../dist/runtimeLog.js";
import { auditProject } from "../dist/audit.js";
import { readFileSync } from "node:fs";

const bridge = new UnrealBridgeClient();
const prefix = process.argv[2] ?? "/Game/AntiVirusSquad";

const ping = await bridge.send("ping", {});
const logPath = logFileFor(ping.projectFile ?? "");
const runtime = summariseRuntimeLog(readFileSync(logPath, "utf8"));

// Only issues that name a Blueprint AND a graph. The rest are engine-level, and there is nothing
// for a Blueprint check to have caught.
const grounded = (runtime.issues ?? []).filter((i) => i.blueprint && i.graph);
if (grounded.length === 0) {
  console.log("No Blueprint-attributed runtime errors in the last session. Nothing to measure.");
  process.exit(0);
}

console.log(`Runtime-confirmed bugs vs what static analysis reports\n`);
console.log(`  log:   ${logPath}`);
console.log(`  scope: ${prefix}`);
console.log(`  ${grounded.length} Blueprint-attributed issue(s) from ${runtime.errorCount} errors\n`);

process.stdout.write("  auditing... ");
// detailedGroups and examplesPerGroup at their maximums, because the default reply shows four
// groups with three examples each - right for a model reading it, wrong for measuring DETECTION.
// Without this the harness cannot tell "the audit never found it" from "the audit found it and the
// reply had no room to say so", and it would report the first while meaning the second.
const audit = await auditProject(bridge, {
  pathPrefix: prefix,
  limit: 2000,
  detailedGroups: 30,
  examplesPerGroup: 10,
});
const truncated = (audit.groups ?? []).filter((g) => g.count > (g.examples ?? []).length);
console.log(`${audit.findingCount} finding(s) across ${audit.blueprintsScanned} Blueprint(s)`);
if (truncated.length > 0) {
  // Said out loud, because a "missed" caused by truncation is a wrong answer wearing the right shape.
  console.log(
    `  NOTE: ${truncated.length} group(s) list fewer examples than they found ` +
      `(${truncated.map((g) => `${g.check} ${(g.examples ?? []).length}/${g.count}`).join(", ")}).` +
      ` A "missed" in one of those checks may be truncation rather than absence.`
  );
}
console.log("");

// Findings are grouped for the reply; the flat list is what matching needs.
const flat = (audit.groups ?? []).flatMap((g) =>
  (g.examples ?? []).map((e) => ({ check: g.check, ...e }))
);

console.log(`  ${"hits".padStart(5)}  ${"blueprint".padEnd(24)}${"graph".padEnd(22)}${"property".padEnd(26)}verdict`);
console.log(`  ${"-".repeat(5)}  ${"-".repeat(24)}${"-".repeat(22)}${"-".repeat(26)}${"-".repeat(34)}`);

let caught = 0;
const missed = [];

for (const issue of grounded) {
  const prop = (issue.property ?? "").toLowerCase();
  // Same Blueprint, same graph, and the finding actually names the property. Matching on the
  // Blueprint alone would score any unrelated warning as a hit, which is how a recall number
  // becomes a lie.
  const hit = flat.find((f) => {
    if (f.blueprint !== issue.blueprint) return false;
    const text = `${f.message ?? ""} ${f.variable ?? ""}`.toLowerCase();
    if (prop.length === 0 || !text.includes(prop)) return false;
    // The graph matches if the finding is FILED under it, or if the message names it.
    //
    // Findings about one variable are collapsed to one per Blueprint, so the `graph` field holds
    // whichever site survived and the rest are listed in the message. Testing only the field scored
    // a finding that names the faulting graph in its own text as a miss - which would have sent
    // someone to add a check that already exists.
    const graph = String(issue.graph ?? "").toLowerCase();
    return !f.graph || !graph || f.graph.toLowerCase() === graph || text.includes(graph);
  });

  const row =
    `  ${String(issue.count).padStart(5)}  ${issue.blueprint.padEnd(24)}` +
    `${String(issue.graph).slice(0, 21).padEnd(22)}${String(issue.property).slice(0, 25).padEnd(26)}`;

  if (hit) {
    caught += 1;
    console.log(`${row}CAUGHT (${hit.check})`);
  } else {
    missed.push(issue);
    const same = flat.filter((f) => f.blueprint === issue.blueprint).length;
    console.log(`${row}missed (${same} finding(s) elsewhere in it)`);
  }
}

const total = caught + missed.length;
console.log(`\n  ${caught}/${total} runtime-confirmed bugs are reported by static analysis.\n`);

if (missed.length > 0) {
  console.log("  Missed, worth deciding about one at a time:");
  for (const m of missed) {
    console.log(`    ${m.blueprint}.${m.graph} - ${m.property} (${m.count} hits at runtime)`);
  }
  console.log(
    "\n  Not every miss is a defect. Whether an array Get is in range depends on what is in the\n" +
      "  array, and no static check can know that. The ones worth acting on are those where the\n" +
      "  reason it is null is visible in the graph."
  );
}
