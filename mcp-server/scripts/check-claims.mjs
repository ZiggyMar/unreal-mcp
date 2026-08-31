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
    figure: "2,669",
    what: "list_blueprints unfiltered, in the `minimal` profile instructions",
    verifiedBy: "not watched live - re-measured by hand 2026-08-31, exact",
  },
  {
    figure: "3,237",
    what: "read_class_defaults, in the HOW TO WORK instructions",
    verifiedBy: "measure:reads (fails at 30% drift)",
  },
  {
    figure: "2,328",
    what: "read_blueprint_summary on a 59-node graph, in the explain_graph description",
    verifiedBy: "not watched live - re-measured by hand 2026-08-31, exact",
  },
  {
    figure: "540",
    what: "list_tools, in the enable_tools description",
    verifiedBy: "not watched live - re-measured by hand 2026-08-31, 551 against \"about 540\"",
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
