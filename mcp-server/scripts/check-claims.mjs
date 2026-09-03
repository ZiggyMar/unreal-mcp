#!/usr/bin/env node
// Every token figure a model reads must have something watching it.
//
// This server tells models what things cost, and those numbers are load-bearing: a model choosing
// between unreal_explain_graph and unreal_read_blueprint_summary is choosing on the figures in their
// descriptions. Three of them have now gone stale and been caught by accident rather than by a check:
//
//   read_class_defaults   quoted 4,728, measured 3,237   caught while measuring something else
//   list_data_table_rows  quoted 7,040, measured 5,472   caught while measuring something else
//   explain_graph         quoted ~8,800, measured 2,328  caught while investigating an inversion
//
// Every one drifted DOWNWARD, because this repo keeps making replies cheaper - compact JSON, float
// trimming, deduplicated fixes - and nothing walks back through the prose afterwards. So the tool
// undersells itself to the one reader whose decision depends on the number, which is the "the tool
// disagrees with the person using it" failure this project keeps finding in new places.
//
// measure:reads verifies three figures live against a real editor. That is the right check and it is
// not enough on its own, because it is a hand-written list: it cannot notice a FOURTH claim being
// added, and this repo has learned four separate times that a hand-maintained index rots. So this
// guard does the half that can run without an editor, and does it by FINDING rather than being told:
//
//   1. every token figure in text a model reads must be registered below
//   2. every registered figure must still appear in the source
//
// What it deliberately does not claim: this does not prove a number is TRUE. Only a live measurement
// does that, and measure:reads is where that happens. This proves something narrower and still worth
// having - that no figure a model reads has appeared without anyone deciding who watches it.
//
// Run: npm run check:claims  (also part of npm test)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Figures a model reads, and what watches each one.
//
// `verifiedBy` must name a real check or say plainly that there is not one. "not watched" is an
// allowed answer and an honest one; what is not allowed is a number nobody has thought about.
const CLAIMS = [
  {
    figure: "438",
    what: "read_blueprint_summary outline=true on BP_Player's 990-node EventGraph, in the `outline` description",
    // Measured live against the real project: 438 tokens for 83 system names, against tens of
    // thousands for the same graph read as nodes. Not watchable by a script - it depends on the
    // Blueprint having comment boxes, and a scratch project has none, so there is nothing for a
    // scripted check to measure. The claim is about the shape of the saving; the number is exact for
    // the graph it names.
    verifiedBy: "not watched live - measured by hand against BP_Player 2026-09-03, exact",
  },
  {
    figure: "2,669",
    what: "list_blueprints unfiltered, in the `minimal` profile instructions",
    verifiedBy: "not watched live - re-measured by hand 2026-08-31, exact",
  },
  {
    figure: "1,691",
    what: "read_class_defaults, in the HOW TO WORK instructions",
    // measure:reads no longer keeps its own copy of this number - it reads it back out of the
    // server's own instructions and compares that to what it measures, so the sentence and the
    // check cannot drift apart. They had: the sentence was corrected to 1,691 and the guard kept
    // failing against its stale 3,237, which is how a guard teaches people to ignore it.
    verifiedBy: "measure:reads (extracts the figure from the live instructions, fails at 15% drift)",
  },
  {
    figure: "1,996",
    what: "read_blueprint_summary on a 56-node graph, in the explain_graph description",
    // Was 2,328 on a 59-node graph and unwatched. Now measured on the largest graph UNDER the
    // structural read's 60-node cap, which measure:reads picks deterministically - above the cap
    // the pair is not comparable at all, because the structure returns 60 nodes of 819 while the
    // explanation returns all of them.
    // Its partner in the same sentence, 337, is deliberately not registered here: this script scans
    // for comma-formatted figures, so a three-digit number is invisible to it. measure:reads checks
    // that half of the pair instead, which is the guard that can actually see it.
    verifiedBy: "measure:reads (comparable-graph pair, fails at 15% drift)",
  },
  {
    figure: "540",
    what: "list_tools, in the enable_tools description",
    verifiedBy: "not watched live - re-measured by hand 2026-08-31, 551 against \"about 540\"",
  },
  {
    figure: "1,458",
    what: "standing context after three journeys run through call_tool, in the call_tool description",
    verifiedBy: "trial:workflows --dispatch (prints standing and tool-list changes)",
  },
  {
    figure: "17,302",
    what: "standing context after the same three journeys run by enabling groups, in the call_tool description",
    verifiedBy: "trial:workflows (prints standing after enables); measured 2026-09-01",
  },
  // --- docs/AGENT_WORKFLOW.md, served verbatim to models by loadDoc() -----------------------------
  //
  // None of these were registered until the scan below was widened to the served guides. Two of them
  // were also wrong: the guide said the `search` profile was "four tools, about 2,200 tokens" when
  // check:profiles has it at five tools and 2,523.
  {
    figure: "2,523",
    what: "the `search` profile's standing cost, quoted twice in the workflow guide",
    verifiedBy: "check:profiles (measures every profile each run and fails outside its ceiling)",
  },
  {
    figure: "1,008",
    what: "enabling the three tools a symptom reply names, in the workflow guide",
    verifiedBy:
      "dispatch.test.mjs asserts the ADVICE (call_tool first, no groups:); the figure itself is " +
      "not watched live - measured by hand 2026-09-02 on the search profile, exact",
  },
  {
    figure: "16,381",
    what: "enabling the two groups holding those three tools, the comparison in the workflow guide",
    verifiedBy:
      "not watched live - measured by hand 2026-09-02, exact. Drifts whenever core or scene gains a " +
      "tool, and drift only widens the gap the sentence is making, so a stale figure here understates",
  },
  {
    figure: "557",
    what: "the larger of the two discovery-reply costs quoted in the workflow guide",
    verifiedBy:
      "not watched live - measured by hand 2026-09-02. Its partner 455 is invisible to this scan, " +
      "which only sees comma-formatted figures, so this half is the one that can be registered",
  },
];

