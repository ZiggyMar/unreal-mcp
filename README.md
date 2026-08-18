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

There is also a companion document that starts from the other end: [docs/COMPLAINTS_SOLVED.md](docs/COMPLAINTS_SOLVED.md) collects the complaints people actually file about Unreal MCP servers, each with its source link, and states plainly whether this project solves it, partly solves it, or does not. The open rows are left open on purpose.

## Status

This is being built and verified in public, milestone by milestone. Each milestone's status doc is written honestly, including what's compiled/tested versus what's still unverified:

- [Milestone 1: read-only Blueprint introspection](docs/M1_STATUS.md): compiles and runs against a real UE 5.8 install; MCP protocol verified end-to-end.
- [Milestone 2: create/edit Blueprint graphs](docs/M2_STATUS.md): create Blueprints, add nodes, connect pins, add variables, compile with structured error reporting.
- [Milestone 3: persistent project index, search, references](docs/M3_STATUS.md): incrementally-updated index (AssetRegistry-backed, disk-cached), `search_project`, `find_references`, `get_project_overview`, optional local-model enrichment for search results.
- [Milestone 4: UE 5.6 support](docs/UE56_STATUS.md): live-verified on 5.6, 21 of 21 checks passing, and released. The plugin source needs zero changes between the two engine versions.
- [Milestone 5: node/function ground-truth catalog](docs/M5_STATUS.md): `unreal_find_node` and `unreal_get_node_signature`, reading the running engine's real Blueprint-callable surface via reflection (12,402 functions on 5.6, 15,775 on 5.8, built in ~0.1s). `unreal_add_node` now answers a wrong function name with `didYouMean` near-misses instead of a dead end.

