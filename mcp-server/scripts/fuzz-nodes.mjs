#!/usr/bin/env node
// Crash sweep: place a lot of different nodes, and a lot of malformed input, and see whether the
// editor survives all of it.
//
// The complaint this answers (ChiR24/Unreal_mcp #499) is an editor HARD CRASH on node creation.
// That class of bug matters more than an ordinary one, because an assert or an access violation
// inside the editor is not an error a caller can handle or retry: it is the editor gone, along
// with every unsaved change in the user's project. A wrong answer costs a retry; a crash costs
// their work.
//
// Two passes:
//   1. every node type the bridge can place, plus a wide sample of real functions taken from the
//      running engine's own catalog, each placed into a scratch graph
//   2. adversarial input on every create path: empty, absurdly long, unicode, path-like, and
//      names that collide with something that already exists
//
// A crash is detected by the connection dying rather than answering. Because a crash also ends
// the run, progress is written to a state file after every single attempt, so the sweep can be
// restarted (with the editor relaunched) and will resume just past the input that killed it, and
// that input is named in the report.
//
// Usage: node scripts/fuzz-nodes.mjs [--limit N] [--reset]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, "..", ".fuzz");
const statePath = join(stateDir, "state.json");

const bridge = new UnrealBridgeClient({
  host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
});

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 400;
const RESET = args.includes("--reset");

const ROOT = "/Game/MCPFuzz";
const BP = `${ROOT}/BP_MCPFuzz`;
const BP_OBJ = `${BP}.BP_MCPFuzz`;

function loadState() {
  if (RESET || !existsSync(statePath)) {
    return { done: [], crashes: [], attempted: null, ok: 0, rejected: 0 };
  }
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/** A dead connection means the editor is gone. Anything else is a normal, handled rejection. */
function looksLikeCrash(message) {
  return (
    message.includes("connection refused") ||
    message.includes("dropped mid-request") ||
    message.includes("ECONNRESET") ||
    message.includes("did not answer")
  );
}

const state = loadState();
const doneKeys = new Set(state.done);

/**
 * Run one attempt. Returns "ok" | "rejected" | "crash".
 * The attempt is recorded BEFORE it runs, so if the editor dies the state file still names the
 * input that killed it.
 */
async function attempt(key, label, cmd, params) {
  if (doneKeys.has(key)) return "skipped";
  state.attempted = { key, label, cmd, params };
  saveState(state);

  let outcome;
  try {
    await bridge.send(cmd, params);
    outcome = "ok";
    state.ok++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeCrash(message)) {
      state.crashes.push({ key, label, cmd, params, message: message.split("\n")[0] });
      state.attempted = null;
      saveState(state);
      return "crash";
    }
    // A structured refusal is a PASS: the tool said no instead of dying.
    outcome = "rejected";
    state.rejected++;
  }

  doneKeys.add(key);
  state.done.push(key);
  state.attempted = null;
  saveState(state);
  return outcome;
}

/** Node types the bridge places directly, with the minimum params each needs. */
const NODE_TYPE_CASES = [
  ["Event", { nodeType: "Event", eventName: "ReceiveBeginPlay" }],
  ["Event-tick", { nodeType: "Event", eventName: "ReceiveTick" }],
  ["Event-bogus", { nodeType: "Event", eventName: "NoSuchEventAtAll" }],
  ["CustomEvent", { nodeType: "CustomEvent", eventName: "FuzzCustomEvent" }],
  ["CustomEvent-empty", { nodeType: "CustomEvent", eventName: "" }],
  ["Branch", { nodeType: "Branch" }],
  ["Sequence", { nodeType: "Sequence" }],
  ["Self", { nodeType: "Self" }],
  ["Cast-actor", { nodeType: "Cast", targetClass: "Actor" }],
  ["Cast-pawn", { nodeType: "Cast", targetClass: "Pawn" }],
  ["Cast-bogus", { nodeType: "Cast", targetClass: "NoSuchClass12345" }],
  ["Cast-missing", { nodeType: "Cast" }],
  ["Macro-foreach", { nodeType: "Macro", macroName: "ForEachLoop" }],
  ["Macro-while", { nodeType: "Macro", macroName: "WhileLoop" }],
  ["Macro-bogus", { nodeType: "Macro", macroName: "NotARealMacro" }],
  ["VariableGet-missing", { nodeType: "VariableGet", variableName: "NoSuchVariable" }],
  ["VariableSet-missing", { nodeType: "VariableSet", variableName: "NoSuchVariable" }],
  ["CallFunction-bogus", { nodeType: "CallFunction", functionName: "NoSuchFunction", className: "KismetSystemLibrary" }],
  ["CallFunction-bogus-class", { nodeType: "CallFunction", functionName: "PrintString", className: "NoSuchClass" }],
  ["nodeType-bogus", { nodeType: "NotANodeType" }],
  ["nodeType-empty", { nodeType: "" }],
];

/** Strings chosen to break naive path/name handling. */
const NASTY_NAMES = [
  ["empty", ""],
  ["space", " "],
  ["long", "A".repeat(512)],
  ["unicode", "テストمرحبا"],
  ["emoji", "Fuzz\u{1F4A5}Name"],
  ["dots", "a.b.c"],
  ["slashes", "a/b/c"],
  ["parent-traversal", "../../Escape"],
  ["quotes", 'He said "hi"'],
  ["null-ish", "\\0"],
  ["braces", "{}[]()"],
  ["leading-digit", "9Lives"],
  ["reserved", "None"],
];

