# unreal-mcp

![Unreal MCP Hero Demo](docs/images/hero.gif)

An MCP server that allows AI agents (Claude, Cursor) to directly control and manipulate Unreal Engine.

This server lets Claude (or any MCP client) read and edit Unreal Engine 5.6/5.8 Blueprints directly, without burning your context window on raw engine JSON, and without needing anything beyond a stock Epic Games Launcher install.

![Architecture](docs/images/architecture.svg)

## The problem this solves

If you've tried pointing an AI assistant at a real Unreal project, you've hit this: Blueprints don't fit in a context window. A single graph dumped as raw engine data is enormous, so either the model never sees enough of the project to have real context, or you spend most of your budget re-explaining what already exists every time you open a new conversation.