All four milestones are build-verified, protocol-verified, **and live-verified on both engine
versions**. See [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md) for the 5.8 session against a
real ~20-Blueprint project and [docs/UE56_STATUS.md](docs/UE56_STATUS.md) for the 5.6 one: reads
returning correct real data, a full create/wire/compile/save write round-trip, and confirmation that
the incremental project index actually stays fresh without restarting the editor (M3's core claim).

Both live sessions earned their keep by catching a real bug that no amount of compiling or protocol
testing would have surfaced. On 5.8 it was `add_node` duplicating an already-present override-event
node. On 5.6 it was the `.uplugin` hard-pinning `EngineVersion` to `5.8.0`: every build check passed
because UnrealBuildTool ignores that field, but the runtime plugin loader honors it, so the editor
stopped on a modal incompatibility dialog and the bridge never started.

Since then, all of that has been exercised live too: `remove_node` and `VariableGet` are covered by
the node-id and control-flow suites, and `add_node` now places `Branch`, `Sequence`, `Cast`, and
standard-library macros (`ForEachLoop`, `WhileLoop`, ...) directly, verified by building and
compiling a real conditional graph through the bridge alone. Node ids are persistent GUIDs, and
every write is undoable with Ctrl+Z under a named "MCP:" transaction. Still outstanding:
`CustomEvent`/`VariableSet` node types have not had a dedicated live check, and the M5 catalog
covers `UFunction`-backed nodes; native `UK2Node` types are placed via the dedicated `nodeType`
values rather than discovered through `unreal_find_node`.

## Quickstart (4-Step Installation)

Ensure you have **Node.js 18+** and a **UE 5.6 / 5.8** project.

### 1. Install the Unreal Plugin

Copy the `UnrealMCPBridge` plugin folder into your Unreal project's `Plugins/` directory:

```bash
# macOS / Linux
mkdir -p "/path/to/YourProject/Plugins" && cp -r UnrealMCPBridge "/path/to/YourProject/Plugins/"

# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "C:\path\to\YourProject\Plugins"; Copy-Item -Recurse UnrealMCPBridge "C:\path\to\YourProject\Plugins\"
```
*Note: Rebuild/open your Unreal project to compile the plugin, and ensure it is enabled in the editor.*

There are prebuilt plugin releases on the releases page, and they are **older than this server**.
The bridge has gained more than twenty commands since the last one, and the protocol number did not
change, so an old plugin looks healthy and then fails on the first tool that needs a command it does
not have. `--doctor` now probes for those commands specifically and says so. Building from this
checkout is the reliable path.

### 2. Build the MCP Server
Install the node dependencies and compile the typescript codebase:

```bash
cd mcp-server && npm install && npm run build
```

### 3. Check it works before wiring anything up

With the editor open, run:

```bash
node mcp-server/dist/index.js --doctor
```

It reports whether the plugin is reachable, whether its protocol matches the server, whether the
project index is built or still scanning, whether the engine's node catalog is readable, and
whether a PIE session is in the way. Every failed check comes with the remedy, so you never have
to guess which of six things is wrong. Exit code 1 means the editor could not be reached.

### 4. Register the Server

**Do not hand-write the config.** Run this and paste what it prints:

```bash
node mcp-server/dist/index.js --print-config                      # Claude Desktop
node mcp-server/dist/index.js --print-config --client cursor      # Cursor
node mcp-server/dist/index.js --print-config --client claude-code # Claude Code
```

It emits the exact JSON for this machine, with absolute paths already resolved, and tells you which
file it goes in.

That exists because client setup is its own category of failure and all of it is self-inflicted: a
missing comma breaks the whole file, a relative path silently does not resolve, and on Windows a
bare `node` may not be on the PATH the client uses. Every one of those produces the same symptom —
the server never starts, with no explanation. The printed config uses the absolute path of the Node
that ran the command, so it cannot be the wrong one.

Then **fully quit and reopen the client.** Closing the window is not enough, and it is the most
common reason a correct config appears not to work.

<details>
<summary>Writing the config by hand (only if the command above cannot run)</summary>

Point your client at the absolute path of `mcp-server/dist/index.js`:

**Claude Code:**
```bash
claude mcp add unreal -- node "/path/to/unreal-mcp/mcp-server/dist/index.js"
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "unreal": {
      "command": "node",
      "args": ["/path/to/unreal-mcp/mcp-server/dist/index.js"]
    }
  }
}
```

Note that `"command": "node"` depends on `node` being on the PATH your client uses, which on Windows
it often is not. That is the single most common reason a correct-looking config never starts, and
the reason `--print-config` exists.

</details>

Once registered, open your project in the Unreal Editor and verify the connection via `unreal_ping`.

For more configuration options and details, see [`mcp-server/README.md`](mcp-server/README.md).


## What CI covers, and what it does not

**Status: the workflow is committed but has never run.** GitHub refused to start it - *"the job was
not started because your account is locked due to a billing issue"* - so no badge is shown here. A
badge reading "failing" for a billing reason would say something false about the code. The workflow
is structurally valid and the whole suite is verified to pass locally with no editor running, which
is the same thing it does on a runner; that is a claim about local runs, not a CI result.

The badge above covers the parts that need no Unreal install, run on a clean Linux machine with
nothing preinstalled: build, typecheck, tool/bridge parity, documentation guards, profile token
budgets, strict-client protocol conformance, and the unit tests - on the oldest Node the README
promises and on the current one. It also checks that `--doctor` and `--print-config` behave
correctly with **no editor running**, since that is exactly when someone reaches for them.

It does **not** run live verification or the local-model benchmark. Those need a running editor, and
one needs a GPU. Their results live in [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md) and
[docs/LOCAL_MODEL_BENCHMARK.md](docs/LOCAL_MODEL_BENCHMARK.md), and they are run by hand against both
engine versions. Claiming them in CI would make the badge mean less than it does.

The C++ plugin is not compiled in CI either, because Epic does not ship an engine that can be
fetched there. `npm run build:engines` builds it against every configured engine locally and reports
success only if every one of them actually built.

## Contributing

Issues and PRs welcome. This project is young and moving fast, so check the status docs above before assuming something works end-to-end.

## License

MIT. See [LICENSE](LICENSE).

