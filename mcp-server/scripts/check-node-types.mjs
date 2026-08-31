#!/usr/bin/env node
// Every node type the bridge can build must be reachable, or deliberately not.
//
// check:parity guards the command surface: 93 bridge commands, 115 MCP tools, all matched. It says
// nothing about the surface INSIDE a command, and add_node is the widest one in the project - a
// `nodeType` string that selects between fourteen kinds of graph node. That inner surface drifted:
//
//   InputKey, InputAxis, Self - implemented in C++, accepted by the bridge, in no tool's enum
//
// So the engine could place them, the bridge could place them, and no model could ask. This is the
// second time the same thing has happened in the same command; the netMode/reliable parameters were
// implemented and unreachable too, which meant a Server RPC - the thing all multiplayer logic is
// built from - could not be authored at all. That one was found by reading the C++ for another
// reason. This one was found by reading an error message from an out-of-date plugin binary, which
// happened to LIST what it accepted. Neither is a way to find things.
//
// The reverse direction matters just as much: an enum offering a nodeType the bridge does not
// implement is a tool advertising something that returns unknown_node_type at the worst moment.
//
// Run: npm run check:nodetypes  (also part of npm test)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const handler = join(here, "..", "..", "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private", "MCPCommandHandler.cpp");
const server = join(here, "..", "src", "index.ts");

// Node types the bridge implements but this server deliberately does not offer, each with the
// reason. Empty today, and kept because "we chose not to" and "nobody noticed" must not look alike -
// that is the distinction this whole repo keeps having to redraw.
const DELIBERATELY_UNEXPOSED = {
  // e.g. SomeNodeType: "why a model should never be offered this",
};

const problems = [];

const cpp = readFileSync(handler, "utf8");
const bridgeTypes = [...new Set([...cpp.matchAll(/NodeType == TEXT\("([A-Za-z_]+)"\)/g)].map((m) => m[1]))].sort();
if (bridgeTypes.length === 0) {
  problems.push("no nodeType comparisons found in MCPCommandHandler.cpp - this guard has drifted from the file it checks");
}

// Every nodeType enum in the server, not one of them. add_node and build_graph each declare their
// own, and they have disagreed before; a guard that reads only the first would be blind to exactly
// the case where one was updated and the other forgotten.
const enums = [...readFileSync(server, "utf8").matchAll(/nodeType: z\.enum\(\[([^\]]+)\]\)/g)].map((m) =>
  [...m[1].matchAll(/"([A-Za-z_]+)"/g)].map((x) => x[1])
);
if (enums.length < 2) {
  problems.push(`expected at least two nodeType enums in src/index.ts, found ${enums.length} - the parse has drifted`);
}

const [first, ...rest] = enums;
for (const [index, other] of rest.entries()) {
  const missing = first.filter((t) => !other.includes(t));
  const extra = other.filter((t) => !first.includes(t));
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      `nodeType enum #${index + 2} disagrees with the first: ` +
        `${missing.length > 0 ? `missing ${missing.join(", ")}` : ""}` +
        `${missing.length > 0 && extra.length > 0 ? "; " : ""}` +
        `${extra.length > 0 ? `has extra ${extra.join(", ")}` : ""}. ` +
        `A model told one thing by unreal_add_node and another by unreal_build_graph will trust whichever ` +
        `it read last.`
    );
  }
}

const exposed = new Set(enums.flat());

const unreachable = bridgeTypes.filter((t) => !exposed.has(t) && !(t in DELIBERATELY_UNEXPOSED));
if (unreachable.length > 0) {
  problems.push(
    `${unreachable.length} nodeType(s) are implemented in the bridge and reachable from no tool:\n` +
      unreachable.map((t) => `    - ${t}`).join("\n") +
      `\n  The C++ can build them and no model can ask for one. Add them to both nodeType enums, or to\n` +
      `  DELIBERATELY_UNEXPOSED in this script with the reason a model should never be offered them.`
  );
}

const phantom = [...exposed].filter((t) => !bridgeTypes.includes(t)).sort();
if (phantom.length > 0) {
  problems.push(
    `${phantom.length} nodeType(s) are offered to models and not implemented in the bridge:\n` +
      phantom.map((t) => `    - ${t}`).join("\n") +
      `\n  A model that picks one gets unknown_node_type after deciding what to build. Implement them or\n` +
      `  remove them from the enums.`
  );
}

// A type nobody can discover is only half-shipped: the enum makes it callable, the description is
// what makes it findable, and this command's description is where a model learns what each type
// needs. A type with no prose is one a model will not choose.
// Scoped to the prose block, rather than searching the whole file for the name. The first version
// looked for `"Type":` and `"Type" (`, and reported VariableGet as undocumented because it is
// written as `"VariableGet" / "VariableSet":` - the guard failing on the shape of the prose rather
// than its absence, which is the same "matched a mention rather than a use" mistake the other
// guards in this repo have each had to unlearn.
const prose = readFileSync(server, "utf8");
const start = prose.indexOf("nodeType determines which other params are required");
const end = prose.indexOf("x/y are optional graph-editor position hints", start);
if (start === -1 || end === -1) {
  problems.push("could not find the nodeType prose block in src/index.ts - this guard has drifted from the text it checks");
}
const block = start === -1 || end === -1 ? "" : prose.slice(start, end);
const documented = new Set([...block.matchAll(/([A-Za-z_]+)/g)].map((m) => m[1]));
const undocumented = start === -1 ? [] : [...exposed].filter((t) => !documented.has(t)).sort();
if (undocumented.length > 0) {
  problems.push(
    `${undocumented.length} nodeType(s) are in the enum with no line describing them in the nodeType prose:\n` +
      undocumented.map((t) => `    - ${t}`).join("\n") +
      `\n  Callable but not findable. Add a "- \\"${undocumented[0]}\\": ..." line saying what it needs.`
  );
}

if (problems.length > 0) {
  console.error("\nnode type check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `node types ok: ${bridgeTypes.length} implemented in the bridge, ${exposed.size} offered across ` +
    `${enums.length} enums that agree, all described` +
    `${Object.keys(DELIBERATELY_UNEXPOSED).length > 0 ? `, ${Object.keys(DELIBERATELY_UNEXPOSED).length} withheld on purpose` : ""}`
);
