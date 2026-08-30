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
const compositeTools = new Set(["read_runtime_errors", "auto_layout_graph", "review_blueprint", "doctor", "enable_tools", "session_changes", "map_system", "plan_feature", "cleanup_blueprint", "add_event_handler", "scaffold_blueprint", "scaffold_widget", "explain_graph", "audit_project", "guard_with_authority", "list_tools", "guide", "find_source", "verify_feature", "check_data_tables"]);

const covered = new Set();
for (const tool of registeredTools) {
  if (compositeTools.has(tool)) continue;
  covered.add(aliases.get(tool) ?? tool);
}

const unreachable = [...bridgeCommands].filter((cmd) => !covered.has(cmd)).sort();
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
