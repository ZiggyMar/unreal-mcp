# unreal-mcp

![Unreal MCP Hero Demo](docs/images/hero.gif)

An MCP server that allows AI agents (Claude, Cursor) to directly control and manipulate Unreal Engine.

This server lets Claude (or any MCP client) read and edit Unreal Engine 5.6/5.8 Blueprints directly, without burning your context window on raw engine JSON, and without needing anything beyond a stock Epic Games Launcher install.

![Architecture](docs/images/architecture.svg)

## The problem this solves

If you've tried pointing an AI assistant at a real Unreal project, you've hit this: Blueprints don't fit in a context window. A single graph dumped as raw engine data is enormous, so either the model never sees enough of the project to have real context, or you spend most of your budget re-explaining what already exists every time you open a new conversation.

This project is built around one idea: **the model should never receive a raw engine dump.** Every hop between the Unreal Editor and Claude compacts the data: tiered reads, diff-based edits, and a persistent index that's built once and updated incrementally instead of re-scanned on every question.

## How it works

Two pieces:

- **`UnrealMCPBridge`** is a C++ editor plugin that runs inside `UnrealEditor.exe` and exposes a local TCP interface over the engine's own Kismet2/EdGraph/AssetRegistry APIs. Built against a stock launcher install: no engine source required to build or run it.
- **`mcp-server`** is a Node/TypeScript MCP server that translates MCP tool calls into bridge requests, and is responsible for keeping every response cheap: compact field names, capped result sizes, and no re-serializing verbose engine data verbatim.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## What's different about this one

There are several Unreal MCP projects on GitHub already, and as of UE 5.8 Epic ships its own experimental first-party MCP plugin (5.8 only, opt-in, requires manually enabling an "Editor Toolset"). Worth being direct about where this project actually differs, rather than just claiming "better":

