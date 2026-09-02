#!/usr/bin/env node
// Break the code on purpose and see whether the suite notices.
//
// 891 tests pass. That is a statement about the tests, not about the code: a test can assert the
// wrong thing and pass forever. Three were nearly written that way in a single session - one that
// checked a field had MOVED rather than that the reply was unchanged, one that would have demanded a
// retype succeed when the honest answer was that it had been declined, one that could have passed by
// never starting a server at all.
//
// So: change one operator, run the suite, put it back. A mutant that survives is a claim nothing is
// checking.
//
// ## Reading the result
//
// A surviving mutant means one of TWO things and they are easy to confuse:
//
//   - a missing test, or
//   - code that does not matter.
//
// The first survivor found here was the second kind. `rankCandidates` has an early return for an
// empty needle, and removing it changed nothing - because the substring arm below already requires
// three characters, so an empty needle can never reach it. The way to tell them apart is to ask what
// the mutant RETURNS, not to assume a hole.
//
// ## Why it derives the mutations
//
// A hand-written list of "things to break" is a hand-maintained index, and this repo has watched four
// of those rot. These come from the source: every comparison and boolean operator is a decision, and
// flipping one is the smallest change that alters behaviour.
//
// Usage:
//   node scripts/mutate.mjs src/matchTerms.ts            one file, up to 12 mutants
//   node scripts/mutate.mjs src/audit.ts --max 4         fewer, when the suite is slow
//   node scripts/mutate.mjs src/a.ts src/b.ts            several files
//
// Each mutant costs a full `npm test` (about a minute), so this is an on-demand tool for code you
// just changed, not part of the suite.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One flip per entry, each the smallest change that alters a decision.
 *
 * Deliberately not arithmetic (`+` to `-`): those produce mutants that are obviously absurd and
 * usually caught by the first assertion, which tells you nothing you did not know. A boundary or a
 * boolean is where real defects live.
 */
const FLIPS = [
  [">=", ">"],
  ["<=", "<"],
  [" > ", " >= "],
  [" < ", " <= "],
  ["===", "!=="],
  ["!==", "==="],
  [" && ", " || "],
  [" || ", " && "],
];

const argv = process.argv.slice(2);
const maxIndex = argv.indexOf("--max");
const MAX = maxIndex >= 0 ? Number(argv[maxIndex + 1]) : 12;
// Drop the flag AND its value - otherwise `--max 4` leaves a bare "4" that reads as a filename, and
// the failure is a confusing ENOENT on a file called "4" rather than a complaint about the flag.
const files = argv.filter((a, i) => !a.startsWith("--") && i !== maxIndex + 1);

if (maxIndex >= 0 && !Number.isFinite(MAX)) {
  console.error(`--max needs a number, got ${JSON.stringify(argv[maxIndex + 1])}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error("usage: node scripts/mutate.mjs <file.ts> [more.ts ...] [--max N]");
  process.exit(2);
}

/** Lines that are comment or blank. Mutating prose proves nothing and wastes a minute per attempt. */
function isProse(line) {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function runSuite() {
  const r = spawnSync("npm", ["test"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    shell: true,
    timeout: 15 * 60 * 1000,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // Green means BOTH: the runner exited 0 and said so. Trusting the exit code alone has bitten this
  // repo before, in the build script, for the same reason.
  return r.status === 0 && /# fail 0/.test(out);
}

let planned = 0;
const survivors = [];
let attempted = 0;

for (const relative of files) {
  const path = join(SERVER_DIR, relative);
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");

  // Collect candidates first, so the report can say how many were skipped for the cap rather than
  // silently stopping - a truncated audit that looks complete is the failure this repo keeps finding.
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    if (isProse(lines[i])) continue;
    for (const [from, to] of FLIPS) {
      if (lines[i].includes(from)) candidates.push({ line: i, from, to });
    }
  }
  planned += candidates.length;

  for (const c of candidates) {
    if (attempted >= MAX) break;
    attempted++;
    const mutatedLines = [...lines];
    mutatedLines[c.line] = mutatedLines[c.line].replace(c.from, c.to);
    writeFileSync(path, mutatedLines.join("\n"), "utf8");
    let caught;
    try {
      caught = !runSuite();
    } finally {
      // Always, on every path. A mutation script that leaves the tree broken is worse than no
      // mutation script.
      writeFileSync(path, original, "utf8");
    }
    const where = `${relative}:${c.line + 1}`;
    const what = `${c.from.trim()} -> ${c.to.trim()}`;
    console.log(`${caught ? "caught    " : "SURVIVED  "} ${where.padEnd(38)} ${what}`);
    if (!caught) survivors.push({ where, what, source: lines[c.line].trim().slice(0, 90) });
  }
}

// Rebuild, because the last thing written was the original but dist still holds the last mutant.
spawnSync("npm", ["run", "emit"], { cwd: SERVER_DIR, shell: true });

console.log(`\n${attempted} mutant(s) run of ${planned} possible${planned > attempted ? ` (capped at ${MAX})` : ""}.`);
if (survivors.length === 0) {
  console.log("Every one was caught.");
} else {
  console.log(`\n${survivors.length} survived - each is EITHER a missing test OR code that does not matter:\n`);
  for (const s of survivors) {
    console.log(`  ${s.where}  ${s.what}`);
    console.log(`      ${s.source}`);
  }
  console.log(
    `\n  Before writing a test: apply the mutation by hand and ask what it RETURNS. If the answer is\n` +
      `  unchanged, the line is redundant and a test would be pinning nothing.`
  );
}
