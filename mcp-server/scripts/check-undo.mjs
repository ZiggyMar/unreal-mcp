#!/usr/bin/env node
// Everything an agent changes, a human must be able to undo.
//
// This is the expectation a person brings from the editor and never states: they watch an agent
// rename a variable across a dozen nodes, decide they preferred it the old way, and press Ctrl+Z.
// Thirty commands in MCPCommandHandler.cpp open a named transaction and behave exactly like that.
// The eight added since - rename_variable, remove_variable, rename_component, remove_component,
// remove_function and the asset operations - opened none, so their edits were permanent the moment
// they landed. Two of them even called Modify(), which records a change for undo and does nothing
// at all outside a transaction: the habit was there, the mechanism was not.
//
// Nothing caught it. check:parity counts commands, check:journal classifies them read or write, and
// neither asks the question a person actually cares about, which is whether the change can be taken
// back. It was found by reading what Epic's own MCP plugin and other servers do about undo, and
// noticing this project had the habit everywhere except in its newest code.
//
// So: every command that changes the project must open an FScopedTransaction, or be listed below
// with the reason it cannot. "The editor cannot undo this either" is a good reason and a common one -
// creating an asset is not undoable in Unreal, and pretending otherwise would be worse than saying
// so. A command that is simply not undoable, that nobody decided, is the case this exists to stop.
//
// Run: npm run check:undo  (also part of npm test)

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const privateDir = join(repoRoot, "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private");
const handlerPath = join(privateDir, "MCPCommandHandler.cpp");
const journalPath = join(here, "..", "src", "journal.ts");

// Write commands that cannot be undone, and why. Each reason has to be about the ENGINE, not about
// the effort of writing the code.
const NOT_UNDOABLE = {
  // It IS the undo. Opening a transaction around it would push an entry onto the very stack it is
  // consuming, and the second call would undo the first undo rather than the work. The editor's own
  // redo is the inverse operation and already exists, which is why nothing is lost by exempting it.
  undo: "it is the undo - transacting it would push an entry onto the stack it consumes; redo is the inverse",

  create_asset: "the editor cannot undo asset creation either - a new .uasset is a file on disk, not a transacted change",
  import_asset: "importing writes a new package; see create_asset. The factory runs outside any transaction and undoing it would leave a .uasset with nothing referencing it",
  duplicate_asset: "same as create_asset: it makes a new package",
  rename_asset: "an asset rename fixes up references across packages and is not transacted in the editor either",
  delete_asset: "asset deletion goes through the editor's own delete path, which is not undoable",
  create_blueprint: "creates a new package; see create_asset",
  create_level: "creates a new package; see create_asset",
  save_asset: "saving is not a change to undo, it is a change being written down",
  save_blueprint: "see save_asset",
  save_level: "see save_asset",
  compile_blueprint: "compiling produces no user-visible change to undo",
  open_level: "changing which level is open is navigation, not an edit",
  start_pie: "entering play is not an edit to the project",
  stop_pie: "leaving play is not an edit to the project",
  watch_runtime: "observes a running game; changes nothing",
  teleport_actor: "moves an actor inside a running game, not in the level - PIE ends and the move ends with it",
  press_input: "presses a key in a running game - it changes what the game is doing, not the project, and the game ends when PIE does",
  run_console_command: "the command decides what it does; this bridge cannot transact on its behalf",
  live_coding_compile: "compiling C++ changes build output, not project state",
  take_screenshot: "writes a PNG to disk; there is no project change to take back",
  set_game_settings: "writes project config files, which the editor does not transact either",
  add_input_mapping: "writes project input config, which the editor does not transact either",
  map_input_key: "edits an InputMappingContext asset through its own save path",
  unmap_input_key: "see map_input_key",
};

const problems = [];

const dispatch = readFileSync(handlerPath, "utf8");

