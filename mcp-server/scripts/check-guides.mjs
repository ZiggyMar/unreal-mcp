// The guide documents are teaching a model reads and acts on. Nothing checked them.
//
// `unreal_guide` serves three files - the Blueprint handbook, the recipes and the agent workflow -
// and between them they name about seventy tools. check:docs covers the README, check:symptoms
// covers the routing table, and these had no guard at all: a renamed tool would leave a recipe
// telling a model to call something that does not exist, at the moment it had gone looking for
// instructions.
//
// That is worse than the same mistake in the README. A human reading a stale README is puzzled; a
// model reading a stale recipe follows it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const serverPath = join(here, "..", "src", "index.ts");

const registered = new Set(
  [...readFileSync(serverPath, "utf8").matchAll(/(?:server\.registerTool|register)\(\s*"(unreal_[a-z0-9_]+)"/g)].map(
    (m) => m[1]
  )
);

// The documents unreal_guide can serve. Read from the tool's own map rather than listed here, so a
// fourth guide cannot be added without this noticing.
const guideSource = readFileSync(serverPath, "utf8");
const guideFiles = [...new Set([...guideSource.matchAll(/file:\s*"([A-Z0-9_]+\.md)"/g)].map((m) => m[1]))];

const problems = [];
if (guideFiles.length === 0) {
  problems.push("no guide documents found in index.ts - this guard has drifted from the tool it checks");
}

let named = 0;
for (const file of guideFiles) {
  let text;
  try {
    text = readFileSync(join(repoRoot, "docs", file), "utf8");
  } catch (err) {
    problems.push(`${file} is served by unreal_guide and could not be read: ${err.message}`);
    continue;
  }

  const mentioned = [...new Set([...text.matchAll(/unreal_[a-z0-9_]+/g)].map((m) => m[0]))];
  named += mentioned.length;
  const missing = mentioned.filter((name) => !registered.has(name)).sort();
  if (missing.length > 0) {
    problems.push(
      `${file} tells a model to call ${missing.length} tool(s) that do not exist: ${missing.join(", ")}.\n` +
        `  This is teaching, not prose - a model that fetched this guide will follow it.`
    );
  }
}

if (problems.length > 0) {
  console.error("guide check FAILED");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`guides ok: ${guideFiles.length} served by unreal_guide, ${named} tool mentions, all registered`);
