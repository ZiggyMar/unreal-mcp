#!/usr/bin/env node
// The README's index of design notes, generated from its own headings.
//
// A hand-maintained index in this repo has rotted four separate times, and the README's own Contents
// block was the fifth: it described the document as "140-odd sections" when there were 293, and not
// one of the ~100 post-mortems appended over the last few sessions appeared in it. Nobody noticed,
// because nothing could.
//
// So this generates the list from the headings and fails when the file disagrees with it. Adding a
// section is now enough; remembering to index it is not a thing anyone has to do.
//
// Usage: node scripts/check-readme-index.mjs [--write]
//   --write   rewrite the index block in place
//   (no flag) fail if the block is not what it would generate
//
// Run: npm run check:index  (also part of npm test)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const README = join(here, "..", "README.md");

const BEGIN = "<!-- INDEX:BEGIN -->";
const END = "<!-- INDEX:END -->";

/**
 * GitHub's anchor rule, which is the only one that matters here: lowercase, strip everything that is
 * not a letter, digit, space or hyphen, then spaces to hyphens.
 *
 * Backticks, quotes, colons and em dashes all vanish rather than becoming hyphens, which is why this
 * is not a naive slugify - a link built the naive way looks right and goes nowhere.
 */
function anchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

const raw = readFileSync(README, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const text = raw.replace(/\r\n/g, "\n");

const beginAt = text.indexOf(BEGIN);
const endAt = text.indexOf(END);
if (beginAt < 0 || endAt < 0 || endAt < beginAt) {
  console.error(`README index markers are missing or out of order (${BEGIN} ... ${END}).`);
  process.exit(1);
}

// Only the headings BELOW the index, which is the run this index is for. Sections above it belong to
// the setup and reference half of the document and are linked by hand, on purpose.
const body = text.slice(endAt);
const headings = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());

if (headings.length < 20) {
  console.error(`only ${headings.length} design notes found below the index - this guard has drifted.`);
  process.exit(1);
}

// Duplicated headings produce duplicate anchors, and every link but the first goes to the wrong
// place. Cheap to detect here and confusing to debug in a browser.
const seen = new Map();
const duplicates = [];
for (const h of headings) {
  const key = anchor(h);
  if (seen.has(key)) duplicates.push(h);
  seen.set(key, true);
}

const generated = [BEGIN, "", ...headings.map((h) => `- [${h}](#${anchor(h)})`), "", END].join("\n");
const current = text.slice(beginAt, endAt + END.length);

if (process.argv.includes("--write")) {
  const next = text.slice(0, beginAt) + generated + text.slice(endAt + END.length);
  writeFileSync(README, eol === "\r\n" ? next.replace(/\n/g, "\r\n") : next, "utf8");
  console.log(`README index written: ${headings.length} design notes.`);
  if (duplicates.length > 0) {
    console.log(`  note: ${duplicates.length} heading(s) repeat, so their links collide: ${duplicates.join(", ")}`);
  }
  process.exit(0);
}

const problems = [];
if (current !== generated) {
  problems.push(
    `the README index does not match its headings. ${headings.length} design note(s) exist below it.\n` +
      `  Run \`npm run check:index -- --write\` to regenerate it.`
  );
}
if (duplicates.length > 0) {
  problems.push(
    `${duplicates.length} design-note heading(s) repeat, so every link but the first goes to the ` +
      `wrong section: ${duplicates.join(", ")}`
  );
}

if (problems.length > 0) {
  console.error("\nREADME index check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(`README index ok: ${headings.length} design notes, all linked, no colliding anchors.`);
