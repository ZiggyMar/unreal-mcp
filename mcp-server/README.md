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
| `unreal_create_struct` | `create_struct` | Create a user-defined Struct with typed fields, validated before the asset is created. |
| `unreal_add_struct_field` | `add_struct_field` | Append a field to an existing Struct. |
| `unreal_list_struct_fields` | `list_struct_fields` | Read a Struct's fields: name, type, sub-type, array-ness, default. |
| `unreal_create_enum` | `create_enum` | Create a user-defined Enum with named entries. |
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
graph calls it, repeat. On the project this is developed against: **176 of 1,007 graphs**.

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
- **The report states its own limits.** It sees what this server did, not hand edits in the editor
  or another tool, and it says so rather than leaving that to be discovered at a bad moment.

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

