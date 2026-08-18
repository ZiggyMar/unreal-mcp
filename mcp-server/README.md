# unreal-mcp-server

Node/TypeScript MCP (Model Context Protocol) server that exposes Unreal Engine Blueprint
introspection **and edit** tools to an MCP client (Claude Code, Claude Desktop, etc).
It is a thin translator: every tool call opens a short-lived TCP connection to the
`UnrealMCPBridge` C++ editor plugin on `127.0.0.1:8765`, sends one line of JSON, reads one
line of JSON back, and reshapes it into a compact result for the model.

This process does **not** talk to Unreal directly via any engine SDK. It only speaks the
bridge's tiny line-delimited JSON protocol over a loopback TCP socket. The Unreal Editor
(with the `UnrealMCPBridge` plugin enabled) must already be running for any tool except
`unreal_ping` to return useful data; `unreal_ping` itself will simply report the connection
error if the editor/bridge isn't up.

## Prerequisites

- Node.js >= 18
- The `UnrealMCPBridge` plugin built and enabled in the target `.uproject`, with the
  Unreal Editor open on that project (see `../docs/M1_STATUS.md` for the current build
  status and manual steps).

## Setup

```bash
cd mcp-server
npm install
npm run build        # compiles src/ -> dist/
npm run typecheck    # tsc --noEmit, no build artifacts
```

Run it standalone (mostly useful for manually checking it starts without error, since a
real MCP client normally launches this itself over stdio):

```bash
npm start
```

## Tools exposed

### Read-only (Milestone 1)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_ping` | `ping` | Liveness check for the editor bridge. |
| `unreal_list_blueprints` | `list_blueprints` | Project-wide (or path-scoped) list of Blueprint assets: name, path, parent class. |
| `unreal_list_blueprint_graphs` | `list_blueprint_graphs` | Graph names + node counts for one Blueprint. |
| `unreal_read_blueprint_summary` | `read_blueprint_graph_summary` | Compact per-node summary of one graph: id, type, title, connected pins only (no position/cosmetic metadata). |
| `unreal_read_node_detail` | `read_blueprint_node_detail` | Full pin/property detail for exactly one node by id. |

These mirror the tiered-read strategy in `../ARCHITECTURE.md`: list graphs -> summarize one
graph -> drill into one node, instead of ever dumping a whole Blueprint's raw engine JSON.

### Write/edit (Milestone 2)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_create_blueprint` | `create_blueprint` | Create a new Blueprint asset at a path with a given parent class; saves to disk by default. |
| `unreal_add_node` | `add_node` | Add an Event/CustomEvent/CallFunction/VariableGet/VariableSet node; returns its new node id immediately. |
| `unreal_connect_pins` | `connect_pins` | Connect an output pin to an input pin (exec or data), via the graph schema. |
| `unreal_set_pin_default_value` | `set_pin_default_value` | Set a literal default on an unconnected input pin. |
| `unreal_remove_node` | `remove_node` | Remove a node by id, breaking its links first. |
| `unreal_add_variable` | `add_variable` | Add a member variable (compact type descriptor: `bool`, `int`, `float`, `vector`, `object:<Class>`, ...). |
| `unreal_compile_blueprint` | `compile_blueprint` | Compile and return structured errors/warnings. **Run this after every batch of edits** (see below). |
| `unreal_save_blueprint` | `save_blueprint` | Save the Blueprint's package to disk. |

**Always call `unreal_compile_blueprint` after a batch of `add_node`/`connect_pins`/
`add_variable` calls, before reporting success to the user.** A graph can look
structurally fine (nodes added, pins connected) and still fail to compile (type
mismatches, unresolved variables, missing required pins). This is the safety net for
every write tool above it, and per `../docs/M2_STATUS.md` it is also the single
least-verified piece of this milestone, so treat its first few real runs with extra
scrutiny.

### Project-wide index (Milestone 3)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_get_project_overview` | `get_project_overview` | Cheap top-level summary: counts + folder/parent-class breakdowns. **Call this first** to orient yourself. |
| `unreal_search_project` | `search_project` | Keyword/substring search across blueprint/function/variable/class names, via a persistent index, not a live rescan. |
| `unreal_find_references` | `find_references` | What references an asset, and what it depends on, via the AssetRegistry dependency graph. The direct answer to "what uses this Blueprint." |

