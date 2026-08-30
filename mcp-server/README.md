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
| `unreal_audit_project` | *(composite)* | Audit every Blueprint and rank what to fix, by likely cost. The "my game has bugs, where do I look" tool. |
| `unreal_project_health` | `project_health` | Where the whole project needs attention: oversized graphs, oversized Blueprints, cast-heavy Blueprints. Costs no asset reads. |
| `unreal_guard_with_authority` | *(composite)* | Put a node behind a HasAuthority branch, keeping its chain. The fix for a client-side GameMode cast. |
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
| `unreal_list_input_mappings` | `list_input_mappings` | Read what input is bound and to which key. First call when a key does nothing. |
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
complaint matrix said "Open" on the assumption these were missing. They were not. The cost of
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

`unreal_doctor` reports the active mode and what it means, since it changes what every call costs.

Combine with `UNREAL_MCP_PROFILE=search` for the cheapest useful setup: four tools standing
(~1.2k tokens instead of ~25.5k) and ~110-token build responses.

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

| `UNREAL_MCP_PROFILE` | Starts at | Reaches | Meant for |
| --- | --- | --- | --- |
| `search` | **4 tools, ~1.2k tokens** | everything, on request | frontier models — what `--print-config` emits |
| `full` (in-process default) | 80 tools, ~25.5k tokens | everything, immediately | when you want no indirection at all |
| `lazy` | 28 tools, ~10.1k tokens | everything, on request | mid-size models |
| `core` | 28 tools, ~10.1k tokens | only those, permanently | clients that ignore `tools/list_changed` |
| `minimal` | 11 tools, ~4.0k tokens | only those, permanently | small local models |

Those figures are measured by `npm run check:profiles`, which runs in the normal test suite and
fails if a profile grows past the ceiling its intended model can hold. They were hand-measured once
before that existed and were wrong within a few commits, which is the argument for the script.

**`search` is the one to reach for on a capable model**, and it is what `--print-config` now writes
for Claude Desktop, Claude Code, and Cursor. Only four tools stand: `unreal_ping`, `unreal_doctor`,
`unreal_list_tools`, and `unreal_enable_tools`. Everything else is registered with its full schema
and switched off. `unreal_list_tools` names every tool with a one-line summary and no schema, so
even discovery is cheap; one `unreal_enable_tools` call then brings back whatever the job needs.

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

