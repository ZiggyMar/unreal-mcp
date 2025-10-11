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