These exist to solve the actual problem this whole project is for: finding things across
a large project without enumerating everything every time, and without losing track of
what's connected to what. The index backing `unreal_search_project` /
`unreal_get_project_overview` lives in the C++ plugin (`FMCPProjectIndex`), is persisted
to `Saved/UnrealMCPBridge/index.json` in the target project so a fresh editor session
doesn't need a full rescan, and is kept fresh incrementally via AssetRegistry delegates
as you edit. See `../docs/M3_STATUS.md` for details.

`unreal_find_references` doesn't depend on that index at all. It queries the
AssetRegistry's dependency graph directly, so it works even before the index has been
built, and for any asset, not just indexed Blueprints.

### Node/function ground-truth catalog (Milestone 5)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_find_node` | `find_node` | Search the running engine's real Blueprint-callable function catalog by intent or partial name. Returns exact `functionName`/`className` values `unreal_add_node` accepts. |
| `unreal_get_node_signature` | `get_node_signature` | Exact pins for one function: each parameter's name, type, direction, and default, from live reflection. |

These solve a different problem than the tools above. The project index answers "what is in
*this project*." The node catalog answers "what does *this engine version* actually expose, and
what exactly is it called." No general-purpose model reliably knows Unreal's exact node names,
pin names, and signatures, and that is the most common cause of a failed edit.

`FMCPNodeCatalog` builds the catalog by walking `UClass`/`UFunction` reflection in the running
editor, so its answers are correct for whatever engine version is open rather than recalled from
training. Unlike the project index it needs no on-disk cache: the walk loads no assets, so it is
cheap enough to build lazily once per session.

**Call `unreal_find_node` before `unreal_add_node` whenever you are not certain a function name
and its owning class are exactly right.** If you skip it and get the name wrong, `unreal_add_node`
now fails with a `didYouMean` list of near-misses drawn from the catalog rather than a bare
`function_not_found`, so the mistake is recoverable in one step:

```json
{
  "ok": false,
  "error": "function_not_found: PrintSting on KismetSystemLibrary",
  "didYouMean": [
    { "functionName": "PrintString", "className": "/Script/Engine.KismetSystemLibrary" }
  ]
}
```

Neither tool ever returns the whole catalog, which runs to thousands of entries. `find_node` hits
carry a `paramCount` and omit the pin list; full pins come only from `get_node_signature` for one
function at a time. This is the same tiered approach as the M1 reads.

#### Optional: local-model enrichment for search results

