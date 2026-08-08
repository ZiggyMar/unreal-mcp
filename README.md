# unreal-mcp

An MCP server that lets Claude (or any MCP client) read and edit Unreal Engine 5.6/5.8 Blueprints directly — without burning your context window on raw engine JSON, and without needing anything beyond a stock Epic Games Launcher install.

![Architecture](docs/images/architecture.svg)

## The problem this solves

If you've tried pointing an AI assistant at a real Unreal project, you've hit this: Blueprints don't fit in a context window. A single graph dumped as raw engine data is enormous, so either the model never sees enough of the project to have real context, or you spend most of your budget re-explaining what already exists every time you open a new conversation.

This project is built around one idea: **the model should never receive a raw engine dump.** Every hop between the Unreal Editor and Claude compacts the data — tiered reads, diff-based edits, and a persistent index that's built once and updated incrementally instead of re-scanned on every question.

## How it works

Two pieces:

- **`UnrealMCPBridge`** — a C++ editor plugin that runs inside `UnrealEditor.exe` and exposes a local TCP interface over the engine's own Kismet2/EdGraph/AssetRegistry APIs. Built against a stock launcher install — no engine source required to build or run it.
- **`mcp-server`** — a Node/TypeScript MCP server that translates MCP tool calls into bridge requests, and is responsible for keeping every response cheap: compact field names, capped result sizes, and no re-serializing verbose engine data verbatim.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

## What's different about this one

There are several Unreal MCP projects on GitHub already, and as of UE 5.8 Epic ships its own experimental first-party MCP plugin (5.8 only, opt-in, requires manually enabling an "Editor Toolset"). Worth being direct about where this project actually differs, rather than just claiming "better":

- **Built around reading, not just writing.** Most existing projects are strong at creating and manipulating Blueprints from a prompt, but don't address what happens when the model needs to *understand a large, already-built* project first. Reading is the first-class citizen here — tiered summaries before full detail, node IDs you can reference without re-fetching.
- **A persistent, incrementally-updated project index.** The bridge indexes Blueprints, functions, variables, and cross-asset references once, caches it to disk, and updates it from `AssetRegistry` delegates as you edit — instead of rescanning the project on every query. `find_references` answers "what actually uses this Blueprint" without the model having to enumerate the project itself.
- **An optional local-model hook for indexing.** If you point `UNREAL_MCP_LOCAL_LLM_URL` at a local model (Ollama or anything OpenAI-compatible), indexing summaries are generated there instead of spending Claude's tokens on mechanical scanning work. Fully optional — the index works without it.
- **Targets both 5.6 and 5.8 from one codebase**, where several existing projects are pinned to a single engine version.

Full survey of the existing ecosystem — licenses, architectures, what each one does well — is in [docs/COMPETITIVE_LANDSCAPE.md](docs/COMPETITIVE_LANDSCAPE.md).

## Status

This is being built and verified in public, milestone by milestone. Each milestone's status doc is written honestly, including what's compiled/tested versus what's still unverified:

- [Milestone 1 — read-only Blueprint introspection](docs/M1_STATUS.md): compiles and runs against a real UE 5.8 install; MCP protocol verified end-to-end.
- [Milestone 2 — create/edit Blueprint graphs](docs/M2_STATUS.md): create Blueprints, add nodes, connect pins, add variables, compile with structured error reporting.
- Milestone 3 — persistent project index and search: in progress.

The one thing every milestone currently shares as a caveat: everything is verified by compiling against the real engine and exercising the real MCP protocol, but nobody has yet run a full session inside the live graphical Editor. That's the next thing to close out — see the status docs for the exact manual steps.

## Setup

Requires UE 5.6 or 5.8 (stock Epic Games Launcher install) and Node.js 18+.

1. Copy `UnrealMCPBridge/` into your project's `Plugins/` folder and enable it (or add it to your `.uproject`'s `Plugins` array).
2. Build your project once so the plugin compiles.
3. In `mcp-server/`, run `npm install && npm run build`.
4. Point your MCP client at it — for Claude Code:

   ```bash
   claude mcp add unreal -- node "/path/to/unreal-mcp/mcp-server/dist/index.js"
   ```

5. Open your project in the Editor, then ask Claude to call `unreal_ping` to confirm the connection.

Full details in [mcp-server/README.md](mcp-server/README.md).

## Contributing

Issues and PRs welcome. This project is young and moving fast — check the status docs above before assuming something works end-to-end.

## License

MIT — see [LICENSE](LICENSE).
