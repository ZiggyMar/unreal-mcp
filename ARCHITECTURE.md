# Unreal MCP: Architecture

## Goal
Let an AI assistant (Claude, via MCP) read and edit a live Unreal Engine 5.6/5.8 project
(Blueprints especially) without wasting tokens, and without requiring anything beyond a
stock Epic Games Launcher engine install on the end user's machine.

## Components

```
Claude (MCP client)
      |  MCP protocol (stdio/socket)
      v
mcp-server/         Node/TypeScript process. Owns the MCP tool surface.
      |  local TCP/HTTP, JSON
      v
UnrealMCPBridge/     C++ editor-only plugin, loaded by UnrealEditor.
      |  UE reflection / Blueprint APIs (Kismet, EdGraph, AssetRegistry)
      v
Unreal Engine 5.6/5.8 Editor process (stock launcher build, no engine source needed to RUN it)
```

- **UnrealMCPBridge** (C++ plugin): runs inside the editor, listens on a local TCP port,
  exposes commands (list assets, read blueprint, create blueprint, add node, connect pins,
  compile, read actor/level state, search). Uses only public Editor Scripting / Kismet2 /
  AssetRegistry APIs, so it works against a standard launcher-installed engine. Must be built
  once per engine version (5.6 and 5.8 builds), like any other UE plugin. This does NOT
  require engine source to build or run; source is only being pulled locally as a reference
  for API behavior during development.
- **mcp-server**: implements the Model Context Protocol, translates MCP tool calls into
  bridge requests, and (critically) is responsible for compacting bridge responses into
  token-cheap summaries before returning them to the model.

## Token-efficiency strategy (the core hard problem)

Never send a Blueprint's raw engine representation. Instead:

1. **Tiered reads.** `list_blueprint_graphs` (names + node counts only) →
   `read_blueprint_graph_summary` (node types, names, connections, no positions/metadata) →
   `read_blueprint_node_detail` (full pin/property detail for ONE node) only when needed.
2. **Diff-based edits.** Writes are expressed as small structured ops (`add_node`,
   `connect_pins`, `set_default_value`, `remove_node`), never "regenerate the whole graph."
3. **Stable IDs.** Every node/pin gets a short stable ID so the model can reference prior
   reads without re-fetching full context.
4. **Project-wide index, cached.** A background index (built once, updated incrementally)
   of all blueprints/classes/functions/variables in the project, queryable by name/keyword,
   so the model doesn't need to enumerate the whole project to find one thing.
5. **Graph rendering on demand.** When useful, the bridge can also push a screenshot of the
   Blueprint graph editor (opened + framed on the relevant nodes) so the user visually sees
   the edit: this is for the human, not fed back to the model as tokens.

## Repo layout (this folder)

```
UnrealMCP/
  ARCHITECTURE.md
  mcp-server/              Node/TS MCP server
  UnrealMCPBridge/          C++ plugin source (copied into target project's Plugins/ to build)
  docs/                     API notes gathered from engine source + public docs
```
