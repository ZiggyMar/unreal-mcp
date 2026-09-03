#!/usr/bin/env node
// Every command the C++ bridge implements must be reachable as an MCP tool.
//
// This exists because it silently was not: the bridge shipped 37 commands while the MCP server
// exposed 23, so levels, actors, components, class defaults, input, and PIE were implemented,
// live-verified, documented, and unreachable by any AI client. Nothing failed loudly, because
// nothing was checking. This is that check.
//
// Run: npm run check:parity   (also runs as part of npm test)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const handlerPath = join(repoRoot, "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private", "MCPCommandHandler.cpp");
const serverPath = join(here, "..", "src", "index.ts");

// Commands the bridge dispatches, from its own `Cmd == TEXT("...")` chain.
const bridgeCommands = new Set(
  [...readFileSync(handlerPath, "utf8").matchAll(/Cmd\s*==\s*TEXT\("([a-z0-9_]+)"\)/g)].map((m) => m[1])
);

// Tools the MCP server registers, minus the unreal_ prefix.
const registeredTools = new Set(
  [...readFileSync(serverPath, "utf8").matchAll(/(?:server\.registerTool|register)\(\s*"unreal_([a-z0-9_]+)"/g)].map((m) => m[1])
);

// Tool names that intentionally differ from their bridge command name.
const aliases = new Map([
  ["screenshot", "take_screenshot"],
  ["read_blueprint_summary", "read_blueprint_graph_summary"],
  ["read_node_detail", "read_blueprint_node_detail"],
]);

// Tools implemented in the MCP server by composing several bridge commands, rather than mapping
// to one. These are deliberate: they belong on the client side because they need no engine access
// beyond the commands that already exist.
// read_runtime_errors reads the editor's own log file from disk. It needs no bridge command at all,
// which is the point: it works while the editor is mid-crash, and it can read the session that
// already happened - which is the situation somebody is in when they say "I pressed play and got
// errors".
// run_tests is a composite of run_console_command plus a parse of Saved/Logs: the engine runs
// automation asynchronously and reports through the log, so there is no single bridge command
// to match it against. Built this way deliberately - a new C++ command would have meant a plugin
// rebuild and an editor restart before anyone could use it.
// trace_input walks read_input_context -> find_references -> read_blueprint_graph_summary, for the
// same reason: every step it needs already exists as a bridge command, so composing it in the server
// costs no plugin rebuild and no editor restart.
// review_layout reads read_blueprint_graph_summary with positions and judges the result in the
// server. The judging is pure and belongs in a unit test, not in the editor - and a rule about how a
// graph LOOKS should be changeable without a plugin rebuild.
const compositeTools = new Set(["review_layout", "tidy_layout", "trace_input", "run_tests", "document_asset", "call_tool", "verify_runtime", "read_runtime_errors", "auto_layout_graph", "review_blueprint", "doctor", "enable_tools", "session_changes", "map_system", "plan_feature", "cleanup_blueprint", "add_event_handler", "scaffold_blueprint", "scaffold_widget", "explain_graph", "audit_project", "guard_with_authority", "list_tools", "guide", "find_source", "verify_feature", "check_data_tables", "find_in_data_tables", "find_orphans",
  // compile_cpp asks the bridge only where the engine and project are (ping) and then runs
  // UnrealBuildTool itself. It is deliberately NOT a bridge command: the compile must survive the
  // editor being busy, and a build that takes minutes has no business occupying the game thread.
  "compile_cpp",
  // hot_reload_cpp starts live_coding_compile and then polls live_coding_status until it finishes.
  // Two bridge commands rather than one because the engine's blocking form spins on the game thread
  // behind a modal dialog, which would hang this plugin's own ticker and every later command with it.
  // The waiting belongs on this side, where it costs the model nothing: still one tool call.
  "hot_reload_cpp",
  // call_parent_function reads the graph, adds a CallParent node and rewires two exec pins. Every
  // one of those is a bridge command that has existed for a long time - which is the point: the fix
  // for the second most expensive finding needed no plugin change at all, only somebody to write
  // down the wiring so a model does not have to get it right from prose.
  "call_parent_function"]);

const covered = new Set();
for (const tool of registeredTools) {
  if (compositeTools.has(tool)) continue;
  covered.add(aliases.get(tool) ?? tool);
}

// Bridge commands that deliberately have no MCP tool: internal helpers a composite tool calls, where
// a separate tool would cost every session a definition for something nobody calls directly.
//
// find_broken_names checks names typed as text - a Data Table row, a timer's target function -
// against whether that thing exists. It belongs inside "find every bug", and audit_project is what
// calls it. Exposing it as well would add ~330 tokens of standing context to earn nothing.
//
// live_coding_compile and live_coding_status are the two halves of hot_reload_cpp. Separately they
// are a start button and a poll, and neither is a job anybody asks for; together they are "make the
// running editor run my fix". Two more tool definitions would cost every session standing context to
// let a caller do by hand what the composite already does correctly.
const internalCommands = new Set(["find_broken_names", "live_coding_compile", "live_coding_status"]);

const unreachable = [...bridgeCommands]
  .filter((cmd) => !covered.has(cmd) && !internalCommands.has(cmd))
  .sort();
const dangling = [...covered].filter((cmd) => !bridgeCommands.has(cmd)).sort();

if (unreachable.length === 0 && dangling.length === 0) {
  console.log(
    `tool parity ok: ${bridgeCommands.size} bridge commands, ${registeredTools.size} MCP tools ` +
      `(${compositeTools.size} composite), all matched`
  );
  process.exit(0);
}

if (unreachable.length > 0) {
  console.error(
    `\nUNREACHABLE: ${unreachable.length} bridge command(s) have no MCP tool, so no AI client can call them:\n` +
      unreachable.map((c) => `  - ${c}`).join("\n") +
      `\n\nAdd a server.registerTool("unreal_${unreachable[0]}", ...) in mcp-server/src/index.ts.`
  );
}
if (dangling.length > 0) {
  console.error(
    `\nDANGLING: ${dangling.length} MCP tool(s) call a bridge command that does not exist, so they fail at runtime:\n` +
      dangling.map((c) => `  - ${c}`).join("\n") +
      `\n\nEither implement it in MCPCommandHandler.cpp or add it to the alias map in this script.`
  );
}
process.exit(1);
