#!/usr/bin/env node
// One concept, one parameter name - or an accepted alias.
//
// I got a parameter name wrong three times in one session, on my own tools, while doing real work:
//
//   unreal_trace_variable        takes `variable`,  six other tools take `variableName`
//   unreal_trace_function_calls  takes `function`,  six other tools take `functionName`
//   unreal_find_node             takes `query`
//
// That is not a model being careless. A model that has just read six tools taking `variableName`
// types `variableName` at the seventh, because that is what the surface taught it. Each miss cost a
// round trip - and this server's own standing instructions say "never guess a name; a guess costs a
// failed call", which only holds up if the names do not need guessing at.
//
// The validation errors were excellent: they named the right parameter and said "Nothing ran". Good
// errors are the second line of defence. The first is not needing them.
//
// So: when a name is used by several tools for the same thing, a tool using a DIFFERENT name for
// that same thing has to accept the common one too. The odd spelling can stay - renaming a published
// parameter breaks callers - but it cannot be the only way in.
//
// Run: npm run check:params  (also part of npm test)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

// Pairs that mean the same thing, minority spelling first. Found rather than assumed: the majority
// name is whichever appears in more tools, and that is checked below so this table cannot drift into
// claiming the wrong one is common.
const SYNONYMS = [
  { odd: "variable", common: "variableName" },
  { odd: "function", common: "functionName" },
];

const problems = [];

/** Each register(...) block, so a parameter can be attributed to its tool. */
const tools = [];
for (const match of source.matchAll(/register\(\s*"(unreal_[a-z0-9_]+)"/g)) {
  const next = source.indexOf("\nregister(", match.index + 10);
  tools.push({
    name: match[1],
    body: source.slice(match.index, next === -1 ? source.length : next),
  });
}
if (tools.length < 50) {
  problems.push(`only ${tools.length} tool registrations parsed - this guard has drifted from src/index.ts`);
}

/** Tools declaring a given parameter at the top level of their inputSchema. */
const declaring = (param) =>
  tools.filter((t) => {
    const schema = /inputSchema:\s*\{([\s\S]*?)\n    \},/.exec(t.body);
    return schema ? new RegExp(`(^|\\s)${param}:\\s*z\\.`, "m").test(schema[1]) : false;
  });

for (const { odd, common } of SYNONYMS) {
  const oddTools = declaring(odd);
  const commonTools = declaring(common);

  // The table says which spelling is the common one. Check that, rather than trust it.
  if (commonTools.length <= oddTools.length) {
    problems.push(
      `SYNONYMS says "${common}" is the common spelling and "${odd}" the odd one, but ${common} is used by ` +
        `${commonTools.length} tool(s) and ${odd} by ${oddTools.length}. Fix the table before trusting it.`
    );
    continue;
  }

  const deaf = oddTools.filter((t) => !new RegExp(`(^|\\s)${common}:\\s*z\\.`, "m").test(t.body));
  if (deaf.length > 0) {
    problems.push(
      `${deaf.length} tool(s) take "${odd}" where ${commonTools.length} others take "${common}", and do not ` +
        `accept "${common}" as well:\n` +
        deaf.map((t) => `    - ${t.name}`).join("\n") +
        `\n  A model that has read the other ${commonTools.length} will type "${common}" here and pay a failed\n` +
        `  call to learn a synonym. Accept both and pick whichever is set.`
    );
  }
}

if (problems.length > 0) {
  console.error("\nparameter name check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `parameter names ok: ${tools.length} tools, ${SYNONYMS.length} synonym pair(s) checked, ` +
    `every minority spelling also accepts the common one`
);