const problems = [];
const found = [];

// A figure is model-facing if it is NOT on a comment line. Comments in this repo carry measurements
// too - 60 of them - but those are records of why a design exists, dated by the commit that made
// them. Nobody acts on a comment. The distinction is the whole point of this guard: it would be
// useless if it demanded every historical note be kept current, and it would be noise nobody runs.
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
  const lines = readFileSync(join(srcDir, file), "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    for (const match of line.matchAll(/([0-9][0-9,]{2,6})\s*tokens?/g)) {
      found.push({ figure: match[1], file: `src/${file}`, line: index + 1, text: line.trim() });
    }
  }
}

// The guides count as text a model reads, because they are.
//
// This script's own header says "every token figure a model reads must have something watching it",
// and it scanned src/ only. docs/AGENT_WORKFLOW.md is not a repo document: loadDoc() reads it off
// disk and returns it verbatim as the body of unreal_guide, so every figure in it is quoted to a
// model with exactly the authority of a figure in a tool description - and none of them were
// registered here.
//
// Found by putting two figures into that guide and watching this guard pass. They were also 10% out,
// from an ad-hoc estimator, which is precisely the drift the registry exists to catch.
//
// The file list is DERIVED, from the loadDoc calls in the server. A hardcoded list would rot the
// moment a fourth guide was served, and this repo has learned four separate times that a
// hand-maintained index rots. docs/ holds a dozen other files - status reports, audits, the
// competitive landscape - which are full of figures and are read by people, not models. Those are
// out of scope on purpose, and the way this list is built is what keeps that line honest rather
// than asserted.
const serverSource = readFileSync(join(srcDir, "index.ts"), "utf8");
const servedDocs = [...new Set([...serverSource.matchAll(/loadDoc\(\s*"([A-Za-z0-9_]+\.md)"/g)].map((m) => m[1]))];
if (servedDocs.length === 0) {
  problems.push(
    "no loadDoc() calls found in src/index.ts, so the served-guide scan below is checking nothing. " +
      "Either the guides stopped being served that way, or this pattern needs updating."
  );
}
const docsDir = join(here, "..", "..", "docs");
for (const doc of servedDocs) {
  let lines;
  try {
    lines = readFileSync(join(docsDir, doc), "utf8").split("\n");
  } catch {
    problems.push(`src/index.ts serves docs/${doc} to models, but it is not on disk.`);
    continue;
  }
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/([0-9][0-9,]{2,6})\s*tokens?/g)) {
      found.push({ figure: match[1], file: `docs/${doc}`, line: index + 1, text: line.trim() });
    }
  }
}

const registered = new Set(CLAIMS.map((c) => c.figure));
const unwatched = found.filter((f) => !registered.has(f.figure));
if (unwatched.length > 0) {
  problems.push(
    `${unwatched.length} token figure(s) are in text a model reads, and nothing is watching them:\n` +
      unwatched
        .map((f) => `    - ${f.figure} at ${f.file}:${f.line}\n        ${f.text.slice(0, 110)}`)
        .join("\n") +
      `\n  Measure it, then add it to CLAIMS in this script saying what verifies it. If nothing does,\n` +
      `  say that - an unwatched number you have decided to accept is fine; one nobody noticed is not.`
  );
}

// The other direction, which is the one that actually rotted elsewhere in this repo: measure:reads
// records `where` a number is quoted as free prose, and nothing has ever checked that the quote is
// still there. A registry entry for a figure that has been edited away is a guard watching nothing
// while reporting ok.
const seen = new Set(found.map((f) => f.figure));
const orphaned = CLAIMS.filter((c) => !seen.has(c.figure));
if (orphaned.length > 0) {
  problems.push(
    `${orphaned.length} registered figure(s) no longer appear in any model-facing text:\n` +
      orphaned.map((c) => `    - ${c.figure} (${c.what})`).join("\n") +
      `\n  Either the text was reworded and this entry is stale, or the claim was dropped. Remove the\n` +
      `  entry. A registry listing numbers that are not there is a check that watches nothing.`
  );
}

if (problems.length > 0) {
  console.error("\nclaim check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

const live = CLAIMS.filter((c) => !c.verifiedBy.startsWith("not watched")).length;
console.log(
  `claims ok: ${found.length} token figure(s) in model-facing text, all registered; ` +
    `${live} watched by a live measurement, ${CLAIMS.length - live} re-measured by hand`
);
