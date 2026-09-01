#!/usr/bin/env node
// One list of "what starts a chain", not three that disagree.
//
// There were three. explainGraph.ts knew about bound events and the legacy input nodes;
// graphSummary.ts knew about four kinds and used its list to decide what survives a node cap; the
// C++ tested two classes. None of them knew about K2Node_EnhancedInputAction, which is how every
// modern Unreal project drives movement, jump, fire and interact.
//
// The cost was not a missing feature but a confident wrong answer: explain_graph listed 25 entry
// points for a real player Blueprint and not one input action, and trace_function_calls called a
// live ping system dead, advising "Do not fix it; find what took over". A model that believes that
// deletes working code.
//
// So: two checks. Nothing outside entryTypes.ts may declare its own entry-type list, and the list
// must still contain the kinds that were painfully learned.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");
const OWNER = "entryTypes.ts";

const problems = [];

// 1. Nobody else declares one.
//
// The shape being caught is a const array literal holding K2Node_ entry kinds. A file that merely
// mentions one type - a check for "is this specific node a custom event" - is not a competing list
// and is not the failure mode here.
for (const file of readdirSync(SRC).filter((f) => f.endsWith(".ts") && f !== OWNER)) {
  const text = readFileSync(join(SRC, file), "utf8");
  for (const match of text.matchAll(/(?:const|let)\s+\w*ENTRY\w*\s*(?::[^=]+)?=\s*\[([^\]]*)\]/gi)) {
    const kinds = [...match[1].matchAll(/"(K2Node_\w+)"/g)].map((m) => m[1]);
    if (kinds.length >= 2) {
      problems.push(
        `${file} declares its own entry-type list (${kinds.slice(0, 4).join(", ")}${kinds.length > 4 ? ", ..." : ""}). ` +
          `Import ENTRY_TYPES from ./entryTypes.js instead - lists that are copied are lists that drift apart.`
      );
    }
  }
}

// 2. The list still contains what was learned the hard way. Each of these cost a real
//    misdiagnosis, so each is named here rather than trusted to survive an edit.
const owner = readFileSync(join(SRC, OWNER), "utf8");
const REQUIRED = [
  ["K2Node_EnhancedInputAction", "modern input - its absence called a working ping system dead code"],
  ["K2Node_ComponentBoundEvent", "a button's On Clicked - its absence described whole menus as dead"],
  ["K2Node_Event", "the ordinary case"],
  ["K2Node_CustomEvent", "the ordinary case"],
  ["K2Node_FunctionEntry", "function graphs have no event at all"],
];
for (const [kind, why] of REQUIRED) {
  if (!owner.includes(`"${kind}"`)) {
    problems.push(`${OWNER} no longer lists ${kind} (${why}).`);
  }
}

// 3. The C++ side must ask the interface, not a class list, or it goes stale the next time Epic
//    adds a node kind - which is exactly how the Enhanced Input gap happened.
const handler = readFileSync(
  join(here, "..", "..", "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private", "MCPCommandHandler.cpp"),
  "utf8"
);
if (!handler.includes("ImplementsInterface(UK2Node_EventNodeInterface::StaticClass())")) {
  problems.push(
    "MCPCommandHandler.cpp no longer tests IK2Node_EventNodeInterface. A list of class names misses " +
      "UK2Node_EnhancedInputAction, which does not derive from UK2Node_Event."
  );
}

if (problems.length > 0) {
  console.error(`\nentry-type check failed (${problems.length} problem(s)):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

const listed = [...owner.matchAll(/"(K2Node_\w+)"/g)].map((m) => m[1]);
console.log(`entry types ok: ${listed.length} kinds in one list, no competing copies, C++ asks the interface`);
