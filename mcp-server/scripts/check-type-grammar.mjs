#!/usr/bin/env node
// Every type descriptor the bridge accepts must be one a model can find out about.
//
// `type` is the second-widest surface inside a command, after `nodeType`: one string that selects
// between about twenty forms - scalars, object and class references, structs, enums, and three kinds
// of container. ResolvePinType in the C++ is the authority on what is accepted. The tool
// descriptions are the only way a model learns any of it, and the two had drifted:
//
//   <set>  - implemented in the bridge, mentioned NOWHERE a model reads
//
// So this server could make a set variable and no model could know to ask, which is the same defect
// as the three unreachable nodeTypes and the netMode parameters before them. The instructions this
// server ships tell models "never guess a name; a guess costs a failed call" - and then left them
// guessing about containers.
//
// This checks the direction that matters. The reverse - prose naming a form the C++ rejects - is
// caught the moment anyone tries it, loudly, with a bad_type error naming what went wrong. Silence
// is the failure worth automating against.
//
// Run: npm run check:types  (also part of npm test)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const handler = join(here, "..", "..", "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private", "MCPCommandHandler.cpp");
const server = join(here, "..", "src", "index.ts");

// Spellings the bridge accepts that a model is deliberately not taught, with the reason. Aliases
// belong here: a model needs one way to say a thing, not four, and "int32" in a description would
// cost tokens in every profile to teach a synonym for "int".
const ALIASES_NOT_TAUGHT = {
  boolean: 'the description teaches "bool"',
  int32: 'the description teaches "int"',
  integer: 'the description teaches "int"',
  real: 'the description teaches "double"',
};

const problems = [];

// The authority: the body of ResolvePinType, not the whole file. A type name quoted in some
// unrelated error message elsewhere is not the bridge accepting it.
const cpp = readFileSync(handler, "utf8");
const start = cpp.indexOf("bool FMCPCommandHandler::ResolvePinType");
if (start === -1) {
  problems.push("ResolvePinType not found in MCPCommandHandler.cpp - this guard has drifted from the file it checks");
}
const body = start === -1 ? "" : cpp.slice(start, cpp.indexOf("\n}", start));

const scalars = [...body.matchAll(/Lower == TEXT\("([a-z0-9_]+)"\)/g)].map((m) => m[1]);
const prefixes = [...body.matchAll(/Lower\.StartsWith\(TEXT\("([a-z0-9_]+):"\)\)/g)].map((m) => `${m[1]}:`);
const suffixes = [...body.matchAll(/Bare\.EndsWith\(TEXT\("([^"]+)"\)\)/g)].map((m) => m[1]);
const mapForm = /Bare\.StartsWith\(TEXT\("map<"\)\)/.test(body) ? ["map<"] : [];

const accepted = [...new Set([...scalars, ...prefixes, ...suffixes, ...mapForm])].sort();
if (accepted.length < 10) {
  problems.push(`only ${accepted.length} type form(s) parsed out of ResolvePinType - the parse has drifted from the C++`);
}

// Where a model can learn them. Any description string in the server counts: the point is whether
// the form is findable at all, not which tool happens to name it - struct: is taught by
// create_struct and enum: by create_enum, and that is fine.
const prose = readFileSync(server, "utf8");
const untaught = accepted.filter((form) => !(form in ALIASES_NOT_TAUGHT) && !prose.includes(form));
if (untaught.length > 0) {
  problems.push(
    `${untaught.length} type form(s) are accepted by the bridge and named nowhere a model reads:\n` +
      untaught.map((f) => `    - ${f}`).join("\n") +
      `\n  A model cannot ask for what it has not been told exists, and this server's own instructions\n` +
      `  tell it not to guess. Name them in a description, or list them in ALIASES_NOT_TAUGHT here\n` +
      `  with the reason a model is better off not knowing.`
  );
}

// An alias listed as not-taught that the bridge has since dropped is a note about nothing, and the
// next person reads it as fact. Same rot as a registry pointing at text that has been reworded.
const stale = Object.keys(ALIASES_NOT_TAUGHT).filter((form) => !accepted.includes(form));
if (stale.length > 0) {
  problems.push(
    `${stale.length} form(s) in ALIASES_NOT_TAUGHT are no longer accepted by the bridge: ${stale.join(", ")}. ` +
      `Remove them; a note explaining why something is hidden outlives the thing it hides.`
  );
}

if (problems.length > 0) {
  console.error("\ntype grammar check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `type grammar ok: ${accepted.length} forms accepted by ResolvePinType, ` +
    `${accepted.length - Object.keys(ALIASES_NOT_TAUGHT).length} taught, ` +
    `${Object.keys(ALIASES_NOT_TAUGHT).length} aliases deliberately not`
);
