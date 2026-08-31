#!/usr/bin/env node
// Documentation guard.
//
// Every other check in this repo watches the code: tool parity, unit tests, live verification, the
// crash sweep. None of them look at prose, and that gap has already cost something real - a slice
// replacement between two headings silently deleted 67 lines of README (the live-verification and
// crash-sweep sections) and every automated check still passed. It surfaced only by luck, when a
// later edit anchored on a heading that no longer existed.
//
// Docs are not decoration in this project. A capability nobody can find is unshipped, and a
// document that claims a tool exists when it does not is worse than silence, because someone will
// act on it. So the same standard applies to prose as to code: if it can rot silently, guard it.
//
// Checks:
//   1. every registered tool is documented in mcp-server/README.md
//   2. every tool the docs mention actually exists
//   3. required README sections are present (catches deletion, which is the failure that happened)
//   4. the complaint matrix uses only its declared statuses
//   5. the complaint matrix does not reference tools that do not exist
//
// Run: npm run check:docs  (also part of npm test)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const serverSrc = readFileSync(join(here, "..", "src", "index.ts"), "utf8");
const serverReadme = readFileSync(join(here, "..", "README.md"), "utf8");
const complaints = readFileSync(join(repoRoot, "docs", "COMPLAINTS_SOLVED.md"), "utf8");
const workflow = readFileSync(join(repoRoot, "docs", "AGENT_WORKFLOW.md"), "utf8");

const problems = [];