// command -> handler function, straight out of the dispatch chain.
const handlerFor = new Map();
for (const match of dispatch.matchAll(/Cmd\s*==\s*TEXT\("([a-z0-9_]+)"\)\s*\)\s*\{\s*(?:Response\s*=\s*|return\s+)(Handle[A-Za-z0-9_]+)\s*\(/g)) {
  handlerFor.set(match[1], match[2]);
}
if (handlerFor.size === 0) {
  problems.push("no command-to-handler pairs parsed from the dispatch chain - this guard has drifted from the C++");
}

/** The body of a function, by counting braces from its opening one. */
function bodyAt(text, from) {
  const open = text.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

// Every function in the plugin, not only the handlers.
//
// The first version sliced to the next `\n}` and looked only at Handle* functions, and it reported
// add_node as permanently destructive - a false alarm twice over. HandleAddNode is a thin wrapper
// that delegates to AddNodeCore, which is where the transaction is; and the naive slice ended at the
// first line-start brace it found rather than the real end of the function.
//
// Both mistakes matter more than they look. A guard that cries wolf is one people learn to skip,
// which is exactly what happened to the lifecycle trial earlier this week, so a false alarm here
// costs more than the check is worth.
const bodies = new Map();
for (const file of readdirSync(privateDir).filter((f) => f.endsWith(".cpp"))) {
  const text = readFileSync(join(privateDir, file), "utf8");
  // Definitions only, anchored at the start of a line, which is where a return type sits. A
  // parameter-list regex missed AddNodeCore outright - the very function this check has to see -
  // because matching balanced parentheses with a regex is a losing game.
  for (const match of text.matchAll(/^[A-Za-z_][^\n=;]*?\bFMCPCommandHandler::([A-Za-z0-9_]+)\s*\(/gm)) {
    if (!bodies.has(match[1])) bodies.set(match[1], bodyAt(text, match.index));
  }
  for (const match of text.matchAll(/^static\s+[^\n=;]*?\b([A-Za-z0-9_]+)\s*\(/gm)) {
    if (!bodies.has(match[1])) bodies.set(match[1], bodyAt(text, match.index));
  }
}
if (bodies.size < 40) {
  problems.push(`only ${bodies.size} function bodies parsed out of the plugin - this guard has drifted from the C++`);
}

/** Does this function, or anything it delegates to, open a transaction? */
function transacts(name, seen = new Set()) {
  if (name === undefined || seen.has(name)) return false;
  seen.add(name);
  const body = bodies.get(name);
  if (body === undefined) return false;
  if (body.includes("FScopedTransaction")) return true;
  // One step down the call chain, repeatedly: the wrapper/Core split is the shape this project
  // uses, and a transaction one level below the handler is still a transaction around the edit.
  if (seen.size > 6) return false;
  for (const call of body.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
    if (transacts(call[1], seen)) return true;
  }
  return false;
}

const journal = readFileSync(journalPath, "utf8");
const setStart = journal.indexOf("const READ_ONLY_COMMANDS = new Set([");
const readOnly = new Set(
  setStart === -1 ? [] : [...journal.slice(setStart, journal.indexOf("]);", setStart)).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
);
if (setStart === -1) {
  problems.push("could not find READ_ONLY_COMMANDS in journal.ts - this guard has drifted");
}

const writes = [...handlerFor.keys()].filter((cmd) => !readOnly.has(cmd)).sort();

const permanent = writes.filter((cmd) => {
  if (cmd in NOT_UNDOABLE) return false;
  // A handler this guard cannot find is reported rather than assumed innocent: not looking and
  // finding nothing wrong are different answers, which is the rule the rest of this repo runs on.
  if (!bodies.has(handlerFor.get(cmd))) return true;
  return !transacts(handlerFor.get(cmd));
});

if (permanent.length > 0) {
  problems.push(
    `${permanent.length} command(s) change the project and open no transaction, so a human cannot undo them:\n` +
      permanent
        .map((c) => `    - ${c} (${handlerFor.get(c)}${bodies.has(handlerFor.get(c)) ? "" : " - handler body not found"})`)
        .join("\n") +
      `\n  Wrap the edit in FScopedTransaction and Modify() what it touches, or add it to NOT_UNDOABLE\n` +
      `  in this script with the engine-level reason it cannot be undone.`
  );
}

const stale = Object.keys(NOT_UNDOABLE).filter((cmd) => !handlerFor.has(cmd)).sort();
if (stale.length > 0) {
  problems.push(
    `${stale.length} command(s) in NOT_UNDOABLE no longer exist: ${stale.join(", ")}. Remove them - an ` +
      `exemption outliving the thing it exempts is a note the next reader takes as fact.`
  );
}

// An exemption for a command that DID learn to transact is also wrong, in the opposite direction: it
// tells the next reader the operation is permanent when it is not.
const wronglyExempt = Object.keys(NOT_UNDOABLE).filter(
  (cmd) => handlerFor.has(cmd) && transacts(handlerFor.get(cmd))
);
if (wronglyExempt.length > 0) {
  problems.push(
    `${wronglyExempt.length} command(s) are listed as not undoable and do open a transaction: ` +
      `${wronglyExempt.join(", ")}. Remove the exemption; it now says the opposite of what the code does.`
  );
}

if (problems.length > 0) {
  console.error("\nundo check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

console.log(
  `undo ok: ${writes.length} commands change the project, ` +
    `${writes.length - Object.keys(NOT_UNDOABLE).filter((c) => writes.includes(c)).length} of them undoable, ` +
    `${Object.keys(NOT_UNDOABLE).filter((c) => writes.includes(c)).length} exempt with a reason`
);
