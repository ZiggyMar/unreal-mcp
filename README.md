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

- **Built around reading, not just writing.** Most existing projects are strong at creating and manipulating Blueprints from a prompt, but don't address what happens when the model needs to *understand a large, already-built* project first. Reading is the first-class citizen here: tiered summaries before full detail, node IDs you can reference without re-fetching.
- **A persistent, incrementally-updated project index.** The bridge indexes Blueprints, functions, variables, and cross-asset references once, caches it to disk, and updates it from `AssetRegistry` delegates as you edit, instead of rescanning the project on every query. `find_references` answers "what actually uses this Blueprint" without the model having to enumerate the project itself.
- **An optional local-model hook for indexing.** If you point `UNREAL_MCP_LOCAL_LLM_URL` at a local model (Ollama or anything OpenAI-compatible), indexing summaries are generated there instead of spending Claude's tokens on mechanical scanning work. Fully optional. The index works without it.
- **Targets both 5.6 and 5.8 from one codebase**, where several existing projects are pinned to a single engine version.

Full survey of the existing ecosystem (licenses, architectures, what each one does well) is in [docs/COMPETITIVE_LANDSCAPE.md](docs/COMPETITIVE_LANDSCAPE.md).

## Status

This is being built and verified in public, milestone by milestone. Each milestone's status doc is written honestly, including what's compiled/tested versus what's still unverified:

- [Milestone 1: read-only Blueprint introspection](docs/M1_STATUS.md): compiles and runs against a real UE 5.8 install; MCP protocol verified end-to-end.
- [Milestone 2: create/edit Blueprint graphs](docs/M2_STATUS.md): create Blueprints, add nodes, connect pins, add variables, compile with structured error reporting.
- [Milestone 3: persistent project index, search, references](docs/M3_STATUS.md): incrementally-updated index (AssetRegistry-backed, disk-cached), `search_project`, `find_references`, `get_project_overview`, optional local-model enrichment for search results.

All three milestones are build-verified, protocol-verified, **and now live-verified**: see
[docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md) for a real session against a real ~20-Blueprint
project: reads returning correct real data, a full create/wire/compile/save write round-trip, and
confirmation that the incremental project index actually stays fresh without restarting the editor
(M3's core claim). That session also caught and fixed a real bug (`add_node` duplicating an
already-present override-event node) that no amount of compiling or protocol testing would have
surfaced. Still outstanding: UE 5.6 hasn't been live-tested yet (5.8 only so far), and a handful of
less-common commands (`add_variable`, `remove_node`, `CustomEvent`/`VariableGet`/`VariableSet` nodes)
haven't been exercised live.

## Quickstart (3-Step Installation)

Ensure you have **Node.js 18+** and a **UE 5.6 / 5.8** project.

### 1. Install the Unreal Plugin
Copy the `UnrealMCPBridge` plugin folder to your Unreal project's `Plugins/` directory:

```bash
# macOS / Linux
mkdir -p "/path/to/YourProject/Plugins" && cp -r UnrealMCPBridge "/path/to/YourProject/Plugins/"

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "C:\path\to\YourProject\Plugins"; Copy-Item -Recurse UnrealMCPBridge "C:\path\to\YourProject\Plugins\"
```
*Note: Rebuild/open your Unreal project to compile the plugin, and ensure it is enabled in the editor.*

### 2. Build the MCP Server
Install the node dependencies and compile the typescript codebase:

```bash
cd mcp-server && npm install && npm run build
```

### 3. Register the Server
Connect the server to your MCP client using the absolute path to `mcp-server/dist/index.js`:

**Claude Code:**
```bash
claude mcp add unreal -- node "/path/to/unreal-mcp/mcp-server/dist/index.js"
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