// --- 1. every tool is documented -------------------------------------------------------------
const registered = [...serverSrc.matchAll(/register\(\s*"(unreal_[a-z0-9_]+)"/g)].map((m) => m[1]);
const undocumented = registered.filter((name) => !serverReadme.includes(name));
if (undocumented.length > 0) {
  problems.push(
    `${undocumented.length} tool(s) are registered but appear nowhere in mcp-server/README.md, so nobody can ` +
      `find them:\n` +
      undocumented.map((n) => `    - ${n}`).join("\n")
  );
}

// --- 2. the docs do not promise tools that do not exist ----------------------------------------
// Prompts are not tools, but they share the naming convention, so they must be declared here or
// the phantom-tool check flags them.
const promptNames = [...serverSrc.matchAll(/registerPrompt\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
const known = new Set([...registered, ...promptNames.map((n) => (n.startsWith("unreal_") ? n : `unreal_${n}`))]);
const mentionedIn = (text, label) => {
  const mentioned = new Set([...text.matchAll(/`?(unreal_[a-z0-9_]+)`?/g)].map((m) => m[1]));
  const phantom = [...mentioned].filter((name) => !known.has(name));
  if (phantom.length > 0) {
    problems.push(
      `${label} references ${phantom.length} tool(s) that do not exist. Someone will try to call these:\n` +
        phantom.map((n) => `    - ${n}`).join("\n")
    );
  }
};
mentionedIn(serverReadme, "mcp-server/README.md");
mentionedIn(complaints, "docs/COMPLAINTS_SOLVED.md");
mentionedIn(workflow, "docs/AGENT_WORKFLOW.md");

// --- 2b. the contents lists every top-level section --------------------------------------------
//
// The README is 5,700 lines and 154 sections, and for most of its life "## Tools exposed" ran from
// line 60 to line 5,560 - 97% of the file - with Configuration, client setup and the workflow
// stranded underneath it. Someone arriving could not find how to install the thing.
//
// A contents block fixes that and then rots: a new top-level section is added, nobody updates the
// list, and the map stops matching the territory. Every other index in this repo learned that the
// hard way, so this one is checked from the start.
{
  const topLevel = [...serverReadme.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).filter((h) => h !== "Contents");
  const contents = new RegExp("## Contents([\\s\\S]*?)\\n## ").exec(serverReadme);
  if (!contents) {
    problems.push("README.md has no Contents section - 154 sections with no way in is not documentation");
  } else {
    const listed = contents[1];
    const missing = topLevel.filter((h) => !listed.includes(h));
    if (missing.length > 0) {
      problems.push(
        `Contents does not list ${missing.length} top-level section(s): ${missing.join(", ")}. ` +
          `A contents block that has fallen behind is worse than none, because it is trusted.`
      );
    }
  }
}

// --- 3. required sections still exist ----------------------------------------------------------
// Listed explicitly because deletion is the failure that actually happened, and a missing section
// leaves no trace for any other check to notice.
const REQUIRED_README_SECTIONS = [
  "## Tools exposed",
  "### Graph authoring and organization",
  "### Scene, actors, components, project settings, and runtime",
  "### Structs and enums",
  "### UMG",
  "### Tested with a local 7B",
  "### Handbooks, for any model driving an engine it cannot recall exactly",
  "### Acting like a colleague, not a code generator",
  "### Working on a project that already exists",
  "### VFX, sound, and animation already work",
  "### Materials",
  "### Readable graphs are produced, not requested",
  "### When something is wrong",
  "### The quality gate",
  "### Security: what this bridge does and does not protect you from",
  "### Team projects: source control and binary assets",
  "### Two editors open: the silent wrong-project edit",
  "### Knowing what the agent touched",
  "### Cost modes",
  "### Tool profiles",
  "### Live verification",
  "### Crash sweep",
  "### Tool parity is enforced, not assumed",
  "### Documentation is guarded too",
  "## Recommended agent workflow",
];
const missingSections = REQUIRED_README_SECTIONS.filter((heading) => !serverReadme.includes(heading));
if (missingSections.length > 0) {
  problems.push(
    `${missingSections.length} required README section(s) are gone. If this was deliberate, remove them from ` +
      `REQUIRED_README_SECTIONS in this script; if it was not, restore them from git:\n` +
      missingSections.map((h) => `    - ${h}`).join("\n")
  );
}

const REQUIRED_WORKFLOW_SECTIONS = ["## The golden path for building a feature", "## Honesty rules"];
const missingWorkflow = REQUIRED_WORKFLOW_SECTIONS.filter((heading) => !workflow.includes(heading));
if (missingWorkflow.length > 0) {
  problems.push(`docs/AGENT_WORKFLOW.md is missing: ${missingWorkflow.join(", ")}`);
}

// --- 4. the complaint matrix uses its declared statuses -----------------------------------------
// The statuses this matrix is allowed to use, each meaning something different:
//   Solved            fixed in this repo
//   Solved (verified) fixed AND mechanically exercised against a real editor, not just reasoned
//                     about. Reserved for claims a script re-checks, because an unexercised
//                     safety guarantee has already turned out to be false once here.
//   Solved (by design) the architecture makes the complaint impossible
//   Solved (optional) solved when a documented opt-in is configured
//   Solved (documented) the tool cannot detect it, but the handbook the model reads names the
//                     pattern and the fix. Deliberately the weakest "solved": it depends on the
//                     model reading the right page, so prefer a check when one is possible.
//   Partly / Open     reduced, or still true
const ALLOWED_STATUSES = [
  "**Solved**",
  "**Solved (verified)**",
  "**Solved (by design)**",
  "**Solved (optional)**",
  "**Solved (documented)**",
  "**Partly**",
  "**Open**",
];
const rows = complaints.split("\n").filter((line) => /^\|\s*[A-Z]\d+\s*\|/.test(line));
if (rows.length < 20) {
  problems.push(`docs/COMPLAINTS_SOLVED.md has only ${rows.length} complaint rows; it looks truncated.`);
}
for (const row of rows) {
  const id = row.match(/^\|\s*([A-Z]\d+)\s*\|/)?.[1] ?? "?";
  if (!ALLOWED_STATUSES.some((status) => row.includes(status))) {
    problems.push(`complaint row ${id} has no recognised status (expected one of ${ALLOWED_STATUSES.join(", ")}).`);
  }
}

// --- no links to somebody's hard drive ---------------------------------------------------------
//
// The root README shipped a `file:///f:/Projects/...` link to the author's own machine, in the file
// a newcomer reads first, where it is worse than a missing link: it looks like a working reference.
// It survived because nothing checked, and it was found by cloning the repo somewhere else and
// reading it as a stranger would.
//
// A machine-local path in documentation is always a mistake, so this is a hard failure rather than
// a warning.
{
  const { readdirSync } = await import("node:fs");
  const docFiles = [
    join(repoRoot, "README.md"),
    join(repoRoot, "mcp-server", "README.md"),
    ...readdirSync(join(repoRoot, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(repoRoot, "docs", name)),
  ];
  for (const file of docFiles) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Markdown link targets only: prose may legitimately mention a Windows path in an example.
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^file:\/\//i.test(target) || /^[A-Za-z]:[\\/]/.test(target)) {
        problems.push(
          `${file.replace(repoRoot, "").replace(/^[\\/]/, "")} links to a machine-local path ` +
            `"${target.slice(0, 60)}" - it works only on the machine it was written on. Use a repo-relative link.`
        );
      }
    }
  }
}

// --- report ------------------------------------------------------------------------------------
if (problems.length === 0) {
  console.log(
    `docs ok: ${registered.length} tools documented, ${rows.length} complaint rows, ` +
      `${REQUIRED_README_SECTIONS.length} required sections present`
  );
  process.exit(0);
}

console.error(`\ndocumentation check failed (${problems.length} problem(s)):\n`);
for (const problem of problems) console.error(`  - ${problem}\n`);
process.exit(1);