By default, `unreal_search_project` hits are bare structural data (kind/path/name/
context): no natural-language summaries, no extra cost, zero setup. If you want hits to
also show a one-line "what does this do" description, point `UNREAL_MCP_LOCAL_LLM_URL`
at any OpenAI-compatible `/chat/completions` endpoint. This works out of the box with a
local [Ollama](https://ollama.com) model, so you can get richer search results **without
spending API tokens on indexing**:

```bash
ollama serve                       # if not already running
ollama pull llama3.2                # or any small/fast model you like

export UNREAL_MCP_LOCAL_LLM_URL="http://localhost:11434/v1"
export UNREAL_MCP_LOCAL_LLM_MODEL="llama3.2"   # optional, this is the default
```

When set, up to a handful of top hits per `unreal_search_project` call get a best-effort
`summary` field generated by that model; the response's `enrichment` field reports
`"local-llm"` or `"none"` so the calling model knows whether this ran. If the endpoint is
unset, unreachable, slow, or errors, search results are returned exactly as they would be
without enrichment. This is designed to never be a hard dependency. See
`src/enrichment.ts` for the implementation.

### Graph authoring and organization

| Tool | Bridge command | Purpose |
| --- | --- | --- |
| `unreal_build_graph` | `build_graph` | Many nodes, wires, and pin defaults in one atomic call, with node `ref` names you choose. **Prefer this over individual `add_node`/`connect_pins` calls whenever placing more than one node.** |
| `unreal_create_function` | `create_function` | Create a function graph with typed inputs/outputs; returns the entry (and result) node ids to wire immediately. |
| `unreal_organize_graph` | `organize_graph` | Node comments, comment boxes, and node positions, so a generated graph reads like a careful human built it. |
| `unreal_auto_layout_graph` | *(composed: `read_blueprint_graph_summary` + `organize_graph`)* | Lay out a whole graph and wrap each execution chain in a comment box titled after its event. No coordinates required from the caller. |
| `unreal_review_blueprint` | *(composed: `list_blueprint_graphs` + `read_blueprint_graph_summary`)* | The quality gate: dead nodes, unhandled cast failures, leftover debug prints, placeholder names, heavy Tick, unlabelled sections. Returns findings with fixes, a score, and one `nextAction`. |
| `unreal_doctor` | *(composed: `ping` + `get_project_overview` + `find_node` + `pie_status`)* | One-call diagnosis of the whole setup, with a remedy per failed check. Never throws: an unreachable editor is the answer, not an error. |
| `unreal_refresh_blueprint` | `refresh_blueprint` | The "right-click > Refresh Nodes" repair: every node re-reads its backing signature. The fix for the whole `in use pin no longer exists` family after a C++ change. |
| `unreal_delete_asset` | `delete_asset` | Delete assets by path, **blocked by default** if anything outside the delete set still references them, with the blocking referencers reported. |

### Scene, actors, components, project settings, and runtime

A Blueprint that compiles is not a game. These are the tools that put the Blueprint into a world,
give it a body, configure its class defaults, bind input to it, and actually run it.

| Tool | Bridge command | Purpose |
| --- | --- | --- |
| `unreal_list_assets` | `list_assets` | AssetRegistry query by class and path, so asset paths are looked up rather than guessed. |
| `unreal_create_level` | `create_level` | Create a Level (World) asset, optionally with a GameMode override. |
| `unreal_open_level` | `open_level` | Load a Level into the editor world. Every actor tool acts on the currently open level. |
| `unreal_spawn_actor` | `spawn_actor` | Place an actor with a transform and label; `StaticMeshActor` + `staticMesh` blocks out geometry in one call. |
| `unreal_save_level` | `save_level` | Save the open Level. Spawned actors live only in memory until this runs. |
| `unreal_add_component` | `add_component` | Add a component to a Blueprint's hierarchy (mesh, collision, camera, spring arm, audio), optionally under a parent component. |
| `unreal_list_components` | `list_components` | Read the component hierarchy, including components inherited from a parent class. |
| `unreal_set_component_property` | `set_component_property` | Set one property on a component template. Fails loudly on an asset path that does not resolve, instead of silently setting `None`. |
| `unreal_set_class_default` | `set_class_default` | Set a Class Defaults (CDO) property. This is how replication gets turned on: `bReplicates`, `NetUpdateFrequency`, `bAlwaysRelevant`. |
| `unreal_set_game_settings` | `set_game_settings` | Project `UGameMapsSettings`: default GameMode, editor startup map, packaged-game default map. Persisted to config. |
| `unreal_add_input_mapping` | `add_input_mapping` | Add an action or axis mapping and save it to config, so `InputAction`/`InputAxis` event nodes have something real behind them. |
| `unreal_start_pie` | `start_pie` | Start Play In Editor, including multi-client sessions (`numPlayers`, `listenServer`) to exercise replication. |
| `unreal_pie_status` | `pie_status` | Whether a PIE session is currently running. PIE starts on the next editor tick, so poll this. |
| `unreal_stop_pie` | `stop_pie` | End the PIE session. Always stop PIE before editing further. |

Compiling proves a Blueprint is valid. Running it is the only thing that proves it works, which is
what `start_pie` is for.

### Readable graphs are produced, not requested

`unreal_build_graph` auto-lays-out the graph it just built, by default. You do not pass `x`/`y`.

This is deliberate, and it is the answer to the most common complaint about AI-authored
Blueprints: that the output compiles but reads as spaghetti. Asking a model to emit good
coordinates does not work reliably, because coordinate quality is exactly what a weaker model is
worst at and never gets feedback on. So the tool does it instead:

- Nodes are ranked into left-to-right columns, so every wire points forward. Cycles from loop
  macros are handled by ignoring back edges, not by giving up.
- Columns are ordered by barycentre sweeps, which removes most wire crossings.
- Execution chains are straightened onto a single row, which is most of what "hand-built" looks
  like in a Blueprint.
- Whole chains are then pushed apart vertically so each event owns a horizontal band.

`unreal_auto_layout_graph` runs the same pass on any existing graph, including ones this server
did not author, and additionally wraps each execution chain in a comment box titled after its
event. It is idempotent: a box whose title already exists is skipped, so running it twice does not
stack duplicates.

The layout engine (`src/layout.ts`) is a pure function over the graph summary with no engine
dependency, so it is unit-tested directly: 21 tests covering left-to-right ranking, exec-chain
straightening, branch fan-out, cycles, disconnected nodes, comment-box geometry, idempotency, and
an overlap check asserted over every pair of placed nodes. `npm test` runs them.

One honest limitation: each node move is its own editor transaction, because the layout is
composed client-side from existing bridge commands. Undoing a layout therefore takes several
Ctrl+Z presses rather than one. A batched move command in the plugin would fix it.

### When something is wrong: `unreal_doctor`

Setup friction is the largest category of complaint about Unreal MCP servers and the one most
people never get past. The reports all look alike: something is refused or silent, and there is no
way to tell which of six independent things is wrong. A troubleshooting page does not help, because
it requires already suspecting the right cause.

`unreal_doctor` checks all of them in order and reports every result with its remedy:

1. **bridge reachable** - is the plugin answering at all
2. **protocol version** - does the loaded plugin match this server, and which one is older
3. **editor responsive** - is the game thread grinding on a compile or waiting on a modal dialog
4. **project index** - built, empty, or still scanning. A still-scanning index is the dangerous
   one: searches report that things do not exist when they do
5. **node catalog** - can the engine's live function surface be read. Without it a model has no
   ground truth for function names and will produce confident nonsense instead of errors
6. **play-in-editor** - is PIE running, which makes Blueprint writes apply to the editor world
   rather than the running one, so they look like they did nothing

It never throws. An unreachable editor is the answer, not an error, and its remedy is the ordered
checklist for fixing it.

**It also runs without an MCP client at all:**

```bash
node dist/index.js --doctor
```

When the complaint is "my AI tool cannot see Unreal", taking the AI tool out of the picture is the
fastest way to learn which half is broken. Exit code 1 if the editor is unreachable, 0 otherwise,
so it can gate a script.

### The quality gate: compiling is not the bar

`unreal_review_blueprint` reports what a senior Unreal developer would flag in review, computed
from one cheap read per graph:

- **dead-node** - nodes wired to nothing, shipped anyway
- **unhandled-cast-failure** - a Cast with its `Cast Failed` path unwired. Silent: the rest of the
  chain simply never runs, and it is the hardest Blueprint bug for a beginner to diagnose
- **debug-print-left-in** - `Print String` still in the graph
- **placeholder-name** - variables still called `NewVar`, `Temp`, `Test`
- **empty-event** - an event with nothing wired to it: an intention never finished
- **tick-heavy** - real work running every frame
- **graph-too-large** / **long-exec-chain** - should have been extracted into named functions
- **unlabelled-sections** - more execution chains than comment boxes
- **branch-dead-path** - a Branch with only one of True/False wired

Each finding carries the concrete fix and the node ids to apply it to. The report includes a
0-100 score and a single `nextAction` naming the one thing most worth doing next, because a caller
handed ten equal priorities picks none of them.

**`unreal_build_graph` attaches this review to its own result, unasked.** That is the point: the
model most in need of the feedback is exactly the model that would never think to ask for it. A
weak model does not usually fail from lack of capability, it fails because nothing ever objects to
what it wrote, so it declares victory. Compilation is a very low bar to clear: a graph full of dead
nodes, unhandled cast failures, and leftover debug prints compiles perfectly.

Every check is deliberately conservative. A false positive teaches a model to distrust the whole
report, which costs more than a missed finding.

### Tool profiles, for small-context models

Tool definitions are paid for on every request, before the user's message is read. The full set is
39 tools and roughly 11.8k tokens of standing cost. On a 200k-context model that is noise; on an
8k or 32k local model it is the difference between usable and unusable.

The instructive descriptions are not the thing to cut, because they are why a weaker model
succeeds at all. So rather than making every user's tools worse, set:

```
UNREAL_MCP_PROFILE=core
```

which exposes 16 tools for about 5.0k tokens, a 58% reduction, and still keeps a straight line
through the whole job: orient, search, read, find the exact node, create the Blueprint, add
variables and functions, build the graph, compile, lay out, review, save. What it drops is the
single-node editing tools (`unreal_build_graph` does that job in one call), the level / actor /
component / PIE surface, and the maintenance tools.

The default is `full`. The active profile and tool count are printed to stderr on startup.

### Tool parity is enforced, not assumed

Every command the C++ bridge dispatches must have a matching MCP tool, and every MCP tool must
call a command the bridge actually implements. `npm run check:parity` (which `npm run build` and
`npm test` both run) parses both sides and fails the build otherwise.

This check exists because the gap it catches really happened: the bridge shipped 37 commands while
the server exposed 23, so levels, actors, components, class defaults, input mappings, and PIE were
implemented, live-verified, documented, and **unreachable by any AI client**. Nothing failed
loudly, because nothing was checking.

## Configuration

Environment variables (all optional):

- `UNREAL_MCP_BRIDGE_HOST`: default `127.0.0.1`
- `UNREAL_MCP_BRIDGE_PORT`: default `8765`
- `UNREAL_MCP_LOCAL_LLM_URL`: unset by default (enrichment disabled). An OpenAI-compatible
  base URL, e.g. `http://localhost:11434/v1` for Ollama.
- `UNREAL_MCP_LOCAL_LLM_MODEL`: default `llama3.2`. Only used if the above is set.
- `UNREAL_MCP_LOCAL_LLM_TIMEOUT_MS`: default `4000`. Per-request timeout for enrichment calls.
- `UNREAL_MCP_LOCAL_LLM_MAX_PER_CALL`: default `8`. Caps how many hits get a live
  enrichment call per `unreal_search_project` invocation (the rest are returned without a
  `summary`, not dropped).

## Pointing an MCP client at this server

### Claude Code

```bash
claude mcp add unreal -- node "F:/!Projects/UnrealMCP/mcp-server/dist/index.js"
```

(Adjust the path if you've moved the repo. Run `npm run build` first so `dist/index.js`
exists.)

Verify it's registered with `claude mcp list`, and check tool availability inside a
session with `/mcp`.

### Claude Desktop

Edit your `claude_desktop_config.json` (Settings -> Developer -> Edit Config) and add:

```json
{
  "mcpServers": {
    "unreal": {
      "command": "node",
      "args": ["F:/!Projects/UnrealMCP/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving. The `unreal_*` tools should then appear in the tool
picker for any chat.

## Recommended agent workflow

If you are pointing an AI assistant at these tools, give it
[../docs/AGENT_WORKFLOW.md](../docs/AGENT_WORKFLOW.md) as context (system prompt block, Claude
Code Skill, or CLAUDE.md section). It encodes the tool-call order that works, the exec-pin naming
sharp edges, and the compile-before-claiming-done rule, and it measurably reduces flailing.

## Notes / limitations

- One TCP request per tool call, on a fresh connection, with no pipelining and no
  persistent session state. This is intentionally simple; revisit if latency becomes an
  issue.
- Node ids are the node's persistent `NodeGuid` (a 32-character hex string), which Unreal
  serializes with the asset. They survive editor restarts, and removing one node does not
  affect any other node's id, so there is no longer any need to re-read a graph after
  `unreal_remove_node` before using ids from an earlier read. Legacy `"n<index>"` ids are
  still accepted for one release for backward compatibility, but are never returned.
- `unreal_add_node`'s `VariableGet`/`VariableSet` only work for variables defined
  directly on the target Blueprint, not variables inherited from a parent Blueprint.
- Every write runs inside a named editor transaction (`MCP: Add Node`, ...), so a human
  working alongside the agent can Ctrl+Z it. For multi-node work, prefer
  `unreal_build_graph`: it places nodes, wires them, and sets pin defaults in one atomic
  call rather than a chain of independent ops.
- No auth/encryption on the bridge socket. It only binds to loopback, which is the
  intended security boundary.
- The project index (`unreal_search_project` / `unreal_get_project_overview`) only
  covers Blueprints under `/Game`, and only the data already introspected elsewhere
  (functions/variables/graphs/node-type counts). It is not a full-text search over
  node contents or comments.
- Local-model enrichment's cache is in-memory and per-process only (cleared when the MCP
  server restarts), not yet persisted to disk. See `docs/M3_STATUS.md` for what a
  follow-up on-disk cache would look like.
- See `../docs/M1_STATUS.md` / `M2_STATUS.md` / `M3_STATUS.md` for exactly what has and
  hasn't been verified against a live editor session at each milestone.

