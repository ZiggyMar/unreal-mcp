// Every tool the symptom index recommends must exist.
//
// src/symptoms.ts maps how a person describes a failure to the tools that find it, so a plain-text
// bug report lands somewhere instead of returning nothing. It names tools as strings, which means a
// renamed or removed tool turns a helpful suggestion into a dead end - and a dead end that arrives
// dressed as an answer, at the one moment the caller has nothing else to go on.
//
// The index is also the only place in this server where the recommendation is curated by hand rather
// than derived from the registry, so nothing else would notice.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const symptomsPath = join(here, "..", "src", "symptoms.ts");
const serverPath = join(here, "..", "src", "index.ts");

const registered = new Set(
  [...readFileSync(serverPath, "utf8").matchAll(/(?:server\.registerTool|register)\(\s*"(unreal_[a-z0-9_]+)"/g)].map(
    (m) => m[1]
  )
);

const symptomSource = readFileSync(symptomsPath, "utf8");

// Only the tools: arrays, not every unreal_* mentioned in prose. The `because` text names tools too,
// and quoting one in an explanation is not the same as routing a caller to it.
// EVERY quoted string in a tools: array, not just the ones shaped like a tool name.
//
// The first version captured /"(unreal_[a-z0-9_]+)"/, and a name that did not fit that shape simply
// vanished from the set rather than being reported - so renaming a tool to anything with a capital
// letter in it made the guard quieter instead of louder. Tested by renaming an entry and watching
// this print "all registered" with a count one lower.
//
// That is the failure this guard exists to catch, in the guard: not finding something and finding
// nothing wrong have to be different outcomes.
const named = new Set();
for (const block of symptomSource.matchAll(/tools:\s*\[([^\]]*)\]/g)) {
  for (const tool of block[1].matchAll(/"([^"]+)"/g)) named.add(tool[1]);
}

const problems = [];

const missing = [...named].filter((name) => !registered.has(name)).sort();
if (missing.length > 0) {
  problems.push(
    `${missing.length} tool(s) recommended by the symptom index do not exist: ${missing.join(", ")}.\n` +
      `  A caller with a plain-language bug report is sent to a tool that is not there, at the one\n` +
      `  moment they have nothing else to go on. Rename them in src/symptoms.ts or drop the entry.`
  );
}

// An entry with no vocabulary can never match, and one with no tools can never help. Both are
// silent: the table just quietly gets smaller.
const entries = [...symptomSource.matchAll(/says:\s*\[([^\]]*)\][\s\S]*?tools:\s*\[([^\]]*)\]/g)];
if (entries.length === 0) {
  problems.push("no symptom entries found at all - the parse in this guard has drifted from the file it checks");
}
for (const [, says, tools] of entries) {
  const phrases = [...says.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const toolNames = [...tools.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (phrases.length === 0) problems.push(`a symptom entry recommending ${toolNames.join(", ")} has no words to match on`);
  if (toolNames.length === 0) problems.push(`a symptom entry matching "${phrases[0]}" recommends no tools`);
  const upper = phrases.filter((p) => p !== p.toLowerCase());
  if (upper.length > 0) {
    // Matching lowercases the caller's text, so an entry with a capital can never fire.
    problems.push(`symptom phrases must be lowercase or they can never match: ${upper.join(", ")}`);
  }
}

if (problems.length > 0) {
  console.error("symptom index check FAILED");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const phraseCount = entries.reduce((n, [, says]) => n + [...says.matchAll(/"[^"]*"/g)].length, 0);
console.log(
  `symptoms ok: ${entries.length} entries, ${phraseCount} phrases, ${named.size} tools recommended, all registered`
);
