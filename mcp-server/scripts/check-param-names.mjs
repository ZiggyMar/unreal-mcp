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
  // Added after four more misses in one working session. The table was too narrow: it covered the
  // two pairs that had bitten by then, so the guard passed while the same class of mistake kept
  // costing round trips. These come from measuring the whole surface rather than from taste -
  // `name` is on 34 tools, `nodeId` on 12, and connect_pins was the only tool of 126 spelling a
  // node id `sourceNodeId`.
  { odd: "functionName", common: "name" },
  // connect_pins' source/target spelling is deliberately NOT here. This guard's argument is a
  // majority one - "a model that has read the other eighteen will type the common word" - and
  // source/target vs from/to is one tool against one tool, so there is no majority to appeal to.
  // It got aliased in index.ts on the separate ground that twelve tools spell a node id `nodeId`
  // and this was the only one that did not, but that is a claim this table cannot check, and an
  // entry the guard has to be argued out of is worse than no entry.
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

/**
 * Tools declaring a given parameter at the top level of their inputSchema.
 *
 * "Top level" is now enforced rather than just claimed. The old pattern allowed any leading
 * whitespace, so a field nested inside an array-of-objects counted as a parameter of the tool -
 * and unreal_add_event_handler was reported for taking `functionName` when what it really has is
 * an `actions: [{ function, functionName, className, params }]` array. Renaming a field inside
 * that object to `name` would be actively worse: at the top level `name` means "the thing this
 * tool acts on", and inside an action it could as easily mean the action's own name.
 *
 * A guard that argues for a wrong change is worse than one that stays quiet, and this one is built
 * to be believed - it already refuses table entries whose majority claim it cannot verify.
 *
 * Top-level keys sit at exactly six spaces: `inputSchema: {` is indented four inside the
 * register() options object, and its own keys one level further in.
 */
const declaring = (param) =>
  tools.filter((t) => {
    const schema = /inputSchema:\s*\{([\s\S]*?)\n    \},/.exec(t.body);
    return schema ? new RegExp(`^ {6}${param}:\\s*z\\.`, "m").test(schema[1]) : false;
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
