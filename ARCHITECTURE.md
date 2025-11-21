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

