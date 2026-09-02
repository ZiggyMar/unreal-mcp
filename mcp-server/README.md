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

## Contents

Everything up to *Tools exposed* is what you need to run this. Everything after it is reference and
the reasoning behind the design — 140-odd sections of it, because every non-obvious decision here was
written down next to the measurement that caused it.

**Getting it running**
[Prerequisites](#prerequisites) · [Setup](#setup) · [Configuration](#configuration) ·
[Pointing an MCP client at this server](#pointing-an-mcp-client-at-this-server)

**Using it well**
[Recommended agent workflow](#recommended-agent-workflow) · [What this costs today](#what-this-costs-today) ·
[The cost nobody was measuring: switching a tool on](#the-cost-nobody-was-measuring-switching-a-tool-on) ·
[Searching for a node by the name the editor shows](#searching-for-a-node-by-the-name-the-editor-shows) ·
[When the host project cannot build, deliver the plugin anyway](#when-the-host-project-cannot-build-deliver-the-plugin-anyway) ·
[Two ways a read-only tool said "there is nothing there"](#two-ways-a-read-only-tool-said-there-is-nothing-there) ·
[The error on the screen that no tool could see](#the-error-on-the-screen-that-no-tool-could-see) ·
["I pressed the key and nothing happened"](#i-pressed-the-key-and-nothing-happened) ·
[The replication bug that never says anything](#the-replication-bug-that-never-says-anything) ·
[Measuring the choice instead of arguing about it](#measuring-the-choice-instead-of-arguing-about-it) ·
[The whole-project audit was missing a whole family](#the-whole-project-audit-was-missing-a-whole-family) ·
[The Level Blueprint was in no list at all](#the-level-blueprint-was-in-no-list-at-all) ·
[A montage without its notifies is blend settings and nothing else](#a-montage-without-its-notifies-is-blend-settings-and-nothing-else) ·
[A struct is its fields, and the generic reader had none of them](#a-struct-is-its-fields-and-the-generic-reader-had-none-of-them) ·
[Enums could be created and never extended](#enums-could-be-created-and-never-extended) ·
["Add a new upgrade type", walked end to end](#add-a-new-upgrade-type-walked-end-to-end) ·
[A build that blamed the file](#a-build-that-blamed-the-file) ·
[Notes / limitations](#notes--limitations)




**Reference and rationale**
[Tools exposed](#tools-exposed) — the full tool table, then the design notes. Start with
*Tool profiles: paying only for what you use* if you care about context cost, *Security* if you are
deciding whether to run it, and the profile table above if you just want the numbers.

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
- `UNREAL_MCP_PROFILE`: default `full` in process, `search` in what `--print-config` writes. See
  [Tool profiles](#tool-profiles-paying-only-for-what-you-use).
- `UNREAL_MCP_MODE`: default `standard`. See [Cost modes](#cost-modes-how-much-to-spend-per-build).
- `UNREAL_MCP_INSTRUCTIONS`: set to `off` to send no server instructions.

### Server instructions: saying it once instead of teaching by failure

MCP lets a server hand the client a block of text before the conversation starts, and this one was
leaving that field empty. Everything the model needed therefore had to arrive some other way: a
prompt it had to decide to pull, or a failed call teaching it the hard way. Both are worse than
saying it once for a few hundred tokens.

What goes in is decided by one rule: it is there only if the model **cannot derive it**. That means
the call order, because a tool description teaches a tool and never a sequence; and the exact
strings, because a model that knows Unreal well still cannot know the target pin is spelled `self` —
it will confidently write `Target` and lose a call to it. Everything long-form stays in the
`unreal_handbook` and `unreal_recipes` prompts and is pointed at rather than inlined.

The text is profile-aware. On `search` it opens by explaining that the short tool list is deliberate
and that one `unreal_enable_tools({groups:["core"]})` call brings back the whole authoring path with
real schemas — without which a model could reasonably conclude the server is broken or crippled.

It measures about 770 tokens. Combined with `search` that is roughly 2.0k of standing cost against
the 25.5k a `full` session pays, and the model arrives already knowing how to work rather than
spending its first calls finding out. `UNREAL_MCP_INSTRUCTIONS=off` suppresses it, which is the
right call on `minimal`, where context is the scarce resource the profile exists to protect.

## Pointing an MCP client at this server

**Do not hand-write this.** Run `--print-config` and paste what it prints:

```bash
node dist/index.js --print-config                      # Claude Desktop
node dist/index.js --print-config --client cursor      # Cursor
node dist/index.js --print-config --client claude-code # Claude Code
```

It resolves the absolute path to `dist/index.js` on this machine, uses the interpreter that is
actually running it rather than a bare `node` that may not be on the client's PATH, and sets the
profile and mode. Every one of those is a way client setup silently fails with the same symptom —
the server never starts and there is nothing to read.

Run `npm run build` first, so `dist/index.js` exists.

### Claude Code

Register with `claude mcp add-json unreal '<the JSON it printed>'`, then verify with
`claude mcp list` and check tool availability inside a session with `/mcp`.

### Claude Desktop

Paste the printed JSON into `claude_desktop_config.json` (Settings -> Developer -> Edit Config).
If the file already has an `mcpServers` block, add the `unreal` entry inside it rather than
replacing it. Then **fully quit** Claude Desktop and reopen it — closing the window is not enough.
The `unreal_*` tools should then appear in the tool picker for any chat.

## Recommended agent workflow

The difference between a smooth run and a flailing one is almost never model quality, it is
tool-call order. [../docs/AGENT_WORKFLOW.md](../docs/AGENT_WORKFLOW.md) encodes the order that
works, the sharp edges that each cost a failed call to discover (exec pin naming, cast pin
spacing, struct default formats, the two UMG traps), the multiplayer and performance judgment
learned by building a real replicated feature through these tools, and the rule that compiling is
not the same as done.

**You do not have to wire it up yourself.** The server offers it as an MCP prompt named
`unreal_workflow`, so any client can pull it in with no configuration:

```
prompts/get  ->  unreal_workflow
```

That matters more than it sounds: "paste this document into your system prompt" is a step someone
with no coding experience will not take, and they are exactly the user this guide is for. It is
served in every profile and costs nothing until requested. Pasting it into a system prompt block,
a Claude Code Skill, or a CLAUDE.md section still works if you prefer.

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



## What this costs today

Every other number in this file is history — what something cost before a change and after it, frozen
at the time. **These are the current ones**, and they are the only numbers here that are checked: the
row for each profile is verified against a live measurement by `npm run measure:profiles`, so this
table cannot quietly go stale the way the standing instructions did.

<!-- costs:begin -->
| profile | standing tokens | what it is |
|---|---:|---|
| `search` | 2503 | five tools; hand it a sentence or a preset name |
| `minimal` | 4251 | ten tools, fixed, for a small local model |
| `core` | 13173 | the authoring spine |
| `lazy` | 13481 | `core` plus deferred groups |
| `full` | 46611 | everything, for a model that can afford it |
<!-- costs:end -->

The three flagship journeys — a bug, a feature and a change, each run from the sentence a person
would type — cost **14 calls and about 3,935 tokens of replies** together. `npm run trial:workflows`
prints that, and it is the number worth watching: it is what the work actually costs, rather than
what the surface weighs.

## Tools exposed

### Read-only (Milestone 1)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_ping` | `ping` | Liveness check for the editor bridge. |
| `unreal_list_blueprints` | `list_blueprints` | Project-wide (or path-scoped) list of Blueprint assets: name, path, parent class. |
| `unreal_list_blueprint_graphs` | `list_blueprint_graphs` | Graph names + node counts for one Blueprint. |
| `unreal_explain_graph` | *(composite)* | What a graph actually does, in plain text. ~10x cheaper than reading it node by node. |
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
| `unreal_set_variable_replication` | `set_variable_replication` | Set an existing variable to `none` / `replicated` / `repnotify`, creating or reusing its `OnRep_` graph. |
| `unreal_watch_runtime` | `watch_runtime` | Sample variables on live actors during PIE, in every world, labelled by net role. |
| `unreal_run_console_command` | `run_console_command` | Run a console line - `ce`, `Ke`, cheats, cvars, `stat` - in the running game or the editor. |
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
| `unreal_document_asset` | *composite* | Everything connected to one asset in one call: ancestry, interfaces, components, replicated variables, event-graph entry points with where each RUNS, and both directions of reference. |

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
| `unreal_add_event_handler` | *(composed: `find_node` + `build_graph`)* | "When X happens, do these things" — the execution chain is wired for you, with no pin names, refs, or connections in the input. |
| `unreal_scaffold_blueprint` | *(composed: create + variables + components + handlers + compile + layout + review + save)* | An entire Blueprint in one call, in the right order. |
| `unreal_create_function` | `create_function` | Create a function graph with typed inputs/outputs; returns the entry (and result) node ids to wire immediately. |
| `unreal_organize_graph` | `organize_graph` | Node comments, comment boxes, and node positions, so a generated graph reads like a careful human built it. |
| `unreal_auto_layout_graph` | *(composed: `read_blueprint_graph_summary` + `organize_graph`)* | Lay out a whole graph and wrap each execution chain in a comment box titled after its event. No coordinates required from the caller. |
| `unreal_review_blueprint` | *(composed: `list_blueprint_graphs` + `read_blueprint_graph_summary`)* | The quality gate: dead nodes, unhandled cast failures, leftover debug prints, placeholder names, heavy Tick, unlabelled sections. Returns findings with fixes, a score, and one `nextAction`. |
| `unreal_audit_project` | *(composite)* | Audit every Blueprint **and Data Table** and rank what to fix, by likely cost. The "my game has bugs, where do I look" tool. |
| `unreal_project_health` | `project_health` | Where the whole project needs attention: oversized graphs, oversized Blueprints, cast-heavy Blueprints. Costs no asset reads. |
| `unreal_guard_with_authority` | *(composite)* | Put a node behind a HasAuthority branch, keeping its chain. The fix for a client-side GameMode cast. |
| `unreal_call_parent_function` | *(composite)* | Add `Parent: BeginPlay` and wire it FIRST, keeping the chain. The fix for `parent-event-not-called`. |
| `unreal_cleanup_blueprint` | *(composed: review + `remove_node` + layout)* | Applies the review fixes that cannot change behaviour, and lists what it left for you with reasons. |
| `unreal_doctor` | *(composed: `ping` + `get_project_overview` + `find_node` + `pie_status`)* | One-call diagnosis of the whole setup, with a remedy per failed check. Never throws: an unreachable editor is the answer, not an error. |
| `unreal_session_changes` | *(server-side log; touches the editor not at all)* | Everything this session changed, grouped by asset, in plain language, with deletions and failures called out. |
| `unreal_undo_history` | `undo_history` | The editor's real undo stack, newest first, marking which entries this bridge made. |
| `unreal_refresh_blueprint` | `refresh_blueprint` | The "right-click > Refresh Nodes" repair: every node re-reads its backing signature. The fix for the whole `in use pin no longer exists` family after a C++ change. |
| `unreal_build_graph` also takes `nodeType: "CallParent"` | `build_graph` | Places a `Parent: BeginPlay` node - the fix for `parent-event-not-called`. Adding an event to a child Blueprint replaces the parent's rather than extending it, and nothing warns. |
| `unreal_read_runtime_errors` | *(reads the editor log)* | What actually failed when you pressed Play, grouped and ranked. The only tool here that sees runtime problems: `Accessed None trying to read property X` names the exact Blueprint, graph and node, and comes back as fields. 2,000 error lines from one session is usually a dozen real causes. |
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
| `unreal_list_actors` | `list_actors` | Read the open level: every actor's label, class, location, and the Blueprint behind it, plus a per-class census. |
| `unreal_set_actor_property` | `set_actor_property` | Override a property on one placed instance, without touching the Blueprint it came from. |
| `unreal_delete_actor` | `delete_actor` | Remove one placed actor from the open level. |
| `unreal_save_level` | `save_level` | Save the open Level. Spawned actors live only in memory until this runs. |
| `unreal_add_component` | `add_component` | Add a component to a Blueprint's hierarchy (mesh, collision, camera, spring arm, audio), optionally under a parent component. |
| `unreal_list_variables` | `list_variables` | Read a Blueprint's variables and its parent class, with types, defaults and per-instance editability. A direct read, so it cannot lag. |
| `unreal_list_components` | `list_components` | Read the component hierarchy, including components inherited from a parent class. |
| `unreal_set_component_property` | `set_component_property` | Set one property on a component template. Fails loudly on an asset path that does not resolve, instead of silently setting `None`. |
| `unreal_set_class_default` | `set_class_default` | Set a Class Defaults (CDO) property. This is how replication gets turned on: `bReplicates`, `NetUpdateFrequency`, `bAlwaysRelevant`. |
| `unreal_set_game_settings` | `set_game_settings` | Project `UGameMapsSettings`: default GameMode, editor startup map, packaged-game default map. Persisted to config. |
| `unreal_describe_class` | `describe_class` | A class's real ancestry, and whether it is server-only. Ask before casting in a networked game. |
| `unreal_list_input_mappings` | `list_input_mappings` | Read the **legacy** project-settings bindings. Returns nothing on an Enhanced Input project - use `read_input_context`. |
| `unreal_read_input_context` | `read_input_context` | Read what an Input Mapping Context binds, keys grouped under the action they fire. |
| `unreal_read_level_sequence` | `read_level_sequence` | Read what a cutscene animates, and the bindings and tracks that quietly animate nothing. |
| `unreal_read_timeline` | `read_timeline` | Read a Blueprint Timeline: length, loop/autoplay/**replicated**, and every float, vector, colour and event track with its curve shape. |
| `unreal_set_niagara_user_parameter` | `set_niagara_user_parameter` | Set a Niagara system's exposed parameter default (float, int, bool). Refuses other types by name rather than writing something you did not mean. |
| `unreal_add_montage_notify` | `add_montage_notify` | Put an instant notify on a montage at a time, so animation can drive a footstep, a hit window or a sound. Refuses a time outside the montage and a duplicate at the same time. |
| `unreal_remove_montage_notify` | `remove_montage_notify` | Take notifies off a montage by name, or just the one at a given time. Reports how many went and what is left; removing nothing is not reported as success. |
| `unreal_map_input_key` | `map_input_key` | Bind a key to an Input Action, with modifiers. Refuses unknown keys and duplicates. |
| `unreal_unmap_input_key` | `unmap_input_key` | Remove one key binding, and say so honestly when it was not bound. |
| `unreal_get_game_settings` | `get_game_settings` | Read the default GameMode and map, plus the open level's override. |
| `unreal_add_input_mapping` | `add_input_mapping` | Add an action or axis mapping and save it to config, so `InputAction`/`InputAxis` event nodes have something real behind them. |
| `unreal_start_pie` | `start_pie` | Start Play In Editor, including multi-client sessions (`numPlayers`, `listenServer`) to exercise replication. |
| `unreal_pie_status` | `pie_status` | Whether a PIE session is currently running. PIE starts on the next editor tick, so poll this. |
| `unreal_stop_pie` | `stop_pie` | End the PIE session. Always stop PIE before editing further. |

Compiling proves a Blueprint is valid. Running it is the only thing that proves it works, which is
what `start_pie` is for.

**Reading a level matters as much as writing one.** Spawning into a level you have not read is how a
project ends up with two PlayerStarts, a second directional light fighting the first, or a duplicate
of something already there under another name — and on a level someone has spent months dressing,
that is worse than doing nothing. `unreal_list_actors` also reports which actors are Blueprint
instances, which is the fastest way to find the ones with logic worth reading.

One distinction the tools state explicitly because it is the classic level-editing mistake:
`unreal_set_actor_property` changes **one placed instance**; `unreal_set_class_default` changes
**every instance**. The response says which one just happened.

### Structs and enums: the refactor a real project gets

| Tool | Bridge command | Purpose |
| --- | --- | --- |
| `unreal_save_asset` | `save_asset` | Save any asset to disk - struct, enum, material, Data Table. Source-control aware. |
| `unreal_create_data_table` | `create_data_table` | Create a Data Table backed by a struct. The data-driven route: item 200 is a row, not a rewire. |
| `unreal_add_data_table_row` | `add_data_table_row` | Add one named row and set its values. Field names are checked before anything is written. |
| `unreal_list_data_table_rows` | `list_data_table_rows` | Read rows with their values, paged, because a Data Table is the one asset built to get large. |
| `unreal_rename_component` | `rename_component` | Rename a component and rebind the member variable graphs reach it through. |
| `unreal_remove_component` | `remove_component` | Remove a component, promoting its children rather than deleting them silently. |
| `unreal_remove_function` | `remove_function` | Remove a function graph, refusing while anything still calls it unless forced. |
| `unreal_rename_variable` | `rename_variable` | Rename a variable and rebind every GET and SET node that reads it, in every graph. Editing the descriptor by hand breaks the Blueprint. |
| `unreal_rename_function` | `rename_function` | Renames a function or macro graph, and rebinds any variable whose RepNotify handler it was - a rename that does only the graph half leaves clients silently not reacting. |
| `unreal_deduplicate_anim_transitions` | `deduplicate_anim_transitions` | Removes state-machine transitions that duplicate another exactly. Always keeps one, so it cannot strand a state. |
| `unreal_remove_variable` | `remove_variable` | Delete a variable, refusing while graph nodes still use it unless forced — and naming which graphs. |
| `unreal_rename_asset` | `rename_asset` | Rename or move an asset through the editor's asset tools, so every reference to the old path is fixed up. Moving the `.uasset` yourself breaks them silently. |
| `unreal_duplicate_asset` | `duplicate_asset` | Copy an asset — how you start "one more like that one" rather than rebuilding a near-identical asset from scratch. |
| `unreal_find_in_data_tables` | *(composed: `list_assets` + `list_data_table_rows`)* | The only tool that looks **inside** Data Table contents: searches every row name and cell value and returns table, row and field — not the rows. `unreal_search_project` does not index them. |
| `unreal_create_struct` | `create_struct` | Create a user-defined Struct with typed fields, validated before the asset is created. |
| `unreal_add_struct_field` | `add_struct_field` | Append a field to an existing Struct. |
| `unreal_remove_struct_field` | `remove_struct_field` | Take a field off a Struct. Refuses while a Data Table is typed by it unless forced, naming the tables and rows whose column would go. |
| `unreal_rename_struct_field` | `rename_struct_field` | Rename a Struct field, keeping the data; every Data Table typed by the Struct follows. |
| `unreal_remove_enum_entry` | `remove_enum_entry` | Remove an enum entry by display name. Says what happens to values that stored it by number. |
| `unreal_rename_enum_entry` | `rename_enum_entry` | Rename an enum entry's display name; the stored value is unchanged, so nothing using it breaks. |
| `unreal_list_struct_fields` | `list_struct_fields` | Read a Struct's fields: name, type, sub-type, array-ness, default. |
| `unreal_pie_actors` | `pie_actors` | Where matching actors are in every running world, with facing, net role, and whether each is locally controlled. |
| `unreal_teleport_actor` | `teleport_actor` | Move an actor while the game runs, optionally aiming it. Sets the control rotation on a possessed pawn, so aimed abilities actually point where you sent them. |
| `unreal_press_input` | `press_input` | Press an Enhanced Input action in the running game, optionally held. Goes through the same modifiers and triggers a real key press would, so what the game sees is what a player would produce. |
| `unreal_verify_runtime` | *(composite)* | Run the game, sample the values you name, and say whether every world agrees. Names the two failure shapes: values that differ between roles (a replication bug) and values that never changed (nothing wrote them). |
| `unreal_set_variable_type` | `set_variable_type` | Retype an existing member variable, rebinding every Get and Set node through the engine. Compiles afterwards and reports what the retype broke. |
| `unreal_create_asset` | `create_asset` | Create any asset type the editor's New Asset menu can create — InputAction, InputMappingContext, Blackboard, BehaviorTree, SoundCue, CurveFloat, LevelSequence, NiagaraSystem, DataAsset. Refuses the eight types with a dedicated tool, and refuses to overwrite. |
| `unreal_create_enum` | `create_enum` | Create a user-defined Enum with named entries. |
| `unreal_add_enum_entry` | `add_enum_entry` | Add one entry to an **existing** Enum, refusing a duplicate label. |
| `unreal_list_enum_entries` | `list_enum_entries` | Read an Enum's entries. Works on engine enums too, for looking up exact value spellings. |

Six variables called `ItemName`, `ItemIcon`, `ItemCount`, `ItemWeight`, `ItemStackable`,
`ItemRarity` are one `S_ItemData` struct, and every function passing them around gets one pin
instead of six. An integer 0/1/2 standing for "Idle/Chasing/Attacking" is an enum, and the Switch
node then has one clearly-labelled pin per case instead of magic numbers.

Variable types gained two descriptors to make this usable end to end, since a struct you cannot
declare a variable of is decoration: `struct:<Name>` and `enum:<Name>`, accepted anywhere a type
string is (`unreal_add_variable`, `unreal_create_function` inputs and outputs, and struct fields,
so structs can nest). Both resolve by short asset name or full path, and `struct:` also resolves
native engine structs.

The mapping this produced for the project it was built on is written up in
[docs/AVS_SKIN_SYSTEM.md](../docs/AVS_SKIN_SYSTEM.md) - two systems, which one is dead and the
evidence for saying so, and one hypothesis that was tested and found wrong before anything was
changed.

### A connection that quietly breaks a chain now says so

An exec **output** pin holds one link. Connecting a new one silently drops whatever was there, the
graph still compiles, and the chain past the old target simply stops running — a broken Blueprint
reporting zero errors.

This tool did it to a function it was building: wiring the Return, it matched *every* node titled
`Set CurrentSkinRow`, including the clear at the top, redirected that node.s exec to the Return, and
orphaned everything between. The compile said **0 errors, 0 warnings**. Only reading the graph back
found it.

`connect_pins` and `build_graph` now report what a link displaced:

```text
This replaced an existing execution link to Get Data Table Row Names.execute, which is now
unreachable unless something else runs it. A Blueprint with an orphaned chain still compiles
with zero errors, so check that this is what you meant.
```

`connected: true` on its own was not the whole truth when the connection removed one.

### Finding the system that is actually live: `unreal_trace_function_calls`

This one exists because of a mistake, and the mistake is worth writing down.

Asked to fix a skin system, this tool searched for the word **"Skin"**, found a system whose names
matched, and spent an afternoon on it. It was the *old* system — replaced months earlier because it
handled mid-round joins badly, and left on the canvas with its front end unplugged. Every part of it
read like working code. The developer had to say *"you've been working on the wrong system"*.

**Names are the weakest thing to search on.** A skin system can be called character selection, or
loadout, or randomisation. Worse, when a system is replaced the old one usually keeps the obvious
name. What cannot be renamed is the **engine function** the system must eventually call: whatever
changes a character's appearance ends up at `SetSkeletalMeshAsset`.

```text
unreal_trace_function_calls({ function: "SetSkeletalMeshAsset" })
```

Every hit comes back as `reachable` or `unreachable`. **A call nothing can reach is the signature of a
replaced system** — not a bug to fix, but a sign to look elsewhere for what took over.

Getting that verdict right took three attempts, and each wrong answer is worth recording because each
was confident:

1. **Reachable within its own graph.** Wrong: a function graph always has an entry node, so every
   call inside one read as live even when nothing called that function.
2. **A project-wide fixpoint** — event graphs run, and whatever a running graph calls runs. Correct
   in shape, and it recomputed the whole live set every round: on 339 Blueprints it exceeded the
   bridge's 60-second budget, so the answer never arrived. An answer nobody receives is not an
   answer. Now a worklist, with reachability marked once per graph by a forward pass instead of a
   backward walk per node.
3. **Too strict.** It reported `OnRep_SkinData` — the one path that actually runs — as a replaced
   system, and told the reader not to fix it. **A RepNotify is called by the engine**, and so are
   construction scripts and overrides of a parent or interface function. Those are seeded as callable
   now.

**Callable and live are different questions**, and the gap between them is where this tool went
wrong. A RepNotify is engine-called, so a call graph says its function is live — but `OnRep_Foo` only
fires when `Foo` *replicates*, and a `Foo` nobody writes never does. On this project
`ApplySelectedMesh` sits in a RepNotify and looks perfectly live; `SelectedMeshIndex` is written by
nobody, so it has never run.

That case is checked automatically now, in the same pass: every variable written anywhere is
collected while the call graph is built, and a RepNotify whose variable is never written is not
seeded as callable. The reply says exactly that — *"it is the RepNotify for X, and nothing anywhere
writes that variable, so it never replicates and this never fires"* — rather than leaving a reader to
run a second tool and join the two answers themselves.

The result on the project that produced the mistake, in **one call, three seconds, 361 tokens**:

```text
RUNS:  BP_Player.OnRep_SkinData          <- the live system
DEAD:  BP_Player.ApplySelectedMesh (x2)
       BP_Player.AttemptSkinUpdate
```

`trace_variable` remains the right tool for the other direction — *"who writes this, and who reads
it"* — and the two still answer different questions. What changed is that the commonest way to get
this wrong no longer requires the reader to notice it.

The same failure improved `trace_variable`'s verdict. It had reported `ServerSkinMemory` as *"read
but never written — the half-built feature"*, and that reading was half the story: **written by
nobody is equally the signature of a system whose writer was ripped out.** Same evidence, opposite
correct response. It now says both, and points at this tool to settle which.

### The bug-hunting primitive: `unreal_trace_variable`

This one was earned rather than designed. The report was *"the skin you pick in the lobby is not the
one you get in the match."* The answer was a single fact — `ServerSkinMemory` is **read in one place
and written in none**, so the lookup deciding which skin you keep always misses and every player
takes the fallback branch. Establishing that fact took **nine round trips**: open a Blueprint, grep
its graphs, repeat. A frontier model would have paid the same nine for the same one sentence.

```text
unreal_trace_variable({ variable: "ServerSkinMemory" })
```

One call returns every Get and every Set across the project, with the Blueprint and graph each sits
in, and where it is declared. It cannot be narrowed to the declaring asset: `GM_Gameplay` reaches
that variable on `AVS_GameInstance` **through a cast**, so a scan of the owner — or of the Blueprint
showing the symptom — would have reported zero of everything and been confidently wrong.

It names the three shapes that are bugs in themselves:

- **read but never written** — every reader sees the default forever, so a branch that depends on it
  always goes the same way. This is what a half-built feature looks like: the reading side exists,
  compiles, and silently takes the fallback. Nothing in Unreal warns about it.
- **written but never read** — either something is missing that should read it, or it is left over.
- **declared and never used at all.**

A few seconds to scan every Blueprint, against the alternative of opening them one at a time.

### Names typed as text, checked against what exists

A whole family of Blueprint bugs is one shape: a node takes a **name as a string**, nothing validates
it, and a wrong one fails silently. The Blueprint compiles, the node is wired, and the call does
nothing.

- **`Get Data Table Row`** with a row name not in the table - returns an empty struct, and the
  `Row Found` pin is routinely left unwired, so nothing reports it.
- **`Set Timer by Function Name`** pointing at a function that does not exist - the timer runs at its
  interval forever and calls nothing.

Neither is visible from the asset holding the string, because the answer lives in a different asset.
No amount of compiling finds them: the compiler has no idea those strings were meant to name
anything. `unreal_audit_project` checks them now, and reports the rows a table **does** have, because
a wrong row name is nearly always a near miss.

**Only literal names are checked, and the reply says so.** A name coming from a variable is a runtime
value and this says nothing about it. Measured on the project: 3 literal names checked, **33 from
variables and skipped**. That is reported as coverage rather than as a clean bill of health - zero
broken out of three reads as "all good" when it means "barely looked".

### The same check, one step out: an asset pin left empty

A name that resolves to nothing and an asset pin that holds nothing fail identically, so they are
checked together. `Play Sound at Location` with no Sound plays no sound. `Spawn Emitter at Location`
with no template spawns nothing. `Set Static Mesh` with no mesh leaves the component invisible. In
every case the node compiles, sits in the execution path, runs, and reports success.

This is what **a deleted or moved asset leaves behind**. Unreal nulls the reference on load and the
node stays, wired and silent, with a clean compile and not one warning. The other honest source is
an author who wired the node and never came back to pick the asset. Both look finished in the editor.

Worth being exact about the case it does *not* cover, because it is the one people expect: removing
a plugin takes that plugin's **node classes** with it, and a Blueprint holding one fails to compile
outright. That is loud, and it needs no tool. This check is for the quiet half.

Twenty calls are checked, chosen so that an empty pin is definitionally a no-op rather than a
legitimate default. Function names are matched **exactly**, never by substring, so a project's own
`PlaySoundAtLocation_Custom` is not swept up; `DamageType` on Apply Damage and every other pin where
`None` means "use the standard one" is deliberately absent. A **connected** pin gets its value at
runtime, so it is never reported. Nodes no execution reaches are counted, not listed - one of them
cannot be the bug, and listing them buries the ones that can.

There is deliberately **no MCP tool** for either. They belong inside "find every bug", and a separate
tool would cost every session ~330 tokens of definition for something nobody calls directly.

### VFX: `unreal_read_niagara_system`

Same shape of gap as animation and AI: 17 Niagara systems in the project this is developed against,
and nothing here could read one. *"The effect doesn't play"* was a question the bridge could not look
at — it could see the Blueprint that spawns the system and nothing about the system itself.

```text
unreal_read_niagara_system({ path: "/Game/VFX/NS_Explosion.NS_Explosion" })
```

**The user parameters are the point.** `Set Niagara Variable (Float)` takes the parameter name as a
**string**, so a name the system does not expose is not an error — it is a silent no-op. The node
sits there wired and compiling, addressing nothing, and nothing on the Blueprint side shows it. Names
come back as a Blueprint must spell them, with Niagara's internal `User.` prefix stripped; reporting
the internal form would hand a caller a string that quietly does nothing.

Two states are named outright rather than left as flags: a **disabled emitter**, which is a part of
the effect that never runs in a system that otherwise looks correct, and a system with **no emitters
at all** — or every emitter disabled — which spawns silently and looks like a perfectly valid asset
in the content browser.

**`unreal_audit_project` scans Niagara too**, and deliberately narrowly. A *disabled emitter* is not
reported: turning one off is ordinary authoring, and on this project `NS_Wind_Swirl` has three of six
disabled on purpose. A check that fired on that would fire on every VFX project and be ignored on all
of them - the same trap the animation checks avoid by leaving single-state machines alone. What is
always wrong is a system that can render **nothing**: no emitters, or every emitter disabled. Both
look like valid assets, spawn without complaint, and produce nothing.

Its own **`vfx` group** at 328 tokens, so a project without Niagara never pays for it.

### AI: `unreal_read_behavior_tree`

The bug that started this project's most urgent day was *"none of the enemies are spawning, and the
ones that do only start walking when you are past the outer firewalls."* The spawning half turned out
to be a null class in a Data Table. The walking half was an AI question — and a Behavior Tree is not
a Blueprint, so `unreal_list_blueprints` never returned one and the entire AI subsystem sat outside
every tool here.

```text
unreal_read_behavior_tree({ path: "/Game/AI/BT_Enemy.BT_Enemy" })
```

The reply is indented, and **the indentation is the behaviour**: a Selector runs its children until
one succeeds, so the second branch only ever runs when the first fails. Flattening that would destroy
the one thing a reader needs.

Decorators are listed against the child they guard, because a decorator is usually *why* a branch
does or does not run — "they stop chasing at the firewall" is a decorator on the chase branch far
more often than it is anything in the task. And the blackboard comes back with the tree: a task reads
`TargetActor`, and whether anything ever **writes** it is the other half of the question.

A tree with no root node is called out rather than returned as an empty list. It is not a normal
state, and it looks perfectly fine in the content browser.

Its own **`ai` group**, and in the `diagnose` preset — because "the enemies are not doing anything"
arrives as a diagnosis, not as a request to open a specific asset.

### Animation: `unreal_read_anim_blueprint`

The largest gap the asset inventory turned up, and the one behind a sentence people actually say.
The project this is developed against holds **6 Anim Blueprints, 27 Montages and 29 Blend Spaces —
62 animation assets — and nothing here could read any of them.** For a game whose enemies walk,
*"the enemy is not animating"* was a question this bridge could not look at: it could see the
Blueprint that sets a `Speed` variable and not the state machine that decides `Speed > 10` means
Run. Reading only the first half is exactly how a model concludes the logic is fine while the
character stands still.

```text
unreal_read_anim_blueprint({ path: "/Game/Characters/ABP_Enemy.ABP_Enemy" })
```

It returns each state machine, its states, and what moves between them — including the **condition**
on each transition, because that is the part that decides whether an animation ever plays. Rules are
summarised to the condition rather than listed as nodes: `Speed > 10` is the answer, and the four
nodes that spell it are not.

Two things it names outright, because both look fine in the editor until someone checks: a state
**nothing leaves**, and a transition whose rule graph is **empty** — which looks wired and behaves
like a wall. An Anim Blueprint with no state machines at all is normal rather than a fault, and the
reply says so instead of returning a bare empty list, so a caller does not go hunting for a problem
that is not there.

**`unreal_audit_project` now scans Anim Blueprints too**, which it could not do before this tool
existed: `list_blueprints` returns Blueprint assets and an `AnimBlueprint` is a different class, so
"find every bug" stopped at the door of the half where *"the character is not animating"* is usually
answered. It checks the two ways a state machine breaks silently — a state **nothing leaves**, which
freezes the character in one pose for the rest of the round, and a transition with an **empty rule**,
which draws exactly like a working one and behaves like a wall.

Scanned across this project: six Anim Blueprints, twenty-one states, **clean on both**. That is worth
saying rather than hiding — a check is not evidence of a bug, and these exist because the failures
are expensive elsewhere, not because this project has them. The unit tests carry the positive cases
the project does not, including the one that matters most: a machine with a *single* state is an
ordinary looping pose and must not be reported, or the check fires on every idle in every project
and is ignored in all of them.

Read-only, and states-and-transitions rather than every node: an anim graph is mostly pose plumbing,
and dumping it would cost a great deal to say little. It lives in its own **`anim` group**, so a
project without animation never pays for it.

### The other half of "data": `unreal_read_asset_properties` / `unreal_set_asset_property`

Counted rather than assumed. Asking the real project this is developed on what it is made of turned
up **41 Data Assets** — and not one tool could see inside any of them. A Data Asset is the typed
sibling of a Data Table and is how a great many teams store the numbers a designer tunes, so *"I have
a change request, find it and change it"* stopped at the door for a whole class of the project's own
configuration.

```text
unreal_read_asset_properties({ path: "/Game/Data/DA_EnemyTuning.DA_EnemyTuning" })
unreal_set_asset_property({ path: "...", property: "MaxHealth", value: "250" })
unreal_save_asset({ path: "..." })
```

The pair is deliberately generic over `UObject` rather than special-cased to Data Assets: the same
two tools cover Curves, Sound Classes, Material Parameter Collections and anything else that is an
asset with settings on it, because finding an `FProperty` and exporting or importing its text does
not care what the outer class is. Five type-specific tools would have cost five tool definitions in
every session's context to do one thing.

Reading returns only what has `CPF_Edit` — what a human could change in the details panel — which is
also exactly the set the setter can write, so the two agree by construction. Values come back spelled
the way they must be written back, and the write path is the same `SetPropertyFromString` the actor,
component and class-default setters use, so its silent-`None` guard now protects four callers rather
than three.

The full asset inventory that prompted this is in
[FEATURE_BACKLOG.md](FEATURE_BACKLOG.md#asset-type-coverage) — 38 classes, with what is and is not
reachable.

### A finding that says what it saw, not only what it concluded

`server-writes-unreplicated` is the most expensive check in the audit, and hunting bugs in a real
game showed all five of its findings there were doubtful. One was a handle to an Actor that
replicates itself (fixed above, now its own cheap check). The other three were `PC_Gameplay` setting
`RowLocal`, `CostServer` and `ScaleNow` from one purchase RPC — names that read like working state
inside a server call, and `ScaleNow` is not read anywhere in that Blueprint at all.

The obvious fix was to suppress the finding when nothing reads the variable, or when every read is
server-side. **The existing tests caught that within a minute, and they were right to.** Reads live
in *other* Blueprints: a HUD widget reading the player's value on a client is exactly the bug this
check exists for, and a rule that only ever looks at one asset would have silenced it. Suppressing a
real finding is far worse than reporting a doubtful one.

So the finding now carries an `observed` field, separate from its conclusion, saying which of three
things the Blueprint actually shows — nothing reads it here, every read here is server-side, or a
read exists outside the server chain and *"this one is worth fixing"*. A check that sees one asset
cannot settle a question that spans several, and saying so beats both guessing and going quiet. Two
tests pin it, including one whose whole job is to fail if anyone tries the suppression again.

`parent-event-not-called` carries the same kind of evidence, and it was the check that made the case
for the field. It fires when a child overrides `BeginPlay` without calling `Parent: BeginPlay`. On a
real game it fired four times, and the right answer was opposite in two of them:

- **`BP_Player`** overrides `BeginPlay` without the parent call, and `BP_BaseCharacter.BeginPlay` is
  the only place `VacuumableComp` is ever set — while `BP_Player` reads it and calls two functions on
  it. Decisive: the component is `None` on the player and those calls silently do nothing. Fixed.
- **`PC_Gameplay`, `PC_Lobby`, `PC_MainMenu`** do the same against `PC_Base`, whose `BeginPlay`
  creates the root layout widget and adds an input mapping context — and none of them reads
  `MyRootLayout` or anything else it sets. There the override may well be deliberate, and "fixing"
  it could create a second widget. Left alone.

Same check, same shape, opposite correct action. So the finding now reports whether the child *reads
what the parent sets*, which is the fact that separates them, and says so in those words.

### Class defaults you can read, not only write: `unreal_read_class_defaults`

`unreal_set_class_default` shipped a long time ago with nothing to read defaults back, which meant a
model could change a default it could not see — it had to already know the property name, what the
value currently was, and how the new one should be spelled. The same asymmetry the asset tools above
just closed.

It was found by needing it. The project audit reported five cases of *"the server writes a variable
that is not replicated"* — a real and expensive class of multiplayer bug, the kind that works
perfectly for whoever is hosting. One of them was `BP_Player` setting `CurrentActivePing`. Whether
that is a bug depends entirely on a fact this bridge could not fetch: **`CurrentActivePing` holds an
object reference to a `BP_PingActor`, and if that Actor replicates itself then the variable is
ordinary server-side bookkeeping and replicating it would change nothing but bandwidth.**

So for an Actor the reply hoists `replicates` and `replicatesMovement` to the top level, ahead of the
property list, because those two decide whether a finding is worth acting on.

Both readers share one walk over the object's editable properties. They ask the same question of
different objects — "what can a human change here, and what does it say now" — and two copies would
answer it two different ways the first time either was touched.

### Data Tables: the reason structs are worth making

A struct describes what one item *is*; a Data Table holds every item there is. That pairing is the
standard way Unreal projects keep gameplay data out of Blueprints, and it is the difference between
adding the two-hundredth item being a row and it being new graph work. The Blueprint that reads the
table does not change when the data does.

```
create_struct   /Game/Data/S_Item      fields: DisplayName (text), Value (int), Icon (object:Texture2D)
create_data_table /Game/Data/DT_Items  rowStruct: /Game/Data/S_Item
add_data_table_row  DT_Items  "Potion"  {"DisplayName":"Health Potion","Value":"25"}
```

Three deliberate behaviours:

**Field names are validated before the row is written.** A half-populated row is worse than a
refusal, because it looks correct in the editor and only reveals itself as wrong during play. An
unknown field name comes back with the list of real ones.

**The stored row is read back, not echoed.** A value the engine coerced or rejected would otherwise
be reported as though it had been stored exactly as sent — the same mistake `create_enum` made
before it was caught.

**Reads are paged, defaulting to 25 rows.** A Data Table is the one asset designed to get large, so
returning nine hundred rows of item data would cost more context than the question that needed
them. The total and the next offset come back with every page.

`unreal_create_struct` validates every field type **before** creating the asset, so a typo in the
fifth field fails cleanly instead of leaving a half-built struct in the project for someone to find
later.

#### The `SetEnums` trap, and why this is routed around it

`UUserDefinedEnum::SetEnums` is the obvious API for writing an enum's values, and
[ChiR24/Unreal_mcp #566](https://github.com/ChiR24/Unreal_mcp/issues) reports it as an open bug: a
C2660 on UE 5.8. The underlying reason is worse than a hidden overload. The signature genuinely
differs between the two engines this project supports:

```
5.6: SetEnums(TArray<TPair<FName,int64>>&, ECppForm, EEnumFlags, bool)
5.8: SetEnums(TArray<TPair<FName,int64>>&, ECppForm, UEnum::EUnderlyingType, EEnumFlags,
              EAddMaxKeyIfMissing)
```

No single call compiles against both. So nothing here calls it. `FEnumEditorUtils` and
`FStructureEditorUtils` sit one level above and are byte-identical across both versions, verified
header to header, which makes the problem not exist rather than solved-for-one-version.

#### Deleting a row: `unreal_remove_data_table_row`

The Data Table surface could create rows, change them and read them — and not remove one. So *"take
this thing out of the game"* had no correct answer, and the workaround people reach for is to clear
the row's asset reference instead.

**That is not a removal.** The row survives, still passes whatever gate the consumer applies, and now
contributes a `None`. That exact mistake put a shipped build in front of players with most of its
enemy spawns silently failing. If the intent is to disable something *temporarily*, change the field
that gates it — a minimum wave, a ratio, an enabled flag — and leave its references intact.

```
unreal_remove_data_table_row({ path: "/Game/Data/DT_Items.DT_Items", rowName: "Potion" })
```

The reply carries **every value the row held**, under `was`. That is the reason this is safe to
offer at all: a delete you cannot undo is a delete nobody should run against a real project, and
those values let `unreal_add_data_table_row` put it back exactly. It costs a few hundred bytes on an
operation that happens rarely, and turns an irreversible action into a reversible one.

Anything that looked the row up by name will find nothing afterwards, so the reply says so and points
at `unreal_find_references` — before you save, while it is still only a change in memory.


#### Finding rows that point at nothing: `unreal_check_data_tables`

This check exists because a bug reached a shipped build that no graph-reading check could ever have
seen, because it was not in a graph — it was in data. `unreal_audit_project` and
`unreal_verify_feature` both call it now, so the two questions a model actually asks — *"where are
the bugs"* and *"is this finished"* — both cover data. It remains callable on its own when the
Data Tables are the thing you want to look at.

A wave system read its enemy types from a Data Table. One row's class reference had been cleared to
`None`. The spawner fed that null straight into `SpawnActorFromClass`, which spawns nothing, raises
nothing and logs nothing — while the spawned-enemy counter still incremented, so the wave never
completed and the game simply stopped producing enemies. To a player that reads as "the game is
broken"; to the developer it read as "works on my machine", because the row *looks* correct in the
editor: it has a name, a ratio, a wave number, and one empty box among them.

```
unreal_check_data_tables({})                          # every Data Table under /Game
unreal_check_data_tables({ pathPrefix: "/Game/Data" })
```

**How a null is recognised without the bridge reporting property types.** A field is judged to hold
an asset reference when *some row fills it with an asset path*; a row giving `None` for that same
field is then a broken reference. The table carries the evidence to convict itself, because a table
with one broken row necessarily still has the working rows to compare against. Ordinary prose that
happens to read "None" is never flagged, since nothing in that field ever looks like a path.

The limit is stated rather than left to be discovered: a field empty in **every** row cannot be
judged this way — there is no filled row to prove it was ever a reference — so those are reported as
`undecidable` instead of being silently passed. A table that cannot be read at all is reported too,
never skipped, because a broken row must not be able to hide behind a plugin-version problem.

Findings name the repair directly: `unreal_set_data_table_row`, then `unreal_save_asset`.

When the audit runs it, an empty reference **leads** the ranked list, ahead of every graph finding.
That is not a preference: a graph finding is something that makes a Blueprint *worse*, while an empty
asset reference is something that does not happen **at all** at runtime, with no error and no log.
Run against a real 339-Blueprint project it surfaced three empty `UpgradeClass` rows ahead of 278
graph findings — in the same project, in the same week its enemy spawns broke for exactly that
reason, which the Blueprint-only version had walked straight past.


#### Changing a row that already exists: `unreal_set_data_table_row`

`unreal_add_data_table_row` deliberately refuses when the row is already there, which is right for
creation — and left no way at all to **change** one. That gap was found the hard way, on a real
shipped build: an enemy row's class reference had been cleared to `None`, so the wave system queued
a null class and those spawns silently did nothing. The table could be *read* through this bridge
and not *repaired* through it, which meant the one tool that could see the bug could not fix it.

```
unreal_set_data_table_row({ path: "/Game/.../DT_Enemies.DT_Enemies",
                            rowName: "Fly",
                            values: { EnemyType: "/Game/.../BP_FlyingEnemy.BP_FlyingEnemy_C" } })
```

It is **partial by design**: only the fields you name are touched. The common case is exactly one
wrong field in an otherwise correct row, and making the caller resend every field to fix one is an
opportunity to get the other five wrong.

The reply reports `before` and `after` for each field it changed:

```json
"changed": { "EnemyType": { "before": "None",
                            "after": "/Game/.../BP_FlyingEnemy.BP_FlyingEnemy_C" } }
```

so the edit can be checked rather than taken on trust, and a value the engine coerced or rejected is
visible instead of being echoed back as though it had been stored. Field names are validated before
anything is written, so a typo refuses the change rather than half-applying it. The row is left
dirty in memory — call `unreal_save_asset`, or nothing reaches a packaged build.


### Tested with a local 7B: 0/5 to 5/5

"Works with any model" is claimed by everything in this space and demonstrated by none of it.
`npm run bench:local` drives this server with a local model through a real agent loop against a
live editor, checks the outcome against the project rather than the transcript, and repeats each
task five times because one run proves nothing.

With `qwen2.5-coder:7b` on an RTX 3060 that is also running the editor:

| Task | Before | After |
| --- | --- | --- |
| Blueprint + typed variable + compile + save | **0/5** | **5/5** (10/10 over two sets) |
| Blueprint + BeginPlay wired to Print String | **0/5** | **5/5** |
| Component with a property + variable + **two** wired handlers | — | **5/5** |

At ~20 tok/s, with zero malformed arguments and zero invented tool names throughout.

**The decisive change was removing a tool, not adding one.** The `minimal` profile offered both
`unreal_create_blueprint` (empty Blueprint) and `unreal_scaffold_blueprint` (complete one). The
model reliably picked the familiar one, made an empty asset, and declared the task done — exactly
the measured failure. Dropping `create_blueprint` from that profile took it from 2/5 to 5/5.

> A profile built for weak models should contain the **best path for each job, not every path.**
> Offering a worse-but-familiar option is offering a way to fail.

The other two changes: `unreal_scaffold_blueprint` collapses four calls into one, in the right
order, so a model that cannot hold a plan across turns does not need to (0/5 to 2/5). And a
one-line pointer at the top of `create_blueprint`'s description, because the scaffold went unused
until it was advertised where the model was already looking — the second time that happened here,
which makes it a pattern.

The third task was added to find where the ceiling had moved to, and did not find one: a
`SphereComponent` with its radius set, a variable, and two separate wired handlers — a real small
feature — passes every time.

Scope, honestly: these are single features with clear descriptions, not system design. A small
model still cannot hold a plan across turns. It no longer has to. Full write-up in
[../docs/LOCAL_MODEL_BENCHMARK.md](../docs/LOCAL_MODEL_BENCHMARK.md).

### Handbooks, for any model driving an engine it cannot recall exactly

Any model - a local Qwen or DeepSeek, or a frontier one - can write logic perfectly well. What none
of them can do reliably is recall Unreal's exact vocabulary: that the target pin is spelled `self`,
that Sequence's outputs are `then_0` and `then_1`, that a struct default is a comma triple. A
frontier model is not exempt from this; it is merely more confident while getting it wrong, which is
worse. That is a gap a document closes, and each of these facts otherwise costs a failed call to
learn.

**`unreal_guide` is how the model reaches them mid-task.** The prompts below have to be pulled in by
the *client*, and most clients surface prompts as a menu for the human — so the model could never
reach any of this on its own initiative, which is exactly when it is worth having. `unreal_guide`
fixes that, and is built to be cheap: with no `section` it returns only the list of section
headings, so the model spends a few hundred tokens to find the one paragraph it needs rather than
several thousand inlining a whole handbook. Pass a heading to read that section, or `full: true` for
everything.

```
unreal_guide({ topic: "handbook" })                      # just the section headings
unreal_guide({ topic: "handbook", section: "pin" })      # the section about pins
unreal_guide({ topic: "recipes", section: "health" })    # how to build health and damage
```

Three guides ship as MCP prompts, so any client can pull them in with no configuration, and they
cost nothing until asked for:

| Prompt | What it carries |
| --- | --- |
| `unreal_handbook` | The mental model, class hierarchy, references and casting, interfaces, type descriptors, multiplayer in one page, performance judgment, the traps |
| `unreal_recipes` | Complete builds: health via interface, interaction, pickups, HUD binding, timers instead of Tick, spawning, save/load |
| `unreal_workflow` | The tool-call order, and the rule that compiling is not done |

#### The recipes are machine-verified against the engine

`npm run verify:handbook` reads the node names out of the recipe tables and asks the **running
engine** whether each one exists on the class it claims.

This is not ceremony. Its first run **rejected 7 of 26 names** in a document written by a model that
knows Unreal reasonably well:

- UE5 renamed the float math nodes: `Subtract_FloatFloat` is really `Subtract_DoubleDouble`
- `GetActorLocation` is really `K2_GetActorLocation`
- **Create Widget and runtime Spawn Actor from Class are not functions at all.** They are native
  `K2Node`s, so `find_node` will never return them however hard you search
- `SpawnActorFromClass` *does* exist in the catalog - on `EditorActorSubsystem` and
  `EditorLevelLibrary`, both **editor-only**. Taking that hit at face value produces a Blueprint
  that works in the editor and does nothing in a packaged game

Every one of those would have been followed confidently by exactly the models least able to notice.
The recipes now carry a table of the nodes that are *not* functions, because "find_node returned
nothing" is otherwise a dead end rather than a signal. The check runs against whichever engine
version is open, so it cannot rot as the engine changes.

### Acting like a colleague, not a code generator

Asked for a stamina system, a competent colleague does not immediately start typing. They say:

> "You already have a stamina variable on BP_Player and a HUD bar reading it — do you want me to
> extend that, or did you mean something else?"

That one sentence is worth more than any graph they could have built instead, because the
alternative is a second stamina system quietly competing with the first, and nobody finds out for
weeks.

A model cannot do that from a chat window: it does not know what is in the project.
`unreal_plan_feature` closes the gap. Give it the user's request in their own words and it returns:

- **existingSystems** — what is already there, with the assets named, so the model can name them
  back to the user
- **raiseWithUser** — the things to say *before* building: what already exists, and what a change
  would reach outside its own system
- **newWork** — the concepts with genuinely nothing behind them
- **conventions** — the naming prefixes, folders, and parent classes this project actually uses, so
  new work looks like the work already there
- **suggestedOrder** — read and confirm before building

It is read-only and index-backed, costing a fraction of one Blueprint read, so there is no budget
excuse to skip it. It is step 1 of the golden path.

Three judgement calls in it are worth naming, because each one is a way the tool could have been
annoying enough to ignore:

- **Only direct matches count as "already exists."** Everything else in a system map is a
  neighbour, and reporting neighbours as duplicates would make every request look like a conflict
  until the model learned to ignore the warnings.
- **When nothing matches, it asks rather than concluding.** "Nothing found" reads naturally as
  "therefore build it", but a project that calls stamina `Endurance` would then get a second
  system — the exact failure this exists to prevent. No stopword list can tell those apart; asking
  can.
- **It does not design the feature.** Judgement is the model's job. This supplies only the facts a
  model cannot otherwise have.

### Working on a project that already exists

The hardest thing about a real project is not writing new logic. It is that one Blueprint is wired
to five others and there is no way to convey that to a model. Describing it in prose does not work.
Reading assets one at a time makes the model rebuild the shape by hand, expensively, and the usual
failure is that it reads the first matching asset, assumes it is the whole system, and edits it.
That is how an agent breaks an eight-month-old project.

`unreal_map_system` answers it directly. Give it a concept and it returns:

- **assets** in the system, most central first, each saying *why* it is there ("has variable Health
  matching 'health'", "uses BP_Player")
- **edges**, so the shape is explicit rather than inferred
- **highRisk**: assets with referencers *outside* the system, where a change is a project-wide event
- **readingOrder**: the most depended-on assets first, because they define the contracts the rest
  obey. Reading a leaf first means re-reading it once the shared type finally appears.

It is built from the project index and the asset dependency graph and **never opens a graph**, so
mapping a twenty-asset system costs a fraction of reading one large Blueprint. That is the point:
it is what you consult *before* deciding what to read. A test asserts no graph read ever happens.

Three uses, in order of how much trouble they save:

1. **Before building**, to find out whether the system already exists. If it does, extend it rather
   than adding a second one - and say so.
2. **Before editing**, to see the blast radius.
3. **To decide what to read at all.**

An empty result is informative rather than a failure: the system genuinely is not there, or is
named something else, and the response says so.

### The C++ half of the project: `unreal_find_source`

A Blueprint-only bridge answers half the question. Real projects keep their base classes, damage
maths and replicated state in C++, so "the health bar does not update when I take damage" is
routinely a question about a `.cpp` file that no Blueprint tool can see. Until now a model could
read every Blueprint in the project, see that `BP_Character` derives from `AMyCharacter`, and have
no way at all to look at `AMyCharacter`.

The fix is deliberately **not** file reading. Every client that drives this server — Claude Code,
Cursor, Claude Desktop with filesystem access — already opens and edits files better than a tool
wrapper could. What none of them knows is *where*: the project root is not the working directory,
plugins keep their own `Source` trees, and nothing in the MCP surface ever said so. `ping` has
always returned the absolute `.uproject` path, and this turns that into a map.

```
unreal_find_source({})                          # project root + every C++ module, incl. plugins
unreal_find_source({ symbol: "AMyCharacter" })  # where that class is declared and defined
unreal_find_source({ symbol: "ApplyDamage", fileFilter: "Character" })
```

Matches come back ranked — the class declaration first, then definitions, then `UFUNCTION` and
`UPROPERTY` declarations, and bare mentions last — because a symbol appears dozens of times in a
real codebase and returning them in file order buries the answer. That ranking is the difference
between this and handing a model a raw grep. Matching is whole-word, so `Health` does not drag in
every `HealthBarWidth`; `Binaries/` and `Intermediate/` are never searched, so a stale generated
header cannot answer for the real one.

It returns **locations, never contents**: a path, a line number, and the one line that matched. A
whole-project symbol lookup costs a few hundred tokens instead of several thousand, and the model
reads what it actually wants with the tools it already has.

### Compiling that C++: `unreal_compile_cpp`

Locating a symbol is half a workflow. `find_source` shows where the C++ is and the model edits it
with its own file tools — and then, until now, had no way to find out whether the edit built. With a
shell that is inconvenient; in Claude Desktop, which has no shell, it is a hard stop, and guessing at
C++ is how a confident wrong answer gets delivered.

```text
unreal_compile_cpp({ file: "M:/Proj/Source/MyGame/Private/MyCharacter.cpp" })
unreal_compile_cpp({})   # full editor build - read the warning below
```

**Single-file is the default and is what you want.** UnrealBuildTool's `-SingleFile` compiles one
translation unit and skips linking: measured at 33 seconds against this plugin's own 6,900-line
command handler, where a full editor build is minutes. It also sidesteps the thing that makes a
naive "just build it" tool useless here — **a running editor holds the module DLL open, so the link
step fails however correct the code is**. The bridge lives inside that editor, so it cannot close it
to satisfy the build. A failure with no diagnostics is almost always that, and the reply says so.

Errors come back structured — file, line, compiler code, message, project-relative paths, duplicates
removed — because a UBT run emits megabytes and the answer is usually one line of it. Forwarding the
log would be the single most expensive reply this server has.



**One caveat, found by running it rather than by reasoning about it.** Unreal builds with unity
enabled, merging many `.cpp` files into one translation unit, so a file can use a type whose header
it never includes and still build — it gets the include free from a neighbour in the blob. Compiled
alone, it fails. The first live run of this tool reported **ten errors in this plugin's own
`MCPTcpServer.cpp`**, a file that builds cleanly on both engines: it used `TJsonWriterFactory` and
`TCondensedJsonPrintPolicy` without including them. The errors were real — that file genuinely could
not be built on its own, and the includes have since been added — but no edit had caused them, and a
model told "ten errors" with no further explanation would set about fixing code its change had not
broken. So those errors are still reported, and a `note` explains where they came from.

The engine and project locations come from `unreal_ping`, not from configuration: they are the two
things a client cannot know and the editor always can. `ping` reports `engineDir` for exactly this
reason — an engine install moves, and there is no registry entry a cross-platform client can trust.

### Making that C++ actually run: `unreal_hot_reload_cpp`

Every other leg of this server could finish its own job. The C++ leg could not. A model could find a
bug in native code, write the fix, and prove it compiled — and the change then sat on disk, because
the running editor holds the DLL it was built from. Applying it meant a human closing the editor,
rebuilding, and reopening. A human working alone does not do that. A human presses **Ctrl+Alt+F11**.

This is that keystroke:

```text
unreal_hot_reload_cpp({})
-> { outcome: "patched",
     meaning: "The code compiled and is running in the editor now. No restart needed." }
```

One tool call. It starts a Live Coding compile, waits for it, and reports which of six things
happened. The waiting is on this side deliberately — the engine's own blocking form,
`Compile(WaitForCompletion)`, spins on `FPlatformProcess::Sleep` on the game thread *behind a modal
slow-task dialog*. That would stop this plugin's ticker, so the reply could never flush and the
client would report the editor as hung — and it is the exact failure `blockingDialogTitle()` exists
to diagnose. So the bridge half is two non-blocking commands and the polling happens where polling is
free.

**The outcomes are not interchangeable, and the engine makes that easy to get wrong.** Three
different results all start with the same four words:

```text
"Live coding succeeded"                                             -> patched, running now
"Live coding succeeded, no code changes detected"                   -> nothing was rebuilt at all
"Live coding succeeded, data type changes ... will likely ... crash" -> patched, and now unsafe
```

A substring test for `"Live coding succeeded"` calls all three a win, and the middle one is the
common case: a model forgets to save, calls this, is told it succeeded, and concludes its fix is
live. So the checks run most-specific first and the no-op has its own outcome — `no-changes`, whose
reply names the three reasons it happens (unsaved file, a module this editor never loaded, a copy of
the source outside the project).

`patched-but-unsafe` is not this tool being cautious; it is the engine reporting that re-instancing
occurred, which means the change altered data types rather than function bodies — adding a
`UPROPERTY` to a live `UCLASS`, typically. Live Coding patches it and says out loud that it does not
guarantee it. Dropping that line and reporting `patched` would be lying in the most expensive
possible way, so the warning *is* the outcome.

One real limit, stated rather than hidden: on `compile-failed` the compiler errors go to the Live
Coding console, a separate process this server cannot read. The reply says so and names
`unreal_compile_cpp` on the changed file, which builds it through UnrealBuildTool and parses the
diagnostics properly. The errors are one call away rather than unavailable.

Live Coding is Windows-only and can be compiled out entirely, so the plugin asks for it the way the
engine's own modules do — `Target.bWithLiveCoding` in `Build.cs`, `#if WITH_LIVE_CODING` in the code.
Where it is missing, the reply says which of those two is missing and names the full rebuild instead
of just refusing.

`unreal_compile_cpp` is the whole of the **`cpp` group**, so a Blueprint-only project never pays for
it. `find_source` deliberately stays in `core`: enabling `"core"` enables `CORE_PROFILE_TOOLS` rather
than this table's `core` entry, so moving `find_source` would have changed what `unreal_list_tools`
*claims* without changing what `enable_tools` *does* — a listing that disagrees with the behaviour is
worse than a group one tool larger than it looks. It earns its place there anyway: called with no
symbol it answers "does this project have C++ at all", which is orientation rather than C++ work.

Two things came out of measuring it against a real project rather than trusting it:

**A module is a directory with a `.Build.cs` in it**, which is how UnrealBuildTool decides. Treating
every directory under `Source/` as a module reported plugins that put `Public/` and `Private/`
straight under `Source/` as modules *called* "Public" and "Private" — so a model asking where new
code belongs was offered two directories that are not modules at all. 26 became 15, and the module
map went from 883 tokens to 556.

**Bare mentions are sampled; declarations and definitions never are.** Searching a common symbol
returned 30 matches of which 25 were the kind that says "this file also refers to it" and answers
nothing — ranked last, and most of the cost. Keeping five of them took that reply from 1,304 tokens
to 507 while keeping every class and definition, and `mentionsOmitted` says how many were left out.

A Blueprint-only project is not an error — it says so plainly and points back at the Blueprint
tools.


### VFX, sound, and animation already work

There is no Niagara tool or animation tool here, and for the common case there does not need to be.
Attaching and driving assets that already exist is what a feature actually requires, and that works
through the component tools:

- `unreal_add_component` a `NiagaraComponent`, `AudioComponent`, or `SkeletalMeshComponent`
- `unreal_set_component_property` to point it at the asset (`Asset`, `Sound`, `SkeletalMeshAsset`,
  `AnimClass`)
- drive it from a graph with `SpawnSystemAtLocation`, `PlaySoundAtLocation`, `PlayAnimMontage`,
  `SetAnimInstanceClass`

Recipe 8 in [../docs/RECIPES.md](../docs/RECIPES.md) has the full list, every name verified against
the running engine.

This was **tested before being believed**, and the test corrected the record: three rows in the
complaint matrix said "Open" on the assumption these were missing. They were not. It is now checked
on every run of `npm run trial:feature` rather than resting on that one test — a claim tested once is
a claim that *was* true once, and this one is load-bearing enough to keep proving: the trial attaches
a `NiagaraComponent`, `AudioComponent`, `SkeletalMeshComponent` and `StaticMeshComponent`, then points
one at a real engine asset and checks the reference actually stuck. Attaching a component that
references nothing would satisfy the first half and none of the intent. The cost of
assuming a gap is not a wrong row in a table, it is building a redundant tool that then charges
every user context for the rest of time.

What is genuinely absent is *authoring* a Niagara system, an animation sequence, or an Anim
Blueprint state machine from nothing. Those are separate surfaces, and they are listed as gaps.

### Materials: most of what a player actually sees

| Tool | Bridge command | Purpose |
| --- | --- | --- |
| `unreal_create_material` | `create_material` | Create a master Material with BaseColor, Metallic, Roughness (and optional Emissive) exposed as parameters. |
| `unreal_create_material_instance` | `create_material_instance` | Create a cheap variation of a parent material. |
| `unreal_set_material_parameter` | `set_material_parameter` | Override one scalar, colour, or texture parameter on an instance. |
| `unreal_list_material_parameters` | `list_material_parameters` | Every parameter a material or instance exposes, with its kind. |

`unreal_create_material` builds the master out of **parameter** expressions rather than baked-in
constants. That is the difference between a project that can be art-directed later and one where
every variation means another material graph: a parameterised master can be instanced, so fifty
colour variants cost fifty instances rather than fifty materials.

Pass `baseColorTexture` and the material becomes **texture x tint**: the colour parameter multiplies
the texture rather than replacing it, which is what keeps a master material recolourable per
instance. Pass `normalTexture` and it is sampled as a normal map (not as colour, which would light
the surface completely wrong) and wired to the Normal input. That is most of the difference between
a surface that reads as a real material and one that reads as coloured plastic.

Colours are `"R,G,B"` or `"R,G,B,A"` with values 0-1, so `"1,0,0"` is red. Emissive values above 1
glow brighter. Metallic is genuinely 0 or 1 for real surfaces; roughness is where the character
lives, 0 being a mirror and 1 being completely matte.

Parameters are overridden on an **instance**, never on the master. Setting them on the master would
change every instance at once, which is the opposite of the point, so `unreal_set_material_parameter`
refuses a master material and says why.

A second engine trap, caught by live verification rather than by reading: all three of
`UMaterialEditingLibrary`'s material-instance setters declare `bool bResult = false;`, never assign
it, and return it. On both engines. They **always** report failure, including when they succeed.
Trusting that bool meant the parameter was genuinely written to the asset while the caller was told
it had not been, which is the worst shape a bug can take. Parameter existence is now checked
against the material's own parameter list and the return value is ignored. An engine API's success
flag is a claim, not evidence.

One version trap, caught by checking both engines before writing rather than after:
`UMaterialEditingLibrary::RecompileMaterial` returns `TArray<FString>` on 5.8 and `void` on 5.6, so
capturing its return value would compile on one engine and fail on the other. It is called for
effect only.

### UMG: the UI half

A game the user can see is mostly UI, and none of it used to be reachable through this bridge.

| Tool | Bridge command | Purpose |
| --- | --- | --- |
| `unreal_scaffold_widget` | *(composite)* | Build a whole UI screen in one call: the Widget Blueprint and every element in it. |
| `unreal_create_widget_blueprint` | `create_widget_blueprint` | Create a Widget Blueprint with a chosen root panel (CanvasPanel by default). |
| `unreal_add_widget` | `add_widget` | Add a widget under the root or a named panel: TextBlock, Button, Image, ProgressBar, boxes, overlays. |
| `unreal_list_widgets` | `list_widgets` | The whole widget tree in depth-first order, with each widget's class, parent, depth, and slot class. |
| `unreal_set_widget_property` | `set_widget_property` | Set a property on a widget, or on its layout slot with `onSlot: true`. |

Two things about UMG trip up everyone meeting it for the first time, model or human, so the tools
name both rather than letting you discover them by failure:

- **A Button holds exactly one child.** To label a button you add the Button, then add a TextBlock
  with `parent` set to the button. A second child fails with `parent_full`, and the error says so.
- **Layout lives on the slot, not the widget.** Position, size, padding, alignment, anchors and
  ZOrder are slot properties, reached with `onSlot: true`. `unreal_add_widget` returns the slot
  class you actually got, because it differs per parent panel and determines which layout
  properties exist.

Anchors are the difference between a HUD that survives a resolution change and one that does not,
so a corner-pinned element should be anchored to that corner rather than placed at fixed
coordinates.

One note the tools repeat because it is the most common way UI work appears to have done nothing:
a Widget Blueprint that is never added to the viewport is invisible. Creating the widget is only
half the job; a Create Widget + Add to Viewport chain in a gameplay Blueprint is the other half.

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

#### It does not penalise its own scaffolding

Every new Blueprint gets greyed-out `BeginPlay` and `Tick` placeholders. They are real
`UEdGraphNode`s, so every quality check counted them as *events wired to nothing* — and a health
pickup that built correctly, compiled 0/0 and did exactly what was asked still came back
`verdict: fail`, for two nodes the server had created itself moments earlier.

A model acting on that either chases a non-problem or deletes scaffolding it should not touch. The
bridge marks them (`ghost: true`, via UE's own `IsAutomaticallyPlacedGhostNode()`) and the checks skip
them: a placeholder is an event nobody has written yet, not an event wired to nothing. A real event
left dangling is still reported — there is a test for each half, because the exemption must not
quietly become a blanket one.

What replaced the false finding on that same pickup is worth quoting, because it is the difference
between noise and use:

```
[EventGraph] 1 Cast node(s) leave the "Cast Failed" pin unhandled
```

That is true, and it is the actual design gap — nothing handles a non-player touching the pickup.

#### A review will not hand you a score for something that does not build

Found by running a real feature request end to end and deliberately leaving it half-wired. The
Blueprint did not compile, and `unreal_review_blueprint` returned **score 95, `"errors": 0`** — because
a review reads graph *structure*, and a compile error is not a structural finding.

That is this project's own failure mode, produced by its own quality gate. The workflow this server
prints tells a model to review before claiming a feature is done, so the one call standing between
*"built it"* and *"it works"* was answering 95/100 about a graph the engine had rejected.

It compiles first now, and leads with the result:

```json
{ "compiles": false, "verdict": "does not compile", "compileErrors": 1,
  "compileMessages": [ ... node and pin named ... ],
  "next": "fix that before anything below",
  "review": { "score": 95, ... } }
```

The review still runs and is still returned — it is not useless, it is **subordinate**. What changed
is that a caller can no longer read a score without seeing that the thing does not build.
`unreal_verify_feature` already reasoned this way; now the tool a model reaches for on its own does
too.

### The last call before "done": `unreal_verify_feature`

The failure this exists for is specific and it is the expensive one. A model builds a feature across
four Blueprints, compiles the one it touched last, sees `success`, and reports the work as finished
— while an asset it edited twenty calls ago no longer compiles, or compiles and is wired wrong.

Nothing in a session ever asked the whole question, because asking it meant remembering every asset
touched and then making two calls per asset. And the model that forgets to check is, by definition,
the model that has already forgotten what it touched.

So the default scope is not a list the caller supplies. It is the **change journal's own record of
what was actually written** — produced by the same wrapper every bridge command passes through, so
it cannot drift from what happened.

```
unreal_verify_feature({})                       # everything written this session
unreal_verify_feature({ paths: ["/Game/BP_Door.BP_Door"] })
```

It returns one `verdict` plus an ordered list of what is still wrong. Compile failures are listed
**before** review findings, because a Blueprint that does not build has no graph worth reviewing —
its findings would describe a graph the engine has already rejected. For the same reason a Blueprint
that fails to compile is not reviewed at all.

`verdict: "pass"` means every asset in scope compiles and reviews clean. Anything else means the
feature is not done, whatever the last individual call said. An asset that cannot be reached is
reported as a blocker rather than skipped, because a check that quietly drops what it could not
examine is worse than no check.

**One asset, one spelling.** The same Blueprint reaches the journal under two names —
`create_blueprint` records the package path (`/Game/X/BP_Alpha`), `build_graph` records the object
path (`/Game/X/BP_Alpha.BP_Alpha`). De-duplicating raw strings treated those as two assets, so a
two-Blueprint feature was compiled and reviewed **four** times and every blocker appeared **twice** —
which reads as two separate problems and invites fixing the same thing twice. Paths are canonicalised
now. Found by running a real two-Blueprint trial, not by reading the code.

**It checks Data Tables too, and that was learned the hard way.** The most expensive bug this tool
has seen was not in a graph at all — a row's class reference cleared to `None`, which the engine
resolves to null and the consumer silently ignores. A verification step that only compiled Blueprints
would have passed that build with a straight face, which is exactly what happened. So every asset in
scope is also swept for null references, and one found is a blocker like any other. Assets that are
not Data Tables are skipped silently rather than reported as unreadable — most of a touched set is
Blueprints, and one line per asset would bury the single real finding.

Beyond that it is deliberately compile + review and nothing more. Two things were considered and cut: a
checkpoint diff, because no snapshot facility exists yet and a parameter that silently does nothing
is worse than an absent one; and starting PIE to sample runtime behaviour, because writes during PIE
apply to the editor world, and a verification step that mutates what it is verifying is not one.


### Half a deletion: `unreal_find_orphans`

Levels are full of actors that only work in pairs — a nav link and the door it belongs to, a trigger
and the thing it triggers, a spawn point and its volume. Delete one half and the other stays behind,
still ticking, still handling events, pointing at nothing. Nothing warns, because **an actor with a
null reference is a perfectly legal actor.**

Found in a real level: 25 nav links, 12 firewalls. Twenty-four paired off two per wall, all within
190 units. One sat 921 units from the nearest firewall — left when a wall was deleted — and still
handled `Receive Smart Link Reached` by messaging a firewall that no longer existed. An enemy that
walked onto it waited for an event that could never arrive.

```
unreal_find_orphans({ of: "BP_NavLink", pairedWith: "BP_Door" })
```

**It pairs by position, not by reading the reference property** — because the reference is the thing
that is broken. A null tells you nothing about what it should have pointed at, and a stale one may
still name a deleted actor. Position survives both: two actors placed together are still where they
were placed. It reports the unpaired partners too, which is the same mistake seen from the other end.

**The threshold is inferred by finding the gap, and that detail was settled by a real level rather
than by argument.** The first version used five times the median pairing distance. On the actual
level the median was 204 units and the orphan sat at 921 — so the threshold landed at 1019 and the
check reported a *clean level* while the bug it was written for sat right there. The synthetic
fixture had passed, because a fixture author puts the orphan somewhere unmissable.

Real pairs cluster; a leftover is separated from that cluster by a jump. So the distances are sorted
and the largest proportional step between neighbours is found: the threshold goes in the gap. A level
whose distances rise smoothly — one with no orphan — produces no threshold at all rather than an
arbitrary cut. The real distribution is now a regression test.


### Looking at it: `unreal_screenshot`

Every other tool here answers in text, and there is a class of question text cannot settle. *Did that
enemy walk toward the player? Did the widget land where it should? Is this material black?* The logic
can read correctly, the variables can hold the right defaults, the graph can compile and review
clean — and the only way to know is to look. A model driving this server previously could not look at
anything, so it could reason perfectly and still be unable to confirm that the thing it just built
actually happens.

```
unreal_screenshot({})                      # the level editor viewport
unreal_start_pie({}); unreal_screenshot({})  # the running game
```

It returns the frame as an MCP image, so a multimodal model sees it directly. The reply also says
which it captured — editor viewport or a live PIE session — because those look similar and confusing
them wastes a turn.

**It is downscaled in the bridge, not by the caller, and that is the load-bearing decision.** An
image costs tokens by *area*: a native 1920×1080 frame would cost more context than every tool
definition on this server combined, which would make the cheapest-possible tool surface pointless the
first time anyone looked at anything. The default long edge is 1280, clamped to `[160, 2048]`. That
is enough to see whether something moved, where it is, or whether it rendered at all. It is not
enough to judge a texture, and it is not trying to be.

Two details that are easy to get wrong and are handled: `ReadPixels` returns whatever alpha the
render target held, which is frequently zero — and a PNG with a zero alpha channel is a perfectly
valid, entirely invisible image, so alpha is forced opaque. And the capture is synchronous, so the
reply names a file that already exists rather than one that is coming; a path returned before the
file is written is a race the caller cannot win.


### A compile error that names the node

A failed compile used to arrive as prose and nothing else — *"The type of Object is undetermined"* —
naming a node title that may occur nine times in the graph and giving no way to reach any of them.
The only move left was to re-read the whole graph and guess, which is expensive when it works and
wrong when two nodes share a title.

`FCompilerResultsLog` has known which node each message came from all along; it is in the message's
own tokens as an `FEdGraphToken`. Reading it costs nothing:

```json
{ "severity": "error", "nodeId": "F7063DC4...", "nodeTitle": "Cast To Pawn",
  "graphName": "EventGraph", "pinName": "Object",
  "text": "The type of Object is undetermined..." }
```

`nodeId` is the same persistent GUID `unreal_read_blueprint_summary` returns, so it goes straight
back into `unreal_read_node_detail` or `unreal_remove_node`. `pinName` is frequently the whole answer
— "not connected" is about one pin, and naming it saves reading every pin on the node. `unreal_build_graph`
additionally returns a `nodeIds` array on the compile result, so the refs you wrote can be mapped
back to the nodes that failed.

All three places that report compile output share one helper, which also repaired a drift nobody had
noticed: `compile_blueprint` reported four severities while `build_graph` and `refresh_blueprint`
collapsed everything through an error-or-warning ternary, so a performance warning arrived labelled
`warning` and an info arrived the same way — both contradicting the four-value type the server
declares.

### Describing the bug in plain language now lands somewhere

The premise of this project is that you say what is wrong in your own words and the model finds it.
The entry point for that is the `search` profile, whose discovery tool is
`unreal_list_tools({match})` - and `match` is a substring search over tool **names and summaries**.
Measured against the words a person actually uses:

```text
match: "upgrade"      0 tools        match: "empty"       2 tools
match: "shop"         0 tools        match: "data table"  2 tools
match: "missing"      0 tools        match: "broken"      2 tools
match: "not showing"  0 tools
match: "bug"          0 tools
```

Only the words a tool *author* would use find anything. And "upgrades aren't showing up in the shop"
is a **real bug in this project** - `DT_Upgrades` has two rows, `Weapon_MachineGun` and
`Vacuum_VirusController`, whose `UpgradeClass` is null, so those upgrades cannot appear - which
`unreal_check_data_tables` reports in one call. Every word of that sentence returned nothing.

Worse, the reply to a search that found nothing was:

```json
{ "matched": 0, "tools": [], "next": "Every matching tool is already enabled; call it directly." }
```

The identical sentence used when every match *is* enabled. A model reading that proceeds as though
it is equipped, having been handed no tools at all.

There is now a second index over the same catalogue, keyed on failure vocabulary rather than tool
vocabulary, consulted only when the literal match finds nothing. The whole path, verified against
the editor: **3 calls, 2,715 tokens** from that sentence to `check_data_tables` naming the two null
rows.

It is a keyword table, and it says so in its own reply - `matchedSymptomWords` names the words it
actually matched, because a caller who believes it was understood will trust a wrong suggestion,
while one who knows it matched "crash" can judge for itself. Three things it got wrong first, all
caught by testing it rather than reading it:

- **Contractions.** The first list had `not showing` and `doesn't show` and missed *"aren't
  showing"* - the exact sentence it was written for. People negate with contractions.
- **Nouns outranking failures.** "Enemies don't take damage" matched `enemy` first and led with
  `read_behavior_tree`, when the useful answer is `trace_variable`. Entries are now ordered so a
  description of the failure beats a noun naming the subject.
- **A reason disagreeing with its own recommendation.** The save entry led with `search_project`
  while its own explanation named `trace_variable` as the answer - found by a test asking whether
  any entry leads with a tool that is true of every symptom.

`npm run check:symptoms` asserts every tool the index recommends is actually registered, since it is
the only place here where a recommendation is curated by hand rather than derived from the registry.
That guard also had to be fixed: it captured `/"(unreal_[a-z0-9_]+)"/`, so a tool renamed to
anything with a capital in it *vanished from the set* instead of being reported - the guard failing
in the way it existed to prevent.

### "Change this" is neither of the other two

The third thing this project promises — *"I have a change request, it finds it and changes it,
whether it's C++ or Blueprints or a Data Table"* — landed worst of the three:

```text
"change the player walk speed"                    ->  nothing at all
"rename FireRate to RateOfFire"                   ->  nothing at all
"the machine gun should cost 500 instead of 300"  ->  nothing at all
"make the health upgrade cost more"               ->  read as BUILDING
```

The last is the dangerous one: `plan_feature` would set about planning a health upgrade system that
already exists, because "make the" reads as a request to create something. Change vocabulary is now
checked *before* build vocabulary — "make a health upgrade" is building, "make the health upgrade
cost more" is a change, and only the second half of that sentence says so.

### Three tools reading properties, two of them agreeing

A coverage pass against the question "does this support everything a normal human would have for this
engine", answered by enumerating what the project actually contains rather than by guessing. Of the
asset classes present — 327 AnimSequences, 297 SoundWaves, 152 Widget Blueprints, 41 Data Assets, 35
Input Actions, 27 Montages, 21 Data Tables, 16 Physics Assets, 15 Niagara systems, 9 Level Sequences,
6 Anim Blueprints, 2 Behaviour Trees — every one has either a dedicated read tool or is served by
`unreal_read_asset_properties`, which handles any asset that is a bag of settings. No gap.

What the pass did find is that `read_asset_properties` returned its properties **verbatim**, while
`read_class_defaults` and `list_variables` — reading the same kind of thing — drop a category of
`"Default"`, a value that is the type's zero, and float padding. Across this project's 41 Data
Assets, **269 of 413 properties carried a zero value**.

The saving is modest and worth stating accurately: **955 tokens, 6%**. A first estimate said 5,669,
arrived at by counting whole entries as savable when dropping `"value":"None"` removes sixteen
characters and leaves the name, type and category standing. Wrong arithmetic, corrected here rather
than repeated.

The consistency is the real point. Three tools describing one convention two different ways is this
repo's most repeated defect, and a caller who learns "absent means zero" from one of them reasonably
expects it from the others. All three now say it **in the same words** — which required fixing
`list_variables`, whose sentence differed both in shape and in using a curly apostrophe where the
others use a straight one.

`check:protocol` asserts it on the **rendered** description rather than the source, because the
sentence is assembled from concatenated string literals and wraps across lines: a source-text check
would match or miss depending on where the author happened to break the line. `read_asset_properties`
also joins `measure:reads` at 1,706 tokens — the same pattern this repo keeps rediscovering, where
every read measured from the start was measured from the start, and the ones that arrived later
arrived unwatched.

### 1,338 tokens per request for a label nobody reads

The previous pass left `full` at 37,400 of its 37,500 ceiling, so the next question was where the
standing context actually goes. Measured rather than guessed — 146,119 characters on `full`:

| part | chars | share |
|---|---:|---:|
| descriptions | 70,614 | 48% |
| input schemas | 59,200 | 41% |
| — of which parameter prose | 26,138 | 18% |
| titles | 4,199 | 3% |
| names | 2,582 | 2% |

So **23% is JSON Schema structure** rather than anything anyone wrote, and its largest single line
item is one string repeated once per tool:

```json
"$schema": "http://json-schema.org/draft-07/schema#"
```

50 characters × 107 tools ≈ **1,338 tokens on every single request**. `zod-to-json-schema` emits it
and the MCP SDK calls that converter without an option to turn it off, so it is stripped at the
transport — the one place that sees the finished payload.

`$schema` declares which dialect a schema is written in. It is optional metadata: a validator with no
declaration uses its newest supported draft, and every construct these schemas use — `type`,
`properties`, `required`, `additionalProperties`, `items`, `enum`, and a union spelled
`"type": ["string","number","boolean"]` — means precisely the same thing in draft-07 and 2020-12.
That is the test a saving like this has to pass: **a compaction that removes an ability is not worth
having at any price, and this removes a label.** Verified against the running server that unknown
parameters are still refused by name, missing required ones are still named back, a wrong type is
still rejected, and a number is still accepted where a value is written.

Every profile got smaller, not just the one that was tight:

| profile | before | after |
|---|---:|---:|
| minimal | 4,015 | **3,917** |
| search | 2,257 | **2,205** |
| core | 12,720 | **12,337** |
| lazy | 12,734 | **12,351** |
| full | 37,400 | **36,009** |

`check:protocol` fails if any schema starts carrying the declaration again, because a dependency
bump that changes the message shape would otherwise be a quiet 1,300-token regression nobody would
think to look for.

### Six decimal places on every float, and 20% of the biggest read

A measurement pass rather than a hunt. `unreal_list_data_table_rows` is the most expensive read on
the surface, and on `DT_UniversalActions` — nine rows of nested CommonUI input data — the reason is
not the rows:

```text
(Key=None,OverrrideState=Enabled,bActionRequiresHold=False,HoldTime=0.500000,
 HoldRollbackTime=0.000000,OverrideBrush=(TintColor=(SpecifiedColor=(R=1.000000,
 G=1.000000,B=1.000000,A=1.000000),...),ImageSize=(X=32.000000,Y=32.000000),...
```

`ExportTextItem` writes every float with six decimal places. Trimming the padding alone takes that
read from **7,040 to 5,695 tokens — 19%** — and loses nothing: `0.500000` → `0.5`, `1.000000` → `1`.

`omitZeroDefault` already trimmed trailing zeros, but only for a value that is a plain decimal on its
own, and its comment said why: *"nothing inside a struct literal or an asset path is touched."* That
was right at the time — a blind replace over a struct literal can reach into a quoted string. This is
that decision revisited with the quoting handled rather than avoided:

- **Quoted spans are skipped entirely**, honouring backslash escapes, so a localisation key or
  display string of `"1.000000"` inside `NSLOCTEXT(...)` survives intact.
- **A number preceded by a letter, digit or underscore is left alone**, so `v1.000000` and
  `/Game/Foo1.000000/Bar` are untouched.

The trade only works if a trimmed value can still be written back — a read that cannot round-trip is
not compaction, it is corruption. Verified against the editor: a row read as
`{"Where":"(X=1.5,Y=0,Z=32)","Rate":"0.5"}` was handed straight back to `set_data_table_row` and came
out identical.

### `value` absent meant zero, and only one of the two tools said so

The same measurement found 95 of 167 properties in `read_class_defaults` carrying **no value at
all** — 29% of a 4,728-token reply. They are not unreadable and not unchanged: the tool layer drops
a value that is the type's zero, which is a deliberate and well-reasoned compaction.

`unreal_list_variables` states that contract in its description — *"`defaultValue` only when it is
not the type's zero"* — and `read_class_defaults`, which applies the same rule to a different key,
**did not**. So `{"name":"SelectedMeshIndex","type":"int32"}` read as "changed to something unknown"
when it means "changed to zero". Different facts, only one of them true, on most of the reply. One
sentence, 83 standing tokens, and the two tools now describe one convention the same way.

### Four ways to write a path that all mean one asset

The same hunt applied to `path`, which nearly every tool here takes. Six forms a caller would
plausibly send, against the real editor:

```text
/Game/Dir/BP_X            accepted
/Game/Dir/BP_X.BP_X       accepted
/Game/Dir/BP_X.BP_X_C     REJECTED   blueprint_not_found
/Content/Dir/BP_X         REJECTED   blueprint_not_found
/Game/Dir/BP_X/           REJECTED   blueprint_not_found
BP_X                      REJECTED   blueprint_not_found
```

The `_C` one is the sharp case, because this server hands it to you: `parentClass` comes back as
`"BP_ShopUpgrade_C"`, so a model that reads a Blueprint, sees its parent, and asks to inspect that
parent writes exactly the form that was refused. `/Content/` is the classic Unreal confusion — the
folder on disk is `Content`, the path the engine uses is `/Game/` — and a model that has looked at
the filesystem has seen the wrong one of the two.

All four are now normalised in `toObjectPath`, which is where the short-to-long expansion already
lived: *"the one place every command crosses into the bridge"*. Doing it per-call-site would have
recreated the inconsistency the previous section just fixed for types.

The care is in what it must **not** touch:

- An asset genuinely named `Foo_C` has the object path `/Game/Foo_C.Foo_C`. The rule is that the
  object name equals the asset name **plus** `_C`, not merely that it ends in `_C` — otherwise every
  call about that asset would be redirected to one that does not exist.
- Only a **leading** `/Content/` is rewritten, so a project with its own `/Game/Content/` folder is
  untouched.
- `compile_cpp` takes a **filesystem** path in a parameter also called `path`. `M:/Proj/Foo.cpp`,
  `Source/Thing/Foo.cpp` and `C:\Proj\Foo.cpp` all pass through unchanged, and there is a test for
  each, because breaking the one tool that compiles C++ is the way this change could do real damage.

`BP_X` alone stays an error. It is genuinely ambiguous — the same name can exist in several folders —
and the bridge's message already names the right path shape and the tool that lists the real ones.

### The C++ spelling of a type was refused, by the tool that C++ leads you to

`{ Cost: 500 }` named a defect class worth hunting rather than waiting for: **the tool disagreeing
with the person using it**, which is invisible to internal tests because every test round-trips its
own output. So the next question was what else a caller would naturally send and be refused.

`unreal_add_variable` accepts 20 of 26 obvious type spellings — `int`, `int32`, `integer`, `bool`,
`boolean`, `Float`, `String` all work — and refused exactly six:

```text
FString   FText   FName   FVector   FRotator      (and a bare class name)
```

Those five are not typos. They are how Unreal itself spells them, and they are what a model has in
front of it **after `unreal_find_source` hands back a header**. The join that broke is C++ to
Blueprint: read a native class, go to declare a matching variable, spell the type the way the source
you just read spells it, and get refused by the same server that showed you the source.

The engine-side resolver is where `int32` and `integer` are already handled and would have been the
tidier place — but it is C++, so it only reaches someone who has rebuilt the plugin. Normalising in
the tool layer reaches everyone now, and follows the rule this project already applies to
compaction: the bridge stays faithful, the tool layer accommodates.

Applied to all four tools that take a type — `add_variable`, `create_function`, `create_struct`,
`scaffold_blueprint` — because normalising *some* would be worse than none: a caller who learns
`FVector` works in one would reasonably expect it in the others. `trial:chain` checks all four,
which is the right home for it: not a value passing between two tools, but the same failure shape one
level up.

Two things deliberately **not** translated. A bare `StaticMesh` could mean `object:StaticMesh` or
`class:StaticMesh` — an instance or the type itself, genuinely different — so it gets a hint naming
both readings and decides neither. And an unknown `F`-name is left alone: `FMyGameplayStruct` should
be `struct:MyGameplayStruct`, but stripping the `F` blindly would also turn `FooBar` into `ooBar`.
Only the engine's own core types are listed, and they are a closed set.

**The containers were the half left undone.** Mining a full working session's transcript for what
actually failed put `unknown_type` second only to the wrong-path error - 22 against 27 - and the
suffix handling above turns out to close only half of it. `FVector[]` was translated; `TArray<FVector>`
was refused, and the second is the spelling sitting in front of anyone who just read a header. Same
join, same session, and confirmed against a live editor rather than reasoned about:

```text
TArray<FName>       ->  refused        ->  now  name[]
TMap<FName,int32>   ->  refused        ->  now  map<name,int32>
TSet<FName>         ->  refused        ->  now  name<set>
```

These are **translated, not hinted**. The ambiguity that stops `StaticMesh` being rewritten - object
or class - has no equivalent here: a `TArray` is an array. So the call simply succeeds instead of
failing with better advice, which is the difference between a good error and no error. It recurses,
so `TMap<FName,TArray<int32>>` resolves in one call rather than teaching one mistake per round trip,
and an element the table does not know is passed through untouched - `TArray<Foo>` becomes `Foo[]`
and the bridge refuses it by its own rules, because guessing a prefix there would be the bare-class
mistake this file already declines to make.

Worth recording how this nearly went in: it was first built as a separate `suggestType.ts` that
attached a hint to the error, complete with its own copy of the C++ spelling table. That is two
places describing one thing - the exact drift this repo keeps finding - and it was only caught by
checking why `FVector` succeeded live when the C++ resolver has no such case. The duplicate was
deleted and the one genuinely missing piece folded into the module that already owned the job, which
also moved it from a hint to a fix.

### `{ Cost: 500 }` was rejected by the schema, not by the engine

With the value findable, the other half of "finds it and changes it" was tried end to end — and the
write refused the obvious call:

```text
add_data_table_row { values: { Cost: 300 } }
  ->  Expected string, received number at values.Cost
```

Everything Unreal writes goes through `ImportText`, which takes a string, so every write parameter
here was declared `z.string()`. That is faithful to the engine and wrong for the caller: the natural
way to say "make it cost 500" is a number, on the single commonest change request there is.

The read/write round trip was never broken — `list_data_table_rows` returns `"300"` and
`set_data_table_row` accepts `"300"` — so this was not two tools disagreeing with each other, which
is the defect this repo usually finds. It was the tool disagreeing with the person using it, which is
harder to see from inside.

Ten write parameters now accept a string, a number or a boolean and stringify it: `500` → `"500"`,
`1.5` → `"1.5"`, `true` → `"true"` — exactly what `ImportText` wants for an int, a float and a bool.
Anything with real structure still has to be spelled the Unreal way (`"(X=0,Y=0,Z=100)"`, an asset
path), because no coercion could guess that. The exposed JSON Schema is a clean
`"type": ["string","number","boolean"]`.

The whole change request now runs **find → change → verify in 6 calls and 408 tokens**, and
`trial:chain` covers it, since a value passing from one tool to the next unedited is exactly what
that trial is for. `check:protocol` asserts the six write parameters still accept a number, and fails
when one is reverted.

### An entire substrate was unsearchable

Following that change request to its end found something worse than a routing gap. To change what the
machine gun costs you first have to find the number, and nothing here could:

```text
unreal_search_project "Weapon_MachineGun"  ->  { "hits": [], "hitCount": 0 }
```

`Weapon_MachineGun` is a real row in this project's `DT_Upgrades`. `search_project` indexes Blueprint
names, parent classes, function names and variable names — row names and cell values are simply not
in the index, and the reply said so nowhere. `check_data_tables` walks every table but reports
*problems*, not values. So the substrate a data-driven game keeps all its tuning in could not be
searched at all, which made "or a Data Table" untrue.

`unreal_find_in_data_tables` closes it: every row name and cell value, returning table, row and field
— never the rows. Composed from `list_assets` + `list_data_table_rows` rather than a new bridge
command, so it works against the plugin binary you already have. On this project, "MachineGun" costs
**280 tokens** to locate across 20 tables and 128 rows.

It also found that `BP_HealthUpgrade` is referenced from **two** tables — `DT_Upgrades` as
`Stat_HealthNum` and `DT_UpgradesBP` as `Stat_HealthNumber`.

Worth recording how the wrong version of this nearly shipped: the routing advice was first written to
say `search_project` "covers Data Table rows and Blueprint contents at once". That was written as
advice before being tried, and it is false. The same paragraph claimed a walk speed lives in a class
default; `read_class_defaults` on `BP_Player` is 4,728 tokens and never mentions `MaxWalkSpeed`,
because it is a property on the movement component. Both claims were replaced with what was actually
verified.

### "Build me this" is not a bug report

The other half of what this project promises is *"I tell it a feature I want, it scans the current
work, adapts to it, builds with it"*. Exercised the same way as the bug half, it landed badly:

```text
"add a new shop upgrade that increases fire rate"  ->  nothing at all
"I want to add a dash ability"                     ->  nothing at all
"add a pause menu"     -> list_widgets, review_blueprint, audit_project
"make the enemies drop loot" -> read_behavior_tree, audit_project
```

Nothing, or a set of tools for finding out what is **broken** handed to someone who wants something
**built**. The subject was read correctly and the intent was not read at all. Intent now picks the
approach and the subject still picks the domain, so "add a pause menu" plans against what exists
*and* brings the widget tools.

And "build a new weapon" was returning widget tools for a reason worth recording: **`ui` matched
inside `b-ui-ld`**. Seventeen phrases in the index were four characters or shorter, and every one is
a substring of ordinary English — `ai` inside "chain", `lag` inside "flag", `hang` inside "change",
`anim` inside "animal", `key` inside "monkey". Confident nonsense, produced by the file whose own
comment warns that a caller who believes they were understood will trust a wrong answer. Matching now
depends on the phrase: multi-word phrases stay substring (`"aren't showing"` must match "upgrades
aren't showing up"), single words of five or more get a word boundary with a free suffix (`crash`
still catches "crashes" and "crashing"), and short words must match whole.

### What `plan_feature` got wrong, and what it got right

Following the build path to `unreal_plan_feature` on the real project: it decomposed the request into
`shop`, `upgrade`, `fire`, `rate`, found `BP_ShopUpgrade`, `BP_ShopComponent.HasUpgrade` and
`BP_Player.FireProjectile`, flagged `BP_Player` as high-risk with 49 referencers, reported the
project's own naming conventions, and told the caller to extend rather than duplicate. That is the
tool working as intended.

Three defects around it:

- **`newWork: ["increas"]`.** The stemmer's `(?:s|x|z|ch|sh)es$` rule is right for boxes→box and
  wrong for every word already ending in `-se`. That non-word reached the user as *"model the data
  for the new parts first (structs and enums for increas)"* — a stemmer that invents words writes
  plans naming assets nobody could build. `-sses` still takes the whole `es` (classes→class), a
  single `-ses` takes only the `s` (increases→increase, phases→phase, purchases→purchase).
- **A verb of effect treated as a thing to build.** "Increases" is what the upgrade *does*, not
  something to create. The nouns in a feature request are the concepts. Deliberately *not* filtered:
  show, hide, display, play, run, start, stop — each is a real noun in a game ("a start menu", "a run
  animation"), and over-filtering loses the subject itself.
- **A cap reported as a count.** Every concept came back as exactly 12 — `shop(12) upgrade(12)
  fire(12) rate(12)` — because `mapSystem` is called with `maxAssets: 12`. That reads as four small
  systems and is really four systems of unknown size. `SystemMap` already tracks `truncated`;
  `plan_feature` was dropping it. It now reports `assetCountIsACap`.

The stopword filter also ran on the raw word while the singulariser ran after it, so `add` was
dropped and `adds` was not — it passed the filter, became "add", and was reported as a concept. One
list, applied to the form the list is written in.

### A style note is not an unfinished feature

`unreal_verify_feature` is the last call before telling the user a feature is done, so its verdict is
the whole product. Run on the flow it exists for — create a Blueprint, add one variable, ask whether
the feature is finished — it answered:

```json
{ "verdict": "fail", "score": 99,
  "blockers": ["... [EventGraph] 3 execution chains but only 0 comment box(es) ..."] }
```

The rule was `score < 100`, so **any** imperfection failed. That finding is `unlabelled-sections`,
severity **info**: a suggestion about comment boxes. A model that trusts the verdict goes and adds
comment boxes to a feature that was already done; a model that learns not to trust it stops reading
the tool at all, which is worse. The verdict now blocks on errors and warnings, and info findings are
still reported on each asset — worth knowing, and not "not finished". Verified both ways against the
editor: the new Blueprint passes at score 99, and `BP_Player` with 16 warnings still fails.

### The example value is a shape, not an answer

Following that path to its end found the risk in it. `unreal_check_data_tables` reports each empty
reference with an `exampleValue` taken from a filled sibling row, so a caller can see what a correct
value looks like. The obvious next move is to copy it, and on this project that is wrong: the example
offered for row `Weapon_MachineGun` is `BP_BulletSize`, taken from `Survival_MobileAgent`. Paste that
in and the machine gun grants a bullet-size upgrade — the table then passes every check here and the
game is quietly wrong, which is worse than the null it replaced because nothing will flag it again.

The two rows flagged on this project (`Weapon_MachineGun` and `Vacuum_VirusController`) name upgrades
that exist as no Blueprint anywhere in it. **"This was never built" is a real answer**, and the advice
now says so rather than implying every null just needs a value typed into it. 95 tokens, and only on
replies that have something to warn about.

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

`nextAction` orders by severity and then by what the finding actually costs you, from the same
table `unreal_audit_project` ranks with. It used to order by severity alone, which left the order
within "warning" to however the graphs happened to be read: on `BP_Player` that put a cost-40
unhandled cast ahead of four cost-55 findings about work running every frame, in the one field
whose entire job is to say what to do next. Two tools that each work, telling you to fix different
things first, is worse than either ranking being imperfect - so they now share one cost table
rather than each owning a copy.

Graphs with findings are reported in full; graphs without them are listed by name under
`cleanGraphs`. `BP_Player` has 60 graphs and 13 with anything to say, and the other 47 each carried
a score, a summary of three zeroes and an empty findings array - 30% of the reply, spent reporting
that nothing is wrong. They are named rather than dropped, because "checked and clean" and "never
looked at" are different answers and a caller that cannot tell them apart re-reads what was already
cleared. The read went from **7,562 to 5,398 tokens** and is now watched by `measure:reads`.

**`unreal_build_graph` attaches this review to its own result, unasked.** That is the point: the
model most in need of the feedback is exactly the model that would never think to ask for it. A
weak model does not usually fail from lack of capability, it fails because nothing ever objects to
what it wrote, so it declares victory. Compilation is a very low bar to clear: a graph full of dead
nodes, unhandled cast failures, and leftover debug prints compiles perfectly.

Every check is deliberately conservative. A false positive teaches a model to distrust the whole
report, which costs more than a missed finding.

### Cost modes: how much to spend per build

Building one system should not cost half a million tokens. The same feature written in C++ costs
maybe twenty thousand, and the difference is not intelligence, it is that a Blueprint tool can be
chatty in ways a text editor cannot.

Set `UNREAL_MCP_MODE` to choose how much a build spends. Measured on a real 5-node build against a
running editor, by `npm run measure:cost`:

| Mode | Build response | vs max | What you get |
| --- | --- | --- | --- |
| `fast` | ~110 tokens | 14% | Correct, compiled, laid-out graphs. Minimal reporting. |
| `standard` (default) | ~172 tokens | 21% | The above, plus a quality score and the single most important thing to fix next. |
| `max` | ~808 tokens | 100% | The above, plus labelled comment boxes per execution chain, every review finding with its fix, and per-node detail. |

**The floor never moves.** Every mode still places whole graphs atomically inside one transaction,
lays them out so they read left to right with straight execution chains, compiles, and refuses to
silently do the wrong thing. What changes between modes is the *polish and the paperwork* — never
the correctness of what lands in the project.

That distinction is the whole design, and there is a test asserting it: a mode that produced worse
Blueprints to save tokens would be a trap, because the person choosing the cheap mode is usually
the person least able to spot the difference.

Two things worth knowing:

- **`fast` says what it gave up.** Its description tells the model that the review is no longer
  attached automatically and it must call `unreal_review_blueprint` itself before claiming a
  feature is done. Cheap should be a choice, not a silent downgrade.
- **`standard` keeps the score and one next action** — about thirty tokens. Dropping it would save
  almost nothing and would remove the only unprompted quality feedback a weaker model ever gets.

**Why `standard` is still the default, deliberately.** An audit of this repo argued for making `max`
the default on the grounds that `standard` withholds review findings and lets a model declare
victory on broken work. The first half of that was a real defect and is fixed: `review.blueprint`
findings reached no build response in any mode, and the graph findings were capped in graph order
rather than by severity, so errors could be pushed out by info-level notes. Both are corrected.

What remains is a genuine trade, and it is resolved in favour of the smaller reply. `max` takes a
build response from roughly 172 tokens to roughly 808, on every build — and the specific thing
`standard` still withholds is the *list* of findings, not the fact that findings exist: it reports
the score and the single most important next action, which is what stops a model claiming success.
The stronger answer to "did I actually finish" is not a longer build response, it is
`unreal_verify_feature`, which costs nothing until the moment it is asked and checks every asset
rather than the one just built.

`--print-config` reads `DEFAULT_MODE` rather than a literal, so if that judgement changes the
printed config changes with it. The profile line above did **not** do that, and said `lazy` while
the in-process default was `full` for months with nothing noticing.

`unreal_doctor` reports the active mode and what it means, since it changes what every call costs.

Combine with `UNREAL_MCP_PROFILE=search` for the cheapest useful setup: four tools standing
(~2.3k tokens standing instead of ~30.1k) and ~110-token build responses.

### Tool profiles: paying only for what you use

Tool definitions are paid for on every request, before the user's message is read. All 80 tools cost
roughly 25.5k tokens of standing cost, every single turn. On an 8k or 32k local model that is the
difference between usable and unusable — but even on a 200k-context frontier model it is 25k tokens
a turn spent describing tools the session will never call.

The obvious fix is to write shorter descriptions. That was measured and rejected: tool descriptions
are 41% of the payload and they are the teaching a weaker model leans on, while parameter prose is
another 17%, so even aggressive editing buys about a tenth of the total and makes every model worse
at sequencing. The bytes are not the problem. **Sending tools the caller will never touch is the
problem.**

| `UNREAL_MCP_PROFILE` | Standing cost | Reaches | Meant for |
| --- | --- | --- | --- |
| `search` | **4 tools, ~2.3k tokens** | everything, on request | frontier models — what `--print-config` emits |
| `full` (in-process default) | 89 tools, ~30.1k tokens | everything, immediately | when you want no indirection at all |
| `lazy` | 32 tools, ~12.4k tokens | everything, on request | mid-size models |
| `core` | 32 tools, ~12.4k tokens | only those, permanently | clients that ignore `tools/list_changed` |
| `minimal` | 11 tools, ~4.8k tokens | only those, permanently | small local models |

Those figures are measured by `npm run check:profiles`, which runs in the normal test suite and
fails if a profile grows past the ceiling its intended model can hold.

**"Standing cost" means tool definitions *plus* the server `instructions` field**, and it did not
until recently. A client sends `instructions` to the model on every turn exactly as it sends tool
definitions, so leaving it out of the budget did not make it free — it made this check report **less
than half** the real figure on `search`, the frontier default: 1,239 tokens of tools beside 1,033 of
instructions. All five ceilings were restated once against the correct quantity. That was a
correction rather than a relaxation: every ceiling encoded an intent about what a model must hold
before it can work, that intent always covered the whole payload, and nothing got bigger on the day
the numbers changed.

**Presets make that saving reachable.** Naming tools is much cheaper than enabling a group, but a
model on `search` starts with four tools and no idea which to name — so its real choices were to
call `unreal_list_tools` and reason about a catalogue, or to pay for `core`. Guesswork stood between
every session and the cheapest path, which made the cheap path an expert move rather than the
default. `unreal_enable_tools({ preset: "diagnose" })` is the tools for one job, already chosen:

| preset | for | tools | standing |
| --- | --- | --- | --- |
| `cpp` | read and change the project's C++ | 13 | 4,081 |
| `data` | Data Tables, structs, enums | 20 | 5,882 |
| `ui` | UMG widgets and their bindings | 17 | 5,928 |
| `diagnose` | find **and fix** a reported bug | 22 | 7,468 |
| `feature` | build a new Blueprint feature | 21 | 7,586 |
| — | the `core` group, for comparison | 32 | 11,666 |

Each is verified by a trial that runs the whole job on it, so "sufficient" means a run passed rather
than that the list looked complete. `trial:diagnose --by-preset` runs the entire find-and-fix loop on
`diagnose` alone; `trial:feature --by-preset` runs all five surfaces on `feature`+`ui`+`data`+`cpp`.
That caught a real omission immediately: `unreal_find_orphans` — a tool whose whole job is finding
something wrong — was missing from the preset for finding things wrong, in a list I had written and
read twice.

**The honest limit: presets do not stack.** One beats `core` comfortably. Two is roughly a wash.
Four together measured **14,368**, which is more than `core` costs — so a job that genuinely spans
four surfaces should enable the group. The instructions say so, with the measured numbers, because a
rule of thumb a model cannot check is one it will apply in the wrong place.

**A field view on the largest listing.** `unreal_list_blueprints` takes an optional `fields` - ask
for `["path"]` and each row carries only that. Measured on the project: 12,117 tokens to 8,950, a
26% cut, for a caller that already knows it only wants paths.

Deliberately **not** universal, and the arithmetic is why. Competing servers expose `_fields` on every
action; an extra parameter on all 96 tools here is roughly 40 tokens each, about 3,800 tokens of
standing context, against reads already down to 1-3.7k. That trade is a loss everywhere except the
few largest reads, so it lives on those and nowhere else. A field name matching nothing is reported
rather than silently narrowing the view - a typo would otherwise read as "this project has no parent
classes" instead of "you spelled it wrong".

**Naming tools instead of enabling a group is the largest single saving available**, and it is now
measured rather than asserted. `npm run trial:feature --by-name` runs the whole five-surface trial on
nothing but the tools it calls — derived from the trial's own source, so the list cannot drift from
what it does — and prices that against the group a model would otherwise reach for:

| what is enabled | tools | standing |
| --- | --- | --- |
| the eight one Blueprint feature needs | 12 | **4,552** |
| everything the five-surface trial calls | 20 | 8,388 |
| the `core` group | 32 | 11,666 |

The trial passes on the named set, so this is not a saving bought with capability. 61% for one
feature, 28% even for a trial that spans Blueprints, data tables, C++, components and UMG. The "~4.5k"
the instructions used to claim by hand turned out to be right — 4,552 — but a number nobody checks is
one that is eventually wrong, so it comes from `src/groupCosts.ts` now like the rest.

The instructions had grown four separate blocks about how to switch tools on — why the list is
short, presets, a group price table, and a note about naming exact tools — **380 tokens of preamble
before any work**, a third of the whole text, and partly redundant with each other. They are now one
block of ~150: what to do first, what it costs, and where to look for the rest. `unreal_list_tools`
already prices every group on demand and now names the presets too, so nothing was lost that a model
cannot reach; it went from 1,162 tokens to 981.

On `search`, the instructions are the larger half, and they are the last thing that should be cut —
four tools are only usable because the text explains how to reach the rest. They now quote the
**measured** cost of every group, generated from `src/groupCosts.ts` so they cannot drift, and steer
by job rather than by habit: they used to say "call `enable_tools({groups:["core"]})` as your first
action", which pointed every session at the single most expensive move available (~10.4k tokens) even
when the job was to read a project and find a bug.

**The single most expensive call in this server was a read, and it was unbounded.** Measured against
a real game rather than reasoned about: `unreal_read_blueprint_summary` on `BP_Player`'s EventGraph —
807 nodes — returned **126,477 tokens**. That is 63% of a 200k context window, in one call, from a
project whose stated premise is that a model should never receive a raw engine dump. Every saving
made on tool definitions is rounding error beside it.

It is capped now, and the numbers are the argument:

| call | tokens |
| --- | --- |
| default (60 nodes, entry points first) | **9,085** |
| `match: "Health"` (23 nodes) | **3,661** |
| `maxNodes: 5000` (all 807) | 126,477 |

Two things make the cap safe rather than lossy. It is applied in the **tool**, not the bridge —
`review`, `audit` and `explain_graph` call the bridge command directly and still receive every node,
so the analysis stays correct while the model gets a view it can afford. Capping in the bridge would
have quietly corrupted them instead, which is precisely the mistake `explainGraph`'s own traversal cap
had already made once, reporting live nodes as dead. And **entry points are never dropped**: a cap
that removes the events leaves a list of function calls belonging to nothing.

A graph smaller than the cap comes back exactly as it always did, with no truncation bookkeeping
attached. Only the graphs that would have cost six figures are touched at all.

**Node ids in a graph summary are abbreviated, because they were 29% of the reply.** A node id is 32
hex characters and appears once per node and again for every link into it — measured on that same
807-node graph, **19,592 tokens of 67,163 were identifiers**, carrying no information beyond "which
node". The summary emits the shortest prefix that is unique across that graph, never shorter than 8,
and **every command that takes a node id accepts a unique prefix**. On that graph the full read went
from 67,163 tokens to 52,469 and the capped default from 9,085 to 8,017.

Two details keep it safe. The length is computed per graph and lengthens if 8 characters would
collide, because two nodes sharing an id is not a cosmetic problem — it is edits landing on the wrong
node. And an ambiguous prefix is *named* as ambiguous, listing the candidates, rather than resolved
to whichever node came first:

```
ambiguous_node_id: 'A' matches 45 nodes in this graph (A0B1A6EB..., ADDE6CA3..., ...). Use more characters.
```

Single-node replies elsewhere still carry the whole GUID, where one identifier costs nothing and
being able to quote it anywhere is worth more.

**And 65% of what was left was JSON keys.** With the ids shortened, the same 807-node graph measured
52,469 tokens of which only **18,461 were data** — the rest was punctuation and repeated key names,
mostly because every link is its own `{"node":..,"pin":..}` object, so the words `node` and `pin`
appeared 1,642 times to carry two short strings each. Wiring is flattened to one line per pin:

```json
{"id":"3C03B7C2","type":"CustomEvent","title":"HealthRegen","pins":["out then -> 53A3335B.execute"]}
```

That is cheaper *and* easier to read than the nested form it replaces, which is the rare case where
those two pull the same way. The `K2Node_` prefix is stripped too — every node in a Blueprint graph
has it, so it identified nothing and cost 1,400 tokens of the same seven characters.

**The default read of that graph is now 3,110 tokens. It started the day at 126,477.**

**The other two big reads got the same treatment**, and the breakdown decided the fix in each case
rather than a guess:

| call | before | after |
| --- | --- | --- |
| `unreal_explain_graph` | 13,294 | **3,804** |
| `unreal_list_blueprints` (339 Blueprints) | 15,149 | **4,508** |
| `unreal_list_blueprints` `match: "Enemy"` | — | **472** |

For `explain_graph` the measurement was the argument: of 13,294 tokens, the **prose was 2,043** and
the structured `chains` array was **7,296** across 89 chains — largely restating the prose, and
carrying every visited node id. The prose is what the tool exists to produce, so it is untouched;
the array was capped and dropped the ids. `audit` and `review` call `explainGraph()` directly and
still receive all of it.

**Capping it was the wrong fix, and the reply said so itself.** The prose is 92 lines of
`- FireWeapon -> Can Shoot -> Branch -> ...`, one per entry point, for **all 89** of them, ending
with the unreachable nodes and their counts. The capped `chains` array then restated the first 25 of
those same chains as JSON (872 tokens), and `unreachable` restated the same list again (110) — while
the reply's own `chainsNote` read *"The prose above covers all of them"*.

The array had exactly one thing the prose does not: the **entry node's id**, which is what lets a
caller jump to a node instead of searching for it. That is 69 tokens of the 872, so it is what
survives, as an `entryIds` map. The steps are stated once, in the prose, where they were already
complete rather than capped.

| | before | after |
| --- | --- | --- |
| `unreal_explain_graph` | 3,671 | **2,329** |

A caller loses `steps` as an array and gets a line to split on `" -> "` instead — about 880 tokens,
a quarter of the reply, for a string split against text that was being sent regardless.

For `list_blueprints`, enumerating a whole project is rarely the question — finding something in it
is, and `match` answers that for a thirtieth of the cost.

### The tests were mutation-tested, and two guards were not guarding

417 tests, and every one of them has assertions - but "has assertions" is not "can fail". So twelve
deliberate mutations were made across the modules this project relies on, each running the whole
suite to see whether anything noticed.

Eleven were caught. **One was not: renaming the `repnotify-does-nothing` check broke no test.** The
function is tested, but nothing asserted on the check NAME - and that name is what the audit prices
by. `FINDING_COST[check] ?? 1` means a drifted name silently drops a cost-60 finding to **1**, under
every cosmetic result in the report. The ranking is the entire product of that tool.

Checking the class instead of the instance then found a second one already live:
**`level-sweep-repeated` was emitted by `quality.ts` and priced nowhere**, so it had been scoring 1
since it was written. Not a decision anyone made - a name that was never added to the table, taking
the fallback in silence. It is now 20, beside `graph-too-large`, which is where an info-severity
sweep check belongs among its two priced siblings at 85 and 50.

The guard is general rather than one more assertion: every `check: "..."` string in `src/` must have
a `FINDING_COST` entry. Confirmed by drifting a name and watching it fail:

```text
not ok - every check a module emits has a price, because the fallback is silent
    emitted but unpriced, so they score 1 and sink: level-sweep-repeated-often
```

Worth recording that the first attempt to confirm it used `level-sweep-DRIFTED`, which slipped past
the check's own lowercase-kebab regex and looked like the guard failing. The mutant was
unrepresentative, not the guard - but a mutation that cannot happen proves nothing either way.

### Every preset was checked for the tool its own job starts from

The lesson from the `diagnose` gap - *a preset check only checks the path the trial walks* - is worth
applying to all five rather than waiting for the next one to surface. Each was started cold and asked
whether it contains the tool its own description implies:

| preset | entry points |
| --- | --- |
| `diagnose` | present |
| `feature` | `map_system` absent |
| `ui`, `data`, `cpp` | present |

**And that one was measured before it was fixed, which changed the answer.** `plan_feature` is in the
`feature` preset and already does the scanning - its `existingSystems` names `GM_Gameplay`,
`GS_Gameplay` and `WBP_HUD` for a countdown request, with reading order and a high-risk marker. So
`map_system` there would be redundant, and its ~690 tokens are not warranted.

What *was* missing is the same thing `map_system` had been missing: **"already exists" and "already
exists and is dead" lead to opposite plans.** Told a system exists, a plan extends it - and extending
something nothing calls produces a feature that cannot run, built carefully on code that was replaced
and left on the canvas. On the real project, `"add a countdown before the wave starts"` names
`ShowCountdown` among the assets to read, and nothing anywhere calls it.

One line, asked once for all matched concepts rather than once each - `"add a countdown before the
wave starts"` examines three, and three copies of one paragraph is the per-row boilerplate this repo
removes everywhere else. 1,021 → 1,096 tokens for the question, against 1,227 for three copies of it.

### What a bug actually costs, measured end to end

A cold session, the way a frontier model really starts - `search` profile, four tools - through to a
diagnosis of a real bug in a real project:

| step | tokens |
| --- | --- |
| standing cost, before a word is typed | 2,424 |
| `enable_tools({preset: "diagnose"})` | 245 + the tool list it turns on |
| `map_system({query: "countdown"})` | ~600 |
| `trace_function_calls({function: "ShowCountdown"})` | 166 |
| `trace_variable({variable: "CountdownTime"})` | 415 |
| **total, cold session to diagnosis** | **~10,500** |

Most of that is the preset's tool definitions, which is the honest shape of the trade: about 2.4k to
be ready for anything, and a one-off ~7k when the job is known.

**Measuring it found a real gap.** `map_system` returned an error - the `diagnose` preset, whose
entire job is "find and fix a reported bug", did not contain the tool a plain-text bug report lands
on. `search_project` was there and covers the raw lookup, which is why nothing looked broken: it
returns hits, and `map_system` returns a system.

The reason it stayed invisible is worth more than the fix. `trial:diagnose --by-preset` exists
precisely to prove a preset is sufficient by running the whole loop on it - but the trial plants a
defect and goes straight to the tools that find *that* defect. **A preset check only checks the path
the trial walks.** The trial now starts from a name in prose, the way a bug report does, and refusing
to include `map_system` fails it:

```text
1 step(s) did not do their job:
  - find the system from a name alone: no reply
      reply: MCP error -32602: Tool unreal_map_system disabled
```

`diagnose` costs 9,568 → 10,257 tokens for it, which is the right trade for the preset whose purpose
it is.

### The tool a plain-text bug lands on now asks whether the system still runs

`unreal_map_system` is where "the countdown never shows up" goes first, and it answered *what this
system is made of* without ever asking whether the system still runs. Against the real project:

```text
"countdown" spans 25 asset(s).
- GM_Gameplay (AVSBaseGameMode): 3 matching variable(s) ... [21 referencers - changing it has reach]
- GS_Gameplay (AVSGameState): 3 matching function(s): ShowCountdown, UpdateCountdown, HideCountdown
- GS_TutGameplay (GameStateBase): 3 matching function(s): ShowCountdown, UpdateCountdown, HideCountdown
```

A precise, useful answer in ~600 tokens - and **nothing calls any of those six functions.** The
liveness pass finds that, but it lives in the audit, and a bug report does not start at the audit.

That gap is the one that cost this project an entire iteration: a skin system found, read and
modified before anyone noticed a newer one had replaced it, the old graphs still on the canvas and
still compiling. A replaced system matches a search exactly like a live one, and reads the same.

Deciding liveness here is not free - it needs every graph in the project, and this tool works from
the index - so it names the one call that *does* answer it rather than guessing or going quiet:

> Before changing any of this, check the system still runs: `unreal_trace_function_calls` on one of
> the functions above says whether anything reaches it.

About forty tokens, on the reply where the mistake actually happens, and only when the map names
functions at all - putting it on a variables-only map would be noise on every reply, which is how a
warning stops being read.

### "Clean" was doing two jobs, and one of them was lying

Having found the doctor giving an all-clear it had not earned, the same question was asked of every
other verdict in the codebase. Two more were doing it.

**`find_orphans` returned `verdict: "clean"` when nothing matched to compare.** "Clean" means it
looked and found nothing wrong; this meant it never looked, because one side of the pairing matched
no actor. The explanation was always in `next`, and a caller reading only the verdict got a guarantee
out of a search that never ran. The test guarding the case is named *"a class name that matches
nothing **says so**"* - which is precisely what the verdict did not do. It is now
`"nothing-to-compare"`.

**`check_data_tables` returned `"clean"` while holding rows it could not judge.** A column empty in
every row of a table gives nothing to compare against - there is no filled row to show whether it
should hold an asset reference - so those rows were skipped, not checked. The `undecidable` list was
always in the reply; the word on the front of it did not admit them. It is now `"partial"` when
nothing is provably wrong and something was not provably right.

On the real project that distinction is live: `check_data_tables` reports 2 null references **and 5
undecidable rows**, a number the old binary verdict had nowhere to put.

This is the third instance of one failure: a check that reports success for "I found no problems"
and for "I could not look" with the same word. The others were `find_broken_names` reporting "0
broken" out of three literal names while 33 came from variables it never checked, and the doctor's
"implements every command this server probes for".

### The doctor said everything was fine while two commands were missing

`unreal_doctor` reported *"The plugin implements every command this server probes for"* against an
editor that did not have `watch_runtime` or `set_variable_replication`. The sentence was true and
useless: the probe list is maintained by hand, it had gone stale, and a model calling either tool
would get `unknown_cmd` from the one check that exists to explain things like that.

Two changes, and the second is the one that matters.

**The probe now says how many it probed.** `"5 probed commands are all implemented. That is a
sample, not the whole surface"` cannot be mistaken for an all-clear the way the old wording could.

**And there is a freshness check.** A hand-maintained list catches the commands somebody remembered
to add to it; comparing the running plugin's build stamp against the newest C++ source on disk
catches **every command at once**, because a plugin older than the source is missing all of them by
definition:

```text
[warn] plugin freshness: The running plugin was built Aug 30 2026 19:42:16, and the C++ source on
       disk is newer.
       -> Every bridge command added since that build answers unknown_cmd, and nothing else looks
          wrong. Close the editor, run `npm run build:engines`, reopen - and check that
          build-targets.json lists the project you actually have open.
```

That last clause is there because it is the failure that actually happened: the project being worked
in was not a build target, so it never received anything, for days, while everything looked healthy.

The source-time lookup is **injected**, like the clock, so the module keeps its property of touching
nothing but the bridge and the check is testable without a source tree that happens to look right.
When there are no sources beside the server — an installed copy — it returns 0 and the check is
**silent rather than reassuring**, because reporting freshness from their absence would be inventing
an answer.

### Two compactions measured and reverted, which is also a result

The repeated-key scan scored every row-shaped reply. `list_blueprint_graphs` came out highest at 44%
and `list_actors` at 28%, so both were tried. Both went back.

**`list_blueprint_graphs` as a `{name: nodeCount}` map** is the same shape as the parent-class census
and saves about 250 tokens of 643. The difference is what the reply is *for*. A census is terminal -
you read it and you are done. This is **navigation**: every name in it gets fed straight into
`read_blueprint_summary` or `explain_graph`, and callers iterate it as a list. Changing it broke
`measure:reads` on the first run, which picks the largest graph from that array to measure the reads
that follow. That is a consumer inside this repo; the ones outside it cannot be fixed by finding out.

**Dropping an actor's `class`**, which its `blueprint` path usually ends in, saves **38 tokens** on a
1,115-token reply - because `hoistSharedClass` already lifts the class out whenever a level is
dominated by one, so what remains is the case where classes differ and the duplication is not there.
Against that, `class` is how anybody identifies an actor: `classFilter` is a parameter of this very
tool, and the test guarding the rare-Blueprint cap asks `a.class === "BP_Boss_C"`, which is the
obvious way to write it.

Both reasons are recorded next to the code rather than in a commit message, because the ideas look
good until they are measured and the next person to have them should get the measurement.

### The second most expensive finding can be fixed now, not just reported

The audit prices `parent-event-not-called` at 95, behind only the multiplayer checks, and it is one
of the nastiest bugs in Blueprints: **adding an event to a child REPLACES the parent's rather than
extending it.** Nothing warns. The Blueprint compiles clean. The parent's `BeginPlay` simply never
happens and the symptom shows up somewhere else entirely.

The finding already said what to do - `unreal_add_node` with `nodeType: "CallParent"`, "then wire it
as the first thing this event runs". Two steps, and the second is where it goes wrong. **"First" is
not "append."** An exec output holds exactly one link, so connecting the parent call to the event
*displaces* whatever was already there:

```text
before:   Event BeginPlay ------------------> DoTheThing -> ...
naive:    Event BeginPlay -> Parent: BeginPlay          DoTheThing -> ...   (orphaned)
correct:  Event BeginPlay -> Parent: BeginPlay -> DoTheThing -> ...
```

The naive result runs *only* the parent call - a worse bug than the one being fixed, and it looks
like a successful edit. `unreal_call_parent_function` is one call that knows the shape: it captures
what the event currently runs, adds the node, and rewires both links, reporting what it moved. Same
argument `guard_with_authority` makes for itself - a general "insert a node" tool has to be told how
to wire, and getting that wrong rearranges somebody's graph quietly.

It is safe to run twice (a graph that already calls the parent is reported as `alreadyPresent` and
left alone), it compiles before and after so "did I break it" is a comparison rather than a guess,
and it re-reads the graph afterwards to confirm the event actually reaches the new node.

**Nothing in it needed a plugin change.** Read the graph, add a node, connect two pins, compile —
every one of those has been in the bridge for a long time. The fix for the second most expensive
finding was missing not because the engine could not do it, but because nobody had written down the
wiring so a model would not have to get it right from prose.

The finding now names the tool instead of describing the procedure, and the graph name is threaded
through rather than written twice, so the fix instruction and the report can never disagree about
which graph they mean.

### Asking the engine instead of inferring it

Two checks were fooled by dispatcher signatures, and both fixes worked by matching graph names
against delegate-typed variables. That is inference about a fact the engine already knows: a
dispatcher's signature graph lives in `Blueprint->DelegateSignatureGraphs`, its own array, separate
from the function graphs.

`GetAllGraphs` flattens them together, which is why they arrive looking exactly like unfinished
functions - a function entry node, nothing wired to it, an ordinary name. `list_blueprint_graphs`
marks them now, from the array rather than from the name:

```json
{"name": "ChangeHealth", "nodeCount": 1, "kind": "delegate"}
```

Absent for an ordinary graph, so a Blueprint with no dispatchers pays nothing. It also helps anyone
reading the graph list directly, which is where this confusion starts - a model picking a graph to
open has no other way to tell a signature from a function it could fill in.

The audit prefers the mark when it is there and keeps the name-matching as a fallback, because the
plugin inside a running editor is routinely older than this server and the variable list is already
in hand. Verified with the current stale plugin: **52 of 511 and 7 empty functions, unchanged** - the
fallback is carrying it, and the mark is a strict upgrade rather than a replacement.

### The same discovery corrected a number on the front page

Finding that event dispatchers appear in the graph list raised an obvious question: what else counts
them? The dead-graph section did.

```text
before   88 of 552 graphs nothing reaches
after    52 of 511
```

Per Blueprint the correction is larger than the total suggests:

```text
BP_Player      13 of 54  ->  3 of 42
GM_Gameplay    10 of 28  ->  1 of 18
GS_Gameplay    15 of 26  ->  8 of 19
```

**41% of what that section reported was a normal event dispatcher.** A model told "13 of BP_Player's
graphs are unreachable" goes hunting through ten dispatchers that are working exactly as intended,
and the finding this section exists for - a system replaced and left on the canvas - is buried in
them.

This is the third class of graph the engine reaches by a route other than a call node, after
animation graphs and interface implementations, and all three were found the same way: by reading
what the list actually contained instead of trusting the number. The published figure was **176 of
1,007**; it is 52 of 511, and the front page says so now.

The test for it pins the property rather than the plumbing: passed a dispatcher, `findDeadGraphs`
still reports it - correctly, because it cannot tell - so the filter belongs where the variable list
is in hand, and the test asserts both halves.

### The bug behind the question I had been asking all session

`unreal_explain_graph` on the function at the centre of *"the countdown never shows up"*:

```text
ShowCountdown: 1 nodes, 1 entry point(s).
- ShowCountdown: nothing wired to it.
```

**It is empty.** So are `UpdateCountdown` and `HideCountdown`, and ten more on the same Blueprint -
`RoundBegin`, `RoundEnd`, `PlayerJoined`, `TutorialEnd`. A system scaffolded and never filled in.

The audit said **nothing** about any of them. `empty-event` covers events; nothing covered a
*function* whose body is empty - which is the case where a caller exists and every one of its calls
silently does nothing. There is no error and no missing node; the call sits right there in the graph.

The interesting part is what happened next, because the first number was wrong three times:

```text
63  every graph whose entry reaches nothing
48  minus Blueprint Interfaces - BI_Power/PowerOn, BPI_MenuButton/VirtualClick.
     An interface declares signatures; empty IS the point.
 7  minus event dispatchers. This is the one that nearly shipped.
```

An event dispatcher is a `mcdelegate` **variable**, and Unreal *also* exposes its signature as a
graph with a `K2Node_FunctionEntry` and `connectedPins: []`. On BP_Player that is `ChangeHealth` and
`SendMessageToHUD` - indistinguishable from an unfinished function unless you know what the name is.
Without that exclusion the check reports every dispatcher in the project.

The seven that survive are real: `ShowCountdown`, `UpdateCountdown`, `HideCountdown`,
`SetChallengeWaveVisuals`, `CalculateNetDotDirection`, `Interacted`.

Priced at **50** - between `empty-event` (40) and `repnotify-does-nothing` (60), and the gap is the
argument. An empty RepNotify is definitely wrong: choosing RepNotify and then writing nothing has no
reading in which it is intended. An empty function might be a stub somebody means to fill this
afternoon, and it only becomes a defect when something calls it - which this check cannot see, so the
fix names `unreal_trace_function_calls` rather than asserting.

Every exclusion was found by reading the findings rather than trusting the count, which is the same
discipline that took `unhandled-cast-failure` from 142 to 111 and then to a lower price. A check that
fires 63 times on a 150-Blueprint project is telling you about the check, not the project.

### Widening the join trial to the ones nobody had tested

The joins the last five bugs came from are covered. The interesting question is the ones that are
not, so four more went in: `list_components` into `set_component_property`, `list_struct_fields`
into `add_struct_field`, `list_assets` into `read_asset_properties`, and the audit into the tool its
own `fix` names.

**All four passed** - fifteen joins green - which is a result worth stating plainly rather than
padding. The type descriptor work generalised: a struct field prints `object:Texture2D` and
`add_struct_field` takes it back unedited, exactly as variables do.

One thing to be honest about. The run reported a failure on
`list_components -> set_component_property`, and it was **the trial's own bug**: the parameters are
`component` and `property`, and it had written `componentName` and `propertyName`. A red result needs
reading before it is believed, and the note is now in the trial next to that call - because the
distinction it turns on is subtle. A parameter *named* differently from the field it takes is normal.
A *value* that has to be edited on the way is the defect this trial exists to catch.

### A trial for the joins, because that is where the last five bugs were

Five defects in five iterations, and they share a shape: **two tools that each work, describing the
same thing differently.**

```text
find_source returned AAVSGameState        describe_class refused it
list_variables printed object:Mesh[]      its own `match` could not find it
a read said type + subType                the write wanted object:<Class>
read_class_defaults dropped the value     the change request needed it
```

None of those is visible in a single call, in a token measurement, or in a unit test with a fixture.
They only exist in the join. `npm run trial:chain` walks the joins a real session makes and passes
every value through **verbatim** - anything needing an edit on the way is a finding, not a step:

```text
find_node -> add_node
  ok    line trace - KismetSystemLibrary::LineTraceSingle
  ok    set timer - KismetSystemLibrary::K2_SetTimer
list_blueprint_graphs -> read_blueprint_summary -> read_node_detail
  ok    read_node_detail takes that id verbatim - 1 pins
list_variables -> add_variable
  ok    the type a read prints round-trips - object:StaticMesh[]
find_source -> describe_class
  ok    find_source said "UKronosGameInstance", describe_class takes it - KronosGameInstance
```

**The first version called the bridge directly, and that was the wrong instrument.** It reported the
`find_source -> describe_class` join as still broken - which is true of the bridge, whose fix is dark
until the plugin is rebuilt, and false of what a model experiences, because the tool layer carries a
shim for exactly that gap. A model never touches the bridge. A trial that tests it is measuring
something nobody experiences, and it would have sent the next session chasing a bug that is already
handled.

Going through the tools also made the trial simpler: `list_variables` returns the descriptor itself,
so the check no longer has to import `asTypeDescriptor` to reconstruct what the caller would see.

### The same prefix problem in the other direction, and worse

Having fixed `find_source` to return `AAVSGameState`, the obvious next question was what happens when
that name is fed to the next tool:

```text
describe_class("AVSGameState")   OK
describe_class("AAVSGameState")  class_not_found
describe_class("Character")      OK
describe_class("ACharacter")     class_not_found
```

**`ACharacter` is the most common class name in all of Unreal C++.** It is what every header writes,
what every tutorial writes, and - as of the previous commit - what `find_source` hands back. The two
tools disagreed about the same class.

`UClass::GetName()` carries no prefix, so reflection knows it as `Character`. The resolver tried
*adding* `A` and `U`, and its own comment said those were a fallback "for a caller who writes the C++
spelling" - which is precisely the case that needs a prefix **removed**. The code did the opposite of
what its comment intended.

It strips now, and the ordering is what makes that safe: the exact name is tried several attempts
earlier, so stripping only runs when nothing is actually called `AFoo` and there is no real class it
can shadow. The uppercase check keeps it from mangling ordinary names - `ACharacter` is A followed by
a capital, while `Actor` is A followed by lowercase and is left alone.

That fix is in the bridge, where it covers every call site that takes a class name: `add_node`'s
`className`, `create_blueprint`'s `parentClass`, `spawn_actor`'s `actorClass`, a Cast's
`targetClass`. It is also dark until the plugin is rebuilt - and `find_source` is handing back
prefixed names *now*. So `describe_class` carries the same retry on this side:

```text
ACharacter     -> Character       (foundAs reported)
AAVSGameState  -> AVSGameState
UUserWidget    -> UserWidget
Nonexistent    -> still class_not_found, not a guess
```

Transitional, and the same shape as reading both `container` and the older `isArray`: it fires only
on `class_not_found` and only for a name that looks like a C++ spelling, so once the plugin catches
up it costs one comparison and never runs. A test asserts the bridge half exists, so the shim can be
removed on purpose rather than forgotten.

### The C++ leg's entry point could not find a class from its Blueprint's parentClass

The fourth leg, same method. A change request against C++ starts by finding where something is
declared, and the natural way to name it is the way the editor does - `list_blueprints` returns
`parentClass: "AVSGameState"`. Asking `find_source` for that returned:

```json
{"matches": {
  "Source/AntiVirusSquad/AVSGameState.cpp": ["1 mention: #include \"AVSGameState.h\""],
  "Source/AntiVirusSquad/AVSGameState.h":   ["8 mention: #include \"AVSGameState.generated.h\""]
}}
```

**Two include lines, and not one word about the class.** The C++ class is `AAVSGameState` - Unreal
prefixes `A` for Actor, `U` for UObject, `F` for struct, `E` for enum, `I` for interface - and the
editor drops the prefix everywhere it shows a name. So the entry point for the entire C++ half of
this server was missing declarations for the most common way a name is written down.

It retries with the prefixes now, and reports which one worked, because the caller not knowing the
C++ spelling is the whole reason they are here:

```text
AVSGameState                 -> foundAs AAVSGameState
AVSBaseGameMode              -> foundAs AAVSBaseGameMode
SpectatorDirectorController  -> foundAs ASpectatorDirectorController
AAVSGameState                -> no retry, found on the first pass
```

The retry is gated on *"found nothing but mentions"* rather than run always, because that is exactly
the prefix signature and nothing else looks like it. A name spelled the way the source spells it
finds its own declaration first time and never pays for a second pass.

**One optimisation in the first version was exactly wrong**, and it is the kind that reads as
obviously correct: skip a prefix the symbol already starts with. `AVSGameState` begins with `A`
because the project's initials do, and the Actor prefix puts *another* one in front - so skipping
would have left the original failure untouched while looking like a fix. It was caught by running
the same four symbols again rather than trusting the change.

### There was no way to read one Data Table row

Following the change-request thread into Data Tables - one of the three jobs named in this project's
brief - the read side had a hole. `list_data_table_rows` pages; there is no bridge command for a
single row; so *"what is WeaponDmg's price"* meant paging a table to find it:

```text
DT_UniversalActions, whole table   7,040 tok
DT_UniversalActions, one row         933 tok
DT_UpgradesOld,      whole table   1,117 tok
DT_UpgradesOld,      one row         269 tok
```

`rowName` does it, and **no plugin change was needed** - the filter is free on this side, so it works
against an editor whose plugin predates it.

Two things follow from it being a *targeted* read, and both are the rule the previous commit
established. It **pages past the default page** first, or a row that happens to be number 400 of 900
is reported missing. And it returns the row **in full**, defaults included, because a field omitted
for being at its default is exactly the field somebody asking for one row by name is about to change.

A name that matches nothing lists the names that exist:

```json
{"error": "row_not_found",
 "rowNames": ["WeaponDmg", "VacuumStorage", "Healing", "MaxHealth", "MaxHealthSquad"]}
```

Not a count. The reason a caller is here is that they do not know what the row is called, and "12
rows exist" is nothing they can act on.

The test for it failed twice for its own reasons before it tested anything - once slicing from the
first *mention* of the tool name, which is in a group list far from the handler, and once on a string
literal with a newline in it. Source-text tests are brittle exactly there, and it is worth saying so
next to one rather than pretending it read cleanly.

### The change-request leg, and a compaction that answered the wrong question

Third leg, same method: *"make the countdown 5 seconds instead of 10"*. `search_project` found
`CountdownTime` in three Blueprints with useful context - `"int variable in GS_Gameplay"` - and the
next step is to read what it is now. That returned:

```json
{"name": "CountdownTime", "type": "int32"}
```

**No value.** The value is `0`, and zero defaults are omitted - a compaction added a few commits ago
that saves 1,060 characters across 167 properties.

*"Absent means the type's zero"* is a fine contract in bulk, where the omission is most of the
saving. It is the wrong answer to `match: "CountdownTime"`. Somebody asking about one property **by
name** is usually about to change it, and needs to see what it is now rather than infer it from a
convention stated in the tool description. A change request that begins by reading the current value
and is told only its type has been answered with nothing it asked for.

So the rule is now about *when* the compaction applies, not whether: **dropped in bulk, kept for a
targeted question.** Both `read_class_defaults` and `list_variables` do it, since both have a filter
and both had the same hole.

```text
match: "CountdownTime"   {"name":"CountdownTime","type":"int32","value":"0"}
no filter                76 properties, 2,254 tokens - unchanged
```

The targeted path puts back exactly one field. Falling back to the raw row would have reintroduced
`subType`, `isArray` and the false flags, which would make the same tool return a different shape
depending on whether a filter was passed - and a test pins that, because it is the obvious way to
write this and it is wrong.

Worth naming what found it. This is a defect introduced by a token optimisation, invisible to every
measurement - the reply got *smaller*, which is what the measurement rewards - and visible in one
call to anyone actually trying to change a value.

### "enemie" is not a word, and it was reading the wrong half of the project

Same session, same method, next request: *"make enemies drop loot when they die"*. The concepts
`plan_feature` examined:

```json
["enemie", "drop", "loot", "die"]
```

`enemie` is not a word. The rule dropped a trailing `s`, and on a real project that is not cosmetic -
the two queries find different systems:

```text
enemie   BP_WaveSystem, BP_DummyTurret, GM_TutGameplay, BP_BaseCharacter, ...
enemy    BP_BaseEnemy, BP_EnemyController, BP_FlyingEnemy, BPI_Enemy, BPI_EnemyInteractable
```

The first list is **spawner bookkeeping** - assets carrying a variable like `RemainingEnemies`. The
second is the enemy system. For a request whose entire subject is enemies, the plan was reading the
wrong half of the project, and `BP_FlyingEnemy`, `BPI_Enemy` and `BP_EnemyController` never appeared
at all.

Three rules now, and deliberately no more: `-ies` to `-y`, `-(s|x|z|ch|sh)es` to the stem, and a bare
`-s` unless the word ends in `ss`. A real stemmer would turn *"sprinting"* into *"sprint"* and
*"regenerates"* into *"regener"*, and the second is worse than the word it replaced. This only has to
undo the plural a person types when they describe a feature.

The threshold moved from five letters to four, because `bars` was being left alone - and a plural
query only matches names containing "bars", so `WBP_DataBar` was missed by the very request that
asked for a bar. Four-letter words that genuinely end in `s` are rare and listed; `axis` is on the
list because Unreal has input axes.

```text
before: concepts ["enemie", ...]   keyAssets: BP_WaveSystem, BP_DummyTurret, GM_TutGameplay
after:  concepts ["enemy", ...]    keyAssets: BP_BaseEnemy, BP_EnemyController, BP_FlyingEnemy
```

### "bar already exists in this project: BP_DummyTurret"

Same method as the map, applied to the feature leg. `unreal_plan_feature`, asked the way a user
asks - *"add a stamina bar that drains when sprinting and regenerates when you stop"*:

```text
raiseWithUser:
  "bar" already exists in this project: BP_DummyTurret, BP_MomBase, BP_Turret and 9 more.
   Extend it rather than adding a second one...
```

`BP_DummyTurret` is in that list because it has a variable called **`TurretBarrelLoc`**. The bridge
searches by substring, which is right for a search box and wrong for deciding a system already
exists - and this claim lands in `raiseWithUser`, the one field whose purpose is to stop a model and
make it ask. A false one buys a pointless question, or a refusal to build something the project does
not have.

Concepts are matched as **words** now. Identifiers are camelCase or snake_case, so the boundaries are
real: `TurretBarrelLoc` is Turret / Barrel / Loc, and none of those is "bar". `WBP_DataBar`,
`UpdateHealBar` and `EnergyRadialBar` all are, and all are genuine - this project really does have
bars.

**Two false negatives found by the existing tests, both worth recording.**

The first rule was *equals the concept, or the concept plus s/es*. That drops `GetVacuumable` - which
IS part of the vacuum system - and `BPI_Damageable`, which is how half of Unreal names an interface.
The distinguishing fact is not prefix-ness: "bar" is a prefix of "barrel" exactly as "vacuum" is of
"vacuumable". It is that `-able` builds a word from another and `-rel` does not. So the rule accepts
a known derivational suffix.

The second was `BP_Thing0`. A trailing index is not part of the word, and reading "Thing0" as one
word loses `WBP_HUD2` and `BP_Player3` along with it.

Both were caught by tests written for something else entirely - the reason-collapsing test and the
prose-size test - because their fixtures happened to contain exactly the names the new rule got
wrong. That is what a fixture built from a real project buys.

And when filtering leaves nothing, the reply says which nothing it is:

> Nothing in the project has "bar" as a word. 2 name(s) contain it inside a longer one - the way
> "bar" sits inside "TurretBarrelLoc" - and none of those is this system.

"Nothing found" would have sent a caller to rename their search, when the search did hit and every
hit was a coincidence.

### Asking the tool a real question, and reading the answer properly

`unreal_map_system` is where a plain-text bug report lands. So it got asked one, against the real
project - *"the countdown never shows up"* - and the answer was read rather than skimmed:

```text
- GS_Gameplay: 3 matching function(s): ShowCountdown, UpdateCountdown, HideCountdown
- WBP_HUD: 3 matching function(s): ShowCountdown, UpdateCountdown, HideCountdown
- 14: used by GM_Gameplay
- 5: used by GM_Gameplay
Read in this order: GM_Gameplay -> GS_Gameplay -> 14 -> 5 -> BP_BaseEnemy -> BP_Player -> ...
```

**Third and fourth in the recommended reading order are assets called "14" and "5".** They are real -
`/Game/ThirdParty/XP/14` and `/5`, both `Texture2D`, in the map only because `GM_Gameplay` happens to
reference them. A model following that order opens a texture before it opens `BP_Player`.

A system map answers *"what makes this work, and what would I break"*. A texture, sound, mesh or font
has no behaviour, so reading one cannot answer either question - and the reading order is capped, so
every slot it takes displaces something that could.

Dropped, but only when pulled in **as a dependency**. An asset that matched the query on its own
account stays whatever its class, because *"the explosion sound"* and *"the health bar material"* are
real questions.

```text
before: GM_Gameplay -> GS_Gameplay -> 14 -> 5 -> BP_BaseEnemy -> BP_Player -> ...
after:  GM_Gameplay -> GS_Gameplay -> BP_BaseEnemy -> BP_Player -> BP_WaveSystem -> ...
```

The reply got slightly *larger* - 664 to 701 tokens - because the freed slots filled with Blueprints.
Same budget, all of it useful.

**The first test for this passed while testing nothing.** It tried to inject a fixture through a
parameter the fake bridge does not read, so the texture was never in the map to be dropped - the
exact vacuous-test shape this project went hunting for with mutation testing earlier. Rewritten
against the injection point that works, and then mutated: removing the rule fails it.

### The one line in the standing text that pays for itself on a single call

Every expensive read now says how to ask for less - but it says it *after* the reply has been paid
for. That is free and one read too late. The instructions, which are billed on every request, never
mentioned narrowing at all.

Almost everything in this project argues against adding to the standing text: the group bullets came
out at 306 tokens, the `fields` hint stayed out of a description at 25. Both were break-even inside a
normal session. This one is not close:

```text
costs   38 tokens x every request
saves   4,393 tokens the first time it prevents an unfiltered read_class_defaults
```

So two lines went in, with the numbers, because generic advice about being efficient is the kind
models nod at and ignore:

> Every large read takes a filter (match, fields, replicatedOnly, direction, limit). Use it:
> the difference is 4,685 tokens against 292, not a trim.

The `minimal` profile gets its own version, and it matters more there than anywhere. That profile
exists for a 14B at 8k context, where an unfiltered `list_blueprints` is **2,669 tokens - a third of
the entire window.** It is tuned to the tools that profile actually registers: no `direction`, no
`replicatedOnly`, because neither tool is there and advice naming a tool you do not have is the thing
three commits ago went to some trouble to remove.

```text
minimal   3,972 -> 4,015 standing    (ceiling 5,000)
core     12,635 -> 12,673            (ceiling 13,000)
search    2,219 ->  2,257            (ceiling 2,500)
```

### The most expensive read of all, where row count says nothing about cost

`list_data_table_rows` is the largest read in the surface and the last one with no guidance in its
reply. It also breaks the rule every other hint uses.

Every other expensive read costs in proportion to how many rows came back, so `ADVISE_WHEN_ROWS_AT_LEAST`
is the right gate. **`DT_UniversalActions` is nine rows and 6,985 tokens** - because one untouched
`FSlateBrush` column exports as 900 characters of `ImageSize`, `Margin` and `OutlineSettings`. A
row-count gate stays silent on exactly the table that needed the advice.

So that one is keyed on the size of the reply, and the lever it names is the one that works today:

```text
DT_UniversalActions              7,040 tok
DT_UniversalActions, limit: 1      945 tok      (-87%)
```

One row shows every column and its shape, which is what *"what is in this table"* usually means. The
hint also points at `unreal_list_struct_fields` on the row struct, which lists the columns with no
row data at all.

The guard now checks both keying rules and asserts at least one hint is size-keyed - because the
instinct is to reach for the row count everywhere, and on this tool that would produce a check that
passes while helping nobody.

### Two places that look like the find_references bug and are not

The spread that bit `find_references` has a benign twin, and it appears twice - `read_class_defaults`
and `list_struct_fields` both do `{...result, ...(compacted ? { key: compacted } : {})}`. Those are
correct: the condition means *"was there anything to compact"*, and when there was not, the raw value
from the spread is exactly the right answer.

The harmful version is a condition meaning *"should the caller see this"*, where falling through
leaves the uncompacted original in place. Both sites now say which they are, so the shape is not
mistaken for the bug - or copied as if it were the fix.

### find_references answered two questions when you asked one

`find_references` returned both directions at once - what references this asset, and what this asset
depends on - and the question is almost always one of them. *"What breaks if I change this"* is
`referencedBy`. *"What does this need"* is `dependsOn`. There was no way to ask for either.

```text
both          2,859 tok
referencedBy  1,086 tok
dependsOn     1,751 tok
```

The counts always survive, whichever half is dropped. *"49 things reference this, here are none of
them"* is a worse answer than either list, and a caller who asked for one direction still needs to
know the other exists before concluding an asset is unused.

**Measuring it caught a bug the code did not show.** The first version spread `...result` and then
conditionally re-added the compacted lists - so skipping one did not remove it, because the raw
uncompacted list from the bridge was already there from the spread. Asking for **one** direction
returned **more** than asking for both:

```text
both          2,859 tok
referencedBy  3,751 tok      <- wrong, and it reads as correct code
```

Not re-adding a field is not the same as removing it. That is now a test, alongside the compaction
helpers, because it is a mistake that produces a *larger* reply while looking like a saving - which
no amount of reading the diff would have surfaced.

### Three of the biggest reads had a cheap form nothing mentioned

Having found this on `list_blueprints`, the obvious question was how many other expensive reads have
a filter their reply never names. Measured on a real Blueprint:

```text
list_variables       2,397 whole     599 replicatedOnly     172 with a match
read_class_defaults  4,685 whole                            292 with a match
list_blueprints      2,669 whole   1,932 fields:["path"]
```

**`read_class_defaults` is the sharp one.** A model asking *"does this replicate movement"* was paying
**4,685 tokens** for 167 properties when `match` answers it for **292** - 94% less - and nothing in
the reply said so. `list_variables` is the same story: *"what can a client see"* costs 599 with
`replicatedOnly` against 2,397 for the whole list, and a model that did not know had to read all 86
variables to find the 15 replicated ones.

All three now say it, and only when it is worth saying. The threshold is one shared constant rather
than three literals, because it is one idea - below thirty rows the sentence costs more than it can
save, and a two-variable Blueprint should pay nothing for advice about filtering.

```text
list_variables  {path}                  2,449 tok   hint: yes
list_variables  {path, replicatedOnly}    599 tok   hint: no
read_class_defaults {path}              4,728 tok   hint: yes
read_class_defaults {path, match}         290 tok   hint: no
```

The description was the wrong place for all three, for the reason worked out on `list_blueprints`:
~25 tokens on **every request** against a saving on **some calls** is break-even inside a normal
session. The reply is free - it appears exactly when a model is looking at the cost it just paid.

One note on the test. The first version asserted that each hint site matched `.length >= <number>` in
the source, which is checking spelling rather than behaviour - one site expressed the same rule
differently and the test failed for a reason unrelated to the property it cares about. Unifying the
threshold into `ADVISE_WHEN_ROWS_AT_LEAST` made the rule real enough to check, which is a better
outcome than a cleverer regex.

### The largest read is at its floor, and the cheap form was never advertised

`list_blueprints` is the most expensive read left - 3,293 tokens - so it got measured properly. Of a
full 345-row reply, **21% is two key names repeated 345 times**. Two shapes beat it:

```text
current array of {path, parentClass}   8,494 tok
map  path -> parentClass               6,511 tok   (-23%)
grouped by parentClass                 5,650 tok   (-33%)
```

**Neither was taken, and the reasons are worth recording** so the next session does not redo this
analysis. `fields: ["path"]` operates on rows, so a map breaks a documented parameter. `measure:reads`
navigates `blueprints[].path` to find the biggest Blueprint in the project - and that is precisely
the "navigation contract" that got the same change reverted for `list_blueprint_graphs` earlier. The
grouped form additionally duplicates the parent-class census `get_project_overview` already gives.

So this read is at its floor, given that a path has to arrive whole and rows have to stay rows.

Except the saving already existed, per call, and nothing said so:

```text
100 rows, default          2,669 tok
100 rows, fields:["path"]  1,932 tok   (-28%)
```

`fields` has been there all along with a good parameter description, and the tool's own description -
the part a model reads when deciding how to call it - never mentioned the lever.

Putting it in the description was considered and the arithmetic says no: about 25 tokens on **every
request** against ~700 saved **per call** is break-even near fifty requests, which is inside a normal
session. The same sum that removed the group bullets from `enable_tools`, and it lands differently
here only because the numbers differ.

So the reply says it, and only when the reply was big enough for the advice to be worth anything -
the same "pay only when it applies" shape as `checksSkipped` and `toolsNotEnabled`:

```json
{"cheaper": "Only need the paths? `fields: [\"path\"]` returns the same rows without parentClass,
             about 27% smaller on a list this size."}
```

Absent under 40 rows, absent when `fields` was already given. Both return paths carry it - the
untruncated branch matters more, because that is the one a caller reaches by raising `maxResults`,
where the reply is the biggest the tool ever sends and nothing was truncated to warn them.

### The recipes taught an input system the reader's project does not use

`unreal_recipes` is described to every model as *"verified end-to-end builds of the systems people
usually ask for"*. The interaction recipe - look at a thing, press a key, it responds - said:

```text
3. unreal_add_input_mapping - kind action, name Interact, key E
```

That is the **legacy** project-settings input system. Every UE5 project uses Enhanced Input, keeping
its bindings in `InputMappingContext` and `InputAction` assets, and following that step there binds a
key nothing ever reads. The symptom is silence: no error, no warning, a graph that compiles and an
`E` that does nothing.

The handbook had the same line in its list of entry points - *"Input events, from a mapping added
with `unreal_add_input_mapping`"* - which is the one document a model is told to read before its
first write.

Both now name the two systems and say which is which, including the part that is genuinely
unguessable and cost a session to learn here: **`unreal_list_input_mappings` returning an empty list
does not mean the project has no input.** It almost always means the project is on Enhanced Input
and you are reading the wrong place. The event node differs too - `Enhanced Input Action IA_Interact`
rather than `InputAction Interact` - which is exactly the kind of exact string a model cannot derive.

A guard holds it: a guide that mentions `unreal_add_input_mapping` must also mention Enhanced Input.
Confirmed by breaking the string and watching it fail. It is a weak check by design - it cannot tell
whether the prose is *correct* - but it makes "teaches only the legacy system" a failing test rather
than something noticed a year later.

### The guide the instructions call "the long form" stopped before the last step

The instructions every session starts with give an eight-step order and then say *"unreal_workflow is
the long form of the order above"*. Holding one against the other:

```text
NOT in AGENT_WORKFLOW.md: unreal_list_blueprints, unreal_find_source,
                          unreal_describe_class, unreal_verify_feature
```

`verify_feature` is the one that matters. The instructions call it step 8 - *"before you report
anything as done"* - and the long-form document's golden path ran fifteen steps and **ended at
Save**. A model that pulled the long form got an order that stops before the step whose entire job is
to catch work reported finished when it is not.

The other three were real too. `find_source` is half of instruction step 2 - *"not everything is a
Blueprint"* - and the C++ path (locate, `compile_cpp`, `hot_reload_cpp`) appeared nowhere in the
document that claims to be the full order.

The handbook had the same shape of gap from the other side. The instructions tell a model to *"pull
in the handbook before your first write"* and separately list the strings it cannot derive - and one
of them was missing from the handbook entirely:

> **Spawn Actor and Create Widget cannot be built by this server, and nothing else will tell you.**

That fact was learned expensively - the node was built, it crashed the editor four times, and the
whole feature was reverted - written into the instructions, and never into the document a model is
told to read.

Three guards now hold the two together: every tool the instruction steps name must appear in the
workflow guide, every unguessable string must appear in the handbook, and no guide may name a tool
this server does not register. The third direction is the one that goes stale silently; it is clean
today.

The first version of that test failed for its own reason, which is worth recording: it searched the
source for a marker containing a newline, and this repo checks out CRLF, so the extraction returned
an empty block and the test failed with nothing to do with the guides. Line endings are normalised
now - and once it actually ran, it found a fifth gap nobody had spotted by eye: `unreal_save_asset`,
which the instructions name for everything that is not a Blueprint, and which the workflow guide's
save step never mentioned.

### The same gap in five places, answered once

Last commit fixed this for the audit. The obvious question was how many other tools give advice
naming something the caller cannot call. For every preset, for every advice-giving tool the preset
**actually carries**:

```text
diagnose / audit_project    call_parent_function, set_data_table_row
diagnose / verify_feature   set_data_table_row
diagnose / find_orphans     open_level
feature  / verify_feature   set_data_table_row
feature  / plan_feature     trace_function_calls
```

`plan_feature` is the one that stings. It was taught to say *"check the system still runs with
`unreal_trace_function_calls` before extending it"* - the single most useful sentence it has, added
because extending a system nothing calls produces a feature that cannot work - and the preset it
lives in does not switch that tool on.

**The first version of that scan was wrong**, and in a way worth recording. It compared every module
against every preset, including presets that do not contain the module's own tool, and produced a
list twice as long - `diagnose / check_data_tables` among them, when `check_data_tables` is not in
`diagnose` at all. Advice from a tool you cannot call is not a gap; it is nothing. The claims in the
source comment were rewritten to the corrected scan.

One helper now covers all five, applied at the seven advice-giving call sites:

```json
{"verdict": "nothing-to-compare",
 "toolsNotEnabled": ["unreal_open_level"],
 "toolsNotEnabledNote": "1 tool(s) named above are switched off in this session: unreal_open_level.
   unreal_enable_tools({ tools: [\"unreal_open_level\"] }) turns on exactly those..."}
```

That is a real `find_orphans` reply on a real `diagnose` session, not a fixture.

**Only the advice fields are scanned**, and that restraint is the design. Scanning whole replies would
be simpler and wrong: `unreal_list_tools` names dozens of deliberately disabled tools - that is its
job - and a note listing all of them would be noise attached to the one reply whose entire purpose is
to describe what is off. So the fields are named: `next`, `fix`, `blockers`, `remedy`, `steps`, and
anything nested under them.

A name this server does not have returns `undefined` rather than `false`, and is not reported.
Telling someone that a tool which does not exist is "switched off" sends them to enable something
they can never get.

The audit-specific version from the previous commit was deleted rather than left beside this one. A
second implementation of the same idea is precisely the drift these commits keep finding.

### The audit was telling you to use tools it had not switched on

Extracting every `unreal_*` mentioned in a finding's `fix` and holding it against the `diagnose`
preset - whose stated job is *"find and fix a reported bug"*:

```text
NOT in diagnose: unreal_call_parent_function, unreal_remove_node,
                 unreal_set_data_table_row, unreal_auto_layout_graph, ...
```

`call_parent_function` is the sharp one. `parent-event-not-called` costs 95, second only to the
multiplayer checks, and its remedy is a single call a model on this preset could not make. Same for
`set_data_table_row`: `check_data_tables` is in the preset, finds a row pointing at nothing, and
names a repair tool that is off.

The obvious fix is to put them in the preset. **Measured, that is the wrong answer:**

```text
diagnose with three added:   10,257 -> 11,127     (+870, on every request)
enable_tools({tools:[...]}):    ~150 tokens, once, only when a finding names one
```

The same arithmetic that removed the group bullets from `enable_tools`, reaching the same verdict
from the other direction. So it is said where the server actually knows what is enabled - only about
tools that are genuinely off, and only when a finding actually named one:

```json
{"fixToolsNotEnabled": ["unreal_call_parent_function"],
 "fixToolsNote": "1 tool(s) named in the fixes above are switched off in this session..."}
```

A complete answer pays nothing for it.

The list is read **out of the fix text**, not declared beside each check. A declared list is a second
place to update, and a second place not being updated is exactly how this was found - the same reason
the group list is now derived in three places instead of written in four.

Two bugs while writing it, both the kind this project keeps naming. The note was attached in one
branch of a ternary and dropped in the other, so an audit with nothing elided silently lost it. And
the first version scanned `examples[].fix`, a field that does not exist on that type - it would have
found nothing, quietly, forever. TypeScript caught the second; only re-reading caught the first.

### "Find every bug" now includes the cutscenes

Reading a Level Sequence was only half of it. `unreal_audit_project` swept Blueprints, Animation
Blueprints, Niagara and Data Tables - and stopped at the door of the cinematics, which is the same
gap that was closed for each of those in turn. A sweep that skips a whole asset family answers a
narrower question than the one it was asked.

Three checks, and they share the property that makes them worth having: **none is an error, none is a
warning, and the sequence plays perfectly while doing less than it appears to.**

```text
sequence-track-muted          40   has keys and does not evaluate
sequence-track-no-sections    35   in the outliner with an empty timeline
sequence-binding-no-tracks    25   the actor is bound and nothing animates it
```

The prices are argued next to the numbers rather than assigned by feel, which is the lesson from
`unhandled-cast-failure` sitting at 90 while firing on ordinary idiom. Muting is *how you audition a
change* and the state most often left behind afterwards - a real defect, but also a legitimate
working state, so it sits with `empty-event` rather than above it. A binding with no tracks is the
residue of deleting tracks: harmless to run, misleading to read, which is where
`debug-print-left-in` sits.

Two things the tests pin down. A track that is both muted **and** empty is reported by both checks,
because they are separate facts and fixing one does not fix the other - un-muting an empty track
still evaluates nothing. And the sequence's **own** tracks are swept, not just the ones under an
actor: a camera cut track with no sections is the usual reason a cutscene plays from the wrong angle,
and it belongs to the sequence rather than to any binding, so a check that only walked bindings would
miss the most consequential case.

Run against the live editor, which has a plugin older than this server, the audit says so rather than
returning a clean cinematics result:

```json
{"checksSkipped": [{"name": "cinematics",
   "why": "unknown_cmd: read_level_sequence - the plugin in this editor is older than this server."}]}
```

That machinery was built two commits ago for exactly this, and this is the first time it has caught a
check that was added after it.

### Failing in one second instead of five minutes

`npm run build:engines` is the one command a user has to run by hand to pick up new bridge commands -
the C++ half arrives no other way. It had no idea whether an editor was open.

A running editor holds `UnrealMCPBridge.dll`, so building with one open compiles every file
successfully and then fails at the **link** step:

```text
LINK : fatal error LNK1104: cannot open file 'UnrealEditor-UnrealMCPBridge.dll'
```

Several minutes in, and it is a message about a file that says nothing about editors. The one obvious
way to get this command wrong should cost a second, not a coffee:

```text
Refusing to build: the editor has "AntiVirusSquad" open (its bridge answered).

A running editor holds UnrealMCPBridge.dll open, so this would compile for several minutes
and then fail at the link step with LNK1104 - a message about a file that says nothing about
editors. Close the editor and run this again.

To compile without installing anything, and without closing anything, use --isolated.
```

It asks the **bridge** first rather than the process table, because the bridge answers with *which
project* is open - "an editor is running" is a much weaker sentence than naming it. The process list
is the fallback for an editor that has not loaded the plugin yet, which holds the DLL just the same,
so a bridge that does not answer is a fallback path rather than proof of absence.

`--isolated` builds into a temporary host project and installs nothing, so it is unaffected and skips
the check. Both were run with an editor open to confirm: the default refuses in under a second, and
`--isolated` built 5.6 clean in 86 seconds.

### Checking Epic's toolset list against the project, class by class

Epic now ships an official [Claude Code skills plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin)
for their MCP, and their 5.8 plugin exposes 30+ toolsets: Control Rig, Sequencer, State Trees,
Gameplay Ability System, automation testing. The obvious reaction is to start building all of it.

The useful reaction is to ask which of them the project actually uses:

```text
LevelSequence        9        ControlRig      0
NiagaraSystem       15        StateTree       0
WidgetBlueprint    152        GameplayAbility 0
AnimBlueprint        6        DataTable      20
```

**Control Rig, State Trees and GAS are zero.** Not built, and that check cost one call. Level
Sequences are **nine**, and nothing here could read one - so "the cutscene does not play" and "the
camera does not move" had exactly one available answer: `read_asset_properties` on the asset, which
returns the raw export text of a `UMovieScene`, a wall of GUIDs with the one interesting fact buried
in it.

`unreal_read_level_sequence` is shaped around the three ways a sequence looks correct and does
nothing, because that is the class of bug this project exists to find:

```text
a binding with no tracks     the actor is in the sequence and nothing animates it
a track with no sections     it is in the outliner with no keys, so it never evaluates
a track with evaluation off  muted, which is identical to working in every static read
```

None of the three is an error. None is a warning. The sequence plays perfectly while doing less than
it appears to, and in the editor each is visible only by scrolling to it and noticing an absence.
Each is counted, and each count is absent when it is zero.

Track class names lose the noise the same way modifier names do - `MovieScene3DTransformTrack`
becomes `3DTransform`, because the field it sits in already says these are tracks.

Epic's own skill turns out to be a thin wrapper - enable two plugins, start the server, use tool
search - with no engine ground truth and no workflow discipline in it. The confirmation worth having
is architectural: their default is three meta-tools rather than registering hundreds, which is the
same conclusion the profile system reached here, arrived at independently.

### 306 tokens per request to avoid one 540-token call

The `search` profile is what a frontier session starts on, and it had drifted to **2,457 tokens
against a 2,500 ceiling** - 43 tokens of headroom, with the next tool addition guaranteed to break
it. Of its 1,425 tool tokens, `unreal_enable_tools` was 538, and **306 of those were a bullet list of
all twelve groups**.

That list is the same catalogue `unreal_list_tools` returns at runtime, with measured costs instead
of prose, for 540 tokens. So the arithmetic:

```text
keep the bullets:   306 tokens x every request of the session
call list_tools:    540 tokens, once
```

**Break-even is two requests.** A forty-request session pays 12,240 tokens to avoid one call of 540.
Tool definitions are billed on every request before your message is read, which is the whole premise
of the profile system, and this was the largest thing in the profile that premise exists to protect.

This is not the "trim descriptions" lever that was measured and rejected here long ago - that was
about cutting the *teaching* a weaker model relies on, and it buys about a tenth of the total while
making every model worse at sequencing. This removes a duplicated **catalogue**, and replaces it with
one line naming the call that returns it better. The two groups worth knowing without a lookup -
`core` is large and for authoring, `edit` is surgery you usually do not need - stayed.

```text
search   2,457 -> 2,209        headroom 43 -> 291
```

The same pass found a **fourth** hand-written copy of the group list, and the stalest yet:
`list_tools`' own `group` filter offered seven of the twelve, so a model reading it learned that
filtering by `input`, `anim`, `ai`, `vfx` or `cpp` was not possible. It is. Derived now, like the
other two, and the guard test covers it - a listing that disagrees with the behaviour sends a caller
looking elsewhere for something that was here all along.

### The doctor said "missing 2" when eight were missing

Running `unreal_doctor` against the editor this is developed on:

```text
FAIL | plugin features: The plugin is missing 2 command(s) this server uses:
       set_variable_replication, watch_runtime
```

Eight were missing. The probe list is maintained by hand, and this is the **second** time it has gone
stale - the first was the commit that added the count to its success message, after it reported an
all-clear on a plugin missing two commands. A session that added the console, Enhanced Input and live
coding added six more bridge commands and none of them reached the list.

Two things were wrong, and the second is the interesting one. The list needed the six new entries.
But the *message* also claimed a precision it never had: the success branch already said "that is a
sample, not the whole surface", while the failure branch said a flat "missing 2". **The reassuring
branch was careful and the alarming one overstated.** It now reads:

```text
At least 8 of the 11 probed commands are missing from this plugin: ...
The probe list is a sample, so there may be more - "plugin freshness" below
answers that for every command at once.
```

The durable half is a guard, in the shape that has worked twice before here. Every command in the
bridge's own `Cmd == TEXT("...")` chain must be either probed or listed as deliberately unprobed:

```text
not ok - every bridge command is either probed or deliberately not, with a reason
    these bridge commands are neither probed nor listed as deliberately unprobed,
    so a plugin missing them would be reported as healthy: brand_new_thing
```

Seventy-three existing commands are seeded into the "deliberately not" set with one shared reason -
they are covered generically by the freshness check, and the probe list exists to name *which*
feature is dark rather than to enumerate everything. The point is not the contents. It is that
adding a command from now on fails this test until somebody decides which side it belongs on.

The healthy-plugin fixture in the tests is now derived from the probe list too, rather than listing
the same commands a second time. Adding a probe used to leave the fixture behind, and the test then
failed for the fixture's reason instead of the code's.

Confirmed by adding a command to the bridge and watching it fail - the first attempt to confirm it
grepped the wrong stream and reported a pass, which is its own small lesson about verifying the
verification.

### Sweeping for silent catches, and what the sweep found

Having written a bare `catch {}` that hid a wrong parameter name for a whole debugging session, the
obvious question was how many others there are. Eleven catches in `src/` swallow without running any
code - **and every one of them has a written reason.** That discipline was already here; the new one
was the exception.

But three of them share a shape worth pulling on. Animation, Niagara and the broken-name sweep each
sit behind a bridge command an older plugin may not have, and each `catch` explained itself in a code
comment **and nowhere else**. The reply then read as a complete audit that happened to find no
animation bugs - which is the same sentence as "I could not look at animation".

That matters most exactly when it is most likely: the plugin inside a running editor is routinely
older than the server, which is what the doctor's freshness check exists to report.

```json
{"checksSkipped": [{"name": "niagara",
   "why": "unknown_cmd: read_niagara_system - the plugin in this editor is older than this server."}],
 "checksSkippedNote": "1 check(s) could not run, so this is not a complete audit: niagara.
   \"No findings\" from a check that never ran looks exactly like a clean result."}
```

The note is absent when nothing was skipped, so a complete audit pays nothing for it.

**The first attempt instrumented the wrong catch**, and running it against the live project said so:
nothing was recorded. Both sweeps read one asset at a time inside a *per-asset* try, so a missing
command never reaches the outer handler - it produces an `unreadable: unknown_cmd` row for **every
asset**, sixty-two of them, which reads as sixty-two corrupt assets rather than one command this
editor does not have. And it kept asking, sixty-two times, for an answer that could not change. A
missing command now stops the loop the first time and is recorded once:

```text
times it retried the missing command: 1     (was going to be one per asset)
unreadable rows: 0                          (was going to be 62)
```

One small thing worth recording because it is the guard working: the field is `name`, not `check`.
`check: "..."` is the pattern the `FINDING_COST` test scans for, and it demanded a price for
"animation" - correctly, since an unpriced finding name silently scores 1 and sinks. These are
skipped *checks*, not findings, so they took a different word rather than the guard being weakened.

### "Is it finished?" never asked whether anything calls it

`unreal_verify_feature` is the last call of the loop - compile every asset written this session,
review it, check the Data Table rows, read the runtime log, return one verdict. It answers *does it
compile and is it well made*.

A function can pass all of that - clean compile, score 100, laid out and commented - and be **called
by nothing at all**. Saying "pass" for that is agreeing the feature is done when it does nothing, and
it is the commonest way a finished-looking feature turns out not to work.

So the journal now records the graph a write created, not just the asset, and verification asks
`trace_function_calls` about exactly the functions this session wrote. Scoped that way deliberately:
sweeping every function on every touched Blueprint would report the 176 pre-existing dead graphs that
project already has and bury the one just written.

**The trace answers in three states, and getting that wrong is how this becomes noise:**

```text
reachable non-empty                      something calls it, on a path that runs.  Fine.
reachable empty, unreachable non-empty   only called from dead code.               Conclusive.
both empty                               no Blueprint call site at all.            Not conclusive.
```

The first draft treated "both empty" as proof, and it would have raised an alarm on **every interface
implementation in the project** - a delegate binding, an interface dispatch, an override, or a call
from C++ all look identical from there. The command names those blind spots itself; the reply now
says which of the two cases it found and how much it is worth.

Verified against real functions on the project it was built from:

```text
ShowCountdown      no Blueprint calls it at all
isChallengeWave    every call site is itself unreachable (5), so nothing runs it
```

It does not flip the verdict, and that is a limit rather than caution: failing a build on evidence
with three known blind spots teaches people to ignore the tool.

**Two mistakes in writing this, both worth recording.** The parameter is `function`, not
`functionName`, and the reply has `reachable`/`unreachable`, not `callers` - the first draft got both
wrong. It reported nothing and **looked exactly like a working check**, because the whole thing sat
inside a bare `catch {}`. That silent catch hid a wrong parameter name for an entire debugging
session, which is the same failure this project keeps finding: silence that means two different
things. A trace that cannot run now says so, in the reply, with the error in it.

### The loudest check in the audit was mostly not a bug

Ranking the real project's findings by cost times count asked an obvious question: what is the
biggest single thing this audit is saying?

```text
5670  unhandled-cast-failure      63 graphs, cost 90
1260  repnotify-does-nothing      21 graphs, cost 60
 900  cast-to-server-only-class    9 graphs, cost 100
```

**142 casts, four and a half times the next finding.** The check flagged every `DynamicCast` with an
unwired Cast Failed pin - which is ordinary, correct Blueprint. Looking at what the casts actually
were, in `BP_Player`'s event graph alone:

```text
Cast To BP_Player      object from: On Component Begin Overlap (HealProximityCollision)
Cast To BP_Player      object from: For Each Loop
Cast To BP_VirusData   object from: Break Hit Result   (after Line Trace For Objects)
Cast To ABP_NewPlayer  exec from:   nothing at all
```

The first three are the cast *being* the filter - that is how you reject the actors that are not
players, and wiring Cast Failed would be wiring "do nothing" to "do nothing". The fourth is a cast
nothing runs, reported as a silent-failure risk when it can never fail because it never happens.

Three discriminators, all from evidence already in the graph: reached from an overlap/hit/damage
event; fed by a loop, a trace or a hit result; or not reached by execution at all. **142 casts ->
111.**

And then the honest part, because the remaining 111 are the real finding. They are not filters and
they are not dead - they are just how Blueprints get written. An idiom that appears 111 times in a
shipping game is not a defect at cost 90, which is the band for "this WILL fail". So it is **40**
now, beside `empty-event`, with the argument recorded next to the number.

**One correction worth recording**, because it was written into the code before it was checked. The
first version of that argument said the check was "shouting over the findings that matter". It was
not: `unreal_audit_project` orders groups by **cost alone**, not cost times count, so 90 placed
unhandled casts fifth - behind the 100s and 95s - and buried nothing. The cost-times-count ranking
was a metric invented to find the biggest block, not the tool's behaviour. What was actually wrong is
narrower and still worth fixing: a reader working down by severity met sixty-three graphs of
mostly-fine casts immediately after "this cast fails on every client, every time".

Four tests cover it, and the last one matters most: a cast on a `BeginPlay` setup path, where failing
means the initialisation silently never happens, is **still reported**. Narrowing a check must not
turn it off.

### The same mistake, in three places, found by building one tool

`unreal_call_parent_function` had the bug it was written to fix - it asked whether a
`K2Node_CallParentFunction` **existed** rather than whether anything ran it. That prompted the
obvious question: where else does this project confuse presence with effect?

Two more, immediately.

**The finding itself had it, and worse.** `findUncalledParentEvents` scanned `childNodeTitles` -
every node in the graph, reached or not - so an orphaned `Parent: BeginPlay` suppressed the finding
entirely. And that is not a corner case, it is *the* case: creating an override event makes the
editor add the parent call for you, and the next thing to touch the event's exec pin displaces it.
**The audit stayed quiet about the bug in exactly the situation that produces it.** It scans the
chains now - what execution reaches - rather than the node list.

Two of its own tests had been passing for that same wrong reason. Both put `"Parent: BeginPlay"` in
the node-title list and in no chain, then asserted no finding. The fixtures now say what they claim,
and a third test covers the orphan case explicitly.

**`repnotify-does-nothing` had a milder version.** "Is this function empty" was answered as "is every
node unconnected", which is closer than counting nodes and still not the question - a wired pair the
function's entry never reaches does nothing at all and was read as a body. It is reachability from
the entry now, and a graph whose entry cannot be identified reports "not readable" rather than
"empty", because a wrong warning about a function that works costs more than a missed one about a
function that does not.

**What it changed on the real project: nothing.** Both checks were re-run against the 150-Blueprint
project with the old rule and the new one, by patching the built file and comparing:

```text
parent-event-not-called   old: 3 (PC_Lobby, PC_Gameplay, PC_MainMenu)   new: 3, same three
repnotify-does-nothing    old: 21                                       new: 21
```

That is the honest result and it is worth stating plainly rather than quietly shipping a "fix" with a
number attached to it. The old rule was wrong; this project does not happen to contain the graph that
proves it. The trial does - `npm run trial:parent-call` builds exactly that graph, because the editor
builds it for you if you are not careful.

### And the fix tool had the same bug it was written to fix

The trial for it - plant the defect, fix it, check the chain - failed on the first run, and what it
caught is the best illustration of the bug there is.

`unreal_call_parent_function` reported **"already calls the parent"** about a graph that read:

```text
Event BeginPlay -> Print String -> Print String        (Parent: BeginPlay, orphaned)
```

The node was there. Nothing ran it. The check asked whether a `K2Node_CallParentFunction` *existed*,
which is presence mistaken for effect - the same class of error as a verdict saying "clean" when it
could not look, and it made the tool report the bug as already fixed.

How the graph got that way is the bug itself: **creating an override event makes the editor add the
parent call for you**, and the next thing to touch the event's exec pin displaces it. The trial's own
setup did exactly that, by accident, while building a fixture. That is how sharp the edge is.

So the check is now "is the parent call reached from the event", and an orphaned node is a third
outcome with its own handling - it gets **wired rather than duplicated**, because adding a second
would leave the graph with a node nothing runs *and* a node that does. `dryRun` says "would wire the
existing" rather than "would add" in that case, since a dry run whose wording describes a different
edit than the real one is worse than no dry run at all.

```text
before : Event BeginPlay -> Print String -> Print String
applied: Event BeginPlay now runs the Parent: BeginPlay first, then Print String.
         The node was already in the graph with nothing running it.
after  : Event BeginPlay -> Parent: BeginPlay -> Print String -> Print String
rerun  : alreadyPresent, unchanged
```

`npm run trial:parent-call` is that run, against a live editor, on assets it creates and deletes.

### A file that compiled seven times and did not build

Every C++ change this session was checked with a single-file compile - `unreal_compile_cpp`'s own
default, seconds instead of minutes, and it works while the editor is open. Seven of them, all clean.

Then `npm run check:engines`, which builds the whole plugin against every installed engine:

```text
5.6: building... ok (111s)
5.8: building... FAILED (175s)
    MCPConsole.cpp(196,4): error C2065: 'FStringOutputDevice': undeclared identifier
```

`FStringOutputDevice` lives in `Containers/UnrealString.h` on 5.6 and in `Misc/StringOutputDevice.h`
on 5.8, and neither header exists on the other version - **there is no single include that satisfies
both.** Targeting 5.6 and 5.8 from one codebase is a headline claim of this project, and it had been
broken for several commits without a single compile failing.

Fixed without a version guard: `Exec` takes any `FOutputDevice`, and this plugin already has one that
collects lines under a lock and caps itself. One fewer type, and no `#if ENGINE_MINOR_VERSION`.

The lesson went into `unreal_compile_cpp`'s description, because a model using it on its own project
will draw exactly the same wrong conclusion:

> **A clean single-file compile is not a clean build.** It proves this file's syntax against the
> engine you are on; it does not prove the module links, and it does not prove a different engine
> version accepts it — types move between versions, and unity builds hide a missing include until the
> file is compiled alone. Treat it as fast feedback, not as the verdict.

That is not hypothetical either: the same run earlier caught `MCPCommandHandler.cpp` using
`FFileHelper` with no `Misc/FileHelper.h`, which unity builds had been hiding for months.

All three targets - 5.6, 5.8, and the game - build clean now.

### 167 properties, and the Blueprint changed a handful

`read_class_defaults` was the second-largest read and, like the first, unmeasured: **16,129
characters on BP_Player, 167 editable properties**. Of those, 95 values were the type's zero and 74
categories were "Default". Most of the list is `PrimaryActorTick`, `CapsuleComponent` and the whole
of `ACharacter`'s details panel, restated on every read.

"What are this Blueprint's class defaults" almost always means **"what did this Blueprint change"**,
and the engine can answer that exactly - compare each property against the parent class default
object. Same mechanism as the Data Table delta, same one that decides what a `.uasset` stores.

Two things it has to get right. A property the Blueprint declares *itself* does not exist on the
parent, so comparing at the same offset would read whatever is at that address - it is only compared
when the parent class actually descends from the class that owns the property, and otherwise always
included, which is correct anyway. And the omitted ones are **counted and named in the reply**:
"12 properties" and "12 of 167, the rest inherited unchanged from ACharacter" are different answers,
and a reader who cannot tell them apart will conclude the Blueprint has twelve properties.

`match` overrides the whole thing. Asking about a property by name answers whether or not it was
overridden, because a search that silently returns nothing for an inherited property is worse than
one that returns the inherited value.

### Raising a ceiling, with the argument written down

Adding the three Enhanced Input tools pushed the `full` profile to 36,038 against its 36,000 ceiling,
and the guard refused it:

```text
full is ~36038 tokens standing, over its 36000 ceiling.
  Either trim a description, move a tool to a group this profile does not include,
  or argue for a higher ceiling here - but do not raise it silently.
```

The raise was not the first move. The `read_class_defaults` description was tightened by 66 tokens -
not enough on its own - and `unreal_build_graph`, the largest definition at 3,530 characters, was
read and left alone. Trimming descriptions was measured and rejected as a lever for this project long
ago: they are the teaching a model relies on, and the per-tool average is **339 against a 420
ceiling**, so there is no bloat to reclaim.

So the ceiling moved to 37,000, with the reasoning in the file beside the previous two raises. The
surface grew because the tool can do more, which is the only reason that number is ever allowed to
move - and `full` is the opt-in profile whose whole premise is "everything, for a model that can
afford it". The defaults people actually run are unchanged: `search` at 2,424 and `core` at 12,839.

### The largest read in the surface, and nobody was watching it

Continuing the read/write audit into Data Tables found something bigger than a mismatch. Measured:

```text
list_data_table_rows        6985 tokens
list_blueprints             3293
read_blueprint_summary      3110    <- an 809-node graph
```

**More than double the next largest read, from nine rows**, and it was not in `measure:reads` at all
— the third time that gap has produced the most expensive thing in the surface. It is measured now,
against the biggest Data Table in the project, discovered the same way the worst graph is.

The cause is that Unreal exports a row in full. One untouched `FSlateBrush` column, per row:

```text
(Key=None,OverrrideState=Enabled,bActionRequiresHold=False,HoldTime=0.500000,
 HoldRollbackTime=0.000000,OverrideBrush=(TintColor=(SpecifiedColor=(R=1.000000,G=1.000000,
 B=1.000000,A=1.000000),ColorUseRule=UseColor_Specified),DrawAs=NoDrawType,Tiling=NoTile,
 Mirroring=NoMirror,ImageType=NoImage,ImageSize=(X=32.000000,Y=32.000000),Margin=(...),...)
```

The facts in that are *no keyboard key* and *hold for half a second*. Everything else is a brush
nobody touched, spelled out in full, nine times.

A first attempt trimmed zero-valued members out of the literal with a string parser: 42%, and stuck,
because `ColorUseRule=UseColor_Specified` and `DrawAs=NoDrawType` are defaults that are not zeros and
no string parser can know it. **Unreal already knows how to say only what differs** — it is how a
`.uasset` stores anything — and the mechanism is a `Defaults` pointer on `ExportText`. So a default
row is constructed once, each property compared against it, identical ones skipped entirely, and the
rest exported as a delta that prunes untouched members out of nested structs too.

**It is a parameter, not the behaviour, and that distinction matters more than the saving.**
`check_data_tables` exists to find asset references that are *empty* — and an empty reference is
identical to the default, so under a delta it disappears and the finding disappears with it. The read
tool asks for the short form; the audit asks for the full one. A test asserts the audit never starts
asking for the delta by accident, because that regression would be silent and total: the audit would
keep passing, and simply stop finding anything.

The convention is stated on the tool, as it is for variables: *a field that is absent is at the row
struct's default*, with `full: true` when you need to see an empty field rather than infer it, and
`unreal_list_struct_fields` on the row struct to see the columns themselves.

One process note. The Data Table discovery silently found nothing on the first run and the read just
did not appear in the results — which reads exactly like "this project has no Data Tables". The
`catch` says why now. A measurement that quietly measures nothing is worse than one that fails.

### One list, written down three times

Adding the `input` group broke two tests and a budget, and each failure pointed at the same thing:
**the list of groups existed in three places.** `TOOL_GROUPS`, the hardcoded `z.enum` on
`enable_tools`, and a third copy in `measure-groups.mjs`. Adding a group updated one of them.

The result was a listing that disagreed with behaviour, in both directions at once. `list_tools`
advertised a group `enable_tools` then rejected as an invalid value — a model reads that the group
exists, asks for it, and is told no. And `measure-groups` never measured it, so the census reported
its price as `~? tok` to a model deciding what to switch on.

Two of the three are derived now: the enum is `["core", ...Object.keys(TOOL_GROUPS)]`, and the
measurement script asks the server's own census instead of carrying a list. The third is prose — the
tool description enumerates the groups by hand — so a test covers it: every group the census reports
must be one `enable_tools` accepts, mentions by name, and has a measured price for.

While fixing that, the reply-budget guard failed honestly and usefully:

```text
list_tools (no filter) is ~716 tokens, over its 700 ceiling.
  That ceiling exists because: the first call of every session on `search`;
  it must cost less than the profile it protects.
  Trim what the reply repeats, or argue for a higher ceiling here - but do not
  raise it silently.
```

So it was trimmed rather than raised. The census sent rows of
`{group, count, costTokens, what}` — four keys spelled once per group, **146 tokens of a 716-token
reply**, on the one call whose entire job is to cost less than the profile it protects. It is a map
from group name to one line now, and the price stays in the line, because choosing a group without it
is choosing blind:

```json
{"input": "4 tools, ~998 tok - key bindings: Enhanced Input contexts - read what is bound, ..."}
```

```text
list_tools (no filter)  716 -> 540
```

Two group costs had also drifted silently while this was going on — `cpp` recorded 316 against 679
measured, `scene` 6,387 against 6,863 — because `hot_reload_cpp` and `run_console_command` were added
without re-measuring. `npm run measure:groups` catches that by comparing rather than trusting, which
is why it was caught at all.

### The input system the project actually uses

The read/write audit reached input and found something worse than a mismatch. `list_input_mappings`
returned this against a real project:

```json
{"actionMappings":[],"axisMappings":[],"actionCount":0,"axisCount":0,
 "note":"These are the legacy (project settings) input mappings. A project using Enhanced Input
         keeps its bindings in InputMappingContext and InputAction assets instead..."}
```

Honest, and a dead end. The note is correct — that project has **three InputMappingContexts and a
dozen InputActions** — and it then points at `list_assets`, which finds the files and says nothing
about what is in them. Enhanced Input is what every UE5 project made in the last few years uses, so
"what is W bound to" had one available answer: `read_asset_properties` on the context, which hands
back the raw export string of the `Mappings` array. Per binding:

```text
(Modifiers=("/Script/EnhancedInput.InputModifierSwizzleAxis'/Game/.../IMC_Default.IMC_Default
:InputModifierSwizzleAxis_1'","/Script/EnhancedInput.InputModifierNegate'/Game/...'"),
Action="/Script/EnhancedInput.InputAction'/Game/.../IA_Move.IA_Move'",Key=S)
```

Every modifier carries a full object path to an instance whose only interesting fact is its class.
The question was "which key moves the player backwards"; the answer was several thousand tokens of
package paths with the word `Negate` buried in them.

Three commands answer it directly and close the loop — read what is bound, bind a key, unbind one:

```text
unreal_read_input_context({ path: "IMC_Default" })
-> { "context": "IMC_Default",
     "actions": { "IA_Move": ["W", "S (Negate)", "A (SwizzleAxis, Negate)", "D (SwizzleAxis)"],
                  "IA_Jump": ["SpaceBar"] },
     "mappingCount": 14 }
```

Grouped by action because that is the question, and the modifier prefix is dropped — the field it
sits in already says whether it is a modifier or a trigger, so `InputModifierNegate` is just
`Negate`, and the short form the read prints is the form the write accepts.

Three refusals are the part worth having. **A misspelled key is silent in every direction**: `FKey`
takes any `FName` without complaint, so a binding to `"Qq"` compiles, saves, appears in the editor,
and never fires — `EKeys` knows every real key, so it is asked. **A duplicate mapping fires twice**,
which reads as an action triggering for no reason, so an existing binding reports `changed: false`
instead of being added again. And unbinding a key that was not bound reports `changed: false` too,
because the engine's own `UnmapKey` does nothing and says nothing for a mapping that is not there —
a misspelling would otherwise look like a successful unbinding.

Mappings whose `Action` is null — an InputAction asset that was deleted out from under the context —
are counted and warned about rather than skipped. They do nothing, and they are easy to miss in the
editor unless you happen to scroll to them.

They live in their own `input` group, for the same reason animation and AI do: a project still on
legacy input has three tools here that answer nothing.

### Auditing every read against its matching write

The variable mismatch raised an obvious question: **how many other pairs in this surface disagree?**
So each read was checked against the write it feeds - can the value one returns be passed to the
other? Three answers came back, and two were no.

**`list_struct_fields` was going out completely raw** and had all three problems at once:

```json
{"name":"Category","type":"byte","subType":"E_UpgradeCategory","isArray":false,"defaultValue":"NewEnumerator0"}
```

`unreal_add_struct_field` takes `"enum:E_UpgradeCategory"`. Nothing in that row is the string it
wants. Compacted the same way variables are - **888 -> 508 characters, a 43% cut** - and the types are
now the ones the write accepts.

**The descriptor list itself was wrong**, and the check caught it before it shipped. The first draft
lowercased `softobject`, `softclass` and `interface` into descriptor heads too - which would have
printed `softobject:Foo`, a string this same tool refuses when handed back. Exactly the mismatch
being removed, recreated in the other direction. Reading `MCPCommandHandler.cpp` rather than assuming
gave the parser's real list: `object:`, `class:`, `struct:`, `enum:`, and nothing else takes a
subtype. Anything outside it keeps `type` and `subType` side by side, because an honest pair beats a
descriptor-shaped string that does not work.

And a Blueprint enum reads back as `byte` with the `UEnum` as its subtype - the bridge says so where
it parses `enum:` - so `byte:E_Rarity` was being printed for a type no call would take. It is
`enum:E_Rarity` now.

### A Set that reported itself as a scalar

The same audit found a fidelity bug in the bridge, in C++:

```cpp
Entry->SetBoolField(TEXT("isArray"), PinType.ContainerType == EPinContainerType::Array);
```

A boolean over a three-valued fact. **A Set and a Map both reported `false`**, so a variable declared
`name<set>` read back as a plain `name` - and this bridge can *create* sets, so the write side could
produce a type the read side had no way to describe. Silence meaning two different things, in the one
field that decides how a value is used.

It sends `container: "array" | "set" | "map"` now, absent for a single value, and the tool layer maps
`[]` and `<set>` into the descriptor - both suffixes the bridge's own parser strips, so both
round-trip. A map has no descriptor form, so `container: "map"` stays on the row rather than being
invented or dropped. The tool layer still reads the old `isArray` as well, because the plugin inside
a running editor is routinely older than this server.

One thing deliberately **not** compacted: an enum default of `NewEnumerator0`. It is tempting to read
that as "index zero, therefore the type's zero" - and reordering entries in the editor does not
renumber those internal names, so `NewEnumerator0` can sit at index 3 and be a deliberate choice.
Plausible, and wrong.

Compiling the bridge change surfaced an unrelated defect it had been hiding: `MCPCommandHandler.cpp`
used `FFileHelper` without including `Misc/FileHelper.h`, and built only because unity builds hand a
file its neighbours' includes. `unreal_compile_cpp` compiles one file alone by default, which is how
it showed up. The file has to build on its own.

### A read and a write that disagreed about type names

`list_variables` was the next most expensive read, and looking at it for tokens found something else
first. Reading a variable answered:

```json
{"type":"Object","subType":"SkeletalMesh","isArray":true}
```

and **creating that same variable takes `"object:SkeletalMesh[]"`** - the compact descriptor
documented on `unreal_add_variable` and `unreal_create_function`. Two languages for one idea, inside
one tool surface, with the model expected to translate between them. Every round trip - read a
variable, recreate it on another Blueprint - was a chance to get the translation wrong, and nothing
would have caught it except the create failing.

So the read answers in the language the write accepts. 56 characters become 23, and a value copied
out of one call can be pasted into the next.

That exposed a second half of the same mismatch: `match` was searching the raw fields, so a caller
pasting back `"object:SkeletalMesh"` - a string this tool had just printed - matched nothing and got
an empty list, as though the variable did not exist. The descriptor is in the haystack now. **A
string the tool prints is a string the tool accepts.**

The token work, in the same pass. Measured on a real 86-variable Blueprint, **53 of the defaults were
zeros** - `()` on every delegate, `None` on every object reference, `0` and `False` on the rest -
about 1,060 characters repeating what `mcdelegate` and `object:WB_Pause_C` had already said. The 33
that survive are the ones somebody chose: 100.0 health, 1500.0 push speed. Float padding goes too,
since the engine writes `100.000000` and a reader wants `100`.

```text
list_variables  2,986 -> 2,397
```

This **reverses an earlier decision in this repo**, and the test that encoded it said "a default of 0
is data, not an absent field". That was right about the danger and wrong about the remedy. The danger
is a reader unable to tell "no default" from "not reported"; the remedy is to state the contract
rather than keep paying for it, which is what the tool description now does: *no `defaultValue` means
the type's zero.* The protection that test was really providing is kept as its own test - the zero
list is a decision per value, not a falsy check, so `"0.0.0"`, `"none"` and `"(0)"` all survive.

### The same gap again, on the two reads the feature trial was paying most for

`npm run trial:feature` walks the whole authoring path - Blueprints, data, C++, components, UI - and
reports what each step costs. Reading it rather than just watching it pass:

```text
the C++ surface
  map the C++ modules                  710 tok
  locate a symbol in C++               683 tok
...
33 calls, ~3900 tokens
```

**Two calls out of thirty-three were 36% of the total**, and neither was in `measure:reads` - the same
gap that let `find_references` sit at 3,736 tokens unnoticed. A guard covering nine of eleven
expensive reads is watching the wrong thing on the other two. Both are measured now, which is again
the half that keeps paying.

The module list arrived as `{module, dir, kind}` and all three fields were paying badly:

```json
{"module":"AdvancedSessions",
 "dir":"M:\Unreal Projects\Anti-VirusSquad\Plugins\AdvancedSessions\Source\AdvancedSessions",
 "kind":"plugin"}
```

`kind` is derivable - a directory under `Plugins/` belongs to a plugin, which is the rule that
assigned it in the first place. The three field names are spelled once per module. And `dir` carries
the absolute project path on every row, **escaped**, so the same forty characters arrive fourteen
times. A map from module name to relative directory fixes all three at once and is the natural shape
anyway, since the question is "where does module X live". Separators become forward slashes, which
Unreal accepts everywhere and JSON does not have to escape - a straight halving of what a separator
costs.

For symbol lookups the numbers were measured before anything was changed: repeated object keys were
16-22% of the reply and repeated file paths another 18-40%. Between a third and three fifths of a
symbol lookup was the reply describing its own shape, and the worst case - a symbol declared and used
in one file - is also the most common one. So matches group under the file, which is how every code
search worth using presents them, and matches what the caller does next: it opens a file.

```text
find_source (modules)   710 -> 366
find_source (symbol)    683 -> 446
trial:feature          3900 -> 3319
```

`kind` is kept on every hit and deliberately not defaulted away - it is the difference between "this
is where the class is declared" and "this file also mentions it", which is the entire ranking the
search exists to produce. `"<file>" + ":" + <line>` is still quotable, which is the form editors and
terminals make clickable.

One thing the change broke and the trial caught: its own check was `(j.matches || []).length === 0`,
and `.length` on a map is `undefined`, which compares false against 0. The check would have passed by
accident rather than by being right.

### The most expensive read was the one nobody was measuring

`find_references` was **3,736 tokens** on a real Blueprint - larger than `list_blueprints`, larger
than anything else - and it was not in `measure:reads`. A guard that watches seven of eight expensive
reads watches the wrong thing on the eighth. It is measured now.

Its rows were `{package, assetName, assetClass}`, and two of the three fields were free:

```json
{"package":"/Game/.../PC_Gameplay","assetName":"PC_Gameplay","assetClass":"Blueprint"}
```

`assetName` is the package's last segment - the same redundancy `compactBlueprintRow` already removes
from a Blueprint listing. `assetClass` is `"Blueprint"` on nearly every row of a Blueprint's
dependency list, which is what `omitDefault` exists for. And once both are gone, a row with nothing
left but its package **is** its package: wrapping one value in an object spends the word `"package"`
116 times to say what position already says.

| | before | after |
| --- | --- | --- |
| `unreal_find_references` | 3,736 | **2,361** |

The array ends up mixed - plain strings for the ordinary case, objects for a row that still has
something to add - and that is worth being explicit about rather than tidy. The objects are exactly
the interesting rows: a Texture or a DataTable among the dependencies is what somebody is looking
for, and it now stands out instead of hiding in a uniform list. A name that is *not* the package's
last segment is kept, because dropping it would be a lie rather than a saving.

### A census that spelled its own column headings 79 times

`get_project_overview` returned its parent-class breakdown as an array of two-key objects:

```json
[{"parentClass":"SaveGame","count":2},{"parentClass":"Actor","count":70}, ...]
```

The names and the numbers are the whole content. `"parentClass"` and `"count"` are punctuation with
a salary, and they were sent **79 times**. As a plain map it says exactly the same thing:

```json
{"SaveGame":2,"Actor":70, ...}
```

| | before | after |
| --- | --- | --- |
| `unreal_get_project_overview` | 1,698 | **829** |

This is the same finding this repo already made about the word `"node"` appearing 1,642 times in one
graph reply, in a different place - so it is a shared `asCountMap` rather than a local fix, and the
next one is a one-line change instead of a rediscovery. A duplicate key keeps the **larger** count
rather than the last written: two rows with one name should not happen, and silently halving a census
if it ever did would be worse than the duplication being replaced.

`unreal_plan_feature` reads this breakdown too, and is untouched - it calls the bridge directly and
still gets the array, the same tool-layer split that made the node cap safe. Verified rather than
assumed: it still reports `Actor (70)`, `Interface (8)` after the change.

### A path that says the name twice, and now says it once

An Unreal object path repeats the asset name: `/Game/Folder/BP_Thing.BP_Thing`. Across a listing of
339 Blueprints that suffix is **1,466 tokens of nothing**, and `list_blueprints` is the most
expensive read left.

Dropping it was declined once, and correctly. Five commands had been verified to accept the package
form, and *five tools of eighty-eight is not evidence about the other eighty-three* - these paths get
pasted into all of them, and a path that always works is worth more than the tokens.

What changed is that the objection was **settled instead of weighed**. Auditing how the bridge turns
a path into an asset, rather than sampling tools: 23 sites use `LoadBlueprintByPath`, 8
`StaticLoadObject`, 14 `LoadObject` - all of which take either form. **Ten do not**: six
`FindObject`, three `StaticFindObject`, and one `GetAssetByObjectPath`, which keys the asset registry
by object path and would simply miss. The short form really would have broken things, in ten specific
places.

So `bridgeClient` expands a package path back to an object path on the way out, at the single
boundary every command crosses. Replies carry the short form; anything pasted back is long again
before it resolves. `list_blueprints` **3,689 to 3,293**, and "a path that always works" is no longer
the price.

Only the exact `/Path/Name.Name` shape is shortened - any other suffix is somebody's real path, and
touching it would be corruption rather than compaction. `compile_cpp` takes a *filesystem* path in a
parameter also called `path`; the expansion ignores anything with a drive letter or a backslash. The
round trip has its own test, and if it ever stops holding the saving has to go back.

### The `minimal` profile was telling weak models to call tools it does not have

The standing `instructions` text is sent to the model on every turn, and it was written once for
every profile. Measured against what each profile actually registers:

| profile | tools named in instructions | reachable |
| --- | --- | --- |
| `minimal` | 18 | **11** |

The thirteen missing ones were not incidental. They included **`unreal_doctor`**, which step 1 says
to call when anything is broken; **`unreal_build_graph`**, which step 5 is built around; and
**`unreal_verify_feature`**, which step 8 demands before reporting anything as done. A model
following the instructions in order hit a tool that does not exist on its first, fifth and eighth
step.

A tool left out of a fixed profile is never *registered*, so `unreal_enable_tools` cannot bring it
back either - and `unreal_enable_tools` was itself in `minimal`, where enabling `["core","ui"]`
returned `"Nothing new to enable"`, `alreadyOn: true`, `enabledCount: 11`. A model would reasonably
read that as "those tools are already available". They are not.

This lands on the weakest models, which are the entire reason `minimal` exists and the least able to
recover from a tool that is not there. It was also paid for: a third of the standing text described a
workflow the profile cannot perform, and `enable_tools` cost ~630 tokens - an eighth of the whole
budget - to be misleading.

`minimal` now has its own instructions naming its own ten tools, and `enable_tools` is gone from it.
The result is a profile that is both correct and cheaper:

| | before | after |
| --- | --- | --- |
| instructions | 781 | **378** |
| standing total | 4,970 | **3,972** |

**−20%, while adding a parameter and fixing the bug.** `core` had a smaller version of the same
problem - steps 4 and 7 named `unreal_list_assets` and `unreal_save_asset`, which it also cannot
reach - and those two mentions are now conditional, since they are correct for `search`, `lazy` and
`full` where the tools are registered-and-off.

`npm run check:profiles` now fails if any profile's instructions name something it cannot reach.
"Reachable" is measured rather than assumed: the check enables every group and asks what the server
can actually serve, because the profiles differ in kind - `search` and `lazy` defer, `minimal` and
`core` are fixed - and encoding that difference by hand is how it would drift again. Prompts count as
reachable too; the first draft called `unreal_handbook`, `unreal_recipes` and `unreal_workflow`
unreachable on every profile, and a guard that cries wolf gets switched off. Confirmed not vacuous by
adding a bad name and watching it fail.

### One finding kind, in full, without paying for twelve others

After an audit the natural next move is "tell me more about that one", and the only lever was
`detailedGroups`, which is **positional**: to see the thirteenth kind you asked for the first
thirteen. Measured against the real project:

| call | tokens | what you get |
| --- | --- | --- |
| plain audit | 2,350 | 4 kinds detailed, 13 counted |
| `detailedGroups: 17` | 4,352 | all 17 detailed - 12 of them unasked-for |
| `check: "repnotify-does-nothing"` | **2,137** | that one kind, 21 examples |

Naming the check is **cheaper than the plain audit**, because everything else drops to a count. A
name that matches nothing is refused and the reply lists the kinds this run actually found - the same
answer given for a wrong pin name and a wrong parameter name, and for the same reason: a check name
is not guessable, and silently returning a summary with every group elided looks identical to "your
check is real and found nothing", which is a different answer.

### The audit now says which systems may already be dead

Nothing in the audit consulted reachability. A finding in code nothing runs was ranked exactly like a
finding in the code that does - and the two most expensive mistakes made against this project were
both the same mistake: work done on a system that had been replaced and left on the canvas.

The first was a skin system, diagnosed and modified before anyone noticed a newer one had taken over.
The second the audit produced by itself: it flagged three PlayerControllers for not calling their
parent's `BeginPlay`, at its second-highest cost, and acting on that would have been wrong in all
three. What that chain sets is `MyRootLayout` - written once, read by nothing across 181 Blueprints -
and the function that would consume it has one call site, itself dead.

So the reply now carries a `possiblyReplaced` section: function graphs no Blueprint node appears to
call, by the same fixpoint the bridge uses - an event graph can fire, a function is live if a live
graph calls it, repeat. On the project this is developed against: **52 of 511 graphs**.

That figure was **176 of 1,007** for a long time, and most of the difference was the check being
wrong rather than the project changing. Three classes of graph are reached by the engine rather than
by a call node, and each was found by looking at what the list actually contained: animation graphs
(37 across three anim Blueprints), interface implementations, and - most recently - **event
dispatcher signatures**, which Unreal puts in the graph list with a function entry and nothing wired
to it. Those alone were 41% of what remained: BP_Player fell from 13 dead graphs to 3, GM_Gameplay
from 10 to 1.

**Grouped by Blueprint, not listed by graph.** Twelve graph names out of 176 was the weakest thing it
could return. `GS_Gameplay.ShowCountdown` is a name; `GS_Gameplay: 15 of 26 uncalled` is a system
that was replaced, and the ratio carries its own confidence - one stray helper in forty is
housekeeping, fifteen in twenty-six is not:

```text
GS_TutGameplay: 13 of 19    PC_TutGameplay: 12 of 27
GS_Gameplay:    15 of 26    GM_Gameplay:    10 of 28
WBP_HUD:         8 of 14    BP_FireWall:     4 of 9
```

A Blueprint needs at least eight graphs to be ranked at all. Sorting purely by proportion put
`W_ExperienceList: 3 of 4` and `W_ChangeLog_Item: 2 of 3` on top - Lyra sample widgets whose few
graphs are CommonUI overrides the framework calls and no node does. Three quarters of four graphs is
not evidence of anything.

It costs **no extra calls** - every graph was already read for the checks above - and about 240
tokens.

**It is a place to look, not a verdict, and the section says so.** It is blind to calls from C++, to
delegates bound at runtime, to interface dispatch, and to `Set Timer by Function Name`, whose target
is a string in a pin rather than a node. Two deliberate biases keep it honest: names are compared
with everything but letters and digits removed, because Unreal renders a graph called `SetInput` on a
node as "Set Input"; and an ambiguous match resolves to **live**. Reporting live code as dead would
send somebody to delete something that runs, which is far worse than missing a dead graph.

Two whole categories are excluded, and both were found by looking at what it flagged rather than by
reasoning about it.

**Interface Blueprints, and their implementations.** An interface's own graphs are declarations, and
an implementation in some other Blueprint is invoked by dispatch rather than called by name - so
every implementation of every interface looked abandoned. `EnemyScalePriority` was flagged in five
gameplay Blueprints at once and is interface-declared in all five. Both are now left alone.

**Animation Blueprints.** Their graphs are *evaluated* by the animation system, not called: `AnimGraph`
itself, one graph per state, one per transition rule. `ABP_NewPlayer` alone contributed 25 - `Locomotion`,
`Idle`, `Jump`, and eighteen graphs all named `Transition` - and every one was wrong. Across three anim
blueprints it was 37 of 219. They are detected by the presence of an `AnimGraph`, not by parent class,
because the parent is usually a project's own C++ anim instance.

Checked against the bridge's own reachability, which is exact where this is heuristic. Every graph
this pass flagged, the bridge also reports as having no live call site - and it correctly left alone
three that do (`GetNextTicket`, `BurnTicket`, `EnsureDeckExists`). Where the two differ it is in the
safe direction: `PushAVSWidget` and `UpdateEnergy` are dead by the bridge's exact reckoning and this
pass calls them live.

**One signal was built, measured, and deleted.** "The same function name is dead in several
Blueprints" should name a replaced *feature* rather than a graph, and two entries did exactly that:
`CountdownUpdated` and `PlayerJoined`, each uncalled across `GM_Gameplay`, `GM_TutGameplay`,
`GS_Gameplay` and `GS_TutGameplay`. The other four were engine-called overrides -
`BP_GetDesiredFocusTarget` in eleven unrelated widgets, `GetPrimaryGamepadFocusWidget` in five,
`GetPressProgress` in four, all CommonUI virtuals. There is no way from a graph name to tell a C++
override from an abandoned function, so it was mostly noise presented as the strongest thing in the
reply. The per-Blueprint ratio already surfaces what the good entries pointed at.

Worth recording how that was nearly got wrong. The first pass at validating it sampled names from the
Blueprint's *graph list* rather than from what had actually been flagged, "found" three false
positives, and would have condemned a working feature. The flagged set is the only thing worth
checking against.

### The project you actually work in has to be a build target

`build-targets.json` had two entries, both scratch projects, and the editor doing real work was not
one of them. The cost was invisible for days: every bridge-side improvement installed into two test
projects while the live game ran a plugin built before any of them. Nothing said so, because nothing
was broken - the editor kept answering, on whatever binary it was last built with.

The distinction that makes this easy to miss: **server-side changes and bridge-side changes arrive by
different routes.** Anything in `mcp-server/` is `node dist/index.js` and reaches a session the next
time it starts. Anything in `UnrealMCPBridge/` is a DLL the editor loaded at launch, and it arrives
only through `npm run build:engines` - into the projects listed in `build-targets.json`, and nowhere
else.

`npm run check:fresh` catches the consequence and always did: it refuses to live-verify against a
plugin older than the source, naming both timestamps. What it could not catch is a project that was
never a target in the first place.

### Watching the game run, which is the half nothing here could see

Every other read in this repository answers what a Blueprint **says** it will do. The expensive bugs
live in the gap between that and what it **does**: a variable that never changes, an actor that never
spawns, a value the server has and the client does not. None of that is visible in a graph, and all
of it is obvious in three seconds of a running game.

```text
unreal_watch_runtime({ action: "start", watch: ["BP_DummyTurret.CurrentHeadYaw"] })
... let real time pass ...
unreal_watch_runtime({ action: "read" })
```

**It samples every PIE world, labelled by net role.** That is the point of it. `server-writes-unreplicated`
is the most expensive check this project has, and its whole difficulty is that it reads as "it works
for the host" and cannot be reproduced by one person. With two PIE clients running:

```text
watch                          role       first  last  changed
BP_DummyTurret.CurrentHeadYaw  Authority  0.0    47.3  true
BP_DummyTurret.CurrentHeadYaw  Client0    0.0    0.0   false
```

That is the bug, observed. Static analysis says the variable is not replicated; this says nobody ever
received it — and the same two lines prove the fix afterwards.

**It does not block the game thread, and that is not an optimisation.** The bridge runs *on* the game
thread, so the obvious implementation — read, sleep, read — stops the world ticking and returns forty
identical samples. Nothing would change because nothing would be running. So sampling is a ticker and
reading is a separate call: start, let real time pass, read.

**The reply is a verdict, not a table.** Forty samples of a float is forty numbers nobody reads. The
answer to "does this ever change" is one word, and the distinct values behind it are worth a line;
returning the raw trajectory would cost more tokens than reading the whole Blueprint. Sampling stops
itself at `maxSamples`, so a watch nobody stopped costs nothing after the window it was asked for.

`npm run trial:runtime` is the proof, and it is deliberately a loop rather than a check. It builds an
actor whose server copy increments a **non-replicated** counter, plays with two players, and asserts
the Authority value moves while the Client's does not - the bug, observed. Then it calls
`unreal_set_variable_replication`, plays again, and asserts the Client value now moves too - the fix,
observed. Every other check in this repository can tell you a change was *written*; this is the only
one that can tell you it *worked*.

One distinction is called out separately in the reply because getting it wrong is expensive:
**"nothing changed" and "nothing was ever found" look identical in a table of values and mean opposite
things.** A spec that matched no actor anywhere is reported as `notFound` — a naming problem, not a
finding about the game.

### The tilde key: `unreal_run_console_command`

Almost every tool here is a specific verb - create this, connect that, read the other. The console is
the opposite shape, and that is exactly why it belongs: it is what a person reaches for when the
specific verb does not exist yet.

```text
unreal_run_console_command({ command: "ce StartWave" })     # fire an event nothing calls yet
unreal_run_console_command({ command: "Ke * ResetHealth" }) # call it on every instance of a class
unreal_run_console_command({ command: "stat unit" })        # is this frame CPU or GPU bound
unreal_run_console_command({ command: "slomo 0.1" })        # watch something too fast to see
```

One tool definition covers `ce`, `Ke`, every cheat the project defines, every cvar, `stat`,
`showdebug`, and `DumpConsoleCommands`. Defining a tool for each would cost a session more standing
context than the whole console does.

**The care is all in reporting it honestly, because the console is unusually good at appearing to
work.** Type `stat untis` and the game carries on exactly as before: nothing runs, nothing prints,
nothing changes. That is indistinguishable from `stat units` having had no visible effect - and a
model that cannot tell them apart spends its next several calls investigating a game that is fine.
`UEngine::Exec` returns false for the typo, so the reply carries `recognised: false` and a next step
naming `DumpConsoleCommands`.

Two more things had to be right or the tool would be quietly useless:

**Most commands answer through the log, not to the caller.** `stat fps` returns an empty string. So do
the cvars, so does `showdebug`. A tool reporting only the return value would say nothing about almost
every command worth running, so the log is captured for the length of the exec and handed back with
it - capped at 60 lines, with the true total reported when there were more, because `obj list` prints
thousands and "60 lines" and "the first 60 of 4,312" are different answers.

**In a running game the console belongs to the player controller.** `ce`, cheats, and everything the
cheat manager owns route through `APlayerController::ConsoleCommand`, not through the engine. Sending
those to `GEditor` does nothing at all, silently. So PIE goes through the player controller - the same
path the tilde key uses - and the server world is chosen deliberately over a client, because a client
would answer about its own copy of the state.

Two commands are refused: `quit` and `exit` (and `debug crash` and relatives). Not a policy about what
you may do - this bridge runs *inside* the editor, so the model would not receive an error, it would
receive nothing ever again, having deleted the thing that would have reported the problem.

### The audit's most expensive finding can now be fixed, not just reported

`server-writes-unreplicated` is priced at 100, the top of the scale, because of how it fails: the
server writes state that never reaches anybody else, so it works perfectly for whoever is hosting and
is invisible to one person testing alone. It survives to a showcase.

Its fix was "mark it Replicated" - and **nothing here could do that**. `unreal_add_variable` took
`replicated` and `repNotify` at creation and there was no way to change an existing variable, so the
audit found its own worst bug and handed the work back to a human. A tool that finds a bug and cannot
fix it is half a tool.

```text
unreal_set_variable_replication({
  path: "/Game/.../PC_Gameplay.PC_Gameplay",
  variableName: "CostServer",
  mode: "replicated",
})
```

Three deliberate details, each of which is a way this could have been worse:

- **`repnotify` creates `OnRep_<Name>` if it is missing and reuses it if it is not.** Going
  repnotify to none and back is an ordinary thing to do while working, and it must not leave a trail
  of duplicate graphs.
- **A newly created `OnRep_` graph is announced as empty.** RepNotify only means clients are *told*
  the value changed; with nothing in the graph it behaves exactly like plain `replicated`, which is a
  quiet way to think a bug is fixed when it is not.
- **Turning replication off never deletes the `OnRep_` graph.** It may hold real logic, and deleting
  a graph to change a flag is not a trade anybody asked for. The reply says it is now unreachable.

An inherited variable is refused by name rather than reported as missing - `"CostServer" is declared
on PC_Base, not on PC_Gameplay, so its replication has to change there` - because "not found" about a
variable you can plainly see in the editor is the kind of answer that costs a caller three more calls
to disbelieve.

### A parameter that does not exist is refused, not ignored

The single worst token bug found so far, and it was found by walking into it: calling
`unreal_list_blueprints` with `nameContains` - which is not a parameter - returned **all 339
Blueprints** and said nothing.

| call | tokens | returned |
| --- | --- | --- |
| `unreal_list_blueprints { match: "ServerList" }` | **75** | the one Blueprint |
| `unreal_list_blueprints { nameContains: "ServerList" }` | **4,014** | all 339, silently |

**53x the cost for one wrong word.** zod strips unknown keys by default, so the filter was dropped
before the tool ever saw it. And the cost is the smaller half of the problem: the caller has a reply
that looks like an answer, and may go on to reason about "the Blueprints matching ServerList" while
holding a list of every Blueprint in the project.

The names are not guessable and there is no reason they should be - `match`, `nameContains`,
`filter`, `contains`, `query` are all equally reasonable things to try. So the answer is the one this
repo already gives for a wrong pin name: refuse it, and say what does exist.

```text
not a parameter of unreal_list_blueprints. It accepts: pathPrefix, match, maxResults, fields.
Nothing was filtered or changed by the unrecognised one - call again with the right name.
```

**91 tokens instead of 4,014**, and the next call is right. Every one of the 97 tool schemas is
strict, the accepted list is captured from the schema at registration so it cannot drift, and
`npm run check:protocol` both asserts the refusal names real parameters and asserts a zero-parameter
tool still accepts an empty object - which is exactly what a change like this breaks quietly.

The other half of that question got a much worse answer for a long time. `.strict()` covers unknown
keys only, so *misspelling* a name produced the message above while *omitting* a required one
produced zod's bare `Required at query`. `unreal_find_orphans` called with no arguments answered
`Required at of / Required at pairedWith` and nothing else - two names, no types, no list, no
example. The caller was told least at the moment they knew least.

```text
unreal_find_orphans requires "of". It accepts: of, pairedWith, maxDistance.
Nothing ran - call again with "of" set.
```

Both messages are now built from the same list, so they cannot drift apart. The annotation clones
each field rather than marking the schema instance, because attaching it in place would name
whichever tool registered first if two ever shared one - a wrong answer that reads exactly like a
right one. `check:protocol` asserts both halves.

### A filtered graph read now brings back what its matches are wired to

`match` narrowed a graph read correctly and then handed back something that could not be used. Match
`"Kronos Match"` on a real widget and the reply contains a node whose wiring reads
`in HostParams <- BE59B028.ReturnValue` - and `BE59B028` is **not in the reply**, because it did not
match. The link cannot be followed. The filter that was supposed to save a call had cost one.

So a match now brings its immediate neighbours with it, marked `neighbour` and carrying `id`, `type`
and `title` and no wiring of their own. One hop, deliberately: a neighbour's own links would name a
second ring of unresolvable ids and undo the saving.

The title is the whole point. Tracing a real LAN bug in this project, `match: "Kronos Match"` used to
give the node id `BE59B028` and nothing else; it now says **`Make Kronos Host Params`**, which is
immediately the node the bug was in.

Measured against `BP_Player`'s 809-node Event Graph, whose raw bridge reply is 52,643 tokens:

| call | nodes | tokens | dangling links |
| --- | --- | --- | --- |
| no filter | 60 (capped) | 2,121 | — |
| `match: "Cast To"` | 8 matched + 32 near | **1,188** | **0** |
| `match: "Skin"` | 16 matched + 16 near | **1,124** | **0** |
| `match: "Set Timer"` | 6 matched + 17 near | **700** | **0** |

**Zero dangling links** is the guarantee, and it is checked as itself rather than as the mechanism
that delivers it - a test builds a 200-node ring, filters it below the cap so matches are genuinely
cut, and asserts every id named in the reply is present in the reply.

The backfill runs **only when a filter was used**, and that restriction was also measured. Without a
filter the "matches" are the entire graph, so backfilling took the unfiltered read from 2,121 tokens
to **3,879** - an 83% rise on the commonest read of all, to fix dangling links in a reply that
already says `truncated` and tells the caller how to narrow. A caller who filtered asked a specific
question and needs the answer to hold together; a caller who did not is still getting oriented.
There is a test pinning that, too.

**`unreal_list_variables` got filtering rather than a cap, and the measurement is why.** 84 variables
came to 4,117 tokens with *no single field dominating* — unlike the graph read, there was no fat to
cut, and a cap would simply have hidden state at random. What a caller actually wants is not "fewer
variables" but a specific set:

| call | tokens | variables |
| --- | --- | --- |
| everything (unchanged) | 5,744 | 84 |
| `match: "Health"` | **354** | 5 |
| `replicatedOnly: true` | **1,133** | 15 |

`replicatedOnly` earns its place because *"what can a client actually see"* is the question behind
this project's highest-cost audit finding — a server writing to an unreplicated variable works
perfectly on the machine the developer is looking at.

**Replies are budgeted too, by `npm run check:replies`.** `check:profiles` guards the standing cost —
what the tool *definitions* cost before a conversation starts. Nothing guarded what a tool costs when
it *answers*, and that gap was not hypothetical: `unreal_list_tools`, whose entire purpose is keeping
this surface cheap, had grown to **5,523 tokens** per call, and `unreal_enable_tools` echoed every
enabled tool name back so that enabling *one* tool cost the same 700 tokens as enabling thirty-two.
Both had grown a tool at a time while the number that would have exposed them sat in a document
nobody re-measured. It now fails the build instead.

It covers only editor-free tools, deliberately — anything that reads a real project produces a reply
whose size depends on the project, so a fixed ceiling would be meaningless and would fail on someone
else's machine.

**`npm run measure:reads` is the other half**, and it needs an editor. It finds the largest graph in
the open project by itself rather than trusting a path hardcoded to one machine — the worst case is
the only case worth measuring, because a small graph tells you nothing — then measures every read
against it. Its ceiling is deliberately loose and absolute (25k tokens) rather than tight and
project-specific: a tight number would fail on every machine but the one that recorded it and would
be deleted within a week, while a loose one still catches the class of bug that matters, which is a
read with no bound at all. Nothing legitimate returns 25k tokens from one call.

Write costs are measured by `npm run measure:cost`: a five-node build response is ~110 tokens on
`fast`, ~194 on `standard`, ~697 on `max`.

**`npm run measure:groups` measures what turning a group ON costs**, which is the number the
`search` profile's whole premise rests on and which nothing had ever checked. Measured:

| group | tools | ~tokens added |
|---|---|---|
| core | 28 | 10,427 |
| scene | 21 | 5,616 |
| data | 13 | 3,610 |
| edit | 8 | 3,153 |
| ui | 5 | 1,942 |
| maintenance | 5 | 1,513 |
| materials | 4 | 1,411 |

The uncomfortable result is the first row. `search` stands at ~1,244 tokens, so a model that follows
`enable_tools`' own advice and turns on `core` is at ~11,671 — which is what `lazy` costs standing,
without the extra call. **The search profile saves nothing for a job that needs `core`**; it saves a
great deal for one that needs `ui` or `materials` and nothing else. That is worth stating plainly
rather than leaving as an implication, because "enable only what you need" reads like a saving in
every case and is one in some.

`unreal_list_tools` now reports `costTokens` per group so the choice is made with the price visible.
Those numbers are generated into `src/groupCosts.ts` by `measure:groups --write`, and the plain
command fails when they drift — a hand-written number would rot, which this repo has already had
happen once when four tools were added to `lazy` and the documented size stayed put. They are in a
reply rather than in `enable_tools`' description because replies cost nothing until called, and
because `enable_tools` sits in the `minimal` profile, which is at exactly its 4,000-token ceiling.

**`npm run build:engines` guards the other claim this project makes**: that one source tree supports
UE 5.6 and 5.8. Dual-version support is the kind of claim that rots silently - a 5.8-only API slips
into a handler, 5.8 keeps building, and nobody finds out until a 5.6 user compiles - so it is one
command that refuses to report success unless every engine really did build.

It has two modes, because they catch different mistakes. The default syncs the source into each
configured project and builds its editor target: that is what actually happens to a user, and it is
the only mode that leaves usable binaries. `npm run check:engines` runs it `--isolated`, which uses
`RunUAT BuildPlugin` instead - compiling against PUBLIC engine APIs only, needing no configured
project, and not dragging in the host project's other plugins. That last part matters: the real game
project used for verification here cannot build its editor target at all, because a Wwise plugin
references an `AkAudio` module that is not installed, and building the whole thing would let an
unrelated failure mask this plugin's own result. Targets come from `build-targets.json`; `--isolated`
falls back to finding engines itself, or set `UNREAL_ENGINES` to a semicolon-separated list of roots.

Last run: 2026-08-30, `UE_5.8` ok (88s) and `UE_5.6` ok (81s).

Both scripts refuse to measure a reply that does not contain what it should, because a reply that is
an error is not a cheap reply — it is a broken measurement, and the first version of `check:replies`
reported two cases comfortably under budget at eleven tokens having faithfully measured the size of
"Tool disabled".

Every case asserts the reply actually *contains* what it should before measuring it. That is not
belt-and-braces: the first version of the script reported two cases comfortably under budget at
**eleven tokens**, because the tool was disabled and it was measuring the error message. They were hand-measured once
before that existed and were wrong within a few commits, which is the argument for the script.

**`search` is the one to reach for on a capable model**, and it is what `--print-config` now writes
for Claude Desktop, Claude Code, and Cursor. Only four tools stand: `unreal_ping`, `unreal_doctor`,
`unreal_list_tools`, and `unreal_enable_tools`. Everything else is registered with its full schema
and switched off. `unreal_list_tools` names tools with a one-line summary and no schema, so even
discovery is cheap; one `unreal_enable_tools` call then brings back whatever the job needs.

**Discovery is itself budgeted, which took one measurement to notice.** Listing all 88 tools cost
**5,523 tokens** — more than four times the entire `search` profile it exists to protect. A discovery
mechanism that costs more than the thing it discovers defeats its own purpose, and a model on
`search` was paying it on the first call of every session. With no filter `unreal_list_tools` now
returns a **group census** at ~338 tokens; `group` or `match` returns real tools (`match: "data table"`
is 141); `all: true` still gives everything, for the rare case that is genuinely wanted.

**Be precise about what that saves, because the headline number is only the first turn.** 1.2k is
what `tools/list` costs before anything is enabled. A model that then asks for the whole `core` group
pays ~11.5k on every turn after — still far better than `full`'s ~28k, but not 1.2k.

The way to keep the saving is to enable *tools*, not groups:

```
unreal_enable_tools({ tools: ["unreal_get_project_overview", "unreal_search_project",
                              "unreal_build_graph", "unreal_compile_blueprint"] })
```

Measured end to end: enabling the `core` group gives 32 tools at **11,597 tokens**; enabling the
eight a feature actually needs gives 12 tools at **4,512 tokens**. That difference is paid on every
turn for the rest of the session, which is why it is worth one extra thought at the start. A
misspelled name is reported back rather than silently enabling nothing.

The saving is 95% of the standing cost, and nothing is given up for it. This is deliberately *not* a
`call_tool(name, json)` dispatcher: enabling a group hands the model the **real, fully typed
schemas**, so argument validation, enum constraints, and parameter documentation are all intact. The
model pays one extra call at the start of a session and stops paying 24k tokens on every turn after
it. Epic's own MCP plugin reached the same conclusion in 5.8 with its Tool Search mode.

Rechecked against Epic's 5.8 documentation, their Tool Search mode returns three meta-tools from
`tools/list` - `list_toolsets`, `describe_toolset`, `call_tool` - and routes every invocation
through the third. Ours answers the same problem with the `search` profile: **four tools, 2,257
tokens**, and the tools a caller enables become *real MCP tools with real schemas*, so the protocol
layer validates arguments and can say "not a parameter of unreal_map_system. It accepts: query,
maxAssets, depth, detail". Behind `call_tool` there is nothing for the protocol to check against, so
a wrong parameter name is the callee's problem to notice - which is precisely the failure that cost
53x on `list_blueprints` here before schemas were made strict. Their design avoids a `tools/list`
refresh; ours keeps validation. Both are defensible, and the difference is worth stating plainly
rather than claiming a win.

Two more things from that documentation are worth recording. Epic exposes `PaginationPageSize` as a
server setting; this project compacts replies instead, and only `list_data_table_rows` truly pages
(`limit` + `offset`). Checking that claim is what turned up `list_assets` answering a cap with
`{count: 3, truncated: true}` - no total, no route forward - while `list_blueprints` and
`list_actors` both give the real total and a `next` naming the parameters that narrow the search.
Three tools describing one situation, one of them differently. `check:protocol` now asserts that any
list reporting `truncated` also says how to see the rest, because a caller who cannot continue
either raises `maxResults` blindly and pays for everything, or reasons from a partial list believing
it is the whole project - and the second looks like success.

The trade is indirection, and that is exactly why the smaller profiles are unchanged: a weak model
handles indirection badly, and `minimal` beats everything else for it. A frontier model handles it
without noticing.

**On a small local model, use `minimal`.** Measured across three benchmark tasks, it completes each
in a single tool call with no failed calls, while `lazy` needs up to sixteen calls and seven
failures for the same outcome. Fewer tools means fewer wrong paths to try first, so the smaller
surface is cheaper and more reliable at once — see
[the benchmark](../docs/LOCAL_MODEL_BENCHMARK.md).

**`minimal` exists for a measured reason.** On a 12 GB GPU, a 14B model loads at 8k context and
fails to load at 16k. The `lazy` profile is ~10.1k tokens of tool definitions by itself, so its tool
list alone would consume the entire budget that model has. **Tool payload size does not just cost
tokens; it decides which models you can run at all.** `minimal` is the authoring spine only - find
a function, create, add state, attach behaviour, compile, review, save - and everything else
arrives through `unreal_enable_tools`.

**`lazy` sits between the two.** Every tool is registered with its full schema, but the optional
groups start switched off, and the always-on set is the whole straight-line authoring path: orient,
search, read, find the exact node, create the Blueprint, add variables and functions, build the
graph, compile, lay out, review, save, plus `unreal_doctor`. A model can complete an entire feature
without enabling anything.

The groups are `core` (the authoring spine — the only one `search` users normally need), `edit`
(single-node graph surgery), `ui` (UMG), `materials` (materials and material instances), `data`
(structs, enums, asset lookup), `scene` (levels, actors, components, class defaults, input, PIE),
and `maintenance` (references, deletion, Refresh Nodes).

`core` remains for clients that do not act on `tools/list_changed`: same small footprint, but the
other tools are unreachable rather than deferred. The active profile and the enabled/registered
counts are printed to stderr at startup.

A test asserts that no tool is stranded outside core and every group, so a tool added in future
cannot silently become unreachable in `lazy` or `search`.


### Rebuilding something you just deleted

Delete-and-rebuild is the ordinary shape of iterating on a feature: build it, look at it, throw it
away, build it again under the same name. That used to stop at the second build with
`asset_name_in_use` — the package was off disk but the `UObject` was still resident, and creating
over it **asserts inside the engine and closes the editor**, so refusing was correct. The remedy
offered ("pick a different name, or restart the editor") is fine advice for a person and a dead end
for an agent.

It now reclaims the name instead: a garbage collection first, which usually clears a leftover
outright, and if something is still holding a reference, the stale object is renamed out of the
package into the transient one. The name becomes free, the object stays alive for whatever still
points at it, and the assert — which fires on finding the name in the target package, not on the
object existing at all — has nothing left to find. Only if both fail does it refuse, and then it says
that both were tried.

Found by running a real feature request end to end and recording where it stalled, which is worth
more than it sounds: the trial's own stall detector reported "0 stalls" while three calls had plainly
failed, because it was pattern-matching for `"error"` with quotes and the real replies said
`asset_name_in_use` and `Input validation error`.

### Driving the editor headlessly

Two things learned by doing it for a day, both of which cost time to rediscover:

**Close the editor gracefully, never force-kill it.** A killed editor shows a **"Restore Packages"**
dialog on next launch, and a modal dialog blocks the game thread — so the bridge accepts the TCP
connection and then never answers, which looks exactly like a hung or broken plugin. `unreal_doctor`
reports it honestly ("accepted the connection but did not answer"), but the cause is a window nobody
is looking at.

**If it does happen, relaunch with `-unattended`**, which suppresses modal dialogs and gets past the
prompt:

```
UnrealEditor.exe <project>.uproject -nosplash -unattended -nopause
```

An editor that has just been force-killed also rebuilds derived data on the next open, so give it
longer than usual before deciding something is wrong — poll `unreal_ping` rather than guessing at a
fixed wait.

### Security: what this bridge does and does not protect you from

Security surveys of MCP servers keep finding the same shape. One 2025 review of popular servers
found [43% with command-injection flaws, 22% allowing path traversal or arbitrary file reads, and no
authentication by default](https://checkmarx.com/learn/mcp-security-risks-real-world-incidents-and-security-controls/).
The current guidance is to validate every tool input and to require confirmation for anything
irreversible.

Stated plainly, because a vague security claim is worse than none:

**What is protected**

- **Loopback only.** The bridge binds `127.0.0.1` and refuses to listen anywhere else. A remote
  attacker cannot reach it.
- **A browser cannot drive it.** The protocol is newline-delimited JSON on a plain TCP port, and a
  web page can open that port: a cross-origin `POST` with `Content-Type: text/plain` is
  CORS-safelisted, so it is sent with no preflight from any site the user happens to be reading. The
  browser writes an HTTP request line, then headers, then the body — and while an unparseable line
  was merely answered and skipped, each header was discarded in turn and then the body parsed as a
  perfectly good command and **ran**. Same-origin policy stops the page reading the reply, which is
  no comfort when `delete_asset` is on the menu. The bridge now closes the connection on the first
  line that is not JSON, which shuts that off completely: every HTTP request begins with a request
  line that is not JSON.
- **A session token, generated by the editor and read by the server.** Loopback is not a trust
  boundary. Any other process running as the same user — an `npm postinstall` script, a downloaded
  plugin, a game mod, a second desktop session over RDP — can open `127.0.0.1:8765` and speak the
  protocol, and this bridge deletes assets and writes levels.

  So the editor generates a 256-bit token at startup and writes it to a per-user, per-**port** file
  (`session-8765.json` under your user settings directory; the exact path is logged). The MCP server
  reads that same file and attaches the token to every request. **There is nothing to configure,
  which means there is nothing to configure wrongly** — the scheme this replaces was an environment
  variable the user had to set in two places, and it had a state where it was on and broken, which
  is the state people actually reach.

  Keyed by port rather than by project because the port is the only thing a client knows before it
  has connected to anything; keying it by project would need a connection to learn the project,
  which would need the token.

  **Enforcement is currently opt-in: launch the editor with `-MCPRequireAuth`.** The token is always
  generated and always sent, so turning enforcement on is a launch flag rather than a code change,
  and it cannot then discover the other half was never wired up.

  The plugin **compiles against both engines** — UE 5.8 (499s) and UE 5.6 (292s), via
  `npm run build:engines`. What has not happened yet is a *runtime* check: nobody has confirmed that
  `FPlatformProcess::UserSettingsDir()` resolves to a directory `sessionToken.ts` actually looks in.
  That mirroring is done by hand per platform, and if it is wrong the client silently finds no token
  and every call fails the moment enforcement is switched on. Compiling proves the code is valid; it
  does not prove the two halves agree on a path. Run one editor with `-MCPRequireAuth`, confirm the
  tools still work, and then the default can move.
- **No arbitrary code execution.** There is no `execute_python`, no shell, no eval. Every command is
  a typed operation over engine APIs, so there is nothing to inject *into*.
- **Writes are confined to `/Game`.** Creating, modifying and deleting are refused for anything
  outside the project's own content. Engine and plugin content stays readable, because reading it
  is useful and harmless.
- **Deletion is reference-checked.** `unreal_delete_asset` refuses by default when something
  outside the delete set still points at the target.
- **Everything is undoable and visible.** Writes land in the editor's undo history under `MCP:`,
  `unreal_undo_history` shows them, and `unreal_session_changes` lists what was touched.

**What is not**

- **There is no authentication.** Anything running as your user on your machine can talk to the
  bridge while the editor is open. Loopback is the whole boundary, and on a shared or untrusted
  machine that is not enough.
- **Prompt injection is real and only partly mitigated.** A model reads Blueprint titles, node
  comments and asset names out of the project. A sentence planted in any of them is a plausible way
  to steer an agent, and no tool schema can prevent it. What the design does instead is bound the
  damage: the worst case is confined to `/Game`, is undoable, is listed by
  `unreal_session_changes`, and cannot delete something still referenced without an explicit
  `force`.
- **An agent can still do the wrong thing correctly.** Guards stop catastrophes, not mistakes. That
  is what the review gate, the change log and the undo history are for.

**The escape hatch is deliberately awkward.** Writing outside `/Game` requires relaunching the
editor with `-MCPAllowEngineWrites`. It is a command-line switch on the *editor*, not a tool
parameter and not an environment variable this server reads, because a control an agent can flip on
its own is not a control. A human choosing it is a decision; anything else is an exploit.

Losing a project asset is a bad afternoon. Losing your engine install is a reinstall.

### Team projects: source control and binary assets

A Blueprint is a **binary** `.uasset`. It cannot be text-merged, which is why Unreal teams rely on
checkout locking rather than merging, and why source control marks a file you have not checked out
as **read-only on disk**.

That combination is where an agent quietly loses work on a real project: it makes the edits, the
save fails, and the caller is told `save_failed` with no idea why.

Saving now checks first:

- **read-only and source control connected** — the file is checked out automatically, then saved
- **read-only and source control unavailable** — the save is refused, and the message says what is
  actually wrong and that **the edits are still live in the editor**, so nothing has to be redone
- **checked out by someone else** — refused, and the message says why two people cannot safely edit
  one Blueprint

`unreal_asset_status` answers the same question **before** the work: whether an asset is writable,
and if not, who holds it. On a source-controlled project that turns a wasted session into one
sentence — *"BP_Door is checked out by alice, so I cannot save changes to it; shall I work on
something else?"* It is a separate call rather than a check inside every write, because querying
source control can hit the network and paying that per node placement would slow the common case to
protect the rare one.

`unreal_ping` reports whether source control is enabled and connected, and `unreal_doctor` warns
when it is enabled but disconnected — before the work, rather than after the failed save.

Verified against a genuinely read-only `.uasset`, since that is exactly what Perforce produces.

### Two editors open: the silent wrong-project edit

The bridge binds one port. If you have **two Unreal Editors open** with this plugin enabled, only one
of them can hold it — and every MCP call goes to that one, whichever it happens to be. An agent told
to work on project A can spend an entire session editing project B, with no error, no warning, and
no symptom until somebody notices the damage.

This is not hypothetical: the same failure is
[an open bug in Unity's MCP ecosystem](https://github.com/CoplayDev/unity-mcp/issues/1023) — "MCP
affects other projects when working in two or more editors".

Three defences, because a silent failure needs to be made loud in more than one place:

**1. `ping` now says which project it is.** Project name, `.uproject` path, and engine version. Every
`unreal_doctor` run names the connected project, so the answer to "am I attached to the right thing?"
is one cheap call away instead of unknowable.

**2. `UNREAL_MCP_EXPECT_PROJECT` refuses to write to the wrong one.** Set it to your project's name
and the **first write of the session** is checked. On a mismatch, nothing is sent:

```
UnrealMCPBridge error: WRONG PROJECT: this bridge is attached to "OtherGame"
(A:/Projects/OtherGame/OtherGame.uproject), but UNREAL_MCP_EXPECT_PROJECT is "MyGame".
Refusing to write. This normally means a second Unreal Editor is open: only one can hold
port 8765, so every call goes to that one. Close the other editor, or run each on its own
port with -MCPBridgePort=<n> and UNREAL_MCP_BRIDGE_PORT. Nothing has been changed.
```

Checked on the first *write*, not in `unreal_doctor` alone, because this failure is silent by nature:
it gets found by someone noticing damage, not by anyone thinking to run a diagnosis first.

**3. The editor that loses the port says so.** Previously it logged `failed to bind TCP listener`,
which reads like a minor startup nuisance. It now states that another editor almost certainly holds
the port, that *this* editor's bridge is not running, and that edits meant for this project will land
in the other one instead.

Running two projects deliberately is fine: give each editor its own port with `-MCPBridgePort=<n>`
and point each MCP server at it with `UNREAL_MCP_BRIDGE_PORT`.

**4. `UNREAL_MCP_READONLY` lets a session look without touching.** The profiles decide what a model
is *handed*; this decides what it can *do*, and only the first question had an answer — on any
profile a model can call `unreal_enable_tools` and turn the writes back on, which is right for a
session meant to build and wrong for one meant to review.

```text
read_only_session: "create_blueprint" changes the project and this session is read-only, so
nothing was sent. Reads are unaffected - list, read, find, describe, search, and every audit
and review built on them all work normally.
```

The classification is **not a second list**. It is `READ_ONLY_COMMANDS` in `journal.ts`: 38 commands,
each read out of its C++ handler and confirmed to touch nothing, with `check:journal` failing if a
read-named command drifts out of it. That list already had to be exactly right, because the session
change log is built from its complement — and a private copy here would be two things describing one
fact, with a write slipping through a session that promised it could not as the failure mode.

Refused at the same choke point the path expansion and the journal use, before the socket is opened,
so "nothing was sent" is a fact rather than a hope. Verified against the editor: reads and
`audit_project` work normally, `create_blueprint` is refused, and a *composite* that writes —
`scaffold_blueprint` — is refused at its first write having created nothing. `1`, `true`, `yes` and
`on` all enable it, because a session that stayed writable because someone typed "true" instead of
"1" would be the worst possible outcome for a flag whose whole job is safety.

It costs nothing in standing context: no new tool, no description change.

### Knowing what the agent touched

Handing an AI direct control of a game engine introduces a failure mode that does not exist when a
human is clicking the buttons: **the human always knows what they touched.** Undo already covers
the reversing half (every write lands in the editor's undo history under an `MCP:` prefix), but
undo is useless if you cannot see what there is to undo, and the user this project is aimed at
cannot read a Blueprint diff to find out.

`unreal_session_changes` answers it directly, in plain language rather than command names:

```json
{
  "totalWrites": 14, "succeeded": 13, "failed": 1, "assetsTouched": 2,
  "destructive": [],
  "byAsset": [
    { "asset": "/Game/BP_Player.BP_Player",
      "changes": ["added a variable", "built graph logic", "compiled a Blueprint"],
      "writeCount": 11 }
  ],
  "scope": "This lists what this MCP server changed during this session only...",
  "undo": "Every change above is in the editor's undo history under an \"MCP:\" prefix..."
}
```

Three decisions worth naming:

- **Recorded by wrapping the transport**, not at the fifty call sites. A log assembled by
  remembering to add a line in fifty places is one omission away from telling the user something
  untrue about their own project, and a change log that is wrong is worse than none.
- **An unrecognised command counts as a write.** A command added later must not escape the log
  because `journal.ts` has not heard of it. Under-reporting a change is the dangerous direction.

  That default is right and it still went wrong, in the way a safe default does: quietly. Fifteen
  read commands were added to the bridge after the read-only list was written - `list_variables`,
  `read_class_defaults`, `describe_class` and twelve more - and every one of them was being logged
  as a change. After a session of nothing but `audit_project`, `map_system`, `find_orphans` and
  `plan_feature`, this tool reported **359 writes across 190 assets**, at 9,871 tokens. It is now
  0 writes and 130 tokens.

  The token cost is the smaller half. A model that calls `session_changes` to check its own work
  and is told it modified 190 assets it never touched has been actively misled by the one tool that
  has to be trustworthy about this.

  `npm run check:journal` is what stops it recurring. It reads the bridge's own dispatch chain, so
  a command cannot exist without being considered, and fails if anything named `read_*`, `list_*`,
  `find_*`, `describe_*`, `get_*` or `search_*` is being logged as a change. It checks that one
  direction only: plenty of pure reads are named otherwise (`pie_status`, `project_health`,
  `trace_variable`), and those are still added by hand after reading the C++ handler - the slow half,
  kept slow on purpose. A read filed as a write is noise in a log; a write filed as a read vanishes
  from the journal entirely, and the journal is what the undo advice is built from.
- **The report states its own limits.** It sees what this server did, not hand edits in the editor
  or another tool, and it says so rather than leaving that to be discovered at a bad moment.

### Why that delete deleted nothing

Left unexplained across two earlier passes, and the honest position at the time was that the cause
was not established. It is now, by bisecting against the editor rather than reading engine source.
Each row was run:

```text
parent alone, saved                                     deletes
parent + graph + compile, no child                      deletes
parent + saved child, NO graphs                         deletes
parent + saved child, graphs on both   -> child deletes, PARENT REFUSES
the same pair in one paths[] call      -> both delete
```

So it is the combination — **a saved parent, a saved child deriving from it, and built graphs.**
Delete the child on its own and the parent is left holding a reference nothing in the session
releases. That is exactly the shape `trial:parent-call` builds, which is why that trial and only that
trial leaked one Blueprint per run.

**The bridge knew all along.** `paths[]` exists because *"its members reference each other, and
force-delete breaks those intra-set links"* — the tool simply never said so on the failure, and the
cleanup helper deleted one asset at a time. Both fixed: the warning now names the cause and the cure,
and `cleanUpScratch` deletes the set in one call, falling back to one-at-a-time if the batch removes
nothing. The parent-call trial now cleans up completely.

One thing this does **not** fix: eleven Blueprints already in that state. A batch delete of all
eleven removes none, because whatever holds them — the child that derived from them — is already
gone. An editor restart is the only thing known to release them, and the message says so rather than
implying a retry will help.

### A delete that deleted nothing reported success

`unreal_delete_asset` answers `{"requested": 1, "deleted": 0, "forced": true}` when the engine
refuses, wrapped in an OK response. Every caller that checks for an error sees success.

It surfaced from the other end. Seven `BP_TrialParent*` Blueprints had accumulated in
`/Game/MCPTrial`, the namespace the trials build in, over seven runs that each printed `cleaned up 2
assets`. Nothing complained, because the next run creates its own uniquely-stamped assets and never
looks at what is already there - so a leak nobody was paying for became a confusing failure
somewhere else entirely, when an unrelated script crashed reading a Blueprint whose file had gone
while `list_blueprints` still reported it.

The tool now states the mismatch and says not to treat the call as done. What it does **not** do is
name a cause. The first version of the message advised saving the asset and deleting again; that was
tested against the real leftovers and made no difference, on an asset `find_references` reports
nothing referencing and `asset_status` reports on disk, writable and not read-only. Shipping advice
that had just been watched failing would have been worse than the silence it replaced, because a
caller would have followed it. A fresh Blueprint deletes, a child deletes, a parent deletes after
its child, and both together in one `paths[]` call delete - all verified against the editor. Why the
compiled trial Blueprints refuse is not established, so the message does not say.

The trials changed with it, on three rules:

- **Sweep on the way in, not only on the way out.** An exit path cannot clean up after a process
  that is no longer running, and it is the killed runs that leak by definition.
- **A delete is judged by what it deleted**, not by whether it threw.
- **A failed delete is reported.** `.catch(() => {})` in a cleanup block is how a trial prints
  `cleaned up 2 assets` while leaving both behind.

The sweep runs `force:true` against the real project, so it matches on a path boundary rather than a
string prefix - `/Game/MCPTrialish/` starts with the scratch root and is a different folder. That
was caught by a test written to assert the loose behaviour, which is how a test ends up encoding the
bug it exists to prevent.

### A claim that looked inverted, and a comparison that was never fair

`explain_graph` says it costs *"about a tenth"* of a structured read. Measured on `BP_Player`'s
EventGraph, `explain_graph` is **2,284** tokens and `read_blueprint_summary` is **2,121** — the prose
form apparently dearer than the structure it exists to replace.

It is not. `read_blueprint_summary` returned **60 of 809 nodes with `truncated: true`**, while
`explain_graph` covered the whole graph. 2,121 tokens buys 7% of that graph; 2,284 buys all of it.
The comparison was never like-for-like, and the honest conclusion is the opposite of the one the
numbers first suggested — worth recording because it is the second time in three sections that a
measurement looked like a defect and turned out to be my reading of it.

Measured properly, on a 59-node graph that does **not** truncate:

```text
read_blueprint_summary   2,328
explain_graph              323      a seventh
```

So the direction was right and the figure was overstated: *a seventh*, not a tenth. The description
also cited "a real 104-node EventGraph costs ~8,800 tokens", written before compact JSON, float
trimming and the rest — a number that has been wrong for weeks in a tool description a model reads
when choosing between two tools.

It now carries the measured pair, and one fact it never mentioned: on a graph too big to return
whole, the choice is not cheaper-versus-dearer but **all of it versus part**. `read_blueprint_summary`
caps at 60 nodes and says so; `explain_graph` explains all 809. That is a better reason to reach for
it than the token count, and it was missing.

The sibling claim checked at the same time — `map_system detail:true` being *"roughly 8x"* — is still
true: 6,786 against 817.

### Looking for waste in the presets, and not finding it

If standing context is the dominant cost, the presets are the answer to it — so a fat preset would
undermine the whole strategy. `diagnose` costs 10,070 tokens against `core`'s 10,443, which looked
like a preset buying almost nothing.

It is not fat. It enables 29 tools averaging 347 tokens, the distribution is flat, and every entry
carries the reason it was added — most of them earned from a real failure ("added because
trial:diagnose --by-preset failed without it… a tool whose entire job is finding something wrong,
absent from the preset for finding things wrong"). The one large entry, `build_graph` at 9%, is there
deliberately: *"the fix half. A preset that can only diagnose leaves the model to enable more before
it can act on what it just found."*

**A negative result worth recording**, because the instinct on seeing 29 tools is to trim, and the
trimming would have cost the preset its ability to fix what it finds.

What the measurement did turn up was a different problem. The `path` parameter is described **five
different ways** across the surface:

```text
15x  "Full asset path of the Blueprint, e.g. /Game/Blueprints/BP_Foo.BP_Foo."
 9x  "Blueprint asset path, e.g. /Game/Blueprints/BP_Player.BP_Player."
 5x  "The Blueprint, e.g. /Game/Player/BP_Player."
```

Three phrasings for one concept, and they disagree about something that matters: two insist on the
**full** path while the third shows the **short** form. Both work — path normalisation accepts either,
along with the `_C` class path and `/Content/` — and no parameter description said so, so a model
reading "Full asset path" would reasonably conclude the short form is invalid.

All 31 now read `Blueprint path; /Game/UI/BP_Foo and /Game/UI/BP_Foo.BP_Foo both work.` Net effect on
tokens is a wash — `core` down 12, `full` up 6 — so this is a correctness change wearing a token
change's clothes, and worth saying so rather than claiming a saving it did not make.

### The biggest token lever was never mentioned to the profile that needed it

Standing context goes with **every message**, so it is not paid once — and that reframes all the
compaction work below it. Every reply saving in this file put together does not approach it.

**Corrected since this was written, and the correction matters.** This used to say a thirty-call job
on `full` "pays 38k tokens of tool definitions thirty times". That is true only without prompt
caching. The tool list is a cacheable prefix sitting ahead of the system prompt and the messages, so
a client that caches — which is every client `--print-config` writes for — is charged it in full once
and at a fraction after. Overstating the figure by roughly ten times, in the paragraph that goes on
to insist the ratio "had to be the real one", is the same mistake one level down.

What genuinely re-charges that prefix at full price is **changing the tool list**, which is why
`unreal_enable_tools` is expensive and `unreal_call_tool` exists. The standing instructions now say
that instead, because it is the sentence a model can act on. Two comments in `index.ts` had the model
right the whole time — "sits ahead of the system prompt and every message, so changing it invalidates
the prompt cache" — so this was one text disagreeing with two others, which is the defect this repo
keeps finding in everything except its own prose.

The comparison, because the first version of this was wrong in the direction that flatters the
argument:

| session | standing |
|---|---:|
| `full` | 38,282 |
| `search` + the `cpp` preset | 6,615 |
| `search` + the `feature` preset | 9,817 |
| `search` + the `diagnose` preset | 12,362 |

**Three to six times, not sixteen.** Sixteen was `full` against `search` with nothing switched on —
true of a session that never does any work. A session that does the work enables a preset, and that
is the number that matters. Still the largest single lever here, and it had to be the real one: an
overstated saving in the one text nobody can skip would undermine every other measurement beside it,
which is exactly what `measure:reads`' drift guard exists to catch.

`core`, `lazy` and `full` now say what they cost, computed from the same table `unreal_list_tools`
prices groups from so it cannot go stale. It ends by telling the model to **tell the user** — a model
cannot change `UNREAL_MCP_PROFILE`, which is set where the server is launched, so the only action
available to it is passing the option on. `search` and `minimal` are left alone: one already opens by
explaining how to widen a deliberately short list, the other is fixed, and paying tokens to give
either of them advice they have already taken would be its own small joke.

### Seven commands that compile and have never run

Three sessions added `rename_asset`, `duplicate_asset`, `rename_variable`, `remove_variable`,
`rename_component`, `remove_component` and `remove_function`. Every one compiles against 5.6, 5.8 and
the game target. **Not one has ever been executed**, because the plugin binary in the editor predates
all of them.

That risk grows quietly. The day the plugin is rebuilt, seven commands go live having never run once
— and nothing existed that would exercise them, so they would go live untested and stay that way
until something broke in front of a user.

`npm run trial:lifecycle` is the thing that runs the moment they exist. It checks **consequences, not
return codes**, because a rename that changed a name and left every referencing node pointing at the
old one has not renamed anything:

- a variable is renamed **while a graph reads it**, then the Blueprint is compiled — the cheapest way
  to ask the engine whether the nodes really moved
- removing a variable that something still reads must **refuse and name the graphs**, and only then
  succeed with `force`
- a component answers to its new name, then removes, then is confirmed gone
- an asset is copied, renamed, and both the new path and the *absence* of the old one are checked

Today it prints five `--` skips and exits **2**: nothing failed, and nothing was proved either. The
setup it depends on was verified separately — create, add variable, build a graph that reads it, add
a component, create a function, compile — all green, so the subject will be real when the commands
arrive.

### A stale plugin looks like four broken features

Running the remaining trials: `feature` (33 calls, ~2,760 tokens), `chain` and `parent-call` all pass.
`runtime` reported **four failures**, and not one of them was a defect in what it tests.

Every one traced to the installed plugin predating this server — and it manifests in **two different
ways, only one of which announces itself**:

- A missing **command** says so: `unknown_cmd: watch_runtime`, with the explanation added a few
  sections ago. Easy to classify.
- A missing **field** says nothing at all. `pie_status` returns `{"running": true}`, and the C++ in
  this repo sets a `worlds` array beside it — *"which worlds are up, not just whether any is"*. The
  trial read the absent array as `0 worlds came up`, turning *a plugin that cannot answer* into *a
  game that did not start*, and every check downstream failed on a sample that was never taken.

`worlds` absent and `worlds` empty are different answers, and this is the same absent-versus-empty
distinction the rest of the codebase is careful about — missed in the one place whose job is to catch
things.

The trial now separates **cannot run** from **failed**, skips checks that depend on a phase that
could not run, and ends with:

```text
CANNOT FULLY RUN: the installed plugin does not have pie_status.worlds, set_variable_replication.
runtime trial: nothing failed, but it could not test its claim. Exiting non-zero on purpose: a
green tick here would be a pass nobody earned.
```

**Exit code 2, deliberately.** Not a failure of the tools, and not a pass — and the two must not share
an exit code, because a trial that returns 0 for *"I could not check"* is how an unverified thing gets
reported as verified. That is the entire reason this trial exists: reasoning about replication is not
the same as watching it.

### `map_system` could not find a system by its own name

Running the other trials after weeks of compaction changes, `trial:diagnose` failed: it plants
`BP_DiagnoseTrial`, asks `unreal_map_system` for `"DiagnoseTrial"`, and got nothing back.

The first read was that the trial expected the wrong thing — `matchesAsWord` deliberately rejects a
substring, because `plan_feature` once claimed *"bar already exists in this project"* on the strength
of a variable called `TurretBarrelLoc`. Checking it against real assets said otherwise:

```text
matchesAsWord("BP_ShopUpgrade",   "ShopUpgrade")     false
matchesAsWord("WBP_HealthBar",    "HealthBar")       false
matchesAsWord("BP_DamageUpgrade", "DamageUpgrade")   false
matchesAsWord("BP_ShopUpgrade",   "upgrade")         true
```

**A multi-word concept could never match anything**, including the exact PascalCase name of the asset
it names. The comparison lowercased the whole concept and tested it against single tokens, so
`"ShopUpgrade"` was checked against `["bp", "shop", "upgrade"]` and matched none of them. Single-word
queries worked, which is why it survived this long — it looks fine until you try two words.

A concept is now split the same way a name is, and matched as a **run of consecutive words**. That
keeps the strictness that made the rule exist — `"bar"` still does not match `TurretBarrelLoc`,
because Turret/Barrel/Loc contains no word "bar" — while `"TurretBarrel"` now does, which is right.
The derived-form rule (`GetVacuumable` is the vacuum system) applies to the last word only, so
`"shopping upgrade"` does not reach `ShopUpgrade` through a suffix on a word that is not the one
being matched.

### The explanation was behind the flag for more detail

The same failure exposed a second thing. `mapSystem` writes an excellent sentence for an empty
result — *"Nothing in the project has X as a word. 3 name(s) contain it inside a longer one, the way
`bar` sits inside `TurretBarrelLoc`"* — and the compact reply **dropped it**, answering with
`assetCount: 0` and *"Pass detail:true for exact asset paths and the reference graph."*

That is advice a caller has no reason to take. They have no assets; a flag promising asset paths
reads as irrelevant. The one sentence that turns a confusing zero into an answer was reachable only
by asking for **more of the thing that was empty**. An empty map now carries its notes, and a
non-empty one pays nothing for it.

### The prose inside the server was the last unguarded text

The Epic check first, since it is a standing item: nothing new. Still the 5.8 experimental plugin,
still Tool Search mode, still loopback-only with no auth, and still *"MCP Resources and Prompts are
not advertised by any shipping toolset."*

That last line pointed at a surface here nobody had looked at. This server **does** advertise three
prompts — `unreal_handbook`, `unreal_recipes`, `unreal_workflow` — and they turn out to be current:
the routing section added two sections ago flows through into `/unreal_workflow` automatically,
because the prompt serves the file rather than a copy of it.

What that trail did turn up is the last piece of unguarded text in the project. Four documents were
already checked for tools that do not exist — the README, the complaint matrix, the workflow guide,
and the guide documents. **`src/index.ts` was not**, and it carries three kinds of prose that name
tools:

- the **standing instructions**, read by every model before its first call;
- the **reply hints**, read at the moment a model is deciding what to do next;
- the **fallback text** served when the docs folder is missing — which is exactly when someone most
  needs the names to be right.

117 tool mentions, 0 phantom today, and nothing would have noticed a rename. Now guarded, verified by
introducing one and watching it fail.

That guard immediately found a second thing: **`check:docs` was already failing**, and it was mine.
The contents check added last session scans `^## ` lines, and the section above quotes the old heading
layout in a fenced code block — so it demanded the contents list five headings that do not exist. A
documentation check tripped by documentation, and the same *matched a mention rather than a use*
mistake this repo keeps making. Code blocks are now stripped before the scan.

Worth being plain about how that slipped through: last session's verification piped `check:docs`
through `tail -1`, which showed the *last* line rather than the failure above it. A check whose output
you truncate is a check you are not reading.

### 97% of the README was one section

"Keep things well organised" is part of the brief, and this file had quietly stopped being. Its
top-level structure:

```text
## Prerequisites            line 15
## Setup                    line 22
## Tools exposed            line 60   <- to line 5,560
## Configuration            line 5,560
## Pointing an MCP client   line 5,600
## Recommended agent workflow
## Notes / limitations
```

**One section held 97% of the document**, and everything a person needs to actually run the thing —
configuration, pointing a client at it, the workflow, the limitations — sat underneath 5,500 lines of
reference and rationale. There was no contents block, so the only way to find "how do I install this"
was to scroll past 146 subsections.

The practical sections now come first, and there is a *Contents* at the top grouped by what you came
for: getting it running, using it well, reference and rationale. Nothing was deleted — the rationale
is the record of why each decision was made, and it stays.

`check:docs` verifies the contents lists every top-level section, because an index that has fallen
behind is worse than none: it is trusted. Verified by removing an entry and watching it fail. That is
the third index in this repo to get that treatment, after the symptom lists and the guide documents,
and the lesson is the same each time — **any list written by hand about something that grows needs a
check, or it silently becomes fiction.**

### The README had the same disease, one section apart

Having found the instructions quoting numbers that had drifted, the obvious next question was whether
this file does it too. It did, and the example is almost comic: one section records `search` moving to
**2,292 tokens**, and a later section says *"`search` is 2,205 and has not moved"*.

The distinction that matters is between two kinds of number, and this file is mostly full of the safe
kind:

- **History** — "4,480 → 3,858 tokens", "7,562 → 2,726". Frozen at the time of the change, correct
  forever, and the record of why something was done.
- **Current state** — "`search` is 2,205". True when written and rotting from that moment.

There is now exactly one current-state claim in this README: the
[What this costs today](#what-this-costs-today) table. Everything else points at it, and
`measure:profiles` verifies every row against a live measurement — between HTML markers, so the parse
cannot drift onto a different table. Verified by putting a wrong number in and watching it report
*"the cost table says search is 9999 tokens and it measures 2292"*.

That message needed fixing too. A README mismatch has none of the fields a budget overrun has, so the
first version failed correctly and printed a line of `undefined` — the same defect as the derived
ceiling a few sections ago, which is a fair sign that failure paths deserve the same care as the
success ones.

### Every number in the instructions was wrong

Reading the standing instructions end to end — the text a `full` session holds before every call —
turned up something worse than an omission. They make a specific, checkable claim:

> Every large read takes a filter (match, fields, replicatedOnly, direction, limit). Use it:
> **the difference is 4,685 tokens against 292**, not a trim.

Re-measured against the real project, every figure quoted anywhere in the server had drifted:

| quoted | actual |
|---|---|
| `read_class_defaults` 4,685 → 292 | **3,237 → 218** |
| `list_variables` 2,397 / 599 / 172 | **1,732 / 508 / 126** |
| `list_data_table_rows` 6,985 → 945 | **5,472 → 182** |

They drifted **downward** — compact JSON, float trimming and deduplicated fix text all made the reads
cheaper, and `fields` on a Data Table did not exist when the sentence was written. Wrong in the
harmless direction is still wrong: this project's whole argument rests on its measurements being real,
and a stale number in the one text nobody can skip undermines every number beside it.

`measure:reads` now **checks the quotes against what it measures**, with a 15% tolerance, because
these are illustrations rather than contracts and a project's own content moves them. 30% drift fails
the run. Verified by putting a wrong number in and watching it report *"quoted as ~9999 tokens … and
measures 3237 (68% out)"*.

That is the guard this repo did not have and most needed: it has been generating measured claims for
weeks, and nothing checked that any of them were still true.

### Neither did the one text every model reads

The guide has to be *fetched*. The server instructions do not — they are the standing context every
model holds before its first call, and on the `search` profile they are the only thing it has besides
four tool names. They taught presets, group pricing, and `enable_tools`. They never mentioned that
`unreal_list_tools` will take the user's sentence.

So the routing was invisible in both places a model could have learned about it. Fixed in the more
important one for **+87 tokens** on `search` (2,205 → 2,292), with the detail left in the guide rather
than repeated here:

```text
OR JUST HAND OVER WHAT THE USER SAID, if you have their words and no plan yet:
  unreal_list_tools({ match: "upgrades aren't showing up in the shop" })
It reads the sentence when no tool name matches, tells a bug from a feature from a change, and
names the words it matched so you can judge the answer. unreal_guide topic:"workflow" has the rest.
```

**An example in the standing instructions is the first thing a model tries**, so one that returns
nothing teaches it the mechanism does not work. `check:protocol` now extracts the calls the
instructions show and *runs* them, rather than checking that the text mentions them.

That guard was written wrong first, in the way this repo keeps finding. `startServer()` defaults to
`full`, whose instructions contain no such example — so the regex matched zero calls and the check
passed **without doing anything**. It now reads the `search` profile where the example lives, and
treats finding *no* example as a failure, because vacuity is the one result that must never look like
success. Verified by pointing the example at a phrase that matches nothing and watching it fail.

### The guide never mentioned the way in

`unreal_guide` serves three documents — the Blueprint handbook, the recipes, the agent workflow — and
they are teaching a model **fetches and follows**. The workflow doc opens well: `unreal_doctor` if
anything is broken, then `unreal_plan_feature` with the user's request in their own words.

It has never mentioned `unreal_list_tools({ match: "<what the user said>" })`. That matters twice
over. A session that starts on the `search` profile has four tools and **cannot reach step 1** until
it enables something, and the routing built over the last several sessions — the thing that reads a
sentence and answers with the tools for it — was reachable only by a model that already knew it
existed.

There is now a *Starting from a sentence* section, 577 tokens when fetched, with the table of what
each intent gets and the two traps a caller most needs warned about: a rename is not a value change,
and a C++ edit is not finished when the file is right.

**And nothing guarded these documents at all.** `check:docs` covers the README, `check:symptoms`
covers the routing table, and the three files a model actually reads had no check — so a renamed
tool would leave a recipe telling a model to call something that does not exist, at the moment it had
gone looking for instructions. That is worse than the same mistake in the README: a human reading a
stale README is puzzled, a model reading a stale recipe follows it.

`npm run check:guides` reads the guide list from the tool's own map rather than a hardcoded list, so a
fourth document cannot be added without it noticing. 70 tool mentions, all registered — verified by
breaking one and watching it fail.

### The C++ leg stopped one step short of working

Applying the same question to the substrate the goal names last: *"whether it's C++ or Blueprints or a
Data Table."*

```text
"my C++ change is not showing up"     -> find_in_data_tables, search_project, trace_variable, find_source
"I edited the header file"            -> nothing
"recompile the C++"                   -> nothing
  advice mentions rebuilding C++: false
```

`find_source` was routed from the start, and it is only half the job. **A Blueprint change is live the
moment it compiles; a C++ change sits in a file the running editor has never read.** A model that
edits the header and reports the work done has left the editor running the old code — which looks
exactly like the change not working, and is the failure mode this repo cares most about: reported
finished, isn't.

`unreal_compile_cpp` and `unreal_hot_reload_cpp` already existed and their own descriptions say
precisely the right thing — *"this is the step that makes a native fix real"*. Nothing pointed a
caller at them. Same defect as the previous section, one substrate over.

There is now a C++ entry in the index, and the change advice carries the follow-up for a request
phrased as a change rather than as a compile problem.

One matching rule had to change to make it work. `"c++"` is three characters, so the short-word rule
demanded a word boundary — and `/c\+\+/` **never matches "C++ class"**, because the boundary after
`+` needs a word character and a space is not one. That rule exists to stop `ai` matching inside
"chain"; the reasoning only applies to letters, so a phrase containing punctuation is matched as a
substring. The tests pin both halves: `c++` matches, and `ai`/`lag` still do not match inside "chain"
and "flag".

### The tools existed and the routing never heard about them

Three commits went into closing "it finds it and then cannot change it" — rename and remove for
assets, variables, components and functions. Then the sentence that started it was asked again:

```text
"rename FireRate to RateOfFire"
  intent: changing
  tools : find_in_data_tables, search_project, trace_variable, find_source
  advice mentions a rename tool: false
```

Four tools that **find** things, and advice naming `set_data_table_row` and `set_class_default` —
none of which renames anything. The capability was built and the router was never told, so the answer
was still *here is how to locate it, and then nothing*, with the tool that does the job sitting one
directory away. **Building something and not telling the router leaves it unreachable for exactly the
caller it was built for.**

A rename and a removal are now their own routes inside the change intent, checked before the generic
one:

| said | leads with |
|---|---|
| "rename FireRate to RateOfFire" | `rename_variable`, `rename_asset`, `rename_component` |
| "delete the old health variable" | `remove_variable`, `remove_function`, `remove_component` |
| "the machine gun should cost 500" | `find_in_data_tables`, `search_project`, … |

The reasons differ too, because the risks do. A rename is dangerous because everything that referred
to the old name is left pointing at nothing — so the advice is that each of these *rebinds the
references as it goes*. A removal is dangerous because of what still depends on the thing — so the
advice is that each of these *refuses while something still references it, and names what does*.

`check:symptoms` had to be widened a second time, and this time properly. It first read only
`SYMPTOMS[].tools`; then `BUILD_TOOLS` and `CHANGE_TOOLS` were named explicitly; then `RENAME_TOOLS`
and `REMOVE_TOOLS` arrived and it was silently checking two lists out of four — confirmed by putting
a typo in one and watching it print `ok`. It now **finds** every `*_TOOLS` list rather than being told
their names, because a guard that must be edited whenever the thing it guards grows will keep being a
step behind. 26 tools checked before, 33 across 4 lists now.

### Finishing the lifecycle, and a trim that was not there

The asymmetry is now closed: everything this server can create, it can also remove or rename.
`rename_component` goes through `FBlueprintEditorUtils::RenameComponentMemberVariable`, because a
component is reached from a graph through a member variable of the same name and only that rebinds
both. `remove_component` promotes attached children rather than deleting them, and says how many —
the editor does the same thing silently, which is how a subtree disappears unnoticed.
`remove_function` refuses while anything still calls it, naming the graphs and the count, the same
rule `remove_variable` and `delete_asset` apply.

Before adding them, the growth of `full` was worth testing rather than assuming. **Trimming was
looked for and is not available**, which is worth recording as a result:

- The largest description, `unreal_build_graph` at 3,499 characters, was read end to end. Four
  paragraphs: when to use `add_event_handler` instead, the transactional rollback semantics, the
  exact `"ref.pinName"` connection format with examples, and the round-trip cost that drives a caller
  to batch. Every one changes behaviour. There is no fat.
- `title` is 3% of the payload and is only a *fallback* for the internal summary — but it is a
  human-readable label some MCP clients render, so removing it trades a real UX loss for tokens.
  Unlike `$schema`, which no client reads, this one is not free.

So the honest position is that `full` grows with capability, and that is not bloat. Which meant the
guard was wrong, not the surface.

**`full` is now budgeted per tool rather than in total.** Its absolute ceiling had been raised five
times — 30k, 33k, 35k, 37k, 37.5k, 38k — each time for capability that was genuinely wanted and each
raise argued for honestly. That is the problem: "everything" grows whenever the tool can do more, so
an absolute ceiling on it can only ratchet upward, and a number that always moves when it is touched
has stopped being a budget and become a changelog.

What that ceiling was really protecting is efficiency, and there is already a number for it: **327
tokens per tool against a 350 budget**, falling as tools are added. That fails when descriptions
bloat and does not fail when the surface honestly grows.

The profiles that are *meant* to be small keep their absolute ceilings, because those are real
promises — `search` must cost less than the thing it discovers, `minimal` must fit a small local
model. **Those are the numbers a frontier model actually pays**, they are listed under
[What this costs today](#what-this-costs-today), and they have barely moved while `full` doubled.

### You could add a variable but never remove or rename one

The same coverage question, asked of the authoring surface rather than the content browser:

```text
add_variable      yes      remove / rename   nothing
add_component     yes      remove / rename   nothing
add_struct_field  yes      remove / rename   nothing
create_function   yes      remove / rename   nothing
```

Everything could be created and nothing taken away. And the rename is the one that stings, because
**"rename FireRate to RateOfFire" is a *variable* rename** — the sentence this repo has quoted all
along as the change-request example. The asset rename added alongside it is a real gap closed, and it
is not the thing that sentence asks for. Worth saying plainly: the wrong rename got built first.

`unreal_rename_variable` goes through `FBlueprintEditorUtils::RenameMemberVariable`, which rebinds
every GET and SET node in every graph, and reports how many nodes moved and which graphs they were
in. Editing the descriptor by hand leaves nodes bound to a name that no longer exists — the Blueprint
stops compiling and the damage is spread across graphs nobody was looking at.

`unreal_remove_variable` **refuses while any node still reads it**, naming the graphs and the count,
because removing it deletes those nodes too. That is the same rule `delete_asset` applies to an asset
something still references, for the same reason: the damage lands where the caller is not looking.
`force: true` when that is genuinely what you mean.

A variable inherited from a C++ parent is refused with the reason, and a name that does not match
lists the ones that do — the commonest cause being a case difference in your own Blueprint.

Compiled against 5.6, 5.8 and the game target. One thing the compiler caught that reading would not
have: `LoadBlueprintByPath` is a **private** static on `FMCPCommandHandler`, so a namespace-level
helper cannot call it. The handlers are members and do the load themselves; only the half that does
not need the access stayed shared.

### You could delete an asset but not rename one

A coverage question, asked by listing what a person does in the content browser every day and checking
which of them exist:

```text
rename     nothing
duplicate  nothing
move       nothing
delete     delete_asset
```

That is a gap worth being embarrassed about, because *"rename FireRate to RateOfFire"* is one of the
sentences the change-request routing was **built and tested against**. The routing worked, the tools
it named could find the thing — and then nothing could change it. Duplicating matters for the other
half: `plan_feature` says to extend what already exists, and duplicating `BP_DamageUpgrade` is exactly
how a person starts a second upgrade.

Both go through `FAssetToolsModule` rather than moving files, because **that is what fixes up the
references**. A rename that leaves every referencing Blueprint pointing at the old path has not
renamed anything, it has broken the project — and it looks like it worked until the next time
anything loads.

Two things the implementation had to bend to:

- **The save is composed in the tool layer, not the bridge.** An unsaved rename reverts on restart, so
  saving is not optional — but `SaveAssetPackage` lives in an anonymous namespace inside a
  five-thousand-line file, and prying it out to share it is a bigger and riskier edit than the
  feature. The MCP tool calls `save_asset` afterwards, which is the composite pattern used everywhere
  here, keeps the bridge command doing one thing, and makes the save visible in the reply.
- **`MakeErrorResponse` and `MakeOkResponse` are file-local too**, which is why every sibling file
  (`MCPSequence.cpp`, `MCPInput.cpp`, `MCPConsole.cpp`) builds its own object and sets `error` and
  `detail` directly. Following the codebase beat fighting it.

Verified by `npm run check:engines`, which compiles into a temporary host project and so runs with the
editor open: **5.6, 5.8 and the game target all build.** The commands are dark until the plugin is
rebuilt, like the others — but they compile, which is the part that can be checked now.

### Asking about one column cost the whole table

`list_data_table_rows` is the largest read left, and unlike the others it barely moved when the
replies became compact — 4%, because it is not indentation, it is nine rows of nested CommonUI struct
literals. You could page rows and pick a single row, but you could not pick a **column**.

That matters because the change-request question is nearly always about one field — *what does
everything cost*, *which rows have no UpgradeClass* — and answering it meant pulling every field of
every row:

```text
every column                        5,472 tokens
fields: ["DisplayName","NavBarPriority"]   229 tokens
```

Same name, same semantics and the same words as `list_blueprints`' existing `fields`, because two
tools with a parameter of the same name behaving differently would be worse than one tool not having
it: a view rather than a filter, every row still returned, and a name that matches nothing **reported
rather than silently dropped**. Asking for `Cost` on a table whose column is `Price` now says the
column does not exist — otherwise every row comes back present and empty, which reads as *no row has
a cost* rather than *there is no such column*, and the caller draws a wrong conclusion about their own
data.

Two other things were measured here and **deliberately not built**:

- **Dropping default members inside struct literals** — 706 of them (`=False`, `=0`, `=None`) in one
  reply, close to half of it. The bridge already exports with a `DefaultPtr`, so anything that
  survived that pruning is a genuine difference from the default. Dropping `X=0` where the default is
  `1` would silently change the value. That is data corruption wearing compaction's clothes.
- **Deduplicating repeated field values across rows** — 20% of long values are exact repeats, worth
  ~2,560 tokens. But unlike the fix text, these are values a caller *writes back*, and a per-row
  reference invites a model to paste `@ref` into a Data Table. The safe subset — fields identical in
  every row — is worth only 309 tokens across every table in the project, which does not justify a
  new reply shape.

### 23% of every reply was indentation

Chasing repeated text one reply at a time led to the thing underneath all of them. The top repeated
substring in `list_blueprints` was not a path or a class name — it was `
    {
      "path": "/G`,
a hundred times. Every reply went out as `JSON.stringify(value, null, 2)`.

Measured across eight reads on the real project:

| read | before | after | |
|---|---:|---:|---:|
| `review_blueprint` | 4,235 | **2,726** | −36% |
| `read_blueprint_summary` | 3,110 | **2,121** | −32% |
| `read_class_defaults` | 4,688 | **3,237** | −31% |
| `list_variables` | 2,449 | **1,732** | −29% |
| `project_health` | 1,617 | **1,267** | −22% |
| `list_blueprints` | 3,328 | **2,669** | −20% |
| `audit_project` | 3,442 | **2,856** | −17% |
| `list_data_table_rows` | 5,695 | **5,458** | −4% |
| **total** | **28,563** | **22,066** | **−23%** |

The spread is just the shape of the data: a long list of small objects is mostly indentation, and a
short list of enormous struct literals is mostly the literals.

**It is the same JSON.** Any parser produces exactly the same object; no field changes, none is
dropped, and every newline that carries meaning — the paragraph breaks inside `next` and `fix` text —
lives inside a string and is untouched by the indent setting. This is the purest form of the trade
this project exists to make: fewer tokens, nothing given up. The three flagship journeys went from
4,480 to **3,858 tokens** without a single assertion changing.

The CLI paths a *human* reads — the doctor report, the audit written to a file, the measurement
scripts — still pretty-print, because there the indentation is the product.

One thing deliberately **not** done afterwards: the reply budgets in `check:replies` now sit well
above what they measure, and the instinct is to re-cut them. That would be wrong. Those ceilings are
*"budgets argued for, not observations rounded up"* — `list_tools match: 500` means "a narrow search
should answer narrowly", and coming in at 149 is the budget being met, not a stale threshold. Lowering
them to hug the new numbers would replace an argument with an observation.

### The same fix, said thirty times

A review of `BP_Player` returns 30 findings drawn from **8 distinct checks**, and every one carried
the full fix text for its check. `unlabelled-sections` fires ten times, so its 187 characters of
advice were sent ten times:

```text
fix text sent   5,680 chars
distinct        1,408 chars
repetition      4,272 chars   ~1,068 tokens, 20% of the reply
```

The advice for a check does not vary by where it fired — that is what makes it a check — so the
repetition carries nothing. The fixes are now a map at the top of the reply keyed by `check`, which
every finding already names. **5,398 → 4,235 tokens, 22%**, and this is the largest read on the
surface after the Data Table one.

Two things kept it honest:

- **It is done where the review is serialised, not where it is produced.** `audit.ts` reads
  `finding.fix` in twelve places off the same `reviewBlueprint`. Stripping the field at the source
  would have broken the audit; stripping it at the tool boundary does not touch it. That is this
  repo's existing rule — compact in the tool layer, never in the shared function — applied to the
  one place it had not been.
- **A check whose advice varies keeps its own text.** If two findings under one check ever carry
  different fixes, the first wins the map slot and the rest keep their own field. Two different
  pieces of advice under one key would silently give one finding the other's fix, which is worse
  than the repetition being removed.

### `unknown_cmd` told a model the feature did not exist

This repo has carried a line for many sessions saying roughly "the plugin binary is older than the
server, so about eleven bridge commands are dark until it is rebuilt". What was never checked is what
a model **experiences** when it calls one:

```text
UnrealMCPBridge error: unknown_cmd: run_console_command
```

Six words. Nothing to say the tool exists, that the plugin is stale rather than the feature missing,
that a rebuild fixes it, or that the rest of the surface is fine. A model reads that as *this cannot
be done* and stops asking — which on this project is happening to **nine of twelve probed commands**.

`unreal_doctor` diagnoses it properly and always has:

```text
fail  plugin features    At least 9 of the 12 probed commands are missing from this plugin
warn  plugin freshness   The running plugin was built Aug 30 2026 19:42:16, and the C++ source
                         on disk is newer.
```

But a model in the middle of a task hits the error, not the diagnosis. The error now points at it:
the plugin binary is older than this server, everything the older plugin knows still works so this is
not a reason to stop, `unreal_doctor` lists what is affected, and the cure is to close the editor, run
`npm run build:engines`, and reopen. It costs nothing in standing context — it is attached on error
only, and a working call carries no such note.

The message says the server **sends** the command rather than *has a tool for* it, deliberately.
Three bridge commands are internal — `find_broken_names`, `live_coding_compile`,
`live_coding_status` — reached only through a composite, and `hot_reload_cpp` hits exactly this error
on a stale plugin. Claiming a tool exists for one of those would be a confident falsehood inside a
message whose whole job is to correct a wrong conclusion.

### The three promises, run from the sentence: `npm run trial:workflows`

Each of the journeys this project is built around was verified by hand, once, in the session that
built it — and none of them was repeatable. The headline claims rested on a measurement nobody could
re-run, and the routing they depend on is a keyword table: the single most fragile thing here, where
a rename or a word dropped from a `says` list breaks a journey without breaking a unit test.

```text
1 a bug in plain language: "upgrades aren't showing up in the shop"      3 calls, ~1629 tokens
2 a feature request: "add a new shop upgrade that increases fire rate"   3 calls, ~1751 tokens
3 a change request: "the machine gun should cost 500 instead of 300"     8 calls, ~1100 tokens

standing context on the `search` profile: ~1135 tokens, paid on every request
all three journeys: 14 calls, ~4480 tokens of replies
```

It reports **calls and tokens per journey** as well as pass/fail, because "does it still work" and
"did it get more expensive" are different regressions and only the first one throws. Journeys 1 and 2
are read-only against the real project; journey 3 builds its own table in the scratch namespace.

Three things this trial got wrong about itself before it was right, all worth keeping:

- **Its teardown used tools the journeys had not enabled.** It left two assets behind and said so —
  `Tool unreal_delete_asset disabled`. The fix was not to enable everything up front, which would
  have quietly made journeys 1 and 2 dishonest about what a bare session can reach, but to enable
  the teardown tools *at teardown*, which is not part of any journey.
- **A bare `catch` over the scratch sweep hid a validation error.** `list_assets` requires a
  `className`; the sweep omitted it, the catch ate the rejection, the sweep silently did nothing, and
  journey 3 then found a *leftover* table from a previous run, wrote the new value into that, and
  verified the table it had just created. Two different tables, reported as a failure whose cause was
  nowhere in the output — the bare-catch pattern this repo keeps finding, in a file written to catch
  exactly that.
- **The headline counted its own setup.** Reporting total calls meant the number moved with how much
  residue happened to be lying around, which is the opposite of something you can compare between
  runs.

The sweep also generalised the delete diagnosis. The stuck leftovers are not only Blueprints: a
`UserDefinedStruct` used as a Data Table's row struct gets stuck the same way when the table is
deleted first. Same shape, same cure — delete the set in one `paths[]` call.

### The loop test: `npm run trial:feature`

The unit tests cover the pieces, and all 315 were green while five separate defects sat in the path
*between* them. Every one appeared only when something used the tools in order:

- deleting a Blueprint and rebuilding it under the same name refused, so iterating stopped dead
- the quality gate returned score 95 for a Blueprint that did not compile
- the review penalised the placeholder `BeginPlay` and `Tick` that `create_blueprint` had just made
- `verify_feature` counted one asset twice, because the journal spells it two ways
- and the first trial harness reported "0 stalls" while three calls had plainly failed

None of those is visible from a unit test, because each is about **what the next call sees**. So this
builds a small feature end to end — create, add a component, build a graph, compile, review, verify,
throw it away, build it again — and checks that each reply contains what that step is *for*. A reply
that merely arrives is not a working step; that mistake hid three of the five.

It covers the surfaces a model is told it can work with — **Blueprints, Data Tables, C++, the
VFX/sound/animation components, and UMG** —
because "whether it is C++ or Blueprints or a Data Table" is the actual requirement and only one of
those was being exercised. The data leg builds a struct and a table, adds a row whose reference is
deliberately empty, checks that `check_data_tables` reports it, repairs it with `set_data_table_row`,
confirms the table is clean, and deletes the row to prove the values come back. The C++ leg maps the
modules and locates a symbol, and treats a Blueprint-only project as a valid answer rather than a
failure.

It uses engine assets only, so it runs against any project, and it deletes what it made even when it
fails. Thirty-three calls, about 3,950 tokens.

The UI leg is there because "a HUD bound to a value" is one of the recipes this project ships, and a
documented workflow that nothing exercises is a claim rather than a feature. It checks the widget
tree reports a panel, not just the two widget names — a flat list of names would pass and tell a
model nothing about nesting.

Verified by breaking it on purpose: with the ghost-node exemption removed, it reports
`review: review flagged the placeholder events again` and exits 1. A trial that has never failed is
not evidence of anything.

### The other loop: `npm run trial:diagnose`

`trial:feature` walks the authoring loop — build a thing, check it works. This walks the loop people
ask for first: *"I tell it a bug in plain text and it finds it and fixes it."* Nothing exercised that
end to end, so the tools answering it were covered only by unit tests and by me reading their output
and being satisfied.

It plants a defect rather than borrowing one from the open project, because a trial that depends on a
particular project's mistakes stops working the moment somebody fixes them. The defect is a node left
wired to nothing — the commonest real mess in a Blueprint anyone has iterated on, and exactly the
thing a human notices by eye and a model cannot see at all unless told. Then it: reviews and requires
the reply to **name** the orphan; compiles and requires that to come back **clean**, because if a
model trusts the compiler to catch this class of defect it will be told everything is fine, which is
why `review` exists at all; cleans up; and re-reviews **independently**, because trusting cleanup's
own account of its work is how a tool gets away with claiming success.

Eight calls, about 1,450 tokens for the whole find-and-fix loop.

The distinction it is built around: a diagnostic tool can be perfectly healthy and still useless, by
returning a reply that is true and unactionable. `"score": 72` is true. So is `"3 findings"`. Neither
tells a model which node to touch. Every check asserts the reply contains something a model could
**act** on.

Verified by breaking it both ways. On its first run the planted node used a function that does not
exist (`GetGameTimeInSeconds` is not on `GameplayStatics`), so no defect was planted and the finder
step correctly reported that nothing was found — the trial caught its own author. And with the
finder's matcher replaced by one that can never match, it exits 1.

### Live verification: `npm run verify:live`

Compiling proves the plugin builds. Running it against a real editor is the only thing that proves
a command works, and this project keeps being reminded of the difference. With an editor open on a
project that has the plugin enabled:

```bash
npm run verify:live             # creates assets under /Game/MCPLiveVerify/ and deletes them again
npm run verify:live -- --keep   # leave them behind to inspect
```

30 checks covering structs, enums, `struct:`/`enum:` variable types, the whole UMG surface, and the
error paths (a wrong type, a native struct, a second child on a Button, an unknown parent), because
wrong-input behaviour is half the product.

Its first run found three real bugs that compiling could not have:

1. **`create_enum` silently produced the wrong asset.** A new enum arrives *empty*, unlike a new
   struct, which arrives with one placeholder member. The code assumed the struct behaviour, so
   every `SetEnumeratorDisplayName` landed on an index that did not exist yet and did nothing.
   Nothing failed. The result was one enumerator too few, all still named `NewEnumeratorN`. The
   command also reported success by echoing the requested entry count back, which is precisely how
   it stayed invisible; it now reads the count off the asset.
2. **New commands inherited an 8s timeout.** `add_widget` recompiles the Widget Blueprint and was
   being cut off mid-call. See C8 in the complaint matrix: the policy is now inverted, so cheap
   reads are the enumerated list and everything else gets a generous default.
3. **`create_blueprint` could hard-crash the editor.** See below.

### Crash sweep: `npm run fuzz:crash`

An assert or access violation inside the editor is not an error a caller can handle or retry. It
is the editor gone, along with every unsaved change in the user's project. A wrong answer costs a
retry; a crash costs them their work. So crashes get their own sweep, separate from correctness
testing:

```bash
npm run fuzz:crash                 # with an editor open
npm run fuzz:crash -- --limit 800  # place more of the catalog
```

Two passes, 477 attempts on the standard run:

1. **Every node type the bridge places directly**, valid and invalid, plus **300 real functions
   taken from the running engine's own catalog** and placed into a scratch graph.
2. **Adversarial input on every create path**: empty, 512 characters, unicode, emoji, embedded
   dots and slashes, `../..` traversal, quotes, `None`, a leading digit.

A structured refusal counts as a **pass** - the tool said no instead of dying. Only a dead
connection counts as a failure. Because a crash also ends the run, progress is written after every
single attempt, so the sweep resumes past the input that killed the editor and names it in the
report.

Result on the current build: **364 accepted, 113 refused cleanly, 0 crashes**, including all 300
catalog functions.

The sweep found this, which is the second crash of the family and the reason the pass exists:

```
Assertion failed: false [UnrealNames.cpp:3278]
FName's 1023 max length exceeded. Got 1039 characters excluding null-terminator
```

A 512-character asset name closed the editor. The doubling is the trap: the object path is
`<package>.<name>`, so the name is counted twice and 512 sails past 1023. Every create path now
validates the path first - length caps well below the engine's limit, `IsValidLongPackageName`,
and `IsValidXName` - because there is no error to catch once `FName` asserts.

### The crash worth naming

`FPackageName::DoesPackageExist` answers for the **disk**. `FKismetEditorUtilities::CreateBlueprint`
asserts on **memory**:

```
Assertion failed: FindObject<UBlueprint>(Outer, *NewBPName.ToString()) == 0
```

Those two disagree in a completely ordinary situation: delete an asset, then create one with the
same name in the same session. The package is off disk so the guard passes; the `UObject` is still
resident so the engine asserts. An assert is not an error a caller can handle, it is the editor
gone, taking every unsaved change with it. This closed the editor during a live verification run.

All four create paths now check memory first and return `asset_name_in_use` with an explanation,
and the exact create-delete-create sequence is a regression check that also asserts the editor is
still answering afterwards. A tool that can crash the editor from a plain input mistake is worse
than one missing the feature.

### Everything else the New Asset menu can make

This server could create eight kinds of asset — Blueprint, Widget Blueprint, Data Table, Enum,
Struct, Material, Material Instance, Level — each through a handler that hard-codes one factory.
Every other kind was unreachable, and the gap was not exotic. An ordinary UE5 request:

> add a dash on Left Shift

needs an `InputAction` asset. This server could *bind* an InputAction to a key with
`unreal_map_input_key` and could never *make* one, so the feature dead-ended at step one on any
modern project. Enhanced Input was supported in every respect except the first.

The fix is the thing the editor already does. Every creatable asset type has a `UFactory` whose
`GetSupportedClass()` names it, and "New Asset" is a menu built by walking those factories.
`unreal_create_asset` finds the factory the same way and calls the same `IAssetTools::CreateAsset`
the eight specific handlers call. **What the editor can make, this can make** — without a
handler per asset type, forever.

Three decisions in it are load-bearing:

- **`CreateAsset`, not `CreateAssetWithDialog`.** The dialog form calls `ConfigureProperties()`,
  which opens a *modal window* — and a modal window in a headless bridge command is a hang that
  takes the editor with it.
- **Exact class match only.** A factory registered for a parent class would produce an asset of the
  wrong type while reporting success. "Close enough" is the failure this project keeps finding in
  other tools.
- **The eight with dedicated tools are refused, by name.** A `UBlueprintFactory` with no parent
  class, or a `UDataTableFactory` with no row struct, produces an asset that exists and is broken —
  worse than an error, because the caller believes it worked. It refuses and says which tool to use.
  It also refuses to overwrite an existing asset.

It compiles against 5.6, 5.8 and the game target. Like the other seven commands added since the
plugin binary was last built, it is verified by `npm run trial:lifecycle`, which asserts the created
asset is *of the class asked for*, that both refusals refuse, and that a refused creation left
nothing behind.

### Input, and a surface inside a command that nobody was guarding

`create_asset` let a feature make an `InputAction`. It still could not make one *do* anything: the
node that reacts to an InputAction in a graph — `UK2Node_EnhancedInputAction` — could not be placed.
So "add a dash on Left Shift" got one step further and stopped again.

Worse, checking how far it got turned up something else. `unreal_add_node` takes a `nodeType`, and
that string is the widest surface in the project — fourteen kinds of graph node behind one
parameter. Three of them were implemented in C++, accepted by the bridge, and in **no tool's enum**:

```text
InputKey     InputAxis     Self
```

The engine could build them, the bridge could build them, and no model could ask. This is the second
time the same thing happened in the same command — `netMode` and `reliable` were implemented and
unreachable too, which meant a Server RPC, the thing all multiplayer logic is built from, could not
be authored at all. That one was found by reading the C++ for an unrelated reason. This one was found
by reading an error message from an out-of-date plugin binary, which happened to *list* what it
accepted. Neither is a way to find things.

`check:parity` guards the command surface — 93 bridge commands, 115 tools, all matched — and says
nothing about the surface *inside* a command. `check:nodetypes` now does, failing in four directions:

- a nodeType the bridge implements that no enum offers
- a nodeType offered that the bridge does not implement (`unknown_node_type`, after the model has
  already decided what to build)
- the two enums disagreeing — `add_node` and `build_graph` each declare their own, and a model told
  one thing by one and something else by the other trusts whichever it read last
- a type in the enum with no line describing it: callable, but not findable

All four were watched failing on their own before being trusted. The first version of the fourth
reported `VariableGet` missing because it is written as `"VariableGet" / "VariableSet":` — the guard
failing on the *shape* of the prose rather than its absence, which is the same "matched a mention
rather than a use" mistake every other guard here has had to unlearn.

**The trap worth naming.** `InputKey` and `InputAxis` are the pre-Enhanced-Input events. On a project
that uses Enhanced Input they compile perfectly and then never fire — no error, no warning, the key
just does nothing. The description now says so, and says how to tell the two kinds of project apart
(`list_assets className=InputMappingContext`), because this is the failure mode that costs the most
time: everything looks right.

### Keyed state, and a container nobody could ask for

Sweeping the same way as the node types — every place the C++ switches on a string a model has to
spell correctly — turned up the `type` descriptor, the second-widest surface in the project. Two
things were wrong with it.

**A container that existed and could not be requested.** `ResolvePinType` accepts `<set>`, and the
string appeared **nowhere** in anything a model reads. This server ships instructions saying *"never
guess a name; a guess costs a failed call"* and then left models guessing about containers.

**Maps could be read and not written.** The bridge could *report* `container: "map"` on an existing
variable and had no way to create one. So "a score keyed by player name" — ordinary Blueprint state —
had no answer but two parallel arrays, which is precisely the shape this project exists to stop a
model from writing. `map<name,int>` and `map<name,object:Actor>` now work, resolved recursively so
every key and value type works for free.

Two refusals come with it, both asked of the engine rather than hard-coded: a key with no hash
(`FBlueprintEditorUtils::HasGetTypeHash`) is refused with the reason, because a vector-keyed map is
one the editor cannot use; and a nested container is refused, because Blueprint does not allow it.

**And a map read back never said what it mapped to.** `container: "map"` was the whole answer, so a
`map<name,int>` and a `map<name,Actor>` were indistinguishable to the model deciding how to use one.
The reads now carry `valueType` and `valueSubType` — the same silence-means-two-things bug the
`container` field itself was written to fix, one level further down.

`check:types` guards the direction that can be silent: a form the bridge accepts that no description
names. The reverse — prose naming a form the C++ rejects — announces itself immediately with a
`bad_type` error, so it does not need automating. Four spellings are listed as deliberately untaught
(`boolean`, `int32`, `integer`, `real`): a model needs one way to say a thing, and teaching synonyms
costs tokens in every profile. The guard also fails if one of *those* notes outlives the alias it
describes.

The grammar text costs 135 standing tokens. `minimal`, the profile built for a 14B at 8k, went 4,008
to 4,143 against a 5,000 ceiling — worth it for the containers most real state is made of.

### Ctrl+Z, and what checking Epic's plugin turned up

Epic shipped their own MCP plugin in UE 5.8 and brought it to UEFN on 20 August 2026. Reading how it
and other servers handle undo — Epic's is one operation per call with a separate undo entry each —
sent me to look at ours, and the answer was worse than theirs.

Thirty commands in `MCPCommandHandler.cpp` open a named `FScopedTransaction` and behave exactly like
the editor. **Every command added since opened none.** Their edits were permanent the moment they
landed. Two even called `Modify()`, which records a change for undo and does nothing at all outside a
transaction: the habit was there, the mechanism was not.

This is the expectation a person brings and never states. They watch an agent rename a variable
across a dozen nodes, decide they preferred it the old way, and press Ctrl+Z. Nothing caught it —
`check:parity` counts commands, `check:journal` sorts them read from write, and neither asks whether
a change can be taken back.

`check:undo` asks. Every command that changes the project must open a transaction or be listed with
the reason it cannot, and the reason has to be about the **engine**, not about the effort of writing
the code — *"the editor cannot undo asset creation either"* is a good reason; *"we didn't get to it"*
is the case this exists to stop. It also fails when an exemption outlives what it exempts, and when
an exemption claims something is permanent that has since learned to transact.

Writing it corrected me four times, which is the point of writing it:

| what I assumed | what was true |
|---|---|
| only the eight new commands lacked transactions | four older ones did too — all three data-table row edits and `set_asset_property`, every one of them undoable in the editor |
| `add_node` had a transaction | it does — but my first version reported it as permanent, because `HandleAddNode` delegates to `AddNodeCore` and I only read the named handler |
| the `create_*` commands can't be undone | six of them already transact; my exemptions said the opposite of the code |
| `compile_cpp` and `hot_reload_cpp` are commands | they are not; I had exempted two names that don't exist |

The false alarm on `add_node` was the one worth fixing carefully. A guard that cries wolf is one
people learn to skip — which had already happened to the lifecycle trial two days earlier — so it now
follows delegation and matches braces properly instead of slicing to the next line-start brace.

**Where we stand against Epic's plugin.** Theirs is deliberately minimal and foundational; the gaps
its reviewers name are tool breadth, context efficiency, transactional batching, read-back, and
production hardening. Ours answers four of those already — 115 tools, a 2,292-token `search` profile
with full schema recovery on demand, whole-graph authoring in one call, and `explain_graph` /
`review_blueprint` / `verify_feature` for read-back. Undo was the one where we were genuinely behind,
and in our own newest code rather than by design.

### Teaching that arrives when it can be used

On `search` — the profile the shipped config selects, and the one a frontier model actually runs —
the instructions had grown larger than the tools: **1,157 tokens of standing text against 1,135 of
schemas.** Standing text goes ahead of everything else in every message, is charged in full before
any work happens, and is re-charged in full whenever it changes - so it is the most expensive kind of
text there is to get wrong.

Most of it earns its place. One block did not, *there*. `GROUND TRUTH YOU CANNOT DERIVE` — the target
pin is `self`, exec pins are `execute`/`then` but `Exec` on loop macros, struct defaults are comma
triples — is the most valuable paragraph in the file, and `search` registers four tools:

```text
unreal_ping   unreal_doctor   unreal_list_tools   unreal_enable_tools
```

None of them can place a node. So 284 tokens of pin names were resent every turn describing calls the
model was not yet able to make. Thirty messages of orientation paid roughly 8,500 tokens for
knowledge it could not use once.

It now arrives from `unreal_enable_tools`, once, at the moment an authoring tool switches on —
and only then. Enabling the C++ tools alone does not need pin names and does not get them.

```text
search standing   2,292 -> 2,008     -12.4%, on every message
enable cpp        no ground truth    it does not author graphs
enable feature    delivered once     284 tokens, at the point of use
enable ui after   not repeated
```

Nothing was cut. The teaching is *better* placed: it lands in a reply the model just asked for, at
the moment it starts writing, instead of in a preamble read before the job was understood.

**The guard matters more than the saving here**, because deleting the delivery would look like a
further win: `search` would get 284 tokens cheaper and quietly stop teaching the strings whose
absence is the most common failed call in this server. `check:profiles` now fails if the exact
strings reach a profile through neither route.

Writing that guard, I put it inside `if (lying.length > 0)` — a branch that is false whenever the
project is healthy. It reported ok with the delivery deleted. A guard nested in a condition that
never runs is the same "reports ok while watching nothing" failure this repo keeps finding, this time
in the check written to prevent a silent loss. It is watched failing now, against the real deletion.

The one-time payload also broke a reply budget, which was right to complain: `enable_tools one tool`
is written for the repeated case at 200 tokens. Two different things were sharing one ceiling, so
they are budgeted separately now — an ordinary enable is **57** tokens, the first authoring enable
**334** — rather than raising a number until the check went quiet.

### What using it on a real game taught it

Driving these tools through actual bugs in a 356-Blueprint project surfaced things no internal trial
had. Two are worth recording because they are about the *shape* of the surface, not any one tool.

**I got a parameter name wrong three times in one session, on my own tools.**

```text
unreal_trace_variable        takes `variable`      six other tools take `variableName`
unreal_trace_function_calls  takes `function`      six other tools take `functionName`
```

That is not carelessness. A model that has just read six tools taking `variableName` types
`variableName` at the seventh, because that is what the surface taught it. Each miss cost a round
trip — and this server's own standing instructions say *"never guess a name; a guess costs a failed
call"*, which only holds up if the names do not need guessing at.

The validation errors were genuinely good: they named the right parameter and said "Nothing ran".
Good errors are the second line of defence; the first is not needing them. Both minority spellings
are now accepted alongside the common one, and `check:params` fails when a tool uses a different name
for a concept several others share without accepting theirs too.

Writing that guard found **two more** I did not know about — `unreal_add_event_handler` and
`unreal_scaffold_blueprint` take `function` inside their nested action objects. It would have been
easy to scope the check to top-level parameters and watch it pass, which is the same "raise the
number until it goes quiet" move this repo has refused elsewhere. They accept `functionName` now too.

**A search that could not find what the engine calls things.** `unreal_find_node` searches the
function catalogue, so `"Array Length"` returns zero hits and `"DoN"` returns unrelated matches — the
array and macro nodes are not functions. A model looking for the Length node has no way to find it
from here. Recorded rather than fixed: the catalogue is the right place for the fix, and it is a
larger change than this section's other findings.

### Nodes that land where their wires are

Someone opened `BP_Player` after this server edited it and found spaghetti: wires crossing the whole
canvas. That was real, and it was this tool's fault twice over.

`unreal_build_graph` deliberately skips auto-layout on a large existing graph — rearranging someone's
Blueprint because you added three nodes to it is worse than the mess it prevents. But it then created
those nodes at the **graph origin**. `Set PlayerName` was at `(960, -3024)`; the nodes feeding it were
at `(0, 0)`.

The reason it could not do better is the second half: **node position was invisible to every read in
this bridge.** `read_node_detail` returned id, type, title, comment, pins — and no `x`/`y`. A caller
could not find out where the nodes it was connecting to were, so it could not place anything sensibly,
and neither could a model driving it.

Both halves are fixed. Reads report position, and `build_graph` places any node the caller did not
position next to the ones it ends up connected to — averaged over its neighbours, offset to the left
because that is the direction Blueprint reads, and staggered so siblings do not stack. It reports
`nodesPlacedNearTheirConnections` so the caller can see it happened.

The rule this encodes: **an edit should be as small on the canvas as it is in the graph.** A tool that
leaves a Blueprint harder to read has not finished the job, however well the logic compiles.

### Proving a change works, in one call

Someone using this server said the quiet part: *"the MCP should add debug lines, make sure its fixes
worked, and only then delete the debug logs."* They were right, and they were right because I had
just reported a Blueprint fix as done on the strength of it compiling. Compiling proves a graph is
well-formed and nothing else.

The pieces to do better already existed — `start_pie`, `watch_runtime` start/read/stop, `stop_pie` —
and using them meant five calls with real time between them. That is exactly the sequence a model
skips. So it is one tool now:

```text
unreal_verify_runtime({ watch: ["BP_Player.PlayerName"], seconds: 18 })
  -> agreed: true  { "Authority": "Devil", "Client0": "Devil" }
     every watched value agreed across all running worlds and none looked unwritten.
```

It starts a session if one is not running, samples, and puts the editor back as it found it. The
verdict names the two failure shapes worth knowing: a value that **differs between roles** is a
replication bug, and one that **stayed empty all session** usually means nothing wrote it — which is
what an orphaned event looks like from outside.

**Both ways it can be wrong were real, and both are tested.** The first version compared the labelled
strings between roles, and PIE gives the same pawn a different suffix in every world — `C_3` on the
server is `C_2` on the client — so it reported a replication bug on every multi-actor value, always.
The second flagged a value that had been correct since the first sample as "never changed", which is
true and useless. A verification tool that cries wolf is worse than none, because the first thing
anyone learns is to stop reading it. Names are stripped for the comparison and kept for the report,
"unwritten" now requires the value to be *empty* as well as stable, and four unit tests hold both
lines.

### The recommended tool could not do what the discouraged one could

The standing instructions tell every model the same thing: *"Build whole graphs with
`unreal_build_graph`, in one call. Do not place nodes one at a time."* That tool's own description
says *"Same per-type params as `unreal_add_node`"*. It was missing four of them:

```text
netMode    reliable    inputs    ownerClass
```

So the recommended way to author a graph could not declare a custom event's parameters, and could not
make one a **Server RPC** — the thing all multiplayer logic is built from. `unreal_add_node`, the one
the instructions steer models away from, could do both.

`check:nodetypes` compares the nodeType *values* the two tools offer and had nothing to say about
their *parameters*. The only way to find this was to need `ownerClass` — for the ordinary cast-then-
get-a-variable pattern — and be told the variable did not exist. A test now asserts that every
per-node parameter `add_node` takes is expressible in `build_graph`, because its description promises
exactly that.

Verified by building what was previously impossible in one call:

```text
CustomEvent "ServerDoThing"  netMode: Server  reliable: true
  inputs: [{Amount, int}, {Who, name}]
    -> pins: then (exec), Amount (int), Who (name)
```

**And the same tool answered in two shapes.** It has five reply paths — layout ran, layout skipped,
layout failed, layout off, review attached — and three returned the raw bridge result while two
returned a trimmed one. So `nodes.ref` was an object on a big graph and a bare id string on a small
one; code reading `nodes.ref.id` worked until the day it did not, which is how a script of mine
crashed mid-session. Worse, the untrimmed replies were the **big-graph** paths, where context is
already scarce. One shape now, on all five, checked by a test — and the compiler caught that my first
fix put the declaration out of scope, which the source-reading test happily passed.

### The bug that only the host cannot see

A player reported rubber-banding: when the host vacuums a client, the client snaps back; when a
client vacuums the host, the host is smooth. That asymmetry is the whole diagnosis.

`DraggedByVacuum` applied `Add Force` to the CharacterMovementComponent behind a **`Has Authority`**
gate. CharacterMovement is client-predicted and server-corrected: the owning client simulates its own
movement and the server corrects disagreement. A force applied *only* on the server is a
disagreement by construction — the client never predicts it, the server insists on it, and the
correction is what the player sees. The host never notices, because **the host is the authority**.

The fix is not to remove the gate. It is to apply the movement where the pawn is *predicted* —
`Is Locally Controlled`, true on the owning client and on the server for anything the server controls
itself — and then to replicate every value the force calculation reads.

That second half nearly shipped broken. `VaccumDragStrength` defaults to `0.0` and did not replicate,
so a correctly-gated client would have multiplied the force by zero and the drag would have stopped
working altogether — worse than the bug. Both it and `LocationDragged` replicate now.

**The fix was wrong, and testing it in play is how that was found.** Moving the gate to
`Is Locally Controlled` made the symptom *worse*: the character juddered in place, "like dragging a
kid who keeps pushing back", and the editor then crashed. The cause is ownership. Those values are
computed on whichever machine runs the ability, and making them replicated hands the client the
server's copy — which stomps the local one every update, so the force flickers between its real
value and `0`. It was reverted the same session.

The honest lesson is about method, not networking: I could not drive input in PIE, said so out loud,
and shipped a networking change I had no way to exercise. Verifying the *plumbing* — both roles
agreeing at their defaults — proved nothing about the case that mattered.

**It is still a check**, because the smell is real: `authority-gated-character-movement` walks the arm
of an authority branch that runs when the check passes and reports character movement found there.
But its advice now says what was learned — that moving the gate is not a safe one-line change, what
to check first, and to test it in play, because a listen-server host cannot see this bug at all.
Priced at 85.

Four tests hold the edges, because a check that fires on the wrong things is worse than none:
moving a plain replicated actor from the server is *correct* and must not fire; the `else` arm is the
client path and must not fire; and the fixed shape must go quiet, or it nags on the graphs someone
just corrected. Across 571 real graphs it produced **zero** false positives.

**Why the existing check missed it.** `server-writes-unreplicated` exists and does fire elsewhere in
that project, but its premise is "an event that runs on the server sets an unreplicated variable".
Here the setter runs from an interface event, not a Server RPC, so it correctly said nothing. The bug
was a different shape, and the honest response to "why did the check not catch this" was to work out
what shape it actually was rather than widen the old check until it fired.

### The tool could not press anything

This server could start a game, read variables out of it, and screenshot it. It could not **press**
anything. So every runtime verification stopped at *"the values agree while nothing is happening"* —
which is true, and proves nothing about behaviour that only exists while an ability is being used.

That gap has a receipt. A networking fix in a real project was shipped on exactly that evidence: both
roles agreeing at their defaults, with nobody using the ability. It made the bug worse and crashed
the editor. The person on the other end found it in thirty seconds by holding a key. The tool could
not hold a key.

`unreal_press_input` closes it. It uses `InjectInputForAction`, which is how Enhanced Input is meant
to be driven programmatically: the action passes through the same modifiers and triggers a real press
would, so the game sees what a player would produce. Synthesising a key at the PlayerController would
bypass the mapping context and test a path nobody plays.

Proven against the real project by pressing the vacuum for six seconds and watching the game react:

```text
press: {"heldForSeconds":6,"inputAction":"IA_Vacuum","localPlayers":2,"worlds":["Authority","Client0"]}

bDirector_IsVacuuming   Authority  changed=true
VacuumChargePercent     Authority  0.000000 -> 2 actors differ   changed=true
```

Injection lasts one frame, so a hold is a ticker that re-injects until the time is up — capped at 30
seconds, and a second call replaces the first rather than stacking, because a held key is a change to
a running game that nothing else will undo.

### Holding the key while you watch

Pressing and watching were two tools, and using them together meant getting the order and the timing
right by hand. `unreal_verify_runtime` takes a `press` now: it starts sampling, waits, holds the
input, keeps sampling, and reports. One call for "run it, hold this, tell me what moved".

The first version of that reply was quietly useless. It reported where each value *ended up*, and a
key is released before the last sample — so a charge meter that had visibly swung to full read back
as `0.000000`, and the verdict said **"every watched value agreed"**. True, and no help at all. What
a press asks is whether the thing moved at any point, so `moved` is now part of every row and of the
verdict, and a value that never budged while the key was held is called out by name.

Pointed at the real bug it was built for, it answered in one call what several rounds of reasoning
had got wrong:

```text
LocationDragged      moved=true  agreed=false
  Authority  BP_Player_C_1=(X=-5726.67, Y=1532.58, Z=2420.15)
  Client0    (X=0.000000, Y=0.000000, Z=0.000000)

VaccumDragStrength   moved=true  agreed=false
  Authority  BP_Player_C_1=250.000000
  Client0    0.000000
```

The server is dragging. The client knows nothing about it — not a stale value, *nothing* — so the
client predicts movement with no force in it and the server corrects it. That is the rubber-band,
measured rather than argued.

It also explains why the obvious fix failed. Replicating those two values does not hand the client
the drag; it hands it a value that updates at the network rate while the force needs one every frame,
so the force flickers and the character judders in place. The shape of the real fix is to tell the
client *what is dragging it* once and let it compute the per-frame direction locally — which is a
design change, not a flag flip, and not one to attempt without being able to reproduce a two-player
vacuum on demand.

**The limit worth stating:** the two PIE players spawn apart, so nothing is in range to vacuum unless
someone walks. Input injection can drive movement too, but not aim at another player reliably. Until
that is solved, this class of bug still needs a human in the loop for the final check.

### Reproducing a two-player bug with nobody playing

The last thing standing between this server and testing a real interaction was position. Two players
spawn at different PlayerStarts, so an ability needing a target in range finds none: the input
arrives, the ability runs, every value stays at its default, and the session proves nothing. That is
not a hypothetical — it is what the first automated vacuum test did.

`unreal_pie_actors` reports where things are in each running world, with their net role, facing, and
whether each is locally controlled. `unreal_teleport_actor` moves them, and takes a `yaw`.

The facing mattered more than expected. Teleporting the two players next to each other still produced
nothing, because the ability gates on a dot product against the camera and the host was looking the
other way. A pawn's mesh rotation is not what an aimed ability tests — the **control rotation** is —
so `teleport_actor` sets that on a possessed pawn, and `pie_actors` reports it.

With those, the bug reproduces from a cold start with nobody at the keyboard: read where the players
are, put the target in front of the host, aim the host at it, hold the vacuum, watch both worlds.

```text
Authority  VaccumDragStrength  BP_Player_C_3=250.000000   changed=true
Client0    VaccumDragStrength  0.000000                   changed=false
```

The server is dragging the client's pawn. The client's copy never learns anything about it, so it
predicts movement with no force in it and gets corrected — which is the rubber-banding, now
reproducible on demand rather than by asking someone to go and play.

`teleport_actor` moves the actor in **every** world by default. A pawn has a copy per world, and
moving only the server's leaves the client's behind — which looks exactly like the desync you were
investigating, except self-inflicted.

### The first time the tooling caught its own bad fix

The rubber-band fix was attempted a second time, properly this time: replicate the *inputs* to the
drag — the list of who is vacuuming, which changes rarely — and let every machine compute the
per-frame pull from those actors' live positions. That avoids what broke the first attempt, where a
per-frame vector arrived at the network rate and the force flickered.

The replication worked. Measured mid-drag, the client's own pawn now had the list:

```text
VacuumingPlayers  Authority  changed=true   BP_Player_C_3=("/Game/AntiViru...
VacuumingPlayers  Client0    changed=true   BP_Player_C_2=("/Game/AntiViru...
```

Then the position check, which is the one that matters:

```text
before  srv target -4551 | cli target -4551
during  srv target -4551 | cli target -4551
```

Nothing moved, on either side. The drag had stopped working altogether — worse than the bug. Some
other condition on that chain is not true on a client.

**That condition has since been found, and the last clause of this paragraph — which used to read
"and the coupling is deeper than the graph shows" — was wrong.** It is not deeper than the graph
shows. It is one node, in the graph, named `Has Authority`. See *The gate that was in the graph the
whole time* below.

It was reverted in the same session and the revert was **verified the same way**: with the original
wiring back, the target moves `-5427 → -5659` under a six-second pull. The drag works again, proven,
not assumed.

**That is the whole point of the last several commits.** The first attempt at this fix shipped, broke
the game, crashed the editor, and was found by the person playing it. The second was caught by the
tooling in about four minutes, before it left the machine. Nothing about the second attempt was
smarter — the difference is that `pie_actors`, `teleport_actor` and `press_input` can now stage the
interaction and watch what happens, so "did this work" is a measurement rather than an argument.

The honest state of that bug: **still unfixed**, twice attempted, mechanism understood and
reproducible on demand. Two plausible fixes are ruled out by evidence rather than opinion, which is
worth more than a third guess.

### Reporting every value, not just the ends

`watch_runtime` reported `first`, `last` and `changed`. For anything transient those are the least
informative pair available: a gameplay tag added when an ability starts and removed when it stops is
absent at both ends, so the tool said **"unchanged"** for the exact state that explained the bug.

The distinct values were already being collected — to decide `changed` — and then thrown away. They
are reported now, in order:

```text
Client0  values: () -> (GameplayTags=((TagName="isAiming.isVaccuming"))) -> ...
```

That one line disproved a hypothesis this project had been about to act on. The theory was that
gameplay tags do not replicate, so a client can never pass the gate on the vacuum drag. The values
show the vacuuming player's tag arriving on the client perfectly well — tags **do** propagate — and
the dragged player carrying no tag on *either* side, while the server drag demonstrably works.

So the explanation is wrong, and it was wrong in the direction that would have produced a third
failed fix. Being able to see what a value actually did, rather than where it started and stopped,
is the difference between disproving a theory in one run and shipping it.

### Filing the runtime tools where the work is

Five tools were added this week for one job: run the game, press something, watch what happens.
They landed in whichever group looked closest at the time, and the result was that the job cost
almost four times what it should.

`start_pie`, `watch_runtime` and `screenshot` sat in `scene`, with level creation and actor
authoring. `press_input`, `pie_actors`, `teleport_actor` and `verify_runtime` sat in `maintenance`,
with renaming assets and tracing variables. So the cheapest way to hold a key and watch a value was
to switch on **both** groups and pay for everything filed near them:

```text
before   maintenance 6,575 + scene 6,611  = 13,186 tokens
after    runtime                          =  3,143 tokens
```

`runtime` is now its own group, and the other two got smaller as a result — `maintenance` 6,575 to
4,578, `scene` 6,611 to 5,465 — so a session that wanted asset surgery was also paying for PIE it
never started.

The whole closed loop runs from it. On the `search` profile, enabling `runtime` alone gives 14 tools
for **4,283** tokens, and that is enough to start a game, position two players, aim one at the other,
hold an input, and read the verdict:

```text
VaccumDragStrength moved=true | agreed=false
1 value(s) differ between roles - a replicated value that differs between Authority and a client
is a replication bug, and the actor names say which copy is wrong.
```

Presets name individual tools rather than groups, so none of them changed. The grouping is about what
a session pays to *hold*, not about what any given job can reach.

### The numbers a model reads are guarded too

Three token figures in tool descriptions have gone stale and been caught **by accident** — each one
while measuring something else:

| claim | was quoted | measured | how it was found |
|---|---|---|---|
| `read_class_defaults` | 4,728 | 3,237 | while measuring something else |
| `list_data_table_rows` | 7,040 | 5,472 | while measuring something else |
| `explain_graph` | ~8,800 | 2,328 | while investigating an apparent inversion |

Every one drifted **downward**, because this repo keeps making replies cheaper — compact JSON, float
trimming, deduplicated fixes — and nothing walked back through the prose afterwards. So the tool
undersold itself to the one reader whose decision depends on the number.

`measure:reads` verifies figures live against a real editor, which is the right check and not enough
on its own: it is a hand-written list of three, so it cannot notice a *fourth* claim being added.
That is the same rot four other indexes in this repo have already suffered.

So `check:claims` does the half that runs without an editor, and does it by **finding** rather than
being told. It scans for every token figure in text a model reads and fails in both directions:

- a figure nothing is registered to watch — *you added a number and nobody decided who checks it*
- a registered figure that no longer appears — *the registry is watching text that is gone*

The second is the failure that actually happened elsewhere here, and no other guard looks for it.

The scan draws one deliberate line: **60** of the token figures in `src/` are in comments and **4**
are in model-facing strings. Comments are records of why a design exists, dated by their commit, and
nobody acts on them; demanding they stay current would make the check noise nobody runs. Only text a
model reads is held to being true.

What it does not claim: this does not prove a number is *right* — only a live measurement does that.
It proves something narrower and still worth having, that no figure a model reads has appeared
without anyone deciding who watches it. All four current figures were re-measured by hand when it was
written: `list_blueprints` 2,669 exact, `list_tools` 551 against "about 540", and both
`explain_graph` figures fresh.

### Documentation is guarded too

`npm run check:docs` (part of `npm run build` and `npm test`) checks that:

- every registered tool is documented here, because a capability nobody can find is unshipped
- every tool the docs mention actually exists, because a document promising a tool that is not
  there is worse than silence: someone will act on it
- the required sections still exist
- every complaint-matrix row carries one of its declared statuses

The third check exists because the failure already happened. A slice replacement between two
headings silently deleted the live-verification and crash-sweep sections, 67 lines, and every
automated check still passed: parity, unit tests, live verification, the crash sweep, none of them
look at prose. It surfaced by luck, when a later edit anchored on a heading that no longer existed.

The guard was verified by reproducing that exact deletion and confirming it fails.

### Tool parity is enforced, not assumed

Every command the C++ bridge dispatches must have a matching MCP tool, and every MCP tool must
call a command the bridge actually implements. `npm run check:parity` (which `npm run build` and
`npm test` both run) parses both sides and fails the build otherwise.

This check exists because the gap it catches really happened: the bridge shipped 37 commands while
the server exposed 23, so levels, actors, components, class defaults, input mappings, and PIE were
implemented, live-verified, documented, and **unreachable by any AI client**. Nothing failed
loudly, because nothing was checking.



## The cost nobody was measuring: switching a tool on

Every token measurement in this project counted **standing context** - the bytes resent on each
turn - and that is the number the profiles, the groups and the presets were all tuned against. It
is a real number, and it was the wrong one to optimise alone.

The advertised tool list is the first thing in a request, ahead of the system prompt and ahead of
every message. `unreal_enable_tools` changes that list. Changing it invalidates the prompt cache
for **the entire conversation**, so the next turn re-reads the whole history at full price instead
of the cached rate. A tool switched on at turn thirty, in a session carrying 60k tokens of history,
costs that re-read once - and the saving it was bought with is a few hundred cached tokens a turn.

So the call this server presents as the cheap path is, for a tool used once, the single most
expensive thing it offers. Nothing here measured that, because everything here measured the wrong
axis.

### What Epic does, and what we were missing

Epic's own MCP plugin (UE 5.8, and extended to UEFN in August 2026) defaults to what their docs call
tool-search mode: `tools/list` returns three meta-tools - `list_toolsets`, `describe_toolset` and
`call_tool` - rather than every schema. The first of those we had. The other two we did not, and
the third is the important one: **you call a tool through the dispatcher instead of switching it
on**, so the tool list never moves and the cache survives.

Reading their documentation is what exposed the hole. This is the one place a competing design was
straightforwardly ahead, and the fix is to adopt it rather than argue with it.

### Both paths, honestly priced

`unreal_call_tool({ tool, args })` runs any registered tool and returns its result with no
tool-list change. `unreal_list_tools({ schema: "unreal_save_asset" })` returns that tool's full
parameter schema **as a reply rather than as a definition** - the same information, derived from
the same zod object the tool validates against, with no tool-list change either. Until it existed,
"what arguments does this take" - the cheapest question in the catalogue - could only be answered by
enabling the tool, which priced a question like a commitment.

Neither path replaces the other, and the tools say so:

| | `unreal_enable_tools` | `unreal_call_tool` |
|---|---|---|
| Tool list changes | yes, once | never |
| Prompt cache | invalidated | survives |
| Schema visible afterwards | yes | no - fetch it with `list_tools({schema})` |
| Right for | a tool used repeatedly, or one whose schema you need in front of you to sequence the job | the long tail: one save, one compile, one status check |

The rule of thumb is in the tool description: one or two uses, dispatch; three or more, enable.

### Where it stands, and where it does not

`unreal_call_tool` is registered on `lazy` and `search` and switched off everywhere else, because
those are the only profiles that defer anything. On `full` every tool is already on, and on `core`
and `minimal` the only tools the dispatcher could reach are the ones already registered and enabled;
in all three it would be an extra hop and an extra schema for no gain.

Registration, not enablement, stays the permission boundary. `core` and `minimal` never register the
tools they exclude, so the dispatcher cannot reach them either and those profiles keep their promise.
A dispatcher that quietly reached everything would have turned a documented tool budget into a
suggestion.

Arguments are validated against the identical strict schema the tool advertises, captured after the
`strictSchema` swap in `register`. Two ways to call one tool that disagree about its arguments is
the defect class this project keeps finding; it is not going to be introduced deliberately.


## Searching for a node by the name the editor shows

`unreal_find_node` is how a model checks a function name before writing a call, so what it fails to
find becomes what the model guesses at. Three defects turned up by simply asking it for things a
person would actually type.

**"Array Length" returned nothing.** The catalog is keyed on the C++ name, `Array_Length`, and the
search compared raw strings — so a space was not an underscore and the query missed. Indexing
`DisplayName` did not save it, because `Array_Length`'s DisplayName is `"Length"`. The editor puts
"Array Length" on that node; the one spelling a model can see was the one spelling that failed.

**"Do N" returned `GetCustomDoNotImportCurveWithZero`.** An unanchored substring match found those
characters inside "...Do **N**ot Import...", and ranked it first. This is the defect class that keeps
recurring here in new clothes: a read-only tool sounding certain about something it cannot see. A
confident wrong hit is worse than no hit — no hit sends the caller to look elsewhere, a wrong one
sends them to write a call that fails.

**Macros were invisible.** `ForEachLoop` and `Make Array` returned nothing, while `unreal_build_graph`
places both perfectly well via `nodeType: "Macro"`. One half of the server implemented what the other
half reported as nonexistent.

### What changed

Matching happens on **words** now. Underscores, spaces and camelCase humps are all the same kind of
boundary, so `Array Length`, `array_length` and `ArrayLength` are one question with one answer. The
words are split once when the catalog is built, not per query — it runs to tens of thousands of
entries and is searched repeatedly in a session.

Ranking runs exact → prefix → whole-word run → typeahead → metadata → raw substring, and that last
tier only fires for a query long enough to mean something. Whole words are what removes the noise:
`["do", "n"]` is not a run inside `["get","custom","do","not","import",...]`, because `n` is not
`not`.

Typeahead survives deliberately: the *final* query word may still match a prefix, so "len" reaches
`Length`. Only the final one — allowing it everywhere brings the noise straight back. A search fix
that breaks the common path is a net loss however good the new cases look, which is why the trial
asserts the things that already worked still work.

### Macros and node kinds were the third defect, and the worst

`unreal_build_graph` places `ForEachLoop`, `DoOnce`, `Gate`, `Branch`, `Sequence` and the rest
perfectly well — via `nodeType: "Macro"` with a `macroName`, or the matching `nodeType` directly.
`unreal_find_node` searched a catalog of Blueprint-callable *functions*, which contains none of them.
One half of the server reported the other half's work as nonexistent.

Half of them returned nothing. The other half was worse: these are the most common nodes in
Blueprint, and the function search answered anyway. `Branch` returned `AddBranchNode` from
`RigVMController`. `Gate` returned `Not_PreBool`. `Sequence` returned `SequenceEvent`. `Select`
returned `SelectAll`. Each is a confident, wrong, fully-detailed answer that a model wires up, fails
on, and pays a round trip to discover.

`find_node` now searches the standard macro library and the built-in node kinds alongside the
function catalog, using the same word-matching rule, and reports them separately with **how to place
them** — `{"name":"ForEachLoop","use":"build_graph nodeType \"Macro\", macroName \"ForEachLoop\""}`.
Naming a node without saying how to place it just moves the guess one step along.

When the query names a kind or macro **exactly**, the coincidental function hits are dropped rather
than disclaimed. Exactness is what makes that safe instead of blunt: `IsValid` is genuinely both a
macro and a function and keeps both, while `AddBranchNode` does not name `Branch`.

The result is cheaper *and* more correct, which is the trade this project keeps looking for:

| query | before | after |
|---|---:|---:|
| `Branch` | 219 tokens, wrong answer | **33 tokens**, right answer |
| `Sequence` | 200+ tokens, `SequenceEvent` | **35 tokens** |
| `Gate` | 200+ tokens, `Not_PreBool` | **36 tokens** |
| `Print String` | 87 tokens | 87 tokens — unchanged |

`npm run trial:nodesearch` checks all of it against a live editor — 25 assertions, including the
`Do N` case and the `IsValid` both-answers case specifically, because those are the ones that would
come back silently.

## When the host project cannot build, deliver the plugin anyway

`--package` compiles the plugin with `RunUAT BuildPlugin`, which does not load the host project and
therefore cannot be blocked by one, then **installs** the resulting binaries into each target. The
install is part of the result rather than a follow-up step: a plugin packaged to a temp folder and
never copied is the same unverified fix this script exists to prevent, so a failed copy fails the
target.

It is not a replacement for the default. `BuildPlugin` compiles against public engine APIs only,
which is a narrower check than the editor target, and the closing message says so.

### It was written for a diagnosis that turned out to be wrong

This existed because one project's editor target "could not build at all". That was stated here as
fact for several sessions. It was two bugs, and one of them was in this script.

**A duplicate plugin.** The project has a complete second sample project nested inside it, so
UnrealBuildTool discovered two copies of several plugins and refused with `Action graph is invalid`
before compiling anything. The supported fix is one empty file: UBT's plugin enumerator stops
descending into any directory containing a `.ubtignore`, so a marker in the nested project's folder
removes it from the scan. Nothing moved, nothing deleted, one line to undo.

```csharp
else if (PluginFile.Name == ".ubtignore")
{
    bSearchSubDirectories = false;
}
```

**An unquoted path, here.** With `shell: true`, `-Project=${target.project}` is re-split by the
shell, so a project path containing a space — `M:/Unreal Projects/...` — reached UBT as
`-Project=M:/Unreal`. The isolated branch quotes its paths and always worked; this one did not. So
the failure appeared **only** on projects whose path has a space, which is why two scratch targets
under `A:/UnrealProjects/` built for months while the real game did not, and why it looked like a
property of that project rather than of this script.

With both fixed, the target that "could not build" builds in nine seconds. `--package` stays,
because a host that genuinely cannot build is a real situation — but it is no longer the answer to
this one.

## Two ways a read-only tool said "there is nothing there"

A tool that fails gets retried. A tool that confidently answers "no" gets believed, and the reader
goes off to build something that already exists or to fix something that was never broken. Both of
these cost a full investigation before they were noticed.

**`trace_variable` did not count spawn pins.** `PlayerWhoPlacedName` came back *read but never
written*, with a verdict explaining that the reading side "silently takes the fallback forever" —
so the ping system read as half-built. It was not. The name was being set on the `SpawnActor` node,
through an **Expose on Spawn** pin, one pin away from where the tracer was looking. That is how most
such variables get their value, and none of it involves a Set node.

It now asks the engine — `UK2Node_ConstructObjectFromClass::IsSpawnVarPin` — rather than guessing,
which covers SpawnActor, Construct Object and Create Widget together and cannot drift from what the
editor shows. A pin that is exposed but left alone is still not a write: an untouched pin sits at
the class default, and counting it would make every spawn of a class a spurious writer. The reply
names the node (`via: "SpawnActor BP Ping Actor"`), because "BP_Player writes a variable it does not
declare" reads as a mistake until you can see it is a spawn pin.

**`search_project` did not index Custom Events.** The index walked `FunctionGraphs`, and a Custom
Event is a node inside the event graph, so `CE_Server_TryPing` — the name of an entire subsystem —
returned zero hits. Events are indexed now and reported as `kind: "customEvent"` so they are never
described as functions.

### The cache that outlived its format

Adding events to the index changed nothing at first, and the reason is worth recording. The index is
cached to `Saved/UnrealMCPBridge/index.json`, the cache carried a `version` field, and **nothing ever
read it**. The editor loaded a cache written by the previous format, found no events in it, and kept
answering "no hits" — which reads exactly like the change not working. The fix would have been to
delete a file nobody knew existed, and the same trap was waiting for every future change to the
format.

The loader checks the version now and rebuilds on a mismatch. Verified the honest way, by leaving a
version-1 cache on disk and watching the new build reject it:

```
LogMCPProjectIndex: project index cache is version 1, this build writes 2 - rebuilding.
```

`npm run trial:findtruth` asserts all of it against the real Blueprints each tool was wrong about —
including that a name which genuinely exists nowhere is *still* reported as nowhere, because
replacing one wrong answer with its opposite is not a fix.

## The error on the screen that no tool could see

Play In Editor kept not starting. `start_pie` answered `{"requested": true}`, every runtime tool
then reported "no game is running", and measurement runs sat waiting for players that never arrived.
The reason was a modal dialog: *"The following blueprints have unresolved compiler errors. Are you
sure you want to Play in Editor?"*, listing fifteen of them, waiting for a human to click.

Nothing here can see a modal or dismiss one. So the editor was sitting on an answerable question and
this server was reporting success and waiting — the single most expensive kind of wrong answer,
because it looks exactly like slowness.

Worse, `project_health` was described as reporting "what does not compile" and reported nothing of
the sort. Its findings were `oversizedGraphs`, `oversizedBlueprints` and `castHeavy` — three ways of
saying a graph is big, and no way of saying a graph is broken. Fifteen Blueprints were failing to
compile, invisible to every tool here and perfectly visible to the person, who got a list of them the
moment they pressed Play.

### What changed

The index records each Blueprint's `EBlueprintStatus` — it already loads every Blueprint, so asking
costs nothing — and `project_health` reports `doesNotCompile` **first**, because nothing else in that
reply matters while one of them is broken: a broken parent takes its children with it, and PIE will
not start at all.

`unreal_start_pie` now refuses rather than starting something a dialog will stop, and names the
offenders:

```
blueprints_do_not_compile: 15 Blueprint(s) have compiler errors, so Play In Editor stops on a
modal that nothing here can dismiss. Starting anyway would report success and do nothing.
  ["B_LoadRandomLobbyBackground", "BP_FirstPersonCharacter", "W_Healthbar", ...]
```

### The check that was reliable-looking and useless

The first version asked `TObjectIterator<UBlueprint>` and found **zero** broken Blueprints in a
project with fifteen — because that iterator only sees *loaded* objects, and on a freshly started
editor almost nothing is loaded. It compiled, ran, reported all clear, and let PIE walk straight into
the modal it existed to prevent.

The index is the right source precisely because building it loads every Blueprint under `/Game`,
which is the same set the editor's own dialog complains about. Verified against the real project: the
refusal lists the same fifteen names that were on the screen.

### Refusing is not enough — a person can click through, so the tool must be able to

Naming the problem still left the tool unable to do what the person does: press *Play in Editor*
anyway. So `unreal_start_pie` takes `ignoreCompileErrors: true`, and it is not a trick — it is the
engine's own path:

```cpp
static bool ShowBlueprintErrorDialog( TArray<UBlueprint*> ErroredBlueprints )
{
    if (FApp::IsUnattended() || GIsRunningUnattendedScript)
    {
        // App is running in unattended mode, so we should avoid modal dialogs and proceed
        return true;
    }
```

A bridge driving the editor from another process *is* a running unattended script. The flag is set
only around the start and restored once PIE is up, or after thirty seconds if it never comes: left
on, it would silently answer every other modal too — save prompts, overwrite confirmations — for the
person sitting in front of the editor, who did not ask for that.

The reply then names the Blueprints it started in spite of, because a degraded session must never
look like a clean one. Anything odd in that run should be weighed against the fifteen broken assets
before it is treated as a finding.

In the project this was found in, all fifteen turned out to be Lyra and SuperGrid sample content —
verified with `find_references`, which showed every referencer was either inside the broken set or
other sample content, and **zero** references from the game's own folder.

## "I pressed the key and nothing happened"

The most common runtime dead end, and the honest answer used to stop at a shrug: *either the input
is not reaching the game, or the thing it triggers needs something that is not there.* True, and it
leaves the caller to open the graph and walk branches by hand.

That hand-walk happened three times in one session on one ability. Holding the vacuum did nothing,
and finding out why meant reading the input node, following exec pins, reading each Branch, chasing
what fed its condition — one call at a time. Every step of it is mechanical, which is the definition
of something a tool should do.

So `unreal_verify_runtime` now answers it. When a press moves nothing, the reply carries
`whyNothingHappened`:

```
"IA_Vacuum" runs through 2 gate(s) before anything happens: Get isAlive -> NOT Boolean.
The FIRST one that is false is the one that stopped it, and everything after it never ran.
```

Three things had to be right for that to work, and each was wrong first.

**It has to follow a call into an event body.** Ability gates live inside the server RPC, not in the
input chain that asks for it — pressing the vacuum calls `StartVaccum`, and the gates are inside
`StartVaccum`. Calling an event does not link to its body in the exec graph, so following links
alone walks straight past every gate. The first version reported *no gates* on a chain with two.

**It has to match a call to its event loosely.** The editor writes a call node's title as a display
name — `Start Vaccum` — while the event is named `StartVaccum`. The unit test passed because it used
the same spelling on both sides; no real graph does.

**It has to read the CHAIN, not the graph.** Reading a large arbitrary slice and hoping the chain
was in it stopped one node short and reported **one** gate on a chain with two. That is worse than
reporting none: the gate it named was true, so the answer exonerated the thing that was actually
stopping it. The walk now says which node it wanted and could not reach, that one is read, and it
walks again — following the chain instead of the graph, which is both correct and faster.

It runs only on the failure path, where the caller is already stuck. A run where everything moved
pays nothing for it.

## The replication bug that never says anything

A RepNotify that does nothing is the quiet half of the replication family. The variable replicates,
the notify fires on every client exactly as designed, and the handler is empty — so the value
arrives and nothing reacts to it. Nothing errors. Nothing warns. It surfaces much later as "the
display never updates", by which point nobody is looking at replication.

Found by hand in a real project first: `OnRep_PlayerWhoPlacedName`, an event with nothing wired to
it, on a variable that replicates perfectly. The name was arriving on every client and the nameplate
never changed.

`repnotify-does-nothing` now catches it, and on the first real Blueprint it ran against it became the
top-priority action and found more of the same beside the one that was known.

Three things keep it honest:

- **A handler that was never read is not called empty.** Not-read and not-there are different
  answers, and reporting the first as the second is the confident wrong answer this project keeps
  finding. Without graph sizes the check stays silent.
- **A variable with no RepNotify is left alone.** Asking for one nobody requested is a style
  opinion; this file is for defects.
- **It runs before the single-player bail-out.** A variable carrying a RepNotify is networked by
  definition, and gating it behind "does this Blueprint have a server event" would silence it on
  exactly the Blueprints that only replicate state — which is most of the UI.

### Where the idea came from

From checking what Epic and others have, which is worth doing periodically. Epic's plugin still
needs a separate `AllToolsets` plugin to expose anything, and its context strategy — a few meta-tools,
terse discovery, schemas on demand — is the same conclusion reached here independently. A third-party
plugin, [monolith](https://github.com/tumourlove/monolith), advertises "unbalanced-handler audits" in
a network namespace. That phrase was the whole contribution: this project had checks for a server
writing an unreplicated variable, and none for a handler that exists and does nothing.

## Measuring the choice instead of arguing about it

`unreal_enable_tools` and `unreal_call_tool` are two ways to reach the same tool, and the guidance
for choosing between them was a rule of thumb: one or two uses, dispatch; more, enable. Reasonable,
and unmeasured.

So the three flagship journeys — a bug, a feature and a change, each run from the sentence a person
would type — were run **both ways**, and `npm run trial:workflows --dispatch` keeps that honest.

| | enable | dispatch |
|---|---:|---:|
| calls | 14 | **11** |
| reply tokens | 4,371 | **3,692** |
| tool-list changes | 1 | **0** |
| standing context afterwards | **17,302** | **1,458** |

All three journeys pass either way — a bug, a feature and a change each got from a sentence to the
right tool. Dispatching costs three fewer calls, ~680 fewer reply tokens, and leaves standing context
**~15,800 tokens lower on every request for the rest of the session**, with no cache invalidation.

That is a bigger number than anything else in this document, and it was invisible while only
standing context was being measured. The enables were counted as three cheap calls; what they
actually bought was a permanent 15,800-token surcharge.

### What this does not say

Dispatching is not free and is not always right. It hands the model no typed schema, so a job that
needs the parameter list in front of it to sequence correctly should enable — and a tool about to be
called many times is worth switching on once. `unreal_list_tools({ schema })` sits between the two:
one tool's real schema, as a reply, with no tool-list change.

The measured comparison now sits in `unreal_call_tool`'s own description, because a rule of thumb a
model reads is worth more than a number in a document it does not.

## The whole-project audit was missing a whole family

`review_blueprint` on one asset reported replication bugs. `audit_project` across all of them
reported none. Both call the same reviewer.

The cause: findings about the Blueprint *as a whole* — where its state lives, whether what the server
writes ever reaches a client — are deliberately kept out of `graphs`, because they are not about a
graph and filing them under an arbitrary one would be a lie. They are returned in `blueprint`. The
audit loop only ever read `graphs`, so it computed the entire multiplayer family for every Blueprint
in the project and threw it away.

A whole-project audit that silently omits a family is worse than one that omits nothing, because the
silence reads as *clean*.

Measured on a real 150-Blueprint game after the fix, and every one of these was previously invisible
to the project sweep:

| check | count |
|---|---:|
| `repnotify-does-nothing` | **81** |
| `server-writes-unreplicated` | 12 |
| `replicated-set-without-server-event` | 6 |

The 81 was spot-checked rather than trusted. On one Blueprint with five RepNotify variables, four
handlers read *"nothing wired to it"* and the fifth — six nodes, casting to a widget and setting a
texture — was correctly **not** flagged.

Not every one is a live bug: a developer may have switched RepNotify on and read the value elsewhere,
in which case the notify is pointless rather than broken. The finding says exactly that — wire the
handler, or drop the RepNotify and replicate plainly.

### Eighty-one findings are a list; tiers are an answer

Handing someone 81 identical warnings is barely better than handing them none, so the check now
separates two cases that need opposite responses.

If the Blueprint reads or writes the variable somewhere, the missing piece is the handler: **wire it,
or drop the RepNotify.** If nothing in the Blueprint touches the variable at all, the whole thing is
**dead state** — replicated across the network, notified on arrival, read by nobody — and the answer
is to delete it, not to wire it.

The distinction came from working one Blueprint by hand. Of four empty handlers on the ping actor:

| variable | verdict |
|---|---|
| `PlayerWhoPlacedName` | a live bug — the name arrived and nothing re-applied it. **Fixed** |
| `CurrentDistanceMeters` | dead state: zero writes, zero reads, while the distance it carries is recomputed locally every tick |
| `PingColor`, `PlayerName` | handler empty, variable used — wire or drop |

The fix mirrored `OnRep_PingTexture`, the one handler in that Blueprint that was already wired
correctly: cast to the widget, call the setter. Compiles clean, and a two-player PIE session shows
the ping carrying the right name on both roles. The check no longer reports that variable, which is
the tightest confirmation available — the tool that found the bug agrees it is gone.

## The Level Blueprint was in no list at all

A trigger opening a door. A sequence starting. Anything specific to one map. That work lives in the
Level Blueprint, and none of it was reachable here — a Level Blueprint is not in the asset registry
as a Blueprint, so `list_blueprints` never showed it and searching for it returned nothing. An entire
category of an Unreal project, invisible.

Found by the same sweep that turned up Timelines and widget animations: list what the engine holds,
then check which of it any tool here can see.

### One resolver, not one more tool

Every graph tool in this server — `explain_graph`, `read_node_detail`, `review_blueprint`,
`list_variables`, `add_node`, `connect_pins` — goes through a single function that turns a path into
a `UBlueprint`. Teaching *that* about levels lights all of them up at once, and costs a caller
nothing: no extra tool definition standing in context on every request, no new name to learn. Pass a
level's path where a Blueprint path goes.

Measured on a real project immediately after:

```
L_Motherboard  ->  LerpPP (18 nodes), EventGraph (69 nodes, 9 entry points)
L_Tutorial     ->  EventGraph (22 nodes)
review_blueprint on L_Tutorial  ->  score 98, 0 warnings
list_variables                  ->  parentClass "LevelScriptActor"
```

Two deliberate choices. The level script is fetched with `bDontCreate`, because asking a question
must never silently author a Level Blueprint into a map that never had one — a level with no script
is a fact worth reporting, not a gap to fill on a read. And when a path is neither a Blueprint nor a
level, the not-found message now names the level route as well, since it is a real answer.

## A montage without its notifies is blend settings and nothing else

Reading an Anim Montage returned three thousand characters of blend options and **nothing about what
the montage does**. Sections are the combo structure — which segment follows which. Notifies are the
timing — when the hit box spawns, when the footstep plays, when the window to chain opens. *"Make the
hit land later"*, *"why does the combo not chain"*, *"when does that sound fire"* are answered by
those two lists and by nothing else in the reply.

Folded into `unreal_read_asset_properties` rather than given a `read_montage` tool of its own, the
same way widget animations went into `list_widgets`. A caller reading an asset wants to know what the
asset does, and one more tool definition standing in context on every request costs more than it is
worth. **Capability added, standing cost unchanged.**

Each notify says whether it is an instant or a *state* with a duration, because Blueprint handles
those with different nodes, so which one it is decides what a caller writes. Each section names what
plays after it, with `(ends)` when nothing does — the difference between a combo that chains and one
that stops, invisible otherwise.

The first four montages read on a real project:

```
ILY_Death_Montage     len=5.64  sections=[Default@0 -> (ends)]     notifies=[]
HealPlayer_Montage    len=0.36  sections=[Default@0 -> Default]    notifies=[]
Shoot_Montage         len=0.36  sections=[Default@0 -> (ends)]     notifies=[]
TakeDamage_Montage    len=0.36  sections=[Default@0 -> (ends)]     notifies=[]
```

`HealPlayer_Montage` points its only section at itself, which is how a montage is made to loop
forever. None of the four fires a single notify, so a reply with no notifies says so rather than
staying quiet — a caller hunting for the moment a hit lands should be told to stop looking here.

### The sweep that found it

Not a guess. List every asset class the project actually contains, then check which of them any tool
here can read:

| present | reader |
|---|---|
| Blueprint, World, WidgetBlueprint, DataTable, Material, BehaviorTree, AnimBlueprint, Niagara, InputAction, LevelSequence | already covered |
| BehaviorTree + Blackboard | covered — `read_behavior_tree` returns the blackboard name and every key with its type |
| **AnimMontage** | **nothing but generic properties** |

Checking rather than assuming mattered: the blackboard pairing looked like the obvious gap and turned
out to be complete.

## A struct is its fields, and the generic reader had none of them

Reading a User Defined Struct with `unreal_read_asset_properties` returned `"properties": []`. A
struct **is** its fields, so that reply contained none of the asset. An enum returned one entry
called `EnumDescription` and not a single enumerator.

**The first fix here was wrong, and the correction is the more useful record.** The fields and
entries were listed inline — which duplicated `unreal_list_struct_fields` and
`unreal_list_enum_entries`, tools that already existed and already answered it. Worse, the two
copies disagreed: the new one reported `FName` and `int32` where the dedicated tool reports `name`
and `int`. That is not a stylistic difference. The short spelling is what `unreal_add_struct_field`
*accepts*, so the C++ vocabulary was the less useful of the two, and two tools describing one thing
differently is the defect this project keeps finding.

So the generic reader points instead of answering: a struct or enum comes back with a `next` naming
the tool that has the content. Cheaper than a second copy, and it cannot drift.

### Names a person can actually use

Unreal stores a user struct's fields internally as `Count_5_9B3F...` with a GUID appended, and that
spelling appears nowhere anyone types. Handing it back would be a name unusable in a Data Table row
or anywhere else, so fields report their **authored** name. Enum entries likewise report the display
name rather than `E_Thing::NewEnumerator0`, and the trailing `_MAX` sentinel is dropped — it is
engine bookkeeping, and listing it would invite a caller to select it.

### The loop this closes

```
DT_UpgradesOld  ->  rowStruct: S_UpgradeRow
S_UpgradeRow    ->  UpgradeId:FName, DisplayName:FText,
                    Category:TEnumAsByte<E_UpgradeCategoryold>, bIsGlobal:bool,
                    ApplyPolicy:TEnumAsByte<E_UpgradeApplyPolicy>, Icon:UTexture2D*, ...
E_UpgradeCategoryold  ->  its valid values
```

Table, to columns, to the legal values for an enum column — the whole path a change request to a
Data Table needs, and none of it was reachable before.

## Enums could be created and never extended

`unreal_add_struct_field` could add a field to an existing struct. Enums had only `create_enum`,
which makes a new one whole. So *"add a new upgrade type"* — one entry on an existing enum, then a
Data Table row — could not be done at all: the only route was recreating the enum, which breaks every
asset already referring to it. An asymmetry rather than a decision.

`unreal_add_enum_entry` closes it. Two things it does deliberately:

**It refuses a duplicate label.** Unreal permits two entries showing the same name — the internal
names differ — and the result is a dropdown with two options nobody can tell apart, forever, with
nothing reporting a problem. Matching is case-insensitive, because `gamma` and `Gamma` are the same
option to the person reading the list.

**It reads the result back rather than echoing the request.** An echo reports success even when
nothing was written, which is exactly how an earlier bug in `create_enum` stayed invisible: naming an
index that did not exist yet did nothing, silently, and left every entry called `NewEnumeratorN`.
Add first, then name — the same order that path had to learn.

The reply also says what a new entry does *not* break: anything switching on the enum keeps
compiling, so a new case is **unhandled** rather than broken, which is quieter and worth pointing at.

Verified on a scratch asset — created with two entries, added a third, refused `gamma` against
`Gamma`, read back `Alpha, Beta, Gamma`, deleted.

## "Add a new upgrade type", walked end to end

The Blueprint half of that promise had a trial. The **data** half did not, and it is the half a
designer lives in: a new option is an enum entry, a row in the table typed by a struct, and the two
have to agree. Every piece existed and nothing checked that they compose — which is how enums stayed
un-extendable through several sessions of work on the read side. Reading an enum worked perfectly, so
nothing ever tried to change one.

`npm run trial:datafeature` walks it on scratch assets: define the type, define the row shape, add
the option, make the table, write a row that uses it, read it back.

### The test that agreed with a bug

Its last assertion first read `/Shield/` against the whole row, and passed — on `"Shield Booster"` in
the *neighbouring* field, while the enum cell read `NewEnumerator2`. A test matching the wrong string
and reporting green.

Tightened to the exact cell, it failed honestly and exposed a real defect. Writes accepted `Shield`;
reads returned `NewEnumerator2` — so a caller could read a Data Table and not write back what it had
just been told.

### Why the read was wrong

The engine's own note on `EDataTableExportFlags` says user enums are exported by the friendly name
set in the editor — but only through `DataTableUtils`. This server's row reader has two paths, and
the one that skips values matching the row defaults (added to keep replies small) had stopped calling
`DataTableUtils` and used raw `ExportText_InContainer` instead.

Skip-if-default decides **whether** to report a value. `DataTableUtils` decides how to **spell** it.
Mixing those meant a token optimisation quietly changed the vocabulary of every enum cell in every
table into one that means nothing to a reader and cannot be written back.

Confirmed on the project's own tables afterwards: `Category` reads `VacuumStorage`, and no
`NewEnumerator` survives anywhere in the reply.

## A build that blamed the file

`unreal_compile_cpp` on an **untouched, known-good** source file failed in three seconds:

```
{"succeeded": false, "errors": [], "totalErrors": 0,
 "reason": ["Result: Failed (OtherCompilationError)"],
 "next": "The build failed without a compiler diagnostic."}
```

No errors, no warnings, and a category instead of a cause. The obvious reading is *"my file is
broken"*, and it was not — nothing about that reply points anywhere useful.

UnrealBuildTool had said exactly what was wrong:

```
Live coding session active. Actions will be limited to compilation of specified files.
Unable to perform hot reload with multiple targets.
```

Live Coding was holding the compiler in the running editor. None of it reached the caller, because
`extractFailureReason` decides which lines get through and matched none of them.

### A guidance branch is only as reachable as the pattern that feeds it

That is the general lesson, and the first version of this section overstated it. It claimed the
`Action graph is invalid` guidance "could never appear". Checked afterwards, it appears fine:
UnrealBuildTool writes `Result: Failed (ActionGraphInvalid)`, the original patterns captured that
line, and the branch matches the code as well as the sentence. The claim was flattering and wrong,
and it took one command to settle:

```
guidanceFor(["Result: Failed (ActionGraphInvalid)"])  ->  "UnrealBuildTool could not plan the build..."
```

What was genuinely unreachable is the Live Coding case, and for a specific reason worth keeping: its
result code is the useless `OtherCompilationError`, which matches no branch, so the only evidence
that could have routed it was the descriptive lines — and those were filtered out before any branch
saw them.

So the rule holds, narrowly: a branch keyed on a **failure code** is reachable because the code is
always captured; a branch keyed on a **descriptive line** is only reachable if the extractor passes
that line through. The second kind is where advice goes to die.

Both cases now come through, and `compile_cpp` names Live Coding, says *"this is not a problem with
the file"*, and points at `unreal_hot_reload_cpp`, which drives Live Coding itself.

### The symptom that pointed at the wrong thing

Pointing at a tool means checking it works, so `unreal_hot_reload_cpp` was tried next. It returned
`cancelled` in three seconds — twice in a row, and again after a genuine one-line change to a source
file, which ruled out "nothing to compile". Its own advice, *"call this again; something is
cancelling it in the editor UI"*, led nowhere.

The conclusion written here at the time was that **C++ could not be compiled by any route on this
project**. That was wrong, and it is worth leaving the reasoning visible rather than quietly
correcting it, because the mistake was a familiar one: three failures with one shared cause, read as
three independent facts.

The shared cause was that the project's editor target genuinely could not be built — for two reasons
that had nothing to do with C++ tooling. See *When the host project cannot build*: a duplicate plugin
from a nested sample project, fixed with a one-file `.ubtignore`, and an unquoted `-Project` path in
this repo's own build script that broke on any path containing a space. With both fixed, the target
builds in nine seconds, and Live Coding compiles rather than cancelling instantly.

What remains true and useful is the narrow part: `compile_cpp` cannot run while Live Coding holds the
compiler, it now says so instead of blaming the file, and it names `hot_reload_cpp` as the tool that
works with an editor open. What was wrong was the sweeping conclusion drawn from it.

### The dialog that blocks the bridge before it ever answers

An editor was restarted and then answered nothing for twelve minutes. The log ended cleanly on
`LogInit: Display: Engine is initialized`, the plugin had logged `listening on 127.0.0.1:8765`, and
the socket connected. Every visible sign said the bridge was up.

It was up. The game thread was blocked by **"Restore Packages"** — the crash-recovery prompt, which
appears at startup after any unclean shutdown. For an editor an agent drives, that means after every
kill, which is to say routinely. It blocks before the first command is served, so the bridge does not
look blocked; it looks dead.

The existing detector named it correctly on the first try. The message it produced was right and I
misread my own truncated copy of it, which is worth recording because the tool was not the problem
twice over — it also cost the time spent looking for a second cause.

Two things came out of it.

**The engine already has a switch for this.** `FPackageAutoSaver` reads
`-AutoDeclinePackageRecovery` into `bAutoDeclineRecovery` and treats it as the user declining:

```cpp
// PackageAutoSaver.cpp
, bAutoDeclineRecovery(FParse::Param(FCommandLine::Get(), TEXT("AutoDeclinePackageRecovery")))
...
if (HasPackagesToRestore() && !bAutoDeclineRecovery && !FApp::IsUnattended())
```

So nothing needs suppressing that the engine did not already offer to suppress — the same shape as
`.ubtignore` for UnrealBuildTool and `GIsRunningUnattendedScript` for the Blueprint error dialog.
Launch an agent-driven editor with it. `verify-restart.mjs` now passes it and had the strongest claim
on it of anything here: that script kills the editor and starts it again, so it *creates* the unclean
shutdown, and was liable to fail its own verification on a dialog it had caused.

The classifier tells this prompt apart from any other dialog for one reason: every other blocking
dialog needs a human to click it, and this one needs a command-line flag once. Advice that ends in
"someone has to dismiss this" is a dead end for a model working alone, and this case has an exit.

### Reaping that only runs after the thing it was written to survive

Dismissing the prompt unblocked the editor, and the very next call was refused:

```
too_many_connections — the bridge is already holding its maximum concurrent connections
```

Nothing had leaked. One tick later the bridge was fine. The refusal was a *second* failure, produced
by the first, arriving after the first was already fixed — which is the version that misleads,
because the cause is gone by the time you read the effect.

`Tick` did two things in an order that only mattered here: adopt queued connections, then reap dead
ones. Both live on the game thread, so a modal stops both. Meanwhile the listener thread keeps
accepting — that is its job, and it is on its own thread precisely so a busy game thread cannot
refuse connections. Seven minutes of a client retrying every five seconds parked eighty-odd sockets
in the queue. On the first tick after the block, the queue drained **oldest first**, all thirty-two
slots went to sockets whose clients had given up minutes earlier, and the one caller actually waiting
was refused.

Every reaping rule was correct. Dead socket, peer closed, orderly close, idle too long — all of them
right, all of them downstream of the block. Which is the same shape as the guidance branch two
sections up: good logic sitting behind the thing that is broken, and therefore not running when it is
the only thing that would have helped.

The fix is ordering, not policy: apply the reaping rule *before* the slot is granted rather than
after. Arriving first does not entitle a connection to a slot — it has to still be there.

The first attempt asked that question the obvious way, and the obvious way is wrong:

```cpp
if (!Adopted->IsConnected()) { ++AbandonedPending; continue; }   // shipped, and did nothing
```

`IsConnected()` wraps `GetConnectionState()`, which does not detect an orderly close — it still
answers `SCS_Connected` for a peer that hung up minutes ago. This file already said so, two hundred
lines further down, in the comment explaining why the receive loop stopped gating on
`HasPendingData`: *"Recv ... returns false for an orderly peer close ... That is the only reliable
end-of-stream signal available here."* The check was written anyway, against advice already present
in the same file.

What is worth recording is the reasoning that produced it, because it was not lazy — it was a
specific, confident, wrong inference. The refusal had cleared on the very next tick, nine
milliseconds later. From that I concluded `IsConnected()` works and the bug was purely ordering. The
observation was real; the attribution was invented. The reap loop clears dead clients through
`ProcessClientSocket`'s `Recv`, not through `IsConnected()` — so the effect I had watched had a
mechanism I never checked, and I built the fix on the mechanism I had assumed.

Measured, on the same trial, with only the predicate changed:

| | connections refused | connections discarded |
|---|---|---|
| `IsConnected()` check | **18** | 0 |
| `Recv`-based probe | **0** | **48**, in a single tick |

The working version asks the way the servicing loop asks, which also means nothing is thrown away by
asking early: `ProcessClientSocket` reads what is there into `RecvBuffer`, answers any complete
request, and sets `bPeerClosed` at end of stream. A client that has connected but not spoken reads
zero bytes and stays. A client that sent a request and then vanished still gets its reply, because
`HasPendingSend` keeps it.

```cpp
const bool bWorthKeeping = ProcessClientSocket(*Adopted);
if (!bWorthKeeping || (Adopted->bPeerClosed && !Adopted->HasPendingSend())) { ++AbandonedPending; continue; }
if (Clients.Num() >= MCPMaxClients) { /* refuse */ }
```

### The trial that agreed with the bug, again

None of the table above would exist if the first trial had been believed. It reported PASS, and it
reported PASS against the *unfixed* binary too — checked on purpose, by reverting the commit and
rebuilding, which is the only reason it was caught. Two earlier versions of it were worse: one used
the wrong request envelope, so every command returned `unknown_cmd` and the "heavy" phase it was
racing never ran; another slept 800ms before opening its sockets, by which time the command it was
racing had already finished. All three passed. A trial that cannot fail is not evidence, and the only
way to find out which kind you have is to run it against the broken thing.

The version that earns its keep asserts its own preconditions — the sockets must be opened *while*
the command is still in flight, and the command must actually have succeeded — and reads the bridge's
own log afterwards rather than trusting its own verdict. The log is what produced the table, and the
log is what showed that the shipped fix had discarded nothing at all.

### One engine compiled it, and only through a header that no longer exists

`build-engines.mjs` builds the plugin against every engine in `build-targets.json`, and 5.8 had been
failing. The summary it printed said this:

```
MCPCommandHandler.cpp(24,1): fatal error C1083: Cannot open include fi
```

Cut at exactly 160 characters, one short of `le: 'Engine/UserDefinedStruct.h'`. The absolute path —
the temp build root, the host project, the module, the `Private` directory, none of which the reader
can act on — had spent the whole budget, and the one word identifying the bug fell off the end. The
fix is not a bigger budget, because the path grows with wherever the build runs. It is to trim the
path to `<file>(line,col):` and spend the width on the message. The same line now reads complete in
130 characters.

The bug it was hiding is more interesting than the truncation. `Engine/UserDefinedStruct.h` does not
exist in 5.8; the header lives in `CoreUObject/Public/StructUtils/`. But 5.6 has **both** spellings,
and the old one is a shim:

```cpp
// 5.6: Engine/Classes/Engine/UserDefinedStruct.h, in full
#if UE_ENABLE_INCLUDE_ORDER_DEPRECATED_IN_5_5
#include "StructUtils/UserDefinedStruct.h"
#endif
```

So this was never merely "broken on the engine we do not test against". On the engine it *was* tested
against every day, it compiled only because a deprecated-include-order flag happened to be on, and it
was one build setting away from failing there too. The 5.8 failure was the first visible symptom of a
latent break, not a portability problem.

Both engines have the real path, so the fix needed no version guard at all — just the current
spelling.

**And the sweep, because one instance is not the interesting question.** The same move that hides one
moved header hides all of them, and finding them one build at a time costs three minutes of compiling
each. Listing every `.h` under both engines and checking all 166 headers the plugin includes takes one
pass:

```
indexed: 5.8 has 137723 include spellings, 5.6 has 133442
plugin references 166 distinct engine headers

MOVED OR REMOVED IN 5.8: none
NOT FOUND IN EITHER INDEX (10) - probably plugin/module headers outside Engine/Source:
  InputAction.h, NiagaraSystem.h, K2Node_EnhancedInputAction.h, ...
```

Clean, and the ten unfound are Enhanced Input and Niagara, which live under `Engine/Plugins` rather
than `Engine/Source` — exactly what the script says about them, rather than a result to explain away.

### The gate that was in the graph the whole time

Two attempted fixes for the rubber-band failed, and after the second one this README concluded that
"the coupling is deeper than the graph shows". That was a guess, made at the end of a long session,
and it was wrong in the direction that excuses not looking further. Reading the chain took four
calls.

`trace_variable` on `VaccumDragStrength` says where it is read — one place, a function called
`DraggedByVacuum` on `BP_BaseCharacter`. `trace_function_calls` says who calls it — one place, the
Event Graph. Walking the exec links backwards from that call gives the whole thing:

```
BP_BaseCharacter, EventGraph:
    Event Tick  ->  Set DeltaSeconds  ->  DraggedByVacuum(DT)

BP_BaseCharacter, DraggedByVacuum:
    Branch  (CheckGameplayTag AND NOT isDead)
      -> Branch  (Has Authority)                      <- the client stops here
        -> CharacterMovement.AddForce( UnitDirection(ActorLocation -> LocationDragged)
                                       * VaccumDragStrength * DT )
```

`Event Tick` runs on every machine. The first branch passes on every machine. The second one does
not: `Has Authority` is false on a client, so `Add Force` is reached only on the server. The client's
CharacterMovement predicts the next position with no force in it, the server's has one, they
disagree, and the server sends a correction. That is the rubber-band, and it is four nodes.

It also explains the second failed attempt exactly. That attempt replicated `VacuumingPlayers` so
every machine would know *what* was pulling it, and the replication demonstrably worked — the client
had the list. But the force is applied behind `Has Authority`, which nobody had changed, so the
client still applied nothing. The data arrived and the gate was still shut. Half a fix looks
identical to no fix from the outside, which is why it read as a deeper mystery than it was.

And the inputs confirm it. `list_variables` on the same Blueprint:

| variable | replicated |
|---|---|
| `LocationDragged` | **false** |
| `VaccumDragStrength` | **false** |
| `isDead` | false |

Which matches the original measurement — server `VaccumDragStrength=250`, client `0` — and means a
complete fix is two changes, not one: replicate the inputs the function reads, *and* let the owning
client through the gate. Either alone does nothing, which is precisely why one attempt at each looked
like two dead ends instead of two halves.

**What is still a judgement call, and is the user's:** `AddForce` is not part of the move the client
saves and the server replays, so applying it on both sides makes the two simulations agree closely
rather than exactly. The engine-exact route is to feed the pull through `AddInputVector`, which *is*
replicated with the move and replayed identically — at the cost of being clamped by `MaxAcceleration`
and therefore changing how the vacuum feels and what `VaccumDragStrength = 250` means. The first
option preserves the tuning and reduces the correction; the second removes the cause and changes the
feel. Both are defensible; neither is mine to pick on a project with no version control and two
reverted attempts behind it.

### The C++ leg, end to end, on a bug the Blueprint leg could not fix

The rubber-band diagnosis above ends at a decision the tool should not make alone, so it was put to
the user: keep the feel and reduce the snap, change the feel and remove the cause, or fix it properly
in C++. They chose C++, which is the interesting answer, because it exercises the half of this server
that exists for exactly that and is used least.

The first useful thing was not writing code. It was reading the engine to find out whether the code
needed writing at all. The plan had been to extend `FSavedMove_Character` by hand — the standard
recipe for "make the server replay a force the client applied" — which is a real amount of work and
easy to get subtly wrong. Two greps said don't:

```
CharacterMovementComponent.h:2983    FRootMotionSourceGroup SavedRootMotion;
CharacterMovementComponent.h:2513    ClientAdjustRootMotionSourcePosition_Implementation(...)
CharacterMovementComponent.h:2740    ConvertRootMotionServerIDsToLocalIDs(...)
RootMotionSource.h:470               struct FRootMotionSource_RadialForce
                                       FVector Location; TObjectPtr<AActor> LocationActor;
                                       float Radius; float Strength; bool bIsPush; bool bNoZForce;
```

Root motion sources are already part of the saved move, already have their own correction path, and
already have an ID-matching function whose entire job is pairing a server's source with the client's
predicted copy. And `FRootMotionSource_RadialForce` is a vacuum: a location, a radius, a strength,
and a `bIsPush` that is false for a pull.

Then the part that decided the design, from `PrepareRootMotion`:

```cpp
const FVector ForceLocation = LocationActor ? LocationActor->GetActorLocation() : Location;
```

Read every frame. Hand it the vacuuming *actor* and every machine computes the pull direction locally
from that actor's own replicated position — which is precisely the shape this README had already
identified as the real fix ("tell the client what is dragging it once and let it compute the
per-frame direction locally"), sitting in the engine the whole time. It is also the exact failure of
the first attempted fix, inverted: that one replicated a direction vector at the network rate to feed
a force that needed one per frame, and the character juddered.

What was actually written is one small function library, `UAVSVacuumStatics`, and the whole of it is
`ApplyVacuumPull` / `RemoveVacuumPull` / `IsVacuumPullActive`.

The round trip is the point:

| step | how |
|---|---|
| find where the force is applied | `trace_variable`, `trace_function_calls`, exec-link walk |
| confirm the engine API rather than recall it | reading `CharacterMovementComponent.h` and `RootMotionSource.cpp` |
| write the C++ | into the project's existing module, no new dependencies |
| compile it with the editor open | `live_coding_compile` → **"Live coding succeeded"** |
| confirm the class exists at runtime | `describe_class` → `/Script/AntiVirusSquad.AVSVacuumStatics` |

No editor restart, no build script, no closing anything. The header records the two things that do
not carry over, because they are the kind of detail that turns a correct fix into a bug report:
`Strength` is now an additive velocity in cm/s rather than a force divided by mass, so
`VaccumDragStrength = 250` does not mean what it meant; and `Radius` is a hard gate —
`PrepareRootMotion` applies nothing at all at `Distance >= Radius`, which the old `AddForce` had no
equivalent of, so a radius left at zero is a pull that silently never happens.

**What is deliberately not done:** the Blueprint rewiring. The primitive compiles and is callable, but
switching `DraggedByVacuum` over means changing when the pull starts and stops, replicating the
vacuum source to the pulled client, and calling it on both the server and that client — gameplay
surgery on a project with no version control, whose final check still needs two humans in a session.
The tool's job was to make the correct fix available and say exactly what it costs. That part is
done and verified; the wiring is a decision, not a mechanism.

### The cheap read left out the only thing worth reading

Finding the rubber-band gate took a dozen calls and a hand-written script to walk exec links
backwards. Afterwards, the obvious question: why was that necessary, when `unreal_explain_graph`
exists and its own description says *"read this before reading a graph node by node"*?

Because on that function it produced this:

```
DraggedByVacuum: 18 nodes, 1 entry point(s).
- DraggedByVacuum -> Branch -> Branch -> Add Force
Not reached by any event chain (data nodes or dead logic): CheckGameplayTag, AND Boolean,
NOT Boolean, Get isDead, Has Authority, ...
```

Two things wrong, and the second is worse than the first.

**`Branch -> Branch -> Add Force` is true of a thousand graphs.** It names the shape of the logic and
none of its content. The entire diagnosis — that the second branch tests `Has Authority`, so the
force never runs on a client — is absent. A model reading the cheap summary has to go and pay for the
expensive one, which is the single outcome the tool exists to prevent.

**And `Has Authority` was filed under "dead logic".** Along with the AND, the NOT, and `Get isDead` —
the three nodes that decide everything the function does. A reader takes that as permission to ignore
them. It is not merely unhelpful, it points the opposite way, which is the failure mode this project
keeps finding: a read-only tool sounding certain about something it has mis-modelled.

Both come from the same root. The walker follows execution links, and a branch condition arrives on a
data link, so conditions were invisible to the chain and indistinguishable from orphans to the
leftovers list.

Now:

```
- DraggedByVacuum -> Branch (CheckGameplayTag AND NOT Get isDead) -> Branch (Has Authority) -> Add Force
```

One line, containing the whole answer that previously took a dozen calls. Four rules produce it, and
each was added because the version without it said something useless:

| without | with |
|---|---|
| `Branch` | `Branch (Has Authority)` — the condition's source node |
| `Branch (AND Boolean)` | `Branch (CheckGameplayTag AND NOT Get isDead)` — resolved two levels |
| `Branch (float < float)` | `Branch (Get Health < Get MaxHealth)` — comparisons name operands |
| `Branch (Reroute Node)` | `Branch (Has Authority)` — a knot is a wire, not a value |

A comparison against a typed-in number resolves to `Get Health >= literal`, because a literal has no
link and so is not in `connectedPins` at all. Naming the half that is a variable is the half a reader
can act on; inventing the other half would be worse than admitting it.

The cost, on the largest graph in the project — `BP_Player`'s 819-node EventGraph:

| | tokens |
|---|---|
| `read_blueprint_graph_summary` (structure) | ~53,300 |
| `explain_graph`, before | ~7,684 |
| `explain_graph`, after | ~7,734 |

**38 branches gained their conditions for 50 tokens** — six tenths of one percent — and the
explanation stays seven times cheaper than the structure it replaces. That is the shape of token
saving worth having: not a smaller answer, a sufficient one. The expensive read is now avoidable for
the question it was most often being bought to answer.

**The discoverability half is worth admitting too.** The tool was there the whole time and was not
reached for, because this session was driving the bridge commands directly rather than the server
tools. Bypassing the layer that adds the summaries costs exactly what the summaries were worth. That
is a hazard for anything driving this from a script, and the reason `unreal_explain_graph`'s
description now opens by naming the debugging question it answers rather than only its token count.

### The guard that kept its own copy of the number it guarded

`measure:reads` exists to stop quoted token figures going stale, and it opens with a comment
explaining that the standing instructions once carried numbers that were 30% out. Running it found
another: `read_class_defaults` is quoted at 3,237 tokens and measures **1,691** — 48% out, in the one
text a model cannot skip.

Correcting the sentence did not make the guard pass. It kept failing, against its own hardcoded copy:

```js
const QUOTED = [
  { label: "read_class_defaults", quoted: 3237, where: "the HOW TO WORK instructions" },
```

Which is the same defect the guard exists to catch — two places describing one thing, free to drift —
committed by the guard itself. A check that complains about a number somebody has already fixed is
worse than no check, because it teaches people to ignore it.

It now reads the figure **out of the server's own text**: the `instructions` from `initialize` plus
every tool description, the exact bytes a client receives. A pattern that stops matching is also a
failure, because a reworded sentence is a sentence whose number is no longer checked, and passing
silently would make the whole thing vacuous.

The same pass corrected a second inaccuracy in that file. It claimed all three of its figures
appeared "in the standing instructions and tool descriptions". Only one did — `list_variables` and
`list_data_table_rows` live in source comments. Worth measuring, since a comment that lies costs the
next reader an afternoon, but they are not what a model reads, and the two are now listed separately
and truthfully.

### A pair that could only be compared below the cap

Asking the server what it actually advertises turned up four sentences quoting a measured number, and
one of them was mine from the previous section:

```
A 59-node EventGraph costs 2,328 tokens as a node-and-pin structure and 323 here, a seventh
```

Adding branch conditions to `explain_graph` should have moved that. Measured on `BP_Projectile`,
which at exactly 59 nodes is plainly the graph it was written about: the structure is still **2,328**
— the quote is exact — and the explanation is **268**, not 323. It got *cheaper* while gaining the
conditions, because dropping the false "dead logic" list saved more than the conditions cost.

Pointing the guard at that claim then exposed something better. It reported `explain_graph` as **740%
over**, because it measures against the biggest graph in the project and the claim is about a small
one. And the comparison is not merely mismatched, it is meaningless above 60 nodes:
`read_blueprint_summary` **caps at 60**, so on an 819-node graph it returns 60 nodes while
`explain_graph` returns all 819. Comparing those two numbers rewards the read that answered a
fraction of the question.

So the guard now picks a second graph — the largest one *under* the cap, deterministically — and
measures both reads on it, checking both halves of the sentence:

```
worst graph found: EventGraph, 819 nodes
comparable graph (under the 60-node structural cap): BP_FlyingEnemy EventGraph, 56 nodes
  structure (comparable)         1996
  explain_graph (comparable)      337
```

And the claim was restated on the graph the guard actually measures, so it stays self-checking rather
than being a number from a graph nobody will look at again. It reads *a sixth* now instead of *a
seventh*, which is a smaller boast and a true one.

Three guards caught each other in sequence doing this: `measure:reads` found the stale figure,
`check:claims` refused the new figures until they were registered, and `check:profiles` caught the
README cost table one token out. None of them is clever. Each of them is a number that has to agree
with another number, which is the only kind of documentation that stays true.

### The same empty brush, exported twenty-eight times

The read census puts `list_data_table_rows` at the top, so that is where the next saving should be.
Looking at what is actually in it: one row of `DT_UniversalActions` is 816 characters, and the
information in it is `Key=Gamepad_FaceButton_Bottom`. The rest is an FSlateBrush nobody ever touched —
`DrawAs=NoDrawType`, `ImageType=NoImage`, `ResourceObject=None`, every margin zero. It draws nothing,
and it is exported in full for every row of every brush column.

Counted properly, the identical 514-character empty brush appears **28 times in one reply**, which is
**67% of it**.

Two compactions already existed and neither can touch this. `trimFloats` shortens each number —
worth 20% here, and already applied. `compactRows` drops a field whose value equals a stated default.
This is a value that is correct, meaningful, and *repeated*, which is a third thing.

So it is written once:

```json
{ "rows": [ { "values": { "KeyboardInputTypeInfo": "(Key=None,...,OverrideBrush=@1@)" } } ],
  "repeated": { "@1@": "(TintColor=(SpecifiedColor=(R=1,G=1,B=1,A=1),...,ResourceName=\"\")" } }
```

| | tokens |
|---|---|
| before | 5,147 |
| after | **1,723** |

**67% off, losslessly.** That last word is doing real work. This does not summarise the value, or
assert something about it, or rely on the reader knowing a convention the way `compactRows`' "absent
means false" does — the exact bytes the engine exported are present, once, and substituting the
legend reproduces the original character for character. There is a test that does exactly that
substitution and compares.

**The trap, and why it is closed rather than documented.** A model that reads `@1@` and pastes the
row back would write the two characters `@1@` into an FSlateBrush column, and the engine would accept
it. So `unreal_set_data_table_row` refuses a value containing a marker and says what to do instead.
Confirmed against the live table:

```
Refusing to write 1 value(s) containing a placeholder from a unreal_list_data_table_rows reply:
KeyboardInputTypeInfo. Markers like @1@ stand for a repeated struct that was written once in that
reply's `repeated` legend... Substitute the legend text for the marker and call again.
```

That guard is the reason this is on by default rather than behind a flag nobody sets.

**Collisions are checked, not assumed.** If `@1@` already appears anywhere in the data the prefix
grows until it does not, and if no free prefix exists the whole compaction is skipped. A saving that
corrupts one row in a thousand is not a saving, and a test feeds it a row whose real content is
literally `"@1@"` to prove the pre-existing text survives.

`list_data_table_rows` is no longer the most expensive read in the surface. The comment that called it
that has been corrected rather than left to age — as has the pair it quoted, now 1,723 against 150
with `fields`, caught by `measure:reads` the moment the number moved.

### Four near-misses in one session, all the same mistake

This one nearly became a fifth reimplementation of something that already existed. The pattern is
worth writing down because it has a single cause.

- Wrote a script to walk exec links backwards — `unreal_explain_graph` does that.
- Started building a read-cost census — `measure-reads.mjs` exists.
- Was about to add struct/enum readers — `list_struct_fields` and `list_enum_entries` exist.
- Measured `list_data_table_rows` at 6,748 tokens full of `0.000000` and started designing a float
  trimmer — `trimFloats.ts` exists, cites this exact table, and was already applied.

Every one of them came from **measuring through the bridge instead of through the tool**. The bridge
is deliberately faithful; all the compaction lives in the tool layer, so a bridge reply shows the
project as it was before any of this work. Reading it and concluding "nothing has been done here" is
an easy and entirely wrong inference, and it cost four detours before the pattern was obvious.

`scripts/call-tool.mjs` is the fix, and it earned its keep the moment it existed. It also had the same
disease in miniature: it truncated replies at 1,200 characters, so the first measurement it produced
reported a 5,000-token reply as 300 tokens. It takes `--full` now.

### Checking whether the last saving generalises, and finding it does not

The repeated-struct compaction took 67% off `list_data_table_rows`, and it is written as a general
function rather than something Data-Table-shaped. The obvious next move is to wire it into the other
reads. The right next move is to find out whether they have anything to collapse.

They do not. Every read in the census, scanned for balanced struct groups repeating three or more
times:

```
  read                        tokens    prize     %
  read_class_defaults           1691        0    0%
  read_asset_properties          338        0    0%
  list_actors                   2392        0    0%
  review_blueprint              2787        0    0%
  list_variables                1750        0    0%
  read_blueprint_summary        2158        0    0%
  list_blueprints               2625        0    0%
```

Zero, everywhere. Data Tables are the one read that exports a full nested struct per row, so they are
the one read where the same untouched `FSlateBrush` can appear twenty-eight times. Wiring the
compaction into the rest would have added a legend, a marker convention and a write-side guard to
seven tools that would never use them.

Recorded because a negative result that took ten minutes to establish saves the next person from
re-deriving it, and because "the general fix should be applied generally" is exactly the kind of
reasoning that sounds right and costs a day.

### Fourteen percent of a reply was node ids nobody can use

With that ruled out, `review_blueprint` is the most expensive read at 2,787 tokens. Breaking it down
by where the bytes go:

| part | share |
|---|---|
| `graphs` (the findings) | 69% |
| `fixes` (advice, already deduped per check) | 17% |
| everything else | 14% |

And inside the findings, one number stands out. Node ids, by severity:

```
warning   16 findings    22 ids     260 chars
info      15 findings   145 ids   1,610 chars
```

Sixteen warnings — the things that might be bugs — carry 260 characters of node ids between them.
Fifteen infos carry **1,610**, and 1,562 of those belong to a single check:

```
unlabelled-sections   "3 execution chains but only 0 comment box(es)."
                      nodeIds: [every chain root]
                      fix: "Run unreal_auto_layout_graph"
```

The count is already in the message. The fix takes a *graph*, not a node — nobody wraps an execution
chain in a comment box one id at a time. So those 1,562 characters, **14% of the whole reply**, are a
list a caller cannot act on.

Dropped, and only for checks that pass that test. `dead-node` says "remove them with
unreal_remove_node" and needs every id. `long-exec-chain` says "extract the middle of it" and its root
id says which chain. `debug-print-left-in` needs to say which prints. Twenty of the thirty-one
findings keep their ids; the eleven that lose them lose nothing.

**2,787 → 2,366 tokens, −15%**, and only at serialisation: `cleanup.ts` reads `finding.nodeIds.length`
off the review internals to report what it left alone, and `audit.ts` reads findings too. Both call
`reviewBlueprint` directly and still receive every field.

### The test for the boring case caught the real bug

The change came with three tests. Two check the intended behaviour. The third checks something that
sounded like paperwork — a review with unactionable ids but *no repeated fixes* — and it was the one
that failed.

`dedupeFixes` builds its `fixes` map for every check, first one wins, and only *emits* the map when
something actually repeated. The stripping ran off the map. So a review with ids to drop and nothing
repeated had each finding's `fix` lifted into a map that was then thrown away: the advice disappeared
from the reply entirely.

That is a silent, total loss of the thing the tool exists to produce, and it existed for about four
minutes. It was not found by thinking about it. It was found by writing the test for the combination
that seemed too dull to break.

### The expensive half of a row, and the note that said not to touch the cheap one

`actorList.ts` carries a long comment recording an idea that was implemented, measured and reverted:
dropping each actor's `class` because its `blueprint` path already ends in it. The measurement was 38
tokens saved, against losing the field `classFilter` matches on and every caller identifies an actor
by. Correctly rejected, and kept as a comment "because the idea looks good until it is measured".

Measuring the same rows from the other end gives a very different number:

```
label       uniq 40/40    704 chars
name        uniq 40/40    868 chars
class       uniq 14/40    736 chars
location    uniq 40/40    662 chars
blueprint   uniq 14/40  3,233 chars   <- 39% of the actors block
```

Fourteen distinct paths written out forty times. The note defends `class`, which costs 736
characters; the path beside it costs 3,233 and is the one repeating. So `class` stays on every row —
it is what identifies an actor — and the path moves to a map keyed by it.

**2,392 → 1,791 tokens, −25%**, and the lookup a caller does is on a value the row already carries.

**The 1:1 relation is checked, not assumed.** `/Game/Red/BP_Thing` and `/Game/Blue/BP_Thing` both
generate a class called `BP_Thing_C`, and then the class identifies nothing. Any class with more than
one path keeps `blueprint` on its rows, so the map never claims something it cannot support. There is
a test with exactly that pair. An actor that is the only one of its class also keeps its path, because
a map entry would be the same bytes plus a lookup.

**Two hoists that had to be ordered.** `hoistSharedClass` already lifts `class` out when every row
shares one. Run first, it strips the field this keys on, so the level with the most to lift — every
actor the same Blueprint — lifted nothing at all. Paths first, then the class. A test asserts on the
combination, where a row ends up carrying neither field and both are named above it.

That test was the interesting part of the change. An existing test asserted `out.actors.every(a =>
a.blueprint)` to mean "the cap chose actors that carry logic, not dressing". The property is
unchanged; only where the answer is written moved. Updating an assertion like that is the moment to
be careful, because relaxing it and calling it a shape change is exactly how a real regression gets
waved through — so it now asks both places rather than fewer.

### Two reads measured and left alone

`list_blueprints`, at 2,625 tokens, is the largest remaining read. Where the bytes go: 100 entries of
`{"path": ..., "parentClass": ...}`, with 2,234 characters of repeated folder prefixes and 37 distinct
parent classes across 100 rows. A columnar or folder-grouped shape would take roughly 28% off.

It was not done, because the same saving is already available without a schema change and the reply
says so:

```
fields: ["path"]     2,625 -> 1,888   (the reply claims "about 27% smaller"; it measures 28%)
match: "Turret"      2,625 ->    84
```

Adding a grouped shape would duplicate what `fields` already gives, at the cost of making a caller
reassemble paths it currently reads directly — and a wrong path is a failed call somewhere else.

`read_class_defaults` at 1,691 and `list_variables` at 1,750 have the same story: a `match` filter
that answers a specific question for 218 and 126 tokens respectively, advertised in the reply.

Recorded because "the biggest number is the best target" is only true when the number is *waste*.
These three are near their floor for what they are being asked, and the cheap forms beside them are
accurate and advertised. The next saving is not here.

### Six trial steps that had never run

Building a benchmark for whole-task cost started by measuring nothing at all: every step came back as
the same validation error, and dispatch mode "won" by 308 tokens because an error is short. Eight
identical step costs gave it away. The benchmark now refuses to price a call that failed.

That was worth generalising, because the trials have the same shape. `step()` in `trial-diagnose`
computed its verdict like this:

```js
const problem = r.error ? "JSON-RPC error" : check ? check(text, parsed) : null;
```

`r.error` is the JSON-RPC **transport** error. A tool that refuses arrives as `result.isError` with
the reason as ordinary text content — so a step whose check was "did anything come back" passed on
the refusal, because a refusal is words. Adding four lines to catch `isError` turned up six steps
across two trials that had never executed:

| trial | step | why |
|---|---|---|
| diagnose | find orphans project-wide | called `find_orphans` with `{}`; schema requires `of` and `pairedWith` |
| runtime | make the actor replicate | `propertyName` where the schema says `property` |
| runtime | make it relevant to every client | same |
| runtime | unreplicated: play, two players | refused by the compile-error guard |
| runtime | replicated: play, two players | same |

The diagnose one was wrong twice over. Even with the right arguments, `find_orphans` looks for a
**level actor** of one class stranded far from its partner class — half a deletion in a map, not a
node left behind in a graph. It could never have found the defect that trial plants. It has been
replaced with `explain_graph`, whose unreachable list is exactly "nodes no event chain reaches",
which is what the planted defect *is*; and the check asserts the stray node is **named**, because a
count would be true and unactionable.

The runtime ones are worse, because of what that trial claims. Its own header says step 4 "is the
point — every other check in this repository can tell you a change was WRITTEN; this is the only one
that can tell you it WORKED." Two of its steps set `bReplicates` and `bAlwaysRelevant`, and neither
had ever taken effect. The two steps that actually play the game were refused by the compile-error
guard over fifteen unrelated Lyra Blueprints, so the whole replication claim rested on steps that
never ran. Sixteen calls, four of them refusals, reported green.

With the parameter fixed and `ignoreCompileErrors` passed for the sample content it does not care
about, it runs twenty-four calls and ends where it always said it would:

```
  Authority  70 -> 381   changed=true
  Client      0 -> 381   changed=true
```

The client counter moving is the replication fix observed on a running game — the thing the trial
exists to prove, produced for the first time.

**The lesson is narrow and worth stating precisely.** Every one of these was a *strict schema doing
its job*: the server refused a malformed call and said exactly which parameter was wrong. The refusals
were correct, informative, and completely invisible, because the harness that received them treated
"the tool said something" as "the tool worked". A guard that reports beautifully to nobody is not a
guard.

### What a whole task costs, and where dispatch stops paying

`measure-profiles` guards the standing cost of the tool definitions. `measure-reads` guards what one
reply costs. Neither answers the question a bill is actually made of, so `measure-task-cost.mjs` runs
the same eight-step find-and-fix task twice — once with every tool advertised, once with three tools
and every call through `unreal_call_tool` — and prices both.

|  | full | search |
|---|---|---|
| tools advertised | 122 | 5 |
| standing, paid once then cached | 41,615 | **1,504** |
| requests sent | 296 | 366 |
| replies received | 1,125 | 1,555 |
| **first run of the task** | 43,036 | **3,425** |
| **each repeat, cache warm** | **1,421** | 1,921 |

So dispatch is not free: it costs about 500 tokens more per run of this task, because the wrapper is
per call and the guidance the dispatcher attaches on first use is real. Against 40,111 tokens of
standing cost saved, **it stays ahead for roughly 80 runs of this task — about 640 tool calls** — and
is dearer after that.

Worth stating plainly, because it is easy to overstate in the other direction: the tool list sits
before the system prompt and the messages, so with prompt caching it is paid at full price **once**
and read cheaply afterwards. It is not re-charged per turn. What re-charges it is *changing* the tool
list, which is the whole reason `unreal_call_tool` exists and `unreal_enable_tools` is expensive.

### Fixing the same four lines twice is how they got wrong in the first place

Catching tool refusals meant editing `step()` in `trial-diagnose` and again in `trial-runtime`, and
the two copies were near-identical before and after. That is the duplication this repository
complains about everywhere else, committed while fixing a bug caused by it.

`scripts/lib/trialStep.mjs` now holds it. A caller still owns the **check** — whether a reply says
the thing the trial claims, which should differ per trial — and no longer owns deciding whether a
reply happened at all. `trial-runtime`'s one genuine difference survives as a hook: a bridge command
the installed plugin has never heard of is an environment that has not caught up, not a broken claim,
so it downgrades to a warning instead of a failure.

Both trials produce byte-identical output after the change, which is the only evidence a refactor of
a test harness is worth anything.

### What the replication trial was always meant to print

With its refused steps repaired, `trial-runtime` runs both halves for the first time:

```
unreplicated   Authority  62 -> 376   changed=true
               Client       0 -> 0     changed=false      <- the bug, observed
replicated     Authority  67 -> 390   changed=true
               Client       0 -> 390   changed=true       <- the fix, observed
```

Its closing line reported only the first of those. That was accurate for as long as the trial could
not do the second — `bReplicates` was never set, because the call that sets it had been refused since
the step was written — so the summary described what the trial actually managed rather than what it
claimed in its own header. It says both now.

Worth separating the two failures, because they are different sizes. Missing the fix half is a bug in
a test. Announcing a conclusion the run did not reach is the thing this repo keeps having to correct
in itself, and it is the one that costs a reader their trust in every other line beside it.

### Running all of them, which nobody had done at once

Two trials turned out to be reporting green over steps that never ran, so the obvious next question
is how many others were. Every trial, run against a live editor in one pass:

| trial | result |
|---|---|
| diagnose | 9 calls, green |
| runtime | 24 calls, green, both halves |
| feature | 33 calls, green — and could not have seen a refusal |
| find-truth | **11/13** |
| node-search | 29/29 |
| parent-call, chain, lifecycle, data-feature, workflows | green |

`trial-feature` had the same blind spot as the other two — `r.error` only, so a tool refusal would
have read as an answer. It happened to have nothing hidden behind it, which is worth stating plainly:
the check was added and *found nothing*, and that is a result rather than a disappointment. It cannot
develop one now.

`trial-find-truth` was the one actually failing, at 11/13, and it had been for some time.

### A stale check fails exactly like a broken tool

The two failures read as capability gaps:

```
FAIL  a struct reports its fields - S_UpgradeCount.S_UpgradeCount ->
FAIL  an enum reports its entries - E_InputDevice.E_InputDevice ->
```

Nothing was broken. `unreal_read_asset_properties` used to inline a struct's fields, and was changed
to return an empty `properties` and a pointer instead:

```json
{ "class": "UserDefinedStruct", "properties": [],
  "next": "A struct's content is its fields, which are not properties and are not listed above.
           unreal_list_struct_fields has them, with the type names unreal_add_struct_field accepts." }
```

That is the better design — a struct's fields are not properties, and holding them in two tools is
how the two drift apart. The trial was not updated with it, so it went on asserting a shape nothing
produces. And a stale check fails in exactly the way a broken tool does, which is why two red lines
sat in the output unread.

It now tests the path a model actually walks: the pointer has to **name** the tool that has the
answer, and that tool has to have it. Three checks instead of two, and 15/15.

### "NewEnumerator2" is true and useless

Repairing the enum half surfaced something the old check had been printing for as long as it existed:

```
E_InputDevice -> NewEnumerator0=0, NewEnumerator1=1, NewEnumerator2=2
```

Unreal stores a User Defined Enum's entries under generated names and keeps what the author typed
separately. `unreal_list_enum_entries` returns both — the trial was reading past `displayName` and
asserting on the internal one, so it passed while displaying three names nobody could act on. The
same asymmetry cost real time earlier in this project, when a Data Table cell read `NewEnumerator2`
while the editor showed "Shield Booster".

The check now requires a display name on every entry, and prints them:

```
E_InputDevice -> KeyboardAndMouse=0, Xbox=1, PlayStation=2
```

Which is the whole theme of this pass. None of these were broken tools. They were **assertions weaker
than the claim above them** — "reports its entries" satisfied by a generated name, "the whole path
works" satisfied by a refusal, "the fix, observed" satisfied by never setting the flag. A test suite
drifts this way quietly, because every one of those still prints in green.

### The note that recommended the expensive route on the cheap profile

Pricing the same task in both modes left one number unexplained: `review_blueprint` cost 87 more
tokens through the dispatcher than called directly, twice. A wrapper should not change what a tool
returns, so it was worth finding out what did.

It was not the wrapper. The reply itself differs, because on `search` most tools are not listed and
the review names one in its advice:

```json
"toolsNotEnabled": ["unreal_auto_layout_graph"],
"toolsNotEnabledNote": "1 tool(s) named above are switched off in this session:
   unreal_auto_layout_graph. unreal_enable_tools({ tools: [\"unreal_auto_layout_graph\"] })
   turns on exactly those, which costs far less than a whole group."
```

Two things wrong with that, and the second is not about tokens.

They are **not switched off**. On `search` and `lazy` the dispatcher is standing, and
`unreal_call_tool` runs any registered tool immediately. Calling them unreachable is false about the
one profile where the note fires most.

And the advice is backwards. `unreal_enable_tools` changes the tool list, and changing the tool list
re-charges the entire cached prefix — the single most expensive thing a model can do to its own
context, and the thing the standing instructions were corrected two commits ago to warn about. The
note was sending callers to that, on the profiles that have the cheap alternative, in a reply that
arrives dozens of times a session.

It now asks `isEnabled("unreal_call_tool")` — the same question, from the source already passed in,
rather than a second copy of the profile to keep in step — and says:

```
1 tool(s) named above are not in this session's tool list: unreal_auto_layout_graph.
unreal_call_tool({ tool: "unreal_auto_layout_graph", args: {...} }) runs one straight away and
leaves the list alone; enabling them instead re-charges your whole cached prefix.
```

**The test fixture was the interesting part.** The existing tests used `allOnExcept(...)`, meaning
"everything on except these" — which reported `unreal_call_tool` as enabled, and so modelled a
profile that does not exist. `full` disables the dispatcher deliberately, because every tool is
already listed and a hop would only add a schema. The fixture now says so, and a second one models
`search` where the dispatcher stands. One of them had to break for this change to be visible, and the
one that broke was the one describing a session nobody runs.

### A one-time cost charged to every run

The task-cost benchmark said dispatch costs 521 tokens more per run of an eight-call task, and most
of that was one step: `build_graph`, 124 tokens direct against 397 dispatched. A wrapper adding 273
tokens to one call and nothing to five others is not a wrapper cost, so it was worth asking what it
actually was.

Running the same call twice in one session answers it:

```
build_graph #1: 381 tokens, 2 content blocks
build_graph #2: 108 tokens, 1 content block
```

The second block is `GROUND_TRUTH` — the pin names and node kinds a model cannot derive — delivered
alongside the first authoring call of a session and never again. And the steady-state dispatched call
is **108 tokens against the direct call's 124**, because the dispatcher's reply does not repeat the
schema the direct path echoes.

So the benchmark was charging a once-per-session cost to every run. It now runs the task twice and
reports both, because "a session's first pass" and "every pass after" are different questions and
only the second one decides anything:

|  | full | search |
|---|---|---|
| replies, first pass | 1,125 | 1,496 |
| replies, second pass | 1,125 | **1,223** |
| first run of the task | 43,036 | **3,366** |
| every run after | **1,421** | 1,589 |

Break-even moved from about 616 calls to **about 1,910**. The earlier figure was not wrong about
anything it measured; it was measuring a first pass and calling it a repeat.

### The last recurring difference was a paragraph nobody needed twice

With the one-time cost separated out, the remaining gap came to 178 tokens over eight calls — and all
178 of it was two copies of one note. Every reply whose advice names an unlisted tool carried:

```
1 tool(s) named above are not in this session's tool list: unreal_auto_layout_graph.
unreal_call_tool({ tool: "unreal_auto_layout_graph", args: {...} }) runs one straight away and
leaves the list alone; enabling them instead re-charges your whole cached prefix.
```

The tool **names** vary and are what a caller acts on. Everything else — what dispatch costs against
enabling — does not vary, is already in the standing instructions every model reads, and was being
re-explained on every reply that gave advice. On `search` that is most of them.

```
Not listed this session: unreal_auto_layout_graph. Reach them with unreal_call_tool; no need to enable.
```

**84 tokens to 44**, and the per-task overhead from 248 to 168. What is left is about 70 tokens of
`{tool, args}` nesting on the requests, which is what dispatch *is*, and one short note per advisory
reply, which is information rather than overhead. That is the floor.

Saying a thing once is the difference between advice and nagging, and the standing instructions are
the right place to say it once.

### `force: true` skipped our check and then didn't force

`get_project_overview` on the real project listed a folder nobody had made on purpose:
`__MCPRuntimeTrial`, **10 Blueprints**. One per run of the replication trial, left in a project with
no version control, going back as far as the trial did.

The trial names its asset uniquely per run on purpose, and says why in a comment: a trial that
depends on its own cleanup having worked fails for reasons that are not about what it tests. Fair.
But every one of those runs had *called* `delete_asset`, and every call had reported success:

```json
{"ok": true, "result": {"requested": 1, "deleted": 0, "forced": true}}
```

`find_references` on one of them returns `referencedByCount: 0`. Nothing was holding it. So why did
a forced delete of an unreferenced asset delete nothing?

Because `force` did half the job. It skipped the referencer scan **in our handler**, and then called
the same non-forcing `ObjectTools::DeleteAssets`, which refuses whenever the object is still
referenced **in memory** — a state the asset registry knows nothing about and `find_references` cannot
see. The parameter was named after the engine's concept and did not use it.

`ObjectTools::ForceDeleteObjects` is the engine's own answer: it severs the remaining references and
deletes. It takes loaded `UObject*` rather than `FAssetData`, which is exactly the point — the
references it has to sever are the loaded ones.

Verified on the ten that had refused for weeks:

```
leftovers before: 10
deleted 10  failed 0
leftovers after: 0
```

**And deleting nothing no longer reads as success.** The counts were always in the reply and always
honest; what was missing was that a caller checking `ok` saw a tick. When `deleted < requested` the
reply now says which case it is and what to do — sever with `force`, or close the editor tab holding
it open. Ten assets accumulated precisely because nothing in the reply objected.

The trial now also sweeps what earlier runs left, before adding to it. That keeps both properties the
unique naming was protecting: the run still does not depend on its own teardown, and the litter stays
bounded at one instead of growing forever. As it happens the teardown works now too, since it goes
through the same `force` that has started forcing — but a trial should not need that to be true.

**Worth saying plainly: this was my mess, in the user's project.** The tool wrote ten assets into a
real game that has no version control and reported success ten times. The bug is fixed and the
folder is empty, but the lesson is about which direction a silent no-op fails in — a delete that
quietly does nothing looks identical to a delete that worked, and only a census of the project ever
finds out.

### The index dropped every change made before anyone asked for it

Having deleted ten stray Blueprints and watched `list_blueprints` report zero, `get_project_overview`
still listed them:

```
index: 352   editor: 339
folders: __MCPRuntimeTrial  10
```

Ten assets that did not exist, in the reply that describes the project, feeding every index-backed
tool there is — `trace_variable`, `map_system`, `project_health`, `find_node`.

The index subscribes to the asset registry properly, and the handlers are right:

```cpp
void FMCPProjectIndex::OnAssetRemoved(const FAssetData& AssetData)
{
    if (!bBuilt) { return; }
    if (Entries.Remove(AssetData.GetObjectPathString()) > 0) { SaveToDisk(); }
}
```

The keys match on both sides. The bug is the first line, and it is `EnsureBuilt` being **lazy** that
makes it one: nothing builds the index until a tool needs it, so `bBuilt` is false for the whole
opening stretch of a session, and every add, removal and rename in that window returns immediately.
Then the first tool that wants the index calls `EnsureBuilt`, which loads a snapshot from disk that
predates all of it.

So the rule was: *changes are tracked, unless they happen before anyone looks* — which is exactly
when a model does its setup work.

A dropped change now marks the cache stale, and `EnsureBuilt` rebuilds instead of loading:

```cpp
if (!bBuilt) { bCacheStale = true; return; }
...
if (!bCacheStale && LoadFromDisk()) { bBuilt = true; return; }
```

It costs one rebuild, once, and only in a session where something changed before the index was first
needed. Doing it the other way — replaying a queue of deltas — sounded cheaper until the callbacks
also fire in their thousands during the registry's initial scan.

Tested by reproducing the exact window on a fresh editor: create an asset and delete it before any
index read, then ask.

```
deleted: {"requested":1,"deleted":1,"forced":true}
phantom StaleProbe in index?  no
old RuntimeTrial phantoms?    no
index: 339   editor: 339   drift note: NONE
```

The ten phantoms went with it, and the log line explaining why fired exactly once.

**Two bugs, one symptom, and they hid each other.** The delete reported success and did nothing; the
index then reported the asset as present, which is what a working index would do for an asset that
was genuinely still there. Each defect made the other look like correct behaviour, and the only thing
that separated them was counting the actual assets in the actual project.

### Three project-wide searches were blind to a third of the project

A throwaway check of whether the index tracks content edits — add a variable, then trace it —
answered yes, and printed a number beside it that did not belong:

```
trace_variable: { "blueprintsScanned": 182, ... "verdict": "Declared and never used at all" }
```

182, in a project with **339** Blueprints. A whole-project search that looked at half the project and
then delivered a verdict about the other half.

The cause is one missing line, and the diff against the code that gets it right makes it obvious:

```cpp
// MCPProjectIndex.cpp, and list_blueprints - correct
Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
Filter.bRecursiveClasses = true;

// trace_variable, trace_function_calls, find_broken_names - not
Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
Filter.bRecursivePaths = true;
```

A Widget Blueprint is a `UWidgetBlueprint` and an Animation Blueprint is a `UAnimBlueprint`, both
**subclasses** of `UBlueprint`. Without `bRecursiveClasses` the filter matches only assets whose class
is exactly `UBlueprint`, so every widget and every anim graph is absent from the search. This project
keeps 88 Blueprints under `/UI` alone.

So the three tools a model reaches for to answer *"where is this used"*, *"who calls this"* and
*"what is broken"* had never once looked at the user interface. And none of them said so — the reply
carried a scanned count and a confident verdict, and the count was the only clue.

Fixed, on the same project:

| | before | after |
|---|---|---|
| `trace_variable` scanned | 182 | **340** |
| `trace_function_calls` scanned | 182 | **340** |

The count is the cheap proof. This is the one that matters — a variable declared in a Widget
Blueprint, asked for by name:

```
declaredIn: BP_DamagingArea, BP_HealingArea, WB_SpectatorHUD
```

`WB_SpectatorHUD` is a `UserWidget`. Before the fix it was not merely missing from that list; it was
never a candidate, and the answer looked complete.

**Worth noting how it was found.** Not by an audit of the filters, and not by anyone reporting a wrong
answer — a variable reported as unused looks exactly like a variable that is unused. It came out of a
number printed next to an answer nobody was checking, in a probe written to test something else
entirely. `blueprintsScanned` exists so a caller can tell breadth from emptiness, and it earned its
place here by contradicting the tool beside it.

### Sweeping the defect, then sweeping what made it findable

The blind-search bug was one missing `bRecursiveClasses`, so the first job was checking whether any
other filter had it. Every `ClassPaths.Add` in the plugin, with the four lines after it:

```
MCPCommandHandler.cpp:1565   list_blueprints          bRecursiveClasses = true
MCPCommandHandler.cpp:5084   list_assets              bRecursiveClasses = true
MCPCommandHandler.cpp:6920   trace_function_calls     (fixed)
MCPCommandHandler.cpp:7287   find_broken_names        (fixed)
MCPCommandHandler.cpp:7520   trace_variable           (fixed)
MCPProjectIndex.cpp:377      RebuildFull              bRecursiveClasses = true
MCPProjectIndex.cpp:723      (index query)            bRecursiveClasses = true
```

Clean — the three fixed ones were all of them.

The more useful sweep is the second one. That bug survived because a wrong answer and a right answer
looked identical: a variable reported as unused reads exactly like a variable that is unused. The
only thing that separated them was `blueprintsScanned: 182` printed beside the verdict. So: which
other tools return a confident negative without saying what they looked at?

Asked of every search tool with a query nothing can match:

| tool | reports breadth |
|---|---|
| `find_node` | `catalogSize: 15234` |
| `find_in_data_tables` | `tablesSearched: 20`, `rowsSearched: 128`, and names tables it could not read |
| `trace_variable`, `trace_function_calls` | `blueprintsScanned: 339` |
| `search_project` | **nothing** |

`find_in_data_tables` is the model to copy — it reports what it searched *and* what defeated it, so a
zero is never ambiguous. Its `tablesSearched: 20` looked like a cap until the project turned out to
have exactly 20 Data Tables; complete coverage, honestly stated.

`search_project` is the primary discovery tool and returned `hitCount: 0` with no breadth at all.
`hitCount` is the RESULT count — on its own it cannot distinguish "the project has no such thing"
from "this tool could not see it", and those need opposite responses from a caller. It now says:

```json
{"query":"ZzNoSuchThing_98765","hits":[],"hitCount":0,"blueprintsSearched":339,"truncated":false}
```

Eight tokens on every search, buying the one signal that made a whole class of blindness visible. The
previous bug went unnoticed for an unknown length of time; the figure that ended it cost about the
same as this.

### The audit reported 468 findings and had not opened half the project

Using the widened `find_broken_names` on the real project turned up five findings, all of them in
`/Game/ThirdParty/SuperGrid/TutorialLevel/` — vendored sample content. Worth saying plainly, since the
previous section fixed that tool: **widening it found nothing new here.** The UI happens to be clean
of that particular check. A fix can be correct and important and still not pay out on the project you
happen to be holding.

What it did turn up was in the reply beside it. `audit_project`:

```
blueprintsScanned: 150
findingCount: 468
truncated: true
```

The project has **339** Blueprints. The audit stops at 150 by default, takes `all.slice(0, limit)` —
the first 150 in registry order, not the most important ones — and never says what it skipped.

`truncated: true` is technically honest and practically useless here, because the same reply
truncates something else and explains *that* at length:

> `detailNote`: 17 further finding kind(s) are listed with counts only and marked detailElided...

A reader has every reason to attach the flag to the truncation the note describes. Two truncations,
one flag, and the expensive one was the silent one.

So the reply now carries a denominator and says which is which:

```
Scanned 150 of 339 Blueprints - the first 150 the project lists, not the most important ones.
The other 189 were not opened, so any finding in them is absent rather than absent-because-clean.
Raise `limit` (up to 2000) to cover them, or pass `pathPrefix` to audit one area properly. This is
a different truncation from the one `detailNote` describes.
```

**And then the number that made the cap indefensible.** Running the same audit with the limit raised:

| | scanned | findings | Blueprints with findings | reply |
|---|---|---|---|---|
| `limit: 150` (old default) | 150 | 468 | 112 | ~2,681 tokens |
| full coverage | 339 | **859** | **259** | ~2,765 tokens |

The default was hiding **46% of the project's findings** — and saving **84 tokens**. It reads as a
token cap and is not one: this reply is grouped, and `detailedGroups` governs how much is *said* per
finding, so its size barely moves with how many there are. The cap was protecting a budget that was
never under threat.

What it does cost is time — 12s at 150, 25s at 339 — so the new default is **500** rather than the
2000 maximum. `audit_project` is a composite issuing many bridge calls, and the binding constraint is
the MCP client's own timeout, which this server does not control. A partial audit that returns beats a
complete one that gets killed. On this project that is full coverage in 24 seconds; above 500 the scan
still truncates, and now says so with a denominator.

Three sections in a row on the same shape: a count with no denominator. `blueprintsScanned: 182` in a
project of 339, `hitCount: 0` with no breadth, and now `blueprintsScanned: 150` of 339. Each one read
as an answer and was a fraction of one.

### The most expensive check could not tell a Server RPC from a name

With the audit finally covering the whole project, the obvious next question is whether its findings
are *right*. Start where it costs most: `cast-to-server-only-class`, 100 points each, twelve of them.

The finding is sound in principle — a GameMode is null on clients, so a cast to one fails there and
every node after it never runs. It is only a defect if the cast is **reached** on a client, and the
first one checked is not. `BP_Player`:

```
KillPlayer -> Do Once -> KillPlayerMC -> ... -> KillPlayerClient -> Cast To GM_Gameplay -> SpawnSpectator
KillPlayerMC -> Set isAlive -> Set isDead -> Set Simulate Physics -> Set Collision Enabled
```

Two chains. The one carrying the cast starts at `KillPlayer`, whose full node detail reads
**"RELIABLE Replicated From Client, Executes On Server"** — a Server RPC, running only where the
GameMode exists. The multicast beside it, `KillPlayerMC`, *"Executes On All"*, carries no cast at all.
Correct code, scored as the worst defect in the audit.

The check already tried to catch this. It looks for two server guards — downstream of a
`Switch Has Authority`, and downstream of *"a custom event named as a server RPC"* — and the second
one is the problem, because it keys on the **name**:

```ts
const SERVER_EVENT = /(^|_)(server|sv)[_\s]/i;
```

`KillPlayer`, `SpawnPlayer` and `AddPlayerToList` are all Server RPCs. None of them says so in its
name. A heuristic that only catches authors who wrote "Server" in the title is a heuristic that
misses the ones who did not.

The engine knows without being asked. `UK2Node_CustomEvent::FunctionFlags` carries `FUNC_NetServer`,
`FUNC_NetMulticast` and `FUNC_NetClient`, so the graph summary now emits `runsOn` for replicated
events — and only for those, so an ordinary custom event costs nothing. The check prefers it and
keeps the name heuristic underneath, because a plugin binary older than the field sends no field and
falling back to a name beats falling back to nothing.

**And the correction, which is the part worth reading.** From counting cast *sites* — four of thirteen
on server-only chains — I expected roughly 31% of this check to be noise. Measured, it removed **one
finding of twelve**:

| | before | after |
|---|---|---|
| `cast-to-server-only-class` | 12 | **11** |
| project findings | 859 | **858** |
| `BP_Player` cost | 1060 | **960** |

The audit reports one finding per Blueprint, not per cast node. `PC_Gameplay` has five cast sites,
three of them server-rooted, and it stays on the list — correctly, because the other two are not.
`BP_Player` was the only Blueprint whose casts were *all* on server-only chains, and it is the only
one that left.

So: 8%, not 31%, and the difference is entirely that I counted the wrong unit before measuring. The
fix is still right — `BP_Player` is the project's most-used Blueprint and was carrying a 100-point
finding for correct code, which inflated its rank in `worstBlueprints` as well as its score. But the
number I would have reported without re-measuring would have been four times the truth.

### The same defect, counted twice, in the class that costs most

`runsOn` was added for the cast check, but three name-guesses were using the same missing data:

```ts
const SERVER_EVENT = /(^|_)(server|sv)[_\s]/i;
```

Those three lists decide whether a Blueprint is networked **at all** — a "no" skips every multiplayer
check under it — and which events to walk forward from. `BP_Player` alone has `FireWeapon`,
`HealthRegen`, `EnergyRegen` and `TraceInteract`, every one reported by the engine as *Executes On
Server* and not one of them saying so in its name. All were invisible to the walk, so anything they
wrote unreplicated was never looked for.

Unlike the cast fix, which removed a false positive, this direction **adds** findings: 858 → 904.

Then the verification, which is where it got interesting. Four examples of
`server-writes-unreplicated` in `BP_Player`, each naming a variable — `CanRegenHealth`,
`CanRegenEnergy`, `VaccumTimer`, `TeamHealSpeed`. All four confirmed `replicated: false`, so the
findings are real. But the examples list showed each of them **twice**, and running the check
directly on the Blueprint returns four, not eight.

**Two loops over one source.** `audit.ts` walked `review.blueprint` in two places a few hundred lines
apart, filing under `graph: "variables"` and `graph: "(whole asset)"`. Every Blueprint-level
finding — the most expensive class in the set — was counted twice, in the group totals, the
per-Blueprint costs, and the `worstBlueprints` ranking built on them.

**And a second duplication underneath it.** `repnotify-does-nothing` has two producers that are not
redundant: `findEmptyRepNotifies` asks whether the handler's entry node goes anywhere,
`reviewRepNotifies` asks how many nodes it has *and* tiers the answer — "and nothing in this
Blueprint reads or writes the variable at all" is the difference between a missing handler and dead
state. Deleting either loses coverage, so both run and the richer message wins, deduped on
`blueprint | check | variable`.

Making that work took four edits, because `variable` existed on both producers and reached nothing:

| dropped at | why |
|---|---|
| `SyncFinding` | the interface had no such field |
| `review.ts` → `blueprint:` | a rebuild that lists the fields it wants |
| `review.ts` → `extraFindings` | the same rebuild, again |
| `audit.ts` push sites | seven of them, each naming its fields |

Four rebuilds between the check that knows and the code that needs to know, each one silently
dropping what it was not told to keep. The debug line that found it printed one key and one
`undefined`.

Where it landed on the real project:

| | findings | note |
|---|---|---|
| before this iteration | 858 | |
| after `runsOn` | 904 | +46 genuinely found |
| after removing the duplicate loop | 844 | −60 duplicates |
| after deduping the two producers | **818** | −26 duplicates |

The totals barely moved and the ranking did. `PC_Gameplay` fell from cost 1935 to 1335 and
`BP_Player` rose to first — which is the point, because the whole purpose of `worstBlueprints` is to
answer "where should I start", and it had been answering with a number that counted some Blueprints
twice.

### Two defects wearing one shape, with opposite remedies

Several iterations went into making the audit's findings *accurate*. The next question is whether
they are *actionable*, and the way to find out is to take the top-ranked one and try to act on it.

`BP_Player` leads `worstBlueprints`, and four of its findings say a server event writes a variable
that is not replicated. All four variables confirmed `replicated: false`, so the findings are true.
Asking the newly-widened `trace_variable` who reads them:

```
CanRegenHealth   scanned 339 | reads: none
CanRegenEnergy   scanned 339 | reads: BP_Player:RegenerateEnergy
VaccumTimer      scanned 339 | reads: BP_Player:EventGraph
TeamHealSpeed    scanned 339 | reads: BP_Player:EventGraph
```

`CanRegenHealth` is written twice by server events and **read nowhere** — not in that Blueprint, not
in the other 338. The finding said *"no client will ever see it"* and advised
`set_variable_replication`. Both are true and the advice is wrong: replicating a variable nothing
reads pays network for a value nobody looks at. It is not a replication bug, it is a dead variable,
and the two need opposite actions.

`repnotify-does-nothing` already tiers exactly this way — "and nothing in this Blueprint reads or
writes the variable at all" is the difference between a missing handler and dead state. The same
distinction now applies here:

```
"HealthRegen" runs on the server and sets "CanRegenHealth", which is not replicated - and nothing
in this Blueprint reads it either.
  fix: Check first whether anything reads it at all: unreal_trace_variable on "CanRegenHealth"
       covers the whole project, and this check can only see one Blueprint. If nothing reads it,
       the variable is dead - remove it, or wire up the read that was meant to exist.
```

Deliberately hedged to "in this Blueprint", because those nodes are all the check can see and a
widget in another asset reading the variable would be invisible to it. Naming the open question and
the call that settles it beats guessing at the answer. On the real project the tiering agrees with
`trace_variable` exactly — the one it calls dead is the one with zero reads across 339 Blueprints.

Roughly **four in ten** of this finding class turn out to be the dead-state kind, which is four in
ten pointed at the wrong remedy. The count does not move; what moves is what a model does next.

**One test had to change, and it is worth saying why.** The existing case built a server event
setting `bVacuumOn` with nothing reading it, then asserted the replication wording — so the new tier
fired and it failed. The fix was to add the read, not to relax the assertion: the test describes the
replication case and its fixture did not contain one. A test that only passed because a distinction
did not exist yet is not evidence the distinction is wrong.

### Following the audit's own advice, and finding what it could not see

The audit nominates a next action. Taking it literally is the fairest test of whether it is any good:

> Start with 2 empty Data Table reference(s), beginning with `DT_Upgrades` row `"Weapon_MachineGun"`
> (UpgradeClass). The engine resolves an empty reference to null and whatever consumes it silently
> does nothing.

True, and reading the column turns up more than it claimed. Nine rows, seven filled:

```
Weapon_MachineGun        ""
Vacuum_VirusController   ""
Survival_MobileAgent     BP_BulletSize_C      <-
Stat_BulletSize          BP_BulletSize_C      <-
Stat_BulletDamage        BP_DamageUpgrade_C
Stat_VacuumSpeed         BP_VacuumSpeedUpgrade_C
Stat_VacuumPush          BP_VacuumPushUpgrade_C
Stat_HealSpeed           BP_HealSpeedUpgrade_C
Stat_HealthNum           BP_HealthUpgrade_C
```

Two separate things here, and the audit could see neither properly.

**The empty rows are not a wiring mistake.** No `BP_MachineGun` or `BP_VirusController` upgrade
Blueprint exists anywhere in the project. The class those rows want was never built, so
`unreal_set_data_table_row` has nothing to point them at. That is an unfinished feature, and the fix
the audit suggests cannot be carried out — worth knowing before trying.

**And `Survival_MobileAgent` runs the bullet-size upgrade.** Every row has its own class except that
one, which shares `Stat_BulletSize`'s. Nothing is null, nothing is broken, the asset resolves: one row
simply does another's job while claiming to be a survival upgrade. Every existing check walked past it,
because they all ask whether a value is *missing*.

So there is a new one. In a column where nearly every row has its own asset, a shared one is worth
mentioning:

```
dataTableDuplicateClasses: [{
  table: "DT_Upgrades", field: "UpgradeClass",
  value: "BP_BulletSize.BP_BulletSize_C",
  rows: ["Survival_MobileAgent", "Stat_BulletSize"]
}]
```

**Its first run is why it is narrow.** It reported two duplicates: that one, and two health upgrades
in an old table sharing a heart icon — which is exactly what icons are for. A shared **class** means
two rows *behave* identically while claiming to differ; a shared texture means they look alike, which
is ordinary design. Restricted to class references, the noise went and the bug stayed.

Two guards keep it quiet elsewhere: at least four filled rows, and at least 70% of them carrying a
value nothing else uses. A column of twelve rows pointing at three classes is a tier system, not
twelve mistakes, and there is a test for that case as well as for the real one.

### "The machine gun upgrade does nothing" — walking the sentence to the cause

The previous section established something rare: a bug in the project whose root cause is *known*.
`DT_Upgrades` row `Weapon_MachineGun` has an empty `UpgradeClass`, so that upgrade instantiates
nothing. That makes it a fair test of the thing this server is for — a symptom in plain English, and
whether the tools lead anywhere from it.

Three calls, as a model would make them:

```
search_project      "machine gun"   ->  hitCount 0, blueprintsSearched 339
map_system          "machine gun"   ->  assetCount 0, with a good note about naming
find_in_data_tables "MachineGun"    ->  DT_Upgrades, row Weapon_MachineGun     <- found
```

The route exists and nothing points down it. Worse, `search_project` returns nothing for **every**
spelling — "MachineGun", "machinegun", "Machine Gun" — because the answer is not in a Blueprint at
all, and that tool searches the Blueprint index: names, parent classes, functions, custom events,
variables. It is called `search_project`, so a bare `hitCount: 0` reads as "the project does not
contain this".

`blueprintsSearched: 339` beside it is honest and, on its own, is a hint a reader has to interpret.
Now it says the rest out loud, and only on a zero:

```
Searched Blueprint names, parents, functions, custom events and variables - not Data Table rows,
non-Blueprint asset names, C++ or placed actors. If the thing you are looking for lives in one of
those: unreal_find_in_data_tables for row and cell contents, unreal_list_assets with `match` for
assets by name, unreal_find_source for C++, unreal_list_actors for a level. Names in this project
are usually run together, so try "MachineGun" as well as "machine gun".
```

**And the advice is followable on the profile where it matters.** That note names four tools, none of
which is listed on `search`. Wrapping the reply in `withDisabledToolNote` means it also says:

```
Not listed this session: unreal_find_in_data_tables, unreal_find_source, unreal_list_actors,
unreal_list_assets. Reach them with unreal_call_tool; no need to enable.
```

Which is the fix from two sections earlier, doing its job on advice that did not exist when it was
written. That is the argument for putting a mechanism in one place rather than writing the sentence
by hand each time.

Nothing was added to the search itself. The scope was always this; the zero simply never said so,
and a dead end and an answer look identical until one of them tells you where else to look.

### Animation could be read and never touched

Counting the gap rather than guessing at it. Animation tools here: three, and all three read.
Animation assets in the project being worked on:

| tool | asset | count |
|---|---|---|
| `read_anim_blueprint` | AnimBlueprint | 6 |
| `read_level_sequence` | AnimMontage | **27** |
| `read_timeline` | AnimSequence | 200 |
| | BlendSpace | 21 |
| | LevelSequence | 9 |

So a model could *see* that a montage has no notify to drive a footstep, a hit window or a sound,
and had no way to put one there. `unreal_read_asset_properties` already reports notifies as
`{name, at, kind}` — a read with no write half.

`unreal_add_montage_notify` and `unreal_remove_montage_notify` are that half, and they speak the
read's vocabulary rather than inventing one: the same `name` and `at`, and the reply lists the
notifies afterwards in the same shape, so a caller sees the result instead of assuming it.

**Instant notifies only, and said out loud.** A notify STATE has a duration and needs a
`UAnimNotifyState` class to give it behaviour; there is no honest way to choose one on a caller's
behalf, so `lastsFor` is refused rather than quietly producing an instant notify. A duration that
vanishes is worse than a call that did not run.

**What it refuses is the interesting part**, verified against a real montage:

```
add "MCPTestFootstep" at 0.5   ->  notifies: [MCPTestFootstep@0.5, PlayMontageNotify@1.499]
add at 99                      ->  time_out_of_range: 99.000 is outside this montage,
                                   which is 2.360 seconds long
add the same one again         ->  notify_already_there: ... adding it twice fires the event
                                   twice, which is a bug that looks like a doubled sound
remove "NoSuchNotify"          ->  removed: 0, and says so rather than reporting success
remove "MCPTestFootstep"       ->  removed: 1
```

A notify past the end never fires and the montage never complains, so refusing is the only place that
can be caught. A duplicate at the same time is worse than useless — it is a doubled sound that reads
as an audio bug. And `removed: 0` is not success, which is the rule the `delete_asset` fix
established three sections ago.

`LinkMontage` rather than a bare time, because a montage notify belongs to a segment and linking is
what keeps it in place when the segment moves; and `TriggerTimeOffset` from
`CalculateOffsetForNotify`, which is what makes a notify sitting exactly on a frame boundary fire on
the side the author meant. Both were read out of the engine headers rather than recalled.

**Three guards caught things this change got wrong**, which is the argument for having them:

| guard | what it caught |
|---|---|
| `check:docs` | two registered tools appearing nowhere in this README |
| `check:undo` | both writes opened no transaction, so a human could not Ctrl+Z them |
| `doctor.test` | two new bridge commands neither probed nor recorded as deliberately unprobed |

The last one is the sharpest: a probe sends no parameters, and probing `add_montage_notify` to find
out whether it exists would have put a notify on somebody's montage. Recorded as not-probed, with
that reason.

The test montage was left exactly as found — one `PlayMontageNotify` at 1.499 — and nothing was
written to disk.

### Pairing every read with the write that edits the same thing

The montage fix closed one asymmetry by hand. The question it raised is how many others there are, so
each read tool was paired against the writes that edit its subject:

```
list_variables            add / remove / rename / set_type / set_replication
list_components           add / remove / rename / set_property
list_data_table_rows      add / set / remove
list_struct_fields        create_struct, add_struct_field            <- no remove, no rename
list_enum_entries         create_enum, add_enum_entry                <- no remove, no rename
read_anim_blueprint       *** NONE ***
read_behavior_tree        *** NONE ***
read_level_sequence       *** NONE ***
read_niagara_system       *** NONE ***
read_timeline             *** NONE ***
```

The first pass at this reported **zero** gaps, because it matched read and write subjects by substring
and "struct" matches "struct_field" matches everything. A sloppy matcher answering "nothing to do" is
the same failure as a search that only looked at half a project - which is why it was rewritten to a
hand-declared pairing that can be read and disagreed with.

Ranked by what the project actually holds: 17 User Defined Structs, 9 User Defined Enums, 15 Niagara
systems, 9 Level Sequences, 6 Anim Blueprints, 2 Behavior Trees. The struct and enum gap wins twice
over - the largest counts, and **11 of the project's 20 Data Tables are typed by a User Defined
struct**, so "rename that column" and "drop that field" are ordinary change requests with no answer.

Four commands close it: `remove_struct_field`, `rename_struct_field`, `remove_enum_entry`,
`rename_enum_entry`.

**Removing a struct field is destructive in a way nothing announces.** The field takes its column and
every value in it out of every table built on the struct, and the tables do not warn. So the removal
refuses while any table is typed by the struct, and says what is at stake:

```
struct_in_use: 1 Data Table(s) are typed by this struct, holding 2 row(s). Removing "Ratio" takes
that column and every value in it out of all of them.
  tablesUsingThisStruct: [{ table: "DT_Enemies", rows: 2 }]
  next: Pass force:true to remove it anyway. Read what the column holds first - list_data_table_rows
        with `fields` on the tables above shows exactly what is about to go.
```

Rename is beside it deliberately, because it is usually what the caller actually wanted: the column
keeps its values and every table follows. A destructive tool should not be the only one on the shelf.

Enum entries match on the **display name** - what `list_enum_entries` reports and what a person sees -
not the internal `NewEnumerator0` spelling, which is the same asymmetry that once cost an afternoon on
a Data Table cell. And removal says the thing that is easy to miss: anything storing the enum by value
keeps its number, so a cell holding the removed entry afterwards reads as whichever entry took its
index.

**The guards caught two things, and one of them was mine.** `check:docs` wanted the four tools in this
file, and `doctor.test` wanted a recorded decision about probing them - a probe sends no parameters,
so probing `remove_struct_field` to learn whether it exists is not a question, it is a deletion.

The second was worse and was caught by using the tool rather than by a guard. Restoring a field after
a live test, `unreal_add_struct_field` refused: it takes `name`, and all four new commands had been
written with `fieldName` and `entryName`. Four tools disagreeing with the one they pair with, in a
repository with a section about exactly that. Renamed before commit; `check:params` passes.

Verified against real assets and every one put back as found: the guard refused on `S_EnemyType`
(`DT_Enemies`, 2 rows) and changed nothing; a rename round-tripped on a struct nothing is typed by; a
name clash was refused; the enum round-tripped `Xbox` -> `XboxPad` -> `Xbox`. Nothing was written to
disk.

### Does supporting more cost more? Measured, and mostly no

Two goals sit beside each other in this project and look like they pull apart: support everything a
person can do in this engine, and cost a model as little as possible. Six tools were added over two
sections. So what did they cost?

Reading the profile figures back across the last eight commits:

| | then | now |
|---|---|---|
| `full` standing | 42,624 | **44,243** |
| `search` standing | **2,471** | **2,471** |

`search` has not moved by a single token, through six new tools. That is not luck - it advertises
five, and everything else is registered and switched off, so the catalogue can grow without the
standing cost following. Breadth is free on the profile `--print-config` writes, and expensive only
on the one that lists everything.

So the two goals do not pull apart, provided a model uses the dispatcher. That is worth stating
plainly, because "add fewer tools to save tokens" is the obvious inference and it is wrong.

**Where breadth is not free is discovery.** The standing cost is flat; the call that finds a tool is
not, because it returns a row per match. `check:responses` had it two tokens under its ceiling:

```
list_tools match     498    500  ok
```

That is a guard about to fire for a reason that has nothing to do with a mistake - the catalogue grew.
And the rows were repeating themselves: ask for "data table" and every one of the seven says
`"on":false`, because on `search` they all are. 189 characters of 1,991 spent restating what the whole
result agrees on.

Hoisted, the same way `unreal_list_actors` hoists a shared class:

```
match "data table"   498 -> 481    (group is mixed, so only `on` lifts)
match "montage"      ...  -> 159    (both lift)
match "enum"         ...  -> 239    (both lift)
```

Only when it is genuinely uniform. The "data table" search spans two groups, so every row keeps its
own `group` and only `on` moves up - a mixed answer still says which is which, which is the whole
reason to check rather than assume.

The saving is small in absolute terms and it is the right shape: it grows with the number of matches,
so it gets larger exactly as the catalogue does. The ceiling stays at 500, now with room under it
again.

### A parameter named without its value

Niagara was next on the read/write census - 15 systems, read-only. Looking at what the read returns
before writing anything:

```json
"userParameters": [
  {"parameter": "Bool_Spawn Probability", "type": "NiagaraBool"},
  {"parameter": "OverlayMaterial",        "type": "MaterialInterface"},
  {"parameter": "OverlaySpawnProbability","type": "NiagaraFloat"}
]
```

Names and types, and not one value. That tells a reader `OverlaySpawnProbability` exists and nothing
about whether it is wrong - the same shape of answer as a graph chain printed without its branch
conditions. So the read got fixed before the write got written:

```json
{"parameter": "Bool_Spawn Probability", "type": "NiagaraBool", "value": true},
{"parameter": "OverlayMaterial", "type": "MaterialInterface",
 "value": "/Game/AntiVirusSquad/VFX/Materials/MI_FirewallOverlay.MI_FirewallOverlay"},
{"parameter": "OverlaySpawnProbability", "type": "NiagaraFloat", "value": 1}
```

**A Niagara bool is not a C++ bool.** `FNiagaraBool` stores -1 for true and 0 for false, so reading
one as a `bool` gives nonsense on exactly the case anybody checks. Read through `FNiagaraBool` and
`GetValue()`. Types that cannot render honestly - structs, data interfaces - get no `value` field at
all rather than a guess, and the `type` beside them says why.

`unreal_set_niagara_user_parameter` is the write. It sets the system's **default** - what every
component placed from it starts with - which is a different thing from the Set Niagara Variable
Blueprint nodes, that change one component at runtime. The reply says which it did, because
confusing the two produces a change that works in the editor and not in the game.

Float, int and bool only, refused by name and type otherwise:

```
"OverlayMaterial" is a MaterialInterface. This sets float, int and bool user parameters; a struct,
an object or a data interface each need a different kind of argument, and guessing one would write
something you did not mean into an asset that will not complain.
```

**And a small honesty fix found by using it.** Setting the float to 0.42 read back as
`0.41999998688697815` - seventeen digits of a float32 that holds about seven. Those extra digits are
not precision, they are a widening artefact a reader has to know to ignore, and the montage read next
door already rounds for the same reason. It reads back as `0.42`.

Verified end to end and put back: read the value, set it, read it back, set it to what it was. The
change was never saved, and an editor restart mid-test confirmed that - the parameter was 1 again on
its own.

`search` stands at **2,471 tokens**, unchanged, for the seventh tool in a row.

### "Tell me everything about BP_Player"

A real request, in the words it arrived in: *"take BP_Player and make me a full document of every
feature that's connected to BP_Player."*

Every part of that answer was already reachable and nothing returned it. By hand it is six calls,
and the six calls are not the problem - the problem is having to remember all six. This project's
own history is the evidence that does not happen: `search_project` was called for a variable,
answered with its declaration, and `unreal_trace_variable`, which had the whole answer in 89 tokens,
went unused for ten more calls because nothing named it.

`unreal_document_asset` decides once what "connected to" means and always returns that. Four kinds,
ordered by how much each constrains a change:

| | |
|---|---|
| **inherits** | the ancestry, and the interfaces it promises to implement |
| **owns** | its components and variables, and which of those cross the network |
| **does** | its graphs, each entry point with where it RUNS |
| **reaches** | what it references, and what references it |

The last is the one people mean by "connected", and the one hand-assembly usually misses. On the
real BP_Player - 819 nodes, 86 variables, 18 components:

```
BP_Player (a BP_BaseCharacter_C)
  inherits: BP_Player_C <- BP_BaseCharacter_C <- Character <- Pawn <- Actor <- Object
  components (18): SpringArm [SpringArmComponent], Camera [CameraComponent], ...
  variables: 86, of which 15 cross the network
  replicated: MaxHealth (real), DataHeld (real), VacuumChargePercent (real), ...
  EventGraph - 819 nodes:
    StartVaccum [server] -> Branch (Get isAlive) -> Can Aim -> ...
    KillPlayerMC [multicast] -> Set isAlive -> Set isDead -> ...
  used by (40): PC_Gameplay, GM_Gameplay, BP_FireWall, C_Vacuumable, BP_BaseEnemy, ...
    - a change here is felt by every one of those.
  note: referencedBy truncated to 40 of 48; raise maxReferences to see the rest.
```

The `[server]` and `[multicast]` tags are the same `runsOn` the graph readers were taught to carry
two commits earlier. That is the argument for fixing a field rather than a caller: it was added for
one diagnosis and it turns up here, in a tool written afterwards, with nobody connecting them.

**What it actually saves, measured rather than claimed:**

| | calls | tokens |
|---|---:|---:|
| by hand (describe_class, list_components, list_variables, list_blueprint_graphs, explain_graph, find_references) | 6 | 8,131 |
| `unreal_document_asset`, as first written | 1 | 7,649 |
| `unreal_document_asset`, after the duplication was found | 1 | **3,883** |

Six percent, on the first version. The tokens in the reply are the answer, and an answer does not get cheaper by being
asked for differently - so anyone claiming a large saving here would be claiming to have deleted
some of it. The saving that matters is the other column: six sequential calls are six turns, and
every turn re-reads the whole conversation, so the round trips cost far more than the reply does.
What is worth more again is that the six are always all six.

**And then the reply was measured against itself.** 31,192 characters, of which `text` was 13,735
and the arrays that `text` is *rendered from* were another 16,000. Seventy-eight percent of the
largest reply this server sends was one set of facts said twice - the exact defect this project
keeps deleting from other replies, in a tool written the same morning. The prose is the product; the
structure it came from is not sent as well. Anything wanted as data has its own tool one call away,
which answers it properly rather than as a by-product.

One thing had to move first: the names of variables that do NOT replicate existed only in the
structured array. Dropping it without adding them to the text would have been a quiet loss of 71
names, not a compaction. They are a single `local (71): ...` line now.

Three sizes, because the graphs are the expensive half: `graphDetail: "none"` is 1,100 tokens,
`"entries"` (the default, event graphs only) 3,883, `"all"` 5,470 - each roughly half what it was. And every truncation says so -
a list that quietly stops short reads as "this is all of them", which is the one thing a document
must never get wrong.

### Reading a literal off sixteen nodes

"Which gameplay tag does each of these `SetGameplayTagMC` nodes set?" is an ordinary question and it
used to cost fourteen calls: one `read_blueprint_summary` with `match`, then a `read_node_detail` per
node to recover a single pin value from 230 tokens of full pin detail.

| | tokens | calls |
|---|---:|---:|
| summary alone (shape only, no values) | 1,258 | 1 |
| summary + 13 `read_node_detail` | 4,248 | 14 |
| summary with `withPinValues` | **1,534** | **1** |

Sixty-three percent fewer tokens, and thirteen fewer round trips - which is the larger saving, since
every round trip re-reads the whole conversation.

The values cost 276 tokens for all sixteen nodes, because only unwired inputs with something in them
are emitted: a wired pin's default is meaningless and is already omitted everywhere else for that
reason, an exec pin has no value, and an empty one is not worth the characters.

**Off by default, and that matters more than the saving.** `explain_graph`, `review_blueprint` and
the whole audit read graph summaries constantly and none of them want pin literals. Switching this
on for everyone would have grown the most-read reply on the surface to answer a question most callers
are not asking. Measured with the flag off, the reply is byte-identical to what it was.

### Guessing a path, and being told the real one

Guessing an asset path is the most common way a call fails, and it is the only failure the server
can just look the answer up for. Both of these were guessed while doing ordinary work on this
project, minutes apart - the name was right each time and only the folders were invented:

```
/Game/Blueprints/Characters/BP_Player          -> blueprint_not_found
/Game/AntiVirusSquad/_Core/GameModes/GM_Gameplay -> blueprint_not_found
```

What that used to cost, per wrong guess:

| | tokens | round trips |
|---|---:|---:|
| the not-found error | 147 | 1 |
| the `list_blueprints` it tells you to run | 104 | 1 |
| the real call | 21 | 1 |
| **total** | **272** | **3** |

The error now ends with `Did you mean` and a real path, so the same work is two calls and the
second one succeeds - 185 tokens, and one wasted round trip instead of two. Round trips are the
larger saving: each one re-reads the whole conversation.

The lookup happens inside the server. `list_blueprints` unfiltered is ~2,669 tokens and none of them
reach the model; what reaches the model is one line naming one path. Nothing is spent on the happy
path - the hook runs only on a reply that is already an error and already names a missing path, so
successful replies are byte-identical to what they were.

**An exact name match ends it.** `BP_Player` is a substring of `ABP_Player`, `WBP_PlayerDeath` and
`WBP_PlayerInfo`; offering those beside the real answer would make a caller who is already confused
choose between four paths when one is correct. Substring hits are the fallback for when nothing
matched exactly, never a garnish on a hit, and a needle under three characters matches nothing at
all.

**When nothing matches, nothing is said.** A wrong "did you mean" lands on a caller who is already
lost and carries more conviction than the error it decorated. The bridge's own error text stays
intact underneath either way - it explains the path-repeats-the-name rule and the create-it-first
case, neither of which a name match can answer, and an error that gets shorter when it gets smarter
is a bad trade.

### The near-miss list was ranked by prefix, so the right answer came third

`didYouMean` is the most useful self-correction signal this system has - the plugin answers an
unresolvable name with the near misses it knows about. It ranked them by shared prefix, and measured
against a live editor that produced answers worse than none:

```text
SpawnActor  ->  Spawn                 (a ThirdParty tutorial conveyor Blueprint)
                Spawn                 (UMG.Viewport)
                SpawnActorFromClass   <- what the caller wanted, ranked third

ApplyRootMotionRadialForce  ->  Apply  (VariantManagerBlueprintLibrary)
```

`Apply` shares five characters out of twenty-six. Offering it to someone already lost is the
confident-falsehood failure this project keeps finding, wearing the costume of helpfulness - and it
costs a round trip AND the credibility of every other suggestion the system makes.

**Containment beats prefix.** A candidate that CONTAINS what was asked for is a better answer than
one that merely starts the same way: `SpawnActorFromClass` contains `SpawnActor`, `Spawn` does not.
Among containing candidates the shortest wins, being the least embellished version of the thing
asked for. Ties keep the engine's own order rather than one invented here.

| query | before | after | |
|---|---:|---:|---|
| `SpawnActor` | 142 | 95 | right answer now first, two junk entries dropped |
| `ApplyRootMotionRadialForce` | 46 | 19 | nothing plausible, so nothing offered |
| `PrintStrng` | 39 | 39 | a real typo still finds `PrintString` |

That last row is the one that mattered. Tightening a filter until the noise goes is easy; the check
that it has not also eaten the genuine near-misses is the whole test.

**An emptied list is removed, not left as `[]`.** An empty array still costs tokens and still
invites the reader to look for an answer that is not there. `unreal_find_node` does proper word
matching and is one call away.

Applied in the bridge client, which is the choke point every command's failure passes through, so
`get_node_signature`, `add_node` and `build_graph` are fixed by one call rather than three. Done
there rather than in the C++ that builds the list, for the reason recorded about the same choice for
type spellings: the resolver is the tidier place and only reaches somebody who has rebuilt their
plugin, while this layer reaches everyone now.

### What Epic's own MCP plugin has, and what it does not

Epic shipped a first-party `Unreal MCP` plugin in **UE 5.8** (June 2026), experimental, embedded in
the editor at `127.0.0.1:8000/mcp`. Checked because it is the obvious question: is there anything in
it this project should have?

**The architecture converged independently.** Epic's `tools/list` returns three meta-tools -
`list_toolsets`, `describe_toolset`, `call_tool` - and discovers the real tools through them. That
is the same answer as the `search` profile here: `unreal_list_tools`, `unreal_list_tools({ schema })`
and `unreal_call_tool`, for the same reason, which is that a full tool list is paid on every request
before the user's message is even read. Two independent designs arriving at the same shape is the
strongest evidence available that it is the right one - stronger than the measurements in this repo,
which only prove it works here.

Differences worth recording:

| | Epic's plugin | this project |
|---|---|---|
| transport | HTTP + SSE, no stdio | stdio MCP, TCP to the editor |
| auth | *"No authentication layer"* | per-session token file |
| surface | Scene, Actor, MaterialInstance, Object toolsets | 134 tools: Blueprints, C++, Data Tables, anim, Niagara, widgets, sequences, audits |
| authoring | spawn, configure, inspect | builds Blueprint graphs, writes C++, edits Data Tables |
| engine | 5.8+ | 5.3+ |

**It is not available to this project.** The editor here is UE 5.6; Epic's plugin needs 5.8. That is
two engine upgrades away for a project with 341 Blueprints, so the comparison is informative rather
than actionable.

One genuine gap it exposed, now closed: **running automation tests**.

### `unreal_run_tests`, without a plugin rebuild

Epic's plugin lists "running automation tests" among its tools and this project had no route to them
at all - not in the bridge, not in the server. Running the tests is something a person does from
Session Frontend every day, and "supports everything a normal human would have for this engine" has
to include the thing that says whether the engine still works.

The obvious implementation is a new bridge command, which means rebuilding the plugin and restarting
the editor before anyone can use it. It did not need one. `Automation` is a console command, the
bridge already runs console commands, and the editor writes every automation line to `Saved/Logs`
before anything else happens - the same property `runtimeLog.ts` is built on. So this is a console
command plus a parser: it works on a plugin nobody rebuilt, and it can read a run that has already
finished.

```text
unreal_run_tests { list: true, match: "Mass.EntityView" }
  ->  {"total":4957,"names":["System.Mass.EntityView.Invalidate"],"omitted":0}          18 tokens

unreal_run_tests { match: "System.Mass.EntityView" }
  ->  {"passed":1,"failed":0,"failures":[],"complete":true,"found":1,"performed":1}     19 tokens
```

Both measured against a live editor. The project has **4,957 tests**; listing them all is roughly
thirty thousand tokens to answer "is there a test for X". So passes are counted and never named, and
failures come back with the engine's own messages attached - the same rule the audit follows.

Three decisions worth keeping:

**`complete` is reported separately from `failed`.** A run that timed out and a run where everything
passed both show zero failures. Reporting the first as the second is the one way this tool could do
real harm, so an unfinished run says so in words rather than leaving it to be inferred from a zero.

**A verdict that is not `Success` is not a pass.** `Fail`, `Skipped`, or a result word a later engine
version introduces all count as not-passing. Treating an unrecognised verdict as success is the
failure mode that makes a test runner worse than no test runner.

**`match` is required to run.** `Automation RunAll` here means ~5,000 tests and many minutes with the
editor held. That is not something to start because a parameter was left out, so it refuses and points
at `list`.

### A description must not name a tool the profile does not have

The standing instructions had this bug once and it was found by hand: the shared text named 18
tools, `minimal` registers 11, and 13 were unreachable - including the first thing step 1 said to
call. That was fixed in `buildInstructions`, and nothing stopped it happening one level down, in the
tool descriptions, which are read in the same breath and cost the same tokens on every request.

It had already happened, in the worst possible place. `unreal_build_graph` is the recommended way to
author a graph on `core`, and its `nodes` field said *"Same per-type params as unreal_add_node"* -
a tool `core` deliberately withholds, because it is a worse path for a weak model. So the profile
built for the weakest models pointed them at a tool they cannot call, in the one field that decides
whether the call is well formed.

A scan found **24 of them** across `core` and `minimal`. The split that matters is not how many but
what kind:

| | example | verdict |
|---|---|---|
| **directing** | "Call this before `unreal_add_node`" | strands a caller — fixed |
| **describing** | "Prefer this over individual `unreal_add_node` calls" | tells them *not* to — allowed |

Twelve directing references were reworded to name the **action** rather than the tool that performs
it: "before you place a node", "with a CallFunction node", "build the graph in one call". That reads
better on every profile, not just the constrained ones — what a caller needs to know is what to do
next, not which entry point happens to do it. `unreal_create_function` was pointing at
`unreal_add_node` for graph authoring, which was wrong for *every* profile: `unreal_build_graph` is
the recommended path and now that is what it says.

Fourteen descriptive references are allowlisted in `check:profilerefs`, each with the reason a model
cannot be stranded by it, and the guard fails if an allowance stops matching real code — an
allowance for something that no longer happens teaches the next reader something false.

Cost: `core` 13,078 → 13,088 and `full` 46,483 → 46,493. Ten tokens for text that stops sending
constrained models to tools that are not there.

### Ranking the graph names, and a diagnosis that was wrong

A wrong graph name is answered by the bridge with an **alphabetical** slice of what exists. On a real
Blueprint that is twelve of fifty-eight graphs - and for `EventGrph` the list stopped at
`EndVacuumObjects`, one entry before `EventGraph`. A list whose whole purpose was to contain the
answer, sorted so that it did not.

Ranking those by similarity is the same fix as the `didYouMean` re-ranking and reuses its scoring:

```text
EventGrph  ->  Did you mean `EventGraph`?
CanShot    ->  Did you mean `CanShoot`?
Nonsense   ->  (no suggestion; the original error stands)
```

**The part worth recording is what happened next.** After wiring it up, the suggestion appeared to
be missing. From that I concluded that tools use two error shapes - some returning errors, some
throwing them - and that the hook only ran on the returned kind. I built a second path for thrown
errors, shipped it, and wrote the lesson up here as fact.

It was wrong. Instrumenting the catch branch afterwards showed it is **never reached**:

| | |
|---|---|
| handlers that catch and return their errors | 129 of 134 |
| handlers that do not | `list_tools`, `enable_tools`, `find_source`, `guide`, `session_changes` |
| ...of those, ones that can produce a not-found error | none — none of them look an asset up |

So there is no second path, and there never was. The most likely reason the suggestion looked absent
is that the shell command used to check it was `tail -3 | head -2`, which cuts off the last line of a
reply - and the appended line is the last line. **I diagnosed a bug in the code from a truncated view
of the output, and built a fix for it.**

The dead branch has been removed and this section rewritten. The graph ranking is real and verified;
the explanation that shipped beside it was not. The ordering that would have prevented it is the one
that eventually settled it: instrument first, conclude second. A theory that explains the symptom is
not evidence, especially when it is the first one to arrive.

### A healthy doctor said "fine" eleven times

The standing instructions make `unreal_doctor` step 1 — *"anything broken: unreal_doctor"* — so
nearly every session pays for it. On a working setup it cost **413 tokens**, and most of that was
prose confirming that things which are fine are fine: `protocol 1`, `27 probed commands are all
implemented`, `source control not enabled`, `ping round trip 9ms`.

This repo already applies "count the passes, name the failures" in the audit and in
`unreal_run_tests`. The diagnostic that gets run first was the one place still doing the opposite.

| | tokens |
|---|---:|
| healthy report, before | 413 |
| healthy report, now | **195** |
| `verbose: true`, or anything not `ready` | 413 |

Three of the eleven checks carry facts worth keeping when nothing is wrong — **which** editor this
is talking to, the engine version, and how much of the project is indexed. Those orient a caller
rather than reassure it. The rest becomes `checksPassed: 10`.

**A degraded report is never compacted.** The entire value of this tool is the detail on the check
that failed, and a diagnostic that gets terser exactly when something breaks would be worse than
none. That invariant is the one pinned by a test, and it is the half that needs no editor to check:
pointed at a port nothing is listening on, the reply keeps every check and never grows a
`checksPassed`.

`verbose` was kept rather than making compaction unconditional, because a failed report is already
full — so `verbose` is the only way to see the *passing* detail through the MCP at all. Removing it
would have kept three ceilings untouched by quietly deleting an ability.

Those ceilings moved instead: `search` 2,500 → 2,550, `core` 13,100 → 13,150, `lazy` 13,400 →
13,450. Thirty-two standing tokens, paid once and then cached, against 218 saved on a call made in
every session.

One guard caught the change honestly. `check:replies` bounds the doctor report at 1,200 tokens for
the case *"run when nothing works"* — and it keys on a string the compact form no longer contains.
It now asks for `verbose: true`, because the report it exists to bound is the one you get when
something is wrong, and that report is always full.

### Two of three `branch-decides-nothing` findings were wrong

This check was written in this repo to replace `branch-dead-path`, which fired on 58% of Branches
and was pure noise. The replacement was narrower and looked safe: *a Branch whose two arms reach the
same node has computed a condition and thrown it away*. On a real project it found three.

Reading the graphs it accused — rather than trusting it — showed two of the three were correct code.
`BP_Player/CanShoot` is:

```text
Branch (EnergyCooldown OR isVaccuming OR inCutscene)   then -> Outputs.Cannot
                                                       else -> Outputs.Can
```

That decides everything. A function's `Outputs` is **one tunnel node**, so both arms land on the
same node by construction — which means comparing node identity alone calls *every boolean function
in the project* a defect. `BP_AntlineCable` was the same shape.

The fix is one line: compare `node.pin`, not `node`.

| | before | after |
|---|---:|---:|
| findings on this project | 3 | 1 |
| of those, real | 1 | 1 |
| precision | 33% | **100%** |

`BP_FireWall.TakeDamage` still fires, which is the half that matters — it sends both arms into
`Set Health`'s single `execute` pin, so node and pin both match. Recall is unchanged; only the
false positives are gone.

**The same mistake in a narrower form.** The comment above this check already explains that its
predecessor fired on ordinary correct practice, and the tests written beside it encoded the same
assumption the code did — `then`/`else` both pointing at one node id, which looked obviously wrong
in a fixture and is obviously right in a function graph. A fixture invented alongside the thing it
tests can only confirm it. What caught this was running the check against a real Blueprint and then
reading that Blueprint.

### 41% of the audit was one note about comment boxes

Measured across the whole project — 339 Blueprints, 834 findings:

```text
unlabelled-sections      344   41%   <- one info-level style note
unhandled-cast-failure   105   13%
long-exec-chain           89   11%
debug-print-left-in       41
graph-too-large           39
...
server-writes-unreplicated 21         <- the multiplayer checks, all of them
cast-to-server-only-class  11            put together, are a fifth of the
reads-server-only-variable  6            comment-box note
```

The condition was `2 or more chains and fewer comment boxes than chains`, which is very nearly every
graph anyone has ever written. A seven-node function with two chains and no comment box is not hard
to read; it is a seven-node function.

This is the failure mode this file already names twice — a check that fires on ordinary correct
practice is noise, and noise is how a report stops being read. It was drowning the findings that
matter: every replication and server-authority finding in the project put together is a fifth of
this one note.

What the finding actually claims is that a reader cannot see the structure without tracing wires,
and that is a property of **size**. So it is now gated on size: 40+ nodes, 3+ distinct chains, and
**no** comment boxes at all. Any attempt at labelling silences it, because "you have one box and
four chains" is advice nobody needs.

| | before | after |
|---|---:|---:|
| `unlabelled-sections` | 344 | **14** |
| whole-project findings | 834 | **504** |

Every other check is unchanged — `unhandled-cast-failure` 105, `long-exec-chain` 89,
`server-writes-unreplicated` 21 — so nothing else was disturbed to get this.

Kept at `info` rather than raised or removed. It has no runtime consequence, and the one piece of
direct human feedback this project has on the subject is that machine-added comment boxes were too
big and too many. It should nudge at the extreme and stay quiet everywhere else.

**Two tests had to be rewritten, and that is the tell.** Both asserted the old behaviour using
four-node fixtures — graphs so small that the check firing on them was the bug. A fixture built
alongside a check tests that the check still does what it does, not that what it does is right.
Nothing in the suite could have caught this; only counting findings on a real project could.

### A finding that was one step from deleting a live variable

`repnotify-does-nothing` fires 26 times on this project. Three were checked against the real
Blueprints, node by node, and all three are true positives — `OnRep_CurrentRepairProgress`,
`OnRep_bIsLoaded` and `OnRep_BulletScale` each contain exactly one node, the entry, and each
variable really is `RepNotify`. The check is precise.

The **wording** was not. One finding escalates when the Blueprint also never reads or writes the
variable, and said:

> Dead state: it is replicated across the network, notified on arrival, and **read by nobody**.
> Check nothing outside this Blueprint reads it — `find_references` — then delete the variable.

Both halves fail. `PS_Gameplay.bHasFinishedCutscene` is written by `PC_Lobby` and read by
`GM_Lobby` — a PlayerState field written by one Blueprint and read by another is the *normal* shape
of that class, not a defect. And `find_references` returns the AssetRegistry's **asset** dependency
graph; it cannot tell you whether a variable is read. The tool that can is `unreal_trace_variable`,
which is what `search_project` already points at for exactly this question.

So the caveat named a tool that could not perform the check, two sentences after an unqualified
claim that the variable was dead. The standing instruction from this project's owner is *"if it does
nothing, delete it."*

The scoped observation is still worth having and is unchanged — "nothing in **this Blueprint** reads
or writes it" is true. What changed is the escalation: it now states its own scope, says outright
that cross-Blueprint use is normal for PlayerState and GameState, and names `unreal_trace_variable`
as the thing that settles it.

**The pattern to take from this**: a check that examines one Blueprint must not phrase its finding
as a fact about the project. The severity was right, the detection was right, and the sentence was
still capable of causing damage no test would have caught — because every test fixture in this
repo is a single Blueprint, which is precisely the scope the claim overstepped.

### A real bug the audit found and never mentioned

Cutting `unlabelled-sections` down changed what the audit leads with, so it was worth looking at
what it now says first. It says this:

> Start with 2 empty Data Table reference(s) — `DT_Upgrades` row `Weapon_MachineGun`
> (`UpgradeClass`)…

Both are real: `Weapon_MachineGun` and `Vacuum_VirusController` have no `UpgradeClass`, so buying
either upgrade does nothing at all. Every other row in the table names its own upgrade Blueprint.

Reading the rest of the table turned up a second bug the ranking never mentioned:

```text
Weapon_MachineGun         (EMPTY)
Survival_MobileAgent      BP_BulletSize      <- "extremely fast, jump higher, unlocks sprint"
Vacuum_VirusController    (EMPTY)
Stat_BulletDamage         BP_DamageUpgrade
Stat_BulletSize           BP_BulletSize      <- the same class
Stat_VacuumSpeed          BP_VacuumSpeedUpgrade
...
```

Buying "Mobile Agent" instantiates the bullet-size upgrade.

**The check for this already existed and had already caught it.** `dataTableAudit.ts` looks for two
rows sharing a class reference, and its own comment names this exact pair as the case that justified
writing it. The result was in the reply, under `dataTableDuplicateClasses`.

It was never *ranked*. `nextAction` — the one field the tool tells a model to act on — named only
the nulls, and `groups` never carried Data Table findings at all. So the finding existed, was
correct, was documented, and could not reach the caller. That is the same defect as a tool no
profile can enable: a route with nothing pointing down it.

Both kinds now lead the ranking, nulls first — both are silent at runtime, but an empty reference
does nothing while a shared one does something plausible, so the empty one is the cheaper read.

The lesson is narrower than "test your checks". Every part of this worked: detection, wording, the
payload field, the tests. What nothing checked was whether a finding could travel from where it is
produced to where it is read.

### The honesty note was padded with things that are not classes

The audit ends with a caveat naming every class it could not resolve, so a reader knows
`cast-to-server-only-class` did not run for those names — *"absent from the findings because nothing
is known about them, not because they are clean."* On this project it named **52**.

Most of them were never classes:

```text
Vector  Rotator  Transform  LinearColor  SlateBrush  TimerHandle  GameplayTag
IntPoint  Margin  SlateColor  SoftObjectPath  S_SkinData  ST_FeedEntry  ...     <- structs
EHorizontalAlignment  ETextJustify  E_GameConclusion  E_InputDevice  ...        <- enums
```

A struct or enum variable carries its own name in `subType` exactly as an object variable does, so
every one of them was handed to `describe_class`, failed, and was recorded as an unresolvable class.
No class check could ever apply to `Vector`.

The fix is to ask only about things that *are* classes — the raw type head is `Object`, `Class`,
`SoftObject`, `SoftClass` or `Interface`, and everything else is skipped before the lookup rather
than after it.

| | before | after |
|---|---:|---:|
| names in the caveat | 52 | **12** |
| `cast-to-server-only-class` found | 11 | 11 |
| whole-project findings | 504 | 504 |

The twelve that remain are coherent and real — three `B_Lyra*` Blueprints and nine `W_*` touch
widgets, which are exactly the assets that do not compile in this project. That is a caveat worth
reading. Fifty-two, three quarters of it `Vector` and `EHorizontalAlignment`, is one a reader learns
to skip — and skipping it costs them the twelve.

**Nothing about this was a bug in the detection.** The check ran correctly, the note was accurate as
written, and every count it reported was true. The defect was that a true statement had been made
useless by including things it was never about.

### The orientation call spent 64% of itself on a long tail

`unreal_get_project_overview` is what the standing instructions send a model to **first**, to get its
bearings in an unfamiliar project. Measured here, that reply was 702 tokens, and 452 of them were the
parent-class census below the top eight:

```text
79 parent classes
43 of them have exactly one Blueprint
```

"One Blueprint inherits from `BP_BillboardVariant_C`" orients nobody. What orients is that this
project is 88 widgets and 71 actors. And the question the tail could answer — which Blueprints sit
under class X — is answered properly by `unreal_list_blueprints`, which reads the editor rather than
a cached index.

| | before | after |
|---|---:|---:|
| overview reply | 702 | **416** |
| parent classes listed | 79 | 21 |

The cut is **by count, not by rank**: every class with three or more Blueprints survives whatever the
project looks like, so a project of forty evenly sized hierarchies keeps all forty. A top-N cut would
have told a different lie about a differently shaped project.

The tail is counted, never dropped — *"58 more parent class(es) account for 73 Blueprint(s)"* — and
the test asserts `kept + hidden == blueprintCount`, so the reply can never quietly disagree with its
own census.

`planFeature` reads the bridge's untouched shape rather than this reply, and already took only the
top six from it — the same judgement, made independently, before this was measured.

**Side effect worth recording**: cutting `unlabelled-sections` and the not-a-class caveat in the two
previous commits took the whole-project audit from 3,206 to 2,968 tokens without anything being
aimed at its size.

It measures 3,171 today, and the difference is not drift. Two coverage notes were added deliberately
afterwards — `parentCallNotChecked` at 190 tokens and the Data Table scan counts at 13 — because a
check that ran on 13% of the project and a Data Table half that read nothing look identical to one
that found nothing. That trade was made with the numbers in front of it: 203 tokens to stop three
findings being read as a clean bill of health.

### Following a Data Table finding into the C++ that reads it

The audit reports an empty class reference as *"whatever consumes it silently does nothing — no
error, no log."* That is true of an empty reference in the abstract. On the real table it was wrong
in the worse direction.

`DT_Upgrades` rows are instances of `FShopUpgradeDef`, a C++ struct. `unreal_find_source
"ShopUpgradeDef"` resolves the missing `F` prefix, finds it at `AC_ShopComponent.h:24`, and names
the two lines in the `.cpp` that read it. The consumer counts ownership by class equality:

```cpp
if (ItemDef->UpgradeClass) {
  for (const TSubclassOf<AActor> &HeldClass : ActiveUpgrades) {
    if (HeldClass == ItemDef->UpgradeClass) { bIsOwned = true; OwnedCount++; }
  }
}
```

So an **empty** `UpgradeClass` does not mean "nothing happens". It means the guard never runs, so
`OwnedCount` stays 0 forever — the upgrade never registers as owned, never reaches `MaxTiers`, and
can be bought an unlimited number of times. A **shared** `UpgradeClass` means two rows share one
ownership counter: buying either tiers up both.

The audit cannot know that, and should not pretend to. What it can do is hand over the thread. The
row struct is now carried on both Data Table finding kinds, and when it is declared in C++ —
`/Script/...` — `nextAction` says so and names `unreal_find_source`. A Blueprint-defined row struct
gets no such pointer, because `find_source` reads C++ and would find nothing; both cases are pinned
by a test.

This is the join the project is meant to close — *"whether it's C++ or Blueprints or a Data Table"*.
The finding starts in a Data Table, the explanation is in a `.cpp`, and until now nothing connected
them.

### A cost-95 check was running on 13% of the project, silently

`parent-event-not-called` is one of the most expensive findings in the table, and rightly so: adding
`Event BeginPlay` to a child silently replaces the parent's, nothing warns, and the child's own logic
still works — so the Blueprint looks correct while everything the parent set up is missing.

It compares a child against its parent's **graph**, so a parent that is not a Blueprint is skipped:

```ts
const parent = eventGraphs.get(child.parentClass);
if (!parent) continue;                 // a C++ parent: skipped, and until now in silence
```

Measured here: **296 of 339 Blueprints inherit from a native class.** The check ran on 43 of them,
and the report mentioned the other 87% nowhere. It found 3 — a number that reads very differently
once you know what it was looking at.

**Firing anyway would have been worse.** This check's own rule is that the signal is overriding a
parent implementation that *does work*; without the parent there is no signal, only a shape, and it
would have fired on hundreds of ordinary widgets. Reading C++ parents properly means parsing
`BeginPlay` out of source, which is a different piece of work.

So it reports coverage instead of inventing findings — the same answer `classesNotResolved` gives,
for the same reason:

> parent-event-not-called ran on 43 of 326 Blueprints; the rest inherit from a native class, which
> this cannot read. Most-used: UserWidget (87), Actor (70), None (11), **AVSActivatableWidget (9)**,
> **AVSButtonBase (6)**, CommonUserWidget (6). Overriding an engine parent is usually fine; one of
> your own C++ classes is worth a look with `unreal_find_source`.

The list is there so the reader can spot their own classes, which they do instantly — `AVS*` is not
`UserWidget`. 190 tokens, on a reply that had just dropped 238 from the two previous commits.

**A coverage number is not a finding, and this project keeps discovering it needs both.** Three
findings from a check that ran on 13% of the project is a different fact from three findings, and
nothing in the reply distinguished them.

### Sweeping for the rest of the silent skips

The parent-call gap in the previous commit was one instance of a shape: work the audit does not do,
reported nowhere. Worth checking whether it was the only one, so the next iteration does not go
looking again.

`audit.ts` has nine `continue` statements. Seven are accounted for:

| | |
|---|---|
| dispatcher graphs | deliberate — without it `empty-function` reports every event dispatcher |
| non-class variable types | added two commits ago, with the reason recorded |
| the parent-call skip | now reports coverage |
| four in the dedup pass | collapsing duplicate findings, not skipping work |

The one thing left was the Data Table half. `auditDataTables` computes `tablesScanned` and
`rowsScanned` and the audit never passed them on, so **a project with no Data Tables and a project
with fifty clean ones produced an identical reply**, and neither said which it was. The absence of
findings is not evidence until you know what was read.

Both numbers are now returned — `dataTablesScanned: 20, dataTableRowsScanned: 128` on this project,
for 13 tokens. There is a 200-table cap on the scan; this project is nowhere near it, but the count
is now visible if a bigger one ever is.

**A negative result is worth writing down too.** The sweep found one more instance and confirmed the
other eight are fine. That is the useful output — not because anything was wrong with them, but
because the next person to ask "where else is this happening" now has an answer instead of a search.

### The planner told a model to extend a touch button for a movement upgrade

Most of this project's recent work has been on finding bugs. The other half of the promise —
*"I tell it a feature I want, it scans the current work, adapts to it, builds with it"* — is
`unreal_plan_feature`, so it was worth running against a real request:

> Add a Mobile Agent upgrade that makes the player faster and jump higher, sold in the shop like the
> other upgrades

Much of the plan is good. It finds the upgrade system (`BP_DamageUpgrade`, `BP_HealSpeedUpgrade`,
`BP_ShopComponent`), and it flags `BP_Player` as high risk with 49 referencers. But it splits the
request into words, and **"Mobile Agent" is a proper noun**:

```text
"upgrade" -> BP_ShopComponent (has function "HasUpgrade")        <- the real system
"mobile"  -> W_ActionTouchButton_MobileOnly                      <- a touch-screen button
```

Both got the same sentence: *"already exists in this project … Extend it rather than adding a second
one."* So the plan instructed a model to extend a touch control for a movement upgrade.

Splitting proper nouns is the root cause and this does not fix it. What it fixes is presenting a
name coincidence with the confidence of a finding. **The discriminator was already on the asset** —
`reasons` records whether a match came from a function, a variable, a reference, or only the name —
and nothing was reading it:

> "mobile" appears in the NAME of 1 asset(s): W_ActionTouchButton_MobileOnly. Nothing else connects
> them to this request, so that may be the same concept or a coincidence — read one before treating
> it as the system to extend.

`upgrade` and `jump` keep the strong wording, because they matched on functions and variables rather
than on spelling. `player` keeps it too — a broad concept, but `has variable "PlayerName"` and
`has function "DamagePlayer"` are real matches, and softening those would be the opposite mistake.

The pattern is one this repo keeps arriving at from different directions: **the evidence for a claim
was already recorded, and the claim was written without consulting it.**

### A space in a search returns nothing, and looks like an answer

Chasing the proper-noun problem from the previous commit turned up something plainer and worse.
`unreal_search_project` matches a **substring**, and asset names contain no spaces:

```text
search_project "shop upgrade"   ->  0 hits
search_project "ShopUpgrade"    ->  BP_ShopUpgrade, BP_ShopUpgradeTier, ...
```

An empty result is indistinguishable from "this project has no such thing". A model asking the most
natural question — the feature's name as a person would write it — gets a confident nothing and may
build a second copy of a system that already exists. The description now says so, in 26 tokens.

**The attempted fix was reverted, and that is the more useful half of this entry.**

The plan was to make `plan_feature` search two-word phrases so "Mobile Agent" stayed one concept.
Written, typechecked, wired in — and it never fired once. `systemMap` deliberately overrides the
substring search:

```ts
// The bridge searches by substring. That is right for a search box and wrong for
// "this system already exists" - see matchesAsWord.
if (!matchesAsWord(matched, query)) { substringOnly += 1; continue; }
```

It requires the query to appear as a **word**. `shopupgrade` is not a word in `BP_ShopUpgrade`, so
concatenating — the very thing that makes `search_project` work — guarantees `mapSystem` finds
nothing. Two layers, opposite matching rules, both correct for their own job.

The feature was deleted rather than kept. It compiled, it was tested, and it did nothing — which is
the same shape as the thrown-error path removed earlier in this project, found the same way: by
checking whether the new code had actually changed the output, rather than whether it ran.

### What this cannot do, and proof that the rest of it can

Two questions worth answering with measurements rather than confidence: where does the tool surface
actually stop, and does the flagship path still work end to end?

**The boundary.** Of 108 bridge commands, exactly three subject areas are read-only:

| | can read | can write |
|---|---|---|
| Level Sequence | `read_level_sequence` | — |
| Behavior Tree | `read_behavior_tree` | — |
| Timeline | `read_timeline` | — |

Everything else that can be read can also be changed — Niagara has `set_niagara_user_parameter`,
materials have `create_material` and `set_material_parameter`, input has `add_input_mapping` and
`map_input_key`, widgets have `add_widget` and `set_widget_property`, montages have
`add_montage_notify`. Closing the three needs new C++ in the bridge and a plugin rebuild, which is
why they are listed rather than quietly missing.

**The path.** Create a Blueprint with a variable, a component and event logic, then compile, review,
verify and delete it — the sequence the standing instructions describe, run against a live editor:

| step | tokens | |
|---|---:|---|
| `scaffold_blueprint` | 187 | Blueprint, variable, SphereComponent, BeginPlay chain, in one call |
| `compile_blueprint` | 21 | 0 errors |
| `review_blueprint` | 227 | score 96 |
| `verify_feature` | 281 | **fail** |
| `delete_asset` | 11 | |
| | **727** | a whole feature built and checked |

The `fail` is correct and worth keeping as the example. The scaffold's only action was a
`Print String`, so `debug-print-left-in` fired: *"Remove them before calling the feature done, or
confirm they are deliberate developer output."* A verifier that passed that would be worthless.

**Also checked, and true**: `unreal_find_node` promises that `"Array Length"`, `"array_length"` and
`"ArrayLength"` all find `Array_Length`. All three do. That promise is what makes the
`search_project` space trap in the previous commit surprising — the two search surfaces genuinely
behave differently, and only one of them says so.

### The space trap was the whole `match` convention, not one tool

The previous commit found that `search_project` matches a substring, so a space matches nothing. That
was not one tool's problem. Every `match` filter in the server did the same thing, and the standing
instructions send every model straight at them — *"Every large read takes a filter (match, fields,
replicatedOnly, direction, limit). Use it: the difference is 1,691 tokens against 218."*

Measured before:

| | natural phrasing | concatenated |
|---|---:|---:|
| `list_blueprints` `"shop upgrade"` / `"ShopUpgrade"` | **0** | 7 |
| `list_variables` `"vacuum charge"` / `"VacuumCharge"` | **0** | 3 |
| `read_blueprint_summary` | **0 nodes** | 5 nodes |
| `explain_graph` | **0 chains** | 2 chains |

Four tools, one behaviour: the way a person writes a name is the one input guaranteed to fail, and
the failure is an empty result that reads as *"this project has none"*.

`match` now splits on whitespace and requires every term, in any order. All four agree:

```text
"vacuum charge"  ->  5 nodes, 2 chains
"VacuumCharge"   ->  5 nodes, 2 chains
"charge vacuum"  ->  5 nodes, 2 chains
```

**It is a strict superset, which is what made it safe to change all four at once.** If the whole
phrase appeared literally then each of its words appears too, so nothing that matched before stops
matching — the concatenated column above is unchanged. Order is not required either, because
"upgrade shop" and "shop upgrade" are the same request and honouring one but not the other would be
a second trap beside the first.

`search_project` keeps its warning rather than this fix: it is the bridge's own C++ search, so
changing it means a rebuild before anyone benefits. Same split this project has made before — the
bridge stays faithful, the tool layer accommodates.

Two `match` filters were deliberately left alone. `unreal_list_tools` already reads whole sentences
on purpose, and `unreal_guide` searches prose, where a literal phrase is the right thing to look for.

### A guard for the trap that nothing could have caught

The `match` fix in the previous commit was found by typing a two-word query by hand. Nothing failed,
no test broke, and all four tools looked like they were filtering correctly — which means nothing
would catch the same mistake in the *next* filter somebody writes.

`check:matchfilters` scans `src/` for `haystack.includes(needle)` and requires every file containing
one to declare **how many** it has and **why** each is deliberate. The question is always the same:

> Is the haystack a **name** or is it **prose**? A name has no spaces, so a spaced query can never
> match it and the filter is broken for the most natural input. Prose has spaces, so a literal
> phrase is a meaningful thing to look for.

Two more name-based filters were converted on the way: `unreal_run_tests` matching automation test
names like `System.Mass.EntityView.Invalidate`, and `unreal_find_orphans` matching actor class names.
Seven substring tests remain, all in two files, all over prose — `list_tools` reads whole sentences
on purpose, and `guide` searches documentation.

**The count is the point, not the filename.** An allowance keyed only by file would let a new
plain-substring filter in `index.ts` inherit the reason belonging to a guide search three hundred
lines away — which is precisely the false confidence the guard exists to prevent. It also fails on an
allowance for a file that no longer has any, so the reasons cannot rot into notes about nothing.

Two things worth recording about building it:

**I ran the guard against a deliberate regression before trusting it.** Dropping a new file with the
old pattern into `src/` made it fail, with the message naming the fix. A guard nobody has watched
fail is a guard nobody should believe.

**It immediately caught my own miscount.** I had declared four allowances for `index.ts`; there are
five, because `list_tools` tests a tool's name and its summary on separate lines. The first thing the
guard did was contradict the person who wrote it.

### A rounding error reported in a paragraph

The bridge notices when its cached index and the editor disagree, and says so in 68 tokens: *"built
from a cached index holding N Blueprints, and the editor currently has M … treat them as approximate
… `list_blueprints` and `list_assets` read the editor directly and are authoritative."*

Every word of that is true, and it is the right warning when the cache is badly out of date. On this
project the disagreement is **341 against 339** — two Blueprints, 0.6%, present all session. Nothing
anyone reads off this reply changes because of two: not the folder census, not the parent-class
breakdown, not "is this project mostly widgets". The full paragraph was being paid on the first call
of every session to report a rounding error.

Under 2% it is now one clause carrying the same two numbers, so a reader who cares can still see the
exact disagreement:

> Cached index has 341 Blueprints, the editor has 339; totals below are the cache's.
> `list_blueprints` reads the editor.

At or above 2% the bridge's own wording stands, because then the totals really might mislead and the
advice about which tools are authoritative earns its tokens. **Both branches are asserted** — the
test checks that whichever fires, both numbers survive, and that the trim does *not* apply when the
cache is genuinely stale. Sizing a warning to the thing it warns about is only an improvement if the
big case still gets the big warning.

The orientation call is now **377 tokens**, from 702 three commits ago.

| | tokens |
|---|---:|
| `get_project_overview` originally | 702 |
| after trimming the parent-class tail | 416 |
| after sizing the drift note | **377** |

Sized in the tool layer rather than in the C++ that writes it, for the usual reason: that needs a
plugin rebuild before anyone benefits, and this is the layer already trimming this reply.

### `review_blueprint` can be asked one question now

`unreal_audit_project` has taken a `check` since it was written — *"pass its `check` to get one kind
of finding back in full"*. `unreal_review_blueprint`, the per-asset half of the same job and the tool
step 6 of the standing instructions makes every authoring session run, never did. A caller with a
specific question had two options: take everything, or narrow by graph and hope the finding lived
there.

| | tokens | |
|---|---:|---|
| whole review of `BP_Player` | 3,279 | |
| `check: "server-writes-unreplicated"` | **1,201** | *"4 of 31 finding(s); the rest are other kinds"* |
| `check: "branch-decides-nothing"` | 535 | names what it *did* find |

**A filtered review must not read as a clean one.** This project has spent several commits on the
difference between "nothing found" and "nothing looked", and a filter that simply returned fewer
findings would be the same trap one level down — ask for `server-writes-unreplicated` on a Blueprint
riddled with dead nodes and get back something short and reassuring.

So the score and the counts still describe the **whole** review, the reply says outright how many it
withheld, and a `check` that matched nothing is answered differently from one that is not a real
check name — the same distinction `audit_project` draws with `checkNotFound`. All four are asserted.

Filtered where the review is *serialised*, not where it is produced: `audit.ts` reads the unfiltered
review off the same function in twelve places. Same rule as `dedupeFixes`, which sits two lines away
for the same reason.

The parameter costs 36 standing tokens and three ceilings moved for it — `core` 13,200, `lazy`
13,500, `full` 352/tool. Break-even is the first filtered call. The number `full`'s ceiling is really
about is whether descriptions are bloating, and they are not: the per-tool average is 342 and flat.

**Two measurements this round found nothing worth changing**, which is worth recording so the next
iteration does not repeat them. The seven `server-writes-unreplicated` messages on `BP_Player` look
repetitive and are not — they are evidence-tiered, one saying *"nothing in this Blueprint reads it
either"* and another not, so collapsing them would flatten a real distinction. And `nextAction` does
restate a finding's message verbatim, but both come from the same source and cannot drift, and the
full sentence in one place is what the weaker profiles rely on. Redundancy, not inconsistency.

### The last list with no way to narrow

Having found `review_blueprint` missing a filter its sibling had, the obvious next question is which
other large reply cannot be narrowed at all. Two tools took no filtering parameter:

| | reply | verdict |
|---|---:|---|
| `list_input_mappings` | 75 tokens | nothing to fix — the whole thing is smaller than a filter's description |
| `list_widgets` | **2,654 tokens** on `WBP_MorrisPopUp` | the gap |

87 widgets, and no way to ask for some of them, while every other list tool takes a `match`. "Which
buttons does this screen have" cost the whole tree.

```text
(no match)     2,654 tokens    87 widgets
"text"           506           13 of 87
"size box"       460           12 of 87
"button"         102            0 of 87
```

The `"size box"` row is the interesting one. The class is `SizeBox`, one word — that query would have
returned nothing before the term-matching fix two commits ago, and the two changes compound without
either being written for the other.

The `"button"` row matters more. **Zero matches still says "0 of 87"**, so a filtered reply cannot be
read as "this widget is empty" — the same rule the review filter follows, and the same one that made
`unlabelled-sections` and the parent-call coverage worth writing down.

One limit is stated rather than left to be discovered: this filters a flat list, so a match's parent
may not be in it. Each entry still names its parent, which is what `add_widget` and
`set_widget_property` actually need.

`full` grew 33 tokens to 46,611, inside the ceiling raised last commit; nothing else moved.

### I filtered half a reply and left the other half alone

Having built four filters that each report what they withheld, the obvious check is whether the rule
actually holds everywhere. Eight filtering tools were called with a query that cannot match anything.
Seven answered honestly. `explain_graph` did not — and the bug was mine, from the commit that added
its `match`:

| match | tokens | chains shown | entryIds | notes |
|---|---:|---:|---:|---:|
| *(none)* | 3,176 | all | 25 | 10 |
| `"vacuum"` | 974 | **15** | 25 | 10 |
| `"zzzznope"` | 516 | **0** | 25 | 10 |

The chain text was filtered. `entryIds` and the *"X and Y run into the same nodes"* notes were not.
So a search for something absent returned 516 tokens of ids and warnings about the chains it had
just excluded, and a real search returned ten notes for fifteen shown chains out of ninety-nine.

**Filtering half a reply is worse than not filtering it**, because the caller cannot tell which half
they are holding. Both are scoped now:

| match | tokens | shown | entryIds | notes |
|---|---:|---:|---:|---:|
| *(none)* | 3,177 | all | 25 | 10 |
| `"vacuum"` | **671** | 15 | 2 | 4 |
| `"zzzznope"` | **63** | 0 | 0 | 0 |

**A note is kept when it names a shown chain, even if its other half is hidden.** *"Changing one
changes both"* is a warning about reaching outside what you are looking at, which is exactly when
filtering makes it matter most. Dropping those would have traded one silent failure for another.

The unfiltered reply is unchanged at 3,177 — this only ever removes things the caller asked not to
see.

Worth noting how it was found: not by reading the code I had written, but by calling eight tools with
a deliberately impossible query and looking at what came back. The `unreachable` list in that same
function *was* correctly suppressed when filtering, with a comment explaining why — so the author
understood the rule and applied it to one of the three things that needed it.

### `hitCount` counted what came back, not what matched

The previous commit found a filter that only half-applied itself, by calling eight tools with a
deliberately impossible query. The same method on a different axis — call six tools with a
deliberately tiny cap and see whether the reply admits being cut — found something worse.

```text
find_node "get" maxResults 2    ->  hits 2,  hitCount 2
find_node "get" maxResults 50   ->  hits 50, hitCount 50
```

Both replies claim to have counted, in a catalog of **15,234 functions**, and neither says the cap
was hit. This is the tool the standing instructions point every model at before it writes a node —
*"never guess a function name; a guess costs a failed call"* — so a caller told there are two matches
for `"get"` may reasonably pick the better of two and never learn there were hundreds.

Five of the six were honest. `search_project`, which does the same job over Blueprints, has always
sent `truncated: Hits.Num() >= MaxResults`. `find_node` was never given it.

```text
find_node "get" maxResults 2         truncated: true   + "hitCount is what came back, not what matched"
find_node "get" maxResults 50        truncated: true   + the same
find_node "SpawnActorFromClass"      (nothing)         genuinely two hits, so nothing to say
```

The third line is the one that keeps it honest. A flag on every reply would be the same noise problem
one level down, so it is emitted only when the cap was actually reached — and a search that really
does match a handful stays clean.

**No schema surface and no plugin rebuild.** The cap is the same arithmetic on this side of the wire,
so all four ceilings are untouched and the fix reaches anyone running the current server against an
older plugin.

Two rounds, two defects, same method: not rereading the code, but calling the tools with inputs
chosen to expose the boundary — nothing matched, and everything matched but capped.

### The audit found the right rows in the wrong table

Exercising `unreal_find_in_data_tables` for the first time turned up something the audit could not
have told anyone. Searching for `BP_BulletSize` returned **three** hits when two were expected — and
the third was in a table this project did not know existed.

```text
DT_Upgrades      referenced by  1 asset   (BP_ShopComponent)
DT_UpgradesBP    referenced by  6 assets  (PC_Gameplay, GM_Gameplay, WB_ShopSlot, BP_ShopUpgrade, ...)
DT_UpgradesOld   referenced by  3 assets
```

Three overlapping upgrade tables. Every Data Table finding this project has reported — two empty
`UpgradeClass` references and a shared one — is in `DT_Upgrades`, the table **one** asset reads.
`DT_UpgradesBP`, which six read, has six rows, six distinct upgrade classes, no empties and no
duplicates. It is clean, and it uses a different row struct entirely: `S_UpgradeDef`, a Blueprint
struct, rather than the C++ `FShopUpgradeDef` the earlier commit traced into `AC_ShopComponent.cpp`.

The findings were right. The conclusion drawn from them — that these were *the* upgrade table's bugs
— was not, and nothing in the reply could have corrected it.

**So a Data Table finding now carries how many assets reference the table**, and the lead sentence
says it: *"row \"Weapon_MachineGun\" (UpgradeClass, a table 1 asset(s) reference)"*. A broken row in
a table nothing reads and a broken row in a table six things read are different facts, and they were
being reported identically. Only tables that already produced a finding are looked up, so a clean
project pays nothing.

**The first version of this shipped the field and not the sentence.** The lookup was attached after
`nextAction` had already been built, so `referencedBy: 1` was in the payload and the sentence never
mentioned it — the reply would have looked correct to anyone reading the JSON and unchanged to anyone
reading the text. Both are asserted now, and so is the case where the lookup fails: the finding
survives and says nothing rather than guessing.

### Two of the top ten were assets nothing references

The previous commit gave Data Table findings a reference count, because a broken row in a table one
asset reads is a different fact from one in a table six read. The same question applies one level up,
to the ranking a model is told to start from:

```text
BP_Player        cost 1410, 33 findings, referenced by 49
PC_Gameplay      cost 1385, 28 findings, referenced by 30
PC_TutGameplay   cost  890, 20 findings, referenced by  0
BP_FireWall      cost  840, 16 findings, referenced by 12
BP_Turret        cost  835, 14 findings, referenced by  1
...
GS_TutGameplay   cost  515, 13 findings, referenced by  0
```

Third and eighth, and nothing references either — **1,405 cost and 33 findings aimed at assets no
other asset mentions.** A model told to start with `PC_TutGameplay` would spend a session there and
the reply gave it no way to know.

`worstBlueprints` now carries `referencedBy`, for 44 tokens across the whole ranking. Only the ten
already being reported are looked up.

**Reported, not re-ranked**, and the distinction is the whole point. Zero referencers is strong
evidence and not proof: a class set in a level's World Settings, or picked at runtime by name, can be
real and show nothing here. Sorting on it would bury a genuine finding on the strength of a
heuristic, and this project has already had to walk back one confident "read by nobody". The number
is the useful part; the judgement belongs to the caller.

The failure case is asserted too: a bridge without `find_references` leaves the ranking intact and
the field absent, rather than reporting zero — which would read as "nothing uses this" and mean the
opposite.

### Answering the question the last commit raised

The previous commit reported that `PC_TutGameplay` and `GS_TutGameplay` sit third and eighth in the
"what to fix" ranking with nothing referencing them, and left it there as a flag. That is an
uncomfortable place to stop: a reader cannot act on "possibly unused". So the next step was to settle
it, by reading the tutorial GameMode's class defaults:

```text
GM_TutGameplay.GameStateClass         GS_PlacementManager
GM_TutGameplay.PlayerControllerClass  PC_Gameplay          <- not PC_TutGameplay
GM_TutGameplay.PlayerStateClass       PS_Gameplay          <- not PS_TutGameplay
GM_TutGameplay.DefaultPawnClass       (engine default)     <- GM_Gameplay sets BP_Player
```

The tutorial GameMode selects none of the tutorial classes. That is why the reference count is zero,
and it also turned up something separate worth a look: `GM_TutGameplay` has no `DefaultPawnClass`
while `GM_Gameplay` sets `BP_Player`.

So the audit now states it rather than leaving the number to be interpreted:

> Nothing references PC_TutGameplay (cost 890, 20 finding(s)), GS_TutGameplay (cost 515, 13
> finding(s)). A place to look last, not a verdict: a class named in a level's World Settings or
> chosen at runtime is real and shows nothing here. Confirm with `unreal_find_references` before
> deleting anything.

81 tokens, and only when it fires — a line that appears on every audit is a line nobody reads.

**The hedge is not politeness.** `find_references` sees asset references; it does not see a class
named in World Settings or resolved at runtime. This project has already walked back one confident
"read by nobody", so the check names the assets, gives the evidence, and stops. Both branches are
asserted, including the silent one.

Checked first, as usual: `find_orphans` pairs actors in a level by proximity, and `possiblyReplaced`
finds uncalled function graphs. Neither covers a gameplay-framework Blueprint no GameMode selects,
which is still a gap worth its own check one day — this is the cheap half, built from a number the
previous commit had already paid for.

### A GameMode that runs gameplay and never says what the player is

The previous commit named a gap and left it: nothing checked whether a gameplay-framework Blueprint
was wired to anything. Reading all five GameModes' class defaults made the shape of the check obvious:

```text
GM_Gameplay              pawn BP_Player                 GS GS_PlacementManager
GM_Lobby                 pawn BP_Player                 GS GS_Lobby
BP_FirstPersonGameMode   pawn BP_FirstPersonCharacter   GS (engine default)
GM_TutGameplay           pawn (engine default)          GS GS_PlacementManager
GM_MainMenu              pawn (engine default)          GS (engine default)
```

`DefaultPawnClass` decides what every joining player possesses. Left at the engine default it is
`ADefaultPawn` — the grey flying sphere with no mesh and no game logic — and nothing warns, because a
GameMode with an engine default is a perfectly valid GameMode. It surfaces as *"the tutorial spawns
me as a floating ball"*, usually from a player rather than a test.

**Two of the five have no pawn and only one is a defect.** `GM_MainMenu` is a menu: no gameplay, no
project GameState, nothing to possess. A check that flagged it would be the noise this project has
spent several commits removing — `unlabelled-sections` at 41% of the audit, `branch-decides-nothing`
at 67% false.

The discriminator is the GameMode's **own other choices**. `GM_TutGameplay` picks a project GameState,
so it has replicated match state and is running real gameplay, and then leaves the pawn at the
engine's. That inconsistency is inside one asset, which is what makes it evidence rather than a guess
about intent. One finding on this project, cost 90, and the fixture asserts the other four stay
silent.

Reported as what was observed, with the escape hatch stated: a GameMode can spawn and possess pawns
in its own graph, and then the engine default is never used. The `fix` says so rather than assuming
the caller is wrong.

Found the ordinary way — by answering a question the previous commit had raised instead of moving on
from it, and by reading five assets before writing a rule about them.
