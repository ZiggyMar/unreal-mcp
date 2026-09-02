#!/usr/bin/env node
// A `match` filter over a NAME must not be a plain substring test.
//
// Asset names, variable names, class names and automation test names contain no spaces. A filter
// written as `haystack.includes(needle)` therefore returns nothing for the way a person writes the
// name, and an empty result is indistinguishable from "this project has none" - so the caller can
// conclude the opposite of the truth. Measured across four tools before this was fixed:
//
//   list_blueprints         "shop upgrade"   0     "ShopUpgrade"   7
//   list_variables          "vacuum charge"  0     "VacuumCharge"  3
//   read_blueprint_summary  "vacuum charge"  0     "VacuumCharge"  5 nodes
//   explain_graph           "vacuum charge"  0     "VacuumCharge"  2 chains
//
// matchTerms.ts is the fix: split on whitespace, require every term, in any order. It is a strict
// superset, so converting a filter can never lose a result that the substring test would have found.
//
// This guard exists because the trap is invisible. Nothing failed, no test broke, and all four tools
// looked like they were filtering correctly. It surfaced only by trying a two-word query by hand,
// which nobody will remember to do for the NEXT filter somebody adds.
//
// Run: npm run check:matchfilters  (also part of npm test)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/**
 * Deliberate substring tests, per file, with how many and why.
 *
 * A COUNT, not just a filename. Matching by filename alone would let a new plain-substring filter
 * added to index.ts inherit the allowance of a guide search three hundred lines away, which is the
 * false confidence this guard exists to prevent.
 *
 * The question is always the same: is the haystack a NAME or is it prose? A name has no spaces, so
 * a spaced query can never match it and the filter is broken for the most natural input. Prose has
 * spaces, so a literal phrase is a meaningful thing to look for.
 */
const ALLOWED = {
  "index.ts": {
    count: 5,
    why:
      "list_tools tests a tool name and its summary and reads a whole sentence on purpose (see " +
      "matchSymptoms), the tool near-miss compares two tool names to each other, and the two guide " +
      "searches look through documentation prose where a literal phrase is what a reader means",
  },
  "findInDataTables.ts": {
    count: 2,
    why:
      'Data Table values are prose - a Description reads "Turns weapon into a Machine Water Gun" - so ' +
      "a phrase search is the point of the tool, and the row-name search shares its query",
  },
};

const problems = [];
const counts = new Map();

for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(join(srcDir, file), "utf8");
  for (const line of text.split("\n")) {
    // The shape being hunted: a haystack tested against a single needle.
    if (!/\.includes\(\s*needle\s*\)/.test(line)) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
}

for (const [file, found] of counts) {
  const allowance = ALLOWED[file];
  if (!allowance) {
    problems.push(
      `${file} has ${found} plain substring filter(s) and no recorded reason. If the haystack is a ` +
        `NAME, use matchTerms/matchesAllTerms - a space in the query returns nothing today and reads ` +
        `as "the project has none". If it is prose, add ${file} to ALLOWED with the reason.`
    );
    continue;
  }
  if (found !== allowance.count) {
    problems.push(
      `${file} has ${found} plain substring filter(s); ${allowance.count} are accounted for. ` +
        `Allowed because: ${allowance.why}. A new one is not covered by that reason - convert it, or ` +
        `raise the count here with its own.`
    );
  }
}

// An allowance for a file that no longer has any is a note about nothing.
for (const file of Object.keys(ALLOWED)) {
  if (!counts.has(file)) {
    problems.push(`ALLOWED lists ${file}, which has no substring filters left. Delete the entry.`);
  }
}

if (problems.length > 0) {
  console.error(`\nmatch filter check failed (${problems.length} problem(s)):\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(
  `match filters ok: ${total} deliberate substring test(s) across ${counts.size} file(s), ` +
    `each with a recorded reason`
);
