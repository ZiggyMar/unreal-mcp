#!/usr/bin/env node
// The layout figures this repo quotes as evidence, checked against the project they came from.
//
// "306 execution wires with 0 backwards" is the evidence behind the rightward-flow rule, and it was
// quoted in five places: layoutReview, layoutTidy, the review_layout description, AGENT_WORKFLOW and
// the README. It was taken with a detector that could not see a Branch's `else` output, so it was
// wrong in all five, and it survived for weeks because it agreed with what everybody believed.
//
// check:claims watches TOKEN figures and says plainly that it cannot prove a number is true. Nothing
// watched these. A rule justified by a number nobody re-measures is a rule nobody can check.
//
// So this re-measures them live, the same way measure:reads does for reply sizes. It needs an editor
// open on the project the figures came from, which is why it is not part of `npm test`: a check that
// cannot run is worse than none, because it gets disabled and then ignored.
//
// What it deliberately does NOT do is fail on small drift. These are somebody's live Blueprints and
// they change; the point is to notice when a quoted figure stops describing the project, not to
// freeze the project. Anything past the tolerance is reported with both numbers so a person decides.
//
// Usage: node scripts/measure-layout.mjs [--json]   (needs an editor open on the AVS project)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/**
 * The figures, where they are quoted, and how far they may drift.
 *
 * `tolerance` is a fraction. Wire counts move when somebody adds a feature; a convention like "2-word
 * titles" should not move at all, so it gets 0.
 */
const CLAIMS = [
  { key: "execWires", label: "hand-maintained execution wires", expect: 369, tolerance: 0.15,
    quotedIn: ["src/layoutReview.ts", "src/layoutTidy.ts", "src/index.ts", "docs/AGENT_WORKFLOW.md", "README.md"] },
  { key: "backwardWires", label: "of them running backwards", expect: 0, tolerance: 0,
    quotedIn: ["src/layoutReview.ts", "docs/AGENT_WORKFLOW.md", "README.md"] },
  { key: "wireMedian", label: "wire median", expect: 272, tolerance: 0.2, quotedIn: ["src/layoutReview.ts"] },
  { key: "wireP90", label: "wire p90", expect: 608, tolerance: 0.2, quotedIn: ["src/layoutReview.ts", "src/layoutTidy.ts"] },
  { key: "wireMax", label: "wire max", expect: 3632, tolerance: 0.25, quotedIn: ["src/layoutReview.ts"] },
];

const CONVENTIONS = [
  { key: "nodesInABox", label: "nodes inside a comment box", expect: "54%", tolerance: 0.15 },
  { key: "boxTitleWords", label: "words in a box title", expect: 2, tolerance: 0 },
  { key: "shoutedTitles", label: "titles shouted in caps", expect: "3%", tolerance: 0.5 },
  { key: "boxedAboveNodes", label: "graph size at which boxing is the norm", expect: 50, tolerance: 0.25 },
];

const BP = "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player";
const PREFIX = "/Game/AntiVirusSquad";

function call(tool, args) {
  const out = execFileSync("node", [join(here, "call-tool.mjs"), tool, JSON.stringify(args), "--full"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000,
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const num = (v) => (typeof v === "string" ? Number(v.replace("%", "")) : v);

function drifted(expect, actual, tolerance) {
  const e = num(expect), a = num(actual);
  if (!Number.isFinite(e) || !Number.isFinite(a)) return expect !== actual;
  if (e === 0) return a !== 0;
  return Math.abs(a - e) / e > tolerance;
}

const json = process.argv.includes("--json");
const problems = [];
const rows = [];

// The hand-maintained half of BP_Player: the graph every one of these figures was taken from.
// maxY 9000 is the boundary between his work and the generated system below it.
const hand = call("unreal_review_layout", { path: BP, maxY: 9000 });
for (const c of CLAIMS) {
  const actual = hand[c.key];
  const bad = drifted(c.expect, actual, c.tolerance);
  rows.push({ ...c, actual, bad });
  if (bad) problems.push(`${c.label}: quoted ${c.expect}, measured ${actual} (quoted in ${c.quotedIn.join(", ")})`);
}

// EventGraphs only, stated rather than inherited from a default.
//
// The conventions quoted in the source were measured over EventGraphs, and they MOVE with scope:
// including function graphs takes nodes-in-a-box from 54% to 41% and wire p90 from 464 to 544,
// because function graphs are small, single-purpose and rarely boxed. Both are true of what they
// measured. Leaving this to the tool's default would mean a later change of default silently
// reporting a scope difference as drift - a check that cries wolf is one that gets switched off.
const sweep = call("unreal_review_layout", { pathPrefix: PREFIX, includeFunctions: false });
for (const c of CONVENTIONS) {
  const actual = sweep.conventions?.[c.key];
  const bad = actual === undefined || drifted(c.expect, actual, c.tolerance);
  rows.push({ ...c, actual, bad, quotedIn: ["src/index.ts", "src/placeNewNodes.ts"] });
  if (bad) problems.push(`${c.label}: quoted ${c.expect}, measured ${actual}`);
}

if (json) {
  console.log(JSON.stringify({ rows, problems }, null, 2));
} else {
  console.log("\nLayout figures this repo quotes, re-measured against the project\n");
  console.log("  status  figure                                   quoted   measured");
  console.log("  ------  ---------------------------------------  -------  --------");
  for (const r of rows) {
    console.log(`  ${r.bad ? "DRIFT " : "ok    "}  ${r.label.padEnd(39)} ${String(r.expect).padStart(7)}  ${String(r.actual).padStart(8)}`);
  }
  console.log(`\n  ${sweep.graphs} graphs swept, ${hand.nodes} nodes in the hand-maintained half.`);
  if (problems.length > 0) {
    console.log(`\n${problems.length} figure(s) no longer describe the project:\n`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log("\nUpdate the text, or explain in it why the number is kept. A figure quoted as evidence");
    console.log("and never re-measured is how '306 execution wires' survived in five places while wrong.\n");
  } else {
    console.log("\n  Every quoted figure still describes the project.\n");
  }
}

process.exit(problems.length > 0 ? 1 : 0);