async function main() {
  console.log(`crash sweep (limit ${LIMIT} catalog functions)\n`);

  // Scratch Blueprint to place everything into. Recreate only if it is not already there, since a
  // resumed run must keep using the same one.
  try {
    await bridge.send("create_blueprint", { packagePath: BP, parentClass: "Actor", save: false });
    console.log("created scratch blueprint");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeCrash(message)) {
      console.error("the editor is not reachable; start it before running the sweep");
      process.exit(2);
    }
    console.log("reusing existing scratch blueprint");
  }

  const place = (params) => ({ path: BP_OBJ, graphName: "EventGraph", ...params });

  // --- pass 1a: every directly-placeable node type ------------------------------------------
  console.log("\npass 1a: node types the bridge places directly");
  for (const [label, params] of NODE_TYPE_CASES) {
    const result = await attempt(`type:${label}`, label, "add_node", place(params));
    if (result === "crash") return report(true);
    if (result !== "skipped") process.stdout.write(result === "ok" ? "." : "r");
  }

  // --- pass 1b: a wide sample of real functions from the engine's own catalog ----------------
  console.log("\n\npass 1b: real functions from the live node catalog");
  const queries = [
    "spawn", "actor", "print", "get", "set", "add", "delay", "cast", "line trace", "widget",
    "player", "component", "vector", "math", "string", "array", "timer", "physics", "input",
    "sound", "material", "animation", "destroy", "attach", "collision",
  ];
  const seen = new Set();
  const functions = [];
  for (const query of queries) {
    if (functions.length >= LIMIT) break;
    try {
      const found = await bridge.send("find_node", { query, maxResults: 40 });
      for (const hit of found.hits ?? []) {
        const key = `${hit.className}::${hit.functionName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        functions.push(hit);
        if (functions.length >= LIMIT) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (looksLikeCrash(message)) {
        state.crashes.push({ key: `find:${query}`, label: `find_node ${query}`, cmd: "find_node", message });
        saveState(state);
        return report(true);
      }
    }
  }
  console.log(`${functions.length} distinct functions to place`);

  for (const fn of functions) {
    const key = `fn:${fn.className}::${fn.functionName}`;
    const result = await attempt(
      key,
      `${fn.className}.${fn.functionName}`,
      "add_node",
      place({ nodeType: "CallFunction", functionName: fn.functionName, className: fn.className })
    );
    if (result === "crash") return report(true);
    if (result !== "skipped") process.stdout.write(result === "ok" ? "." : "r");
  }

  // --- pass 2: adversarial input on the create paths ------------------------------------------
  console.log("\n\npass 2: adversarial input on create paths and names");
  for (const [label, name] of NASTY_NAMES) {
    const cases = [
      [`bp:${label}`, "create_blueprint", { packagePath: `${ROOT}/${name}`, parentClass: "Actor", save: false }],
      [`bp-class:${label}`, "create_blueprint", { packagePath: `${ROOT}/BP_Fuzz_${label}`, parentClass: name, save: false }],
      [`struct:${label}`, "create_struct", { packagePath: `${ROOT}/S_${label}`, fields: [{ name, type: "int" }] }],
      [`struct-type:${label}`, "create_struct", { packagePath: `${ROOT}/S_T_${label}`, fields: [{ name: "F", type: name }] }],
      [`enum:${label}`, "create_enum", { packagePath: `${ROOT}/E_${label}`, entries: [name] }],
      [`widget:${label}`, "create_widget_blueprint", { packagePath: `${ROOT}/W_${label}`, save: false }],
      [`widget-class:${label}`, "add_widget", { path: `${ROOT}/W_Base.W_Base`, widgetClass: name, name: "X" }],
      [`var:${label}`, "add_variable", { path: BP_OBJ, variableName: name, type: "int" }],
      [`var-type:${label}`, "add_variable", { path: BP_OBJ, variableName: `V_${label}`, type: name }],
      [`node-fn:${label}`, "add_node", place({ nodeType: "CallFunction", functionName: name, className: name })],
      [`graph:${label}`, "add_node", { path: BP_OBJ, graphName: name, nodeType: "Branch" }],
      [`path:${label}`, "list_blueprint_graphs", { path: name }],
    ];
    for (const [key, cmd, params] of cases) {
      const result = await attempt(key, `${cmd} ${label}`, cmd, params);
      if (result === "crash") return report(true);
      if (result !== "skipped") process.stdout.write(result === "ok" ? "." : "r");
    }
  }

  await report(false);
}

async function report(crashed) {
  console.log("\n");
  console.log(`attempts accepted: ${state.ok}`);
  console.log(`attempts refused cleanly: ${state.rejected}   <- these are passes: the tool said no instead of dying`);
  console.log(`editor crashes: ${state.crashes.length}`);

  if (state.crashes.length > 0) {
    console.log("\nCRASHES:");
    for (const c of state.crashes) {
      console.log(`  ${c.label}`);
      console.log(`    cmd: ${c.cmd}  params: ${JSON.stringify(c.params)}`);
    }
  }
  if (crashed) {
    console.log("\nThe editor died. Restart it and re-run this script; it resumes past the input above.");
    process.exit(1);
  }

  // Clean up only on a complete, crash-free run, so a crashed run leaves the evidence in place.
  try {
    const assets = await bridge.send("list_assets", { className: "Blueprint", pathPrefix: ROOT });
    console.log(`\nleftover scratch assets under ${ROOT}: ${(assets.assets ?? assets.results ?? []).length ?? "?"}`);
  } catch {
    /* listing is a convenience, not a result */
  }
  console.log("\nno crashes.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`sweep could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
