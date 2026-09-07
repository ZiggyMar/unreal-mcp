# Teardown: Epic's first-party MCP plugin in UE 5.8

Read from the shipped source in a stock launcher install of UE 5.8, not from the documentation or
the launch coverage. Both of those understate it substantially.

```
Engine/Plugins/Experimental/ModelContextProtocol   ~6,300 lines, protocol layer only
Engine/Plugins/Experimental/ToolsetRegistry        registration, schema generation, agent skills
Engine/Plugins/Experimental/Toolsets/*             27 plugins, ~800 tool functions
```

The reason the press called it "deliberately minimal" is that `ModelContextProtocol` on its own
really is minimal — it is just the server. Every capability lives in the 27 sibling toolset plugins,
and those are not minimal at all.

## The shape of it

| | Epic | Us |
|---|---|---|
| Transport | HTTP + SSE, in-editor, `127.0.0.1:8000/mcp` | stdio MCP server → TCP bridge into the editor |
| Auth | none, loopback-only | none, loopback-only |
| Threading | game thread, serial | game thread via Ticker, serial |
| Tool count | ~800 across 27 toolsets | 140 |
| Context strategy | Tool Search Mode: `tools/list` returns 3 meta-tools | profiles (`minimal`/`core`/`lazy`/`full`) + build modes |
| Engine versions | 5.8 only | 5.6 and 5.8 from one codebase |
| Install | enable several engine plugins | one editor plugin, stock launcher install |

## What they have that is better than ours

Ranked by how much it would improve this project, not by how impressive it is.

### 1. A round-trip Blueprint graph DSL — `blueprint_dsl.py`, 2,530 lines

The single most important thing in the whole plugin, and the one that lands squarely on our own
thesis. An S-expression IDL for Blueprint graphs with a genuine round trip:

- `read_graph_dsl(graph)` decompiles an existing graph to DSL text
- `write_graph_dsl(graph, code)` transpiles DSL text into nodes and compiles
- `get_graph_dsl_docs()` returns the grammar

```lisp
(event BeginPlay
  (bind meshActor (Utilities|Casting|CastToStaticMeshActor :Object spawnedActor)
    (:then
      (bind comp (Class|StaticMeshActor|GetStaticMeshComponent :self meshActor))
      (Components|StaticMesh|SetStaticMesh :self comp :NewMesh "/Engine/BasicShapes/Cube.Cube"))
    (:CastFailed)))
```

The grammar covers `event`, `fn`, `bind`, `if`/`elif`/`else`, `for` (range and for-each), `while`,
`switch`, `break`, `return`, arithmetic and comparison operators, vector/rotator/transform accessors,
and named exec continuations for latent and task nodes with auto-derived data-output variables.

**Why it beats what we do.** Our writes are JSON node specs plus a connection list; our reads are
tiered summaries and node detail. A DSL is better at both ends for the same reason: control flow is
expressed as control flow rather than as a wiring diagram the model has to hold in its head, and the
same text is both the read format and the write format, so an edit is "read, change one line, write
back" rather than "read, work out which node ids to remove, add new ones, rewire". It is also
cheaper per graph than anything we currently emit.

Supporting tools in the same toolset: `get_node_depths`, `get_subtree`, `get_connected_subgraph`,
`get_node_connections`, `find_node_types`, `get_node_type_pins`, `arrange_nodes`.

### 2. `execute_tool_script` — cross-tool transactions

Runs a Python script against the toolset APIs inside a `_TransactionalScriptRunner`: many tool calls,
one round trip, one undo entry, all-or-nothing. Paired with `get_execution_environment`, which
describes the available modules, and with per-tool output schemas so the script can pass results
between calls.

We have this for graph building only — `unreal_build_graph` is genuinely atomic, opens one
`FScopedTransaction`, and cancels the lot on any failure. What we do not have is the same guarantee
across *different* tools: creating a Blueprint, adding a component, adding variables and building a
graph is four transactions, and a failure at step three leaves the first two applied.

### 3. Structured results — `outputSchema` and `structuredContent`

Their server advertises an `outputSchema` per tool and returns `structuredContent`, generated from
the UFUNCTION's real return type with field-level descriptions. Their own guidance is blunt about the
alternative: free-form strings carry no schema and force the client to parse them.

Better than ours in fidelity, and rejected anyway after measuring it — see the Options section. The
SDK makes `structuredContent` mandatory once `outputSchema` is declared and still requires `content`,
so the payload doubles. Their design assumes a client that parses structured output; ours assumes a
model reading the JSON directly, and it already gets it.

### 4. Image results — closed-loop visual verification

`MakeImageResult` plus `Screenshot`, `CaptureViewport`, `CaptureAssetImage`, `Snapshot`.

**Not a gap.** An earlier revision of this line said "we have no image path at all", which was
written against a stale checkout and was wrong: `unreal_take_screenshot` already returns a proper MCP
`type: "image"` content block with a base64 PNG, downscaled by `maxLongEdge`. What Epic has that we
do not is the per-asset and per-widget captures (`CaptureAssetImage`, `Snapshot`) rather than the
viewport, and those are reachable through `unreal_epic` when their plugin is running.

### 5. Agent Skills served from the server

`UAgentSkill` objects — a description and an instructions body — registered from C++ or Python
(`@agent_skill`), shipped next to the tools. `EditorToolset` ships `blueprint_basics`,
`material_basics`, `default_outdoor_lighting`, `unreal_skill_best_practices`.

We have the same idea already in `unreal_handbook` and `unreal_recipes`; theirs is better only in
that guidance ships with each toolset rather than centrally.

### 6. Coverage in domains we do not touch

Niagara, PCG, Gameplay Ability System, StateTree, MVVM, UMG, Sequencer and anim layers, Chaos Cloth,
MetaHuman, Data Registry, Gameplay Tags, Game Features, Live Coding, plugin management, config
settings, semantic asset search (`FindSimilar`), and Slate UI driving (`Click`, `Type`, `Hover`,
`FillForm`, `WaitFor`) so an agent can operate editor UI that has no scripting API.

This is not a gap to close by porting. It is a reason to consider delegating.

### 7. `GenerateClientConfig`

Writes client config files instead of printing them, with per-client descriptors for path and root
key, JSON upsert that preserves existing entries, and TOML written once because TOML cannot be
safely upserted without a parser.

**Adopted.** See `mcp-server/src/clientConfig.ts` and `--install-config`.

## What is still ours

- **5.6.** They have no 5.6 story at all.
- **The persistent project index.** No `MCPProjectIndex` equivalent: no incrementally updated,
  disk-cached index of Blueprints, functions, variables and cross-asset references, and no
  `find_references`. Their reads are per-asset; ours answer project-level questions.
- **Everything aimed at a weak model.** `didYouMean` near-misses, profiles that hide the wrong path
  rather than every path, build modes, quality review attached to a write, `unreal_doctor`. Their
  plugin exposes the engine faithfully and leaves competence entirely to the client.
- **Install footprint**, and no dependency on an Experimental plugin whose APIs Epic says may change
  at any time.

## Options, ranked

1. ~~**Adopt the DSL shape.**~~ **Done.** `mcp-server/src/graphDsl.ts` decompiles a graph summary to
   S-expressions; `mcp-server/src/graphDslCompile.ts` parses the same syntax and lowers it to a
   `unreal_build_graph` payload. Exposed as `format: "dsl"` on `unreal_explain_graph` and a `dsl`
   parameter on `unreal_build_graph`, folded into existing tools rather than added as new ones, and
   costing 110 standing tokens after two rounds of trimming - argued for in `measure-profiles.mjs`
   rather than raised silently. No bridge change was needed: `read_blueprint_graph_summary` already
   takes `withPinValues`. Measured at 302 characters against 2,045 for the same graph as
   node-and-pin structure.
2. ~~**Add `outputSchema`/`structuredContent`.**~~ **Rejected, with a measurement.** The MCP SDK
   makes `structuredContent` mandatory once `outputSchema` is declared, and `content` is still
   required, so the data ships twice. That is +100% on every response to hand a duplicate to a model
   that already reads the JSON in `content`. Epic can afford it - in-process HTTP, small structs, no
   frugality rule; a server whose stated hard requirement is token frugality cannot.
3. ~~**Extend the transaction boundary across tools.**~~ **Done, with one honest limit.** `run_batch`
   re-enters `Dispatch` per step inside one `FScopedTransaction`; UE's buffer nests by reference
   counting, so all fifty existing handlers collapse into one undo entry unchanged. It is NOT
   all-or-nothing: `Cancel` discards the undo record without reverting mutations, and automatic undo
   was rejected as unsafe (no title guard, and a transient transaction is already popped, so it would
   revert the human's last action). `open_level`, `create_level` and `delete_asset` are refused as
   steps because they reach `UTransBuffer::Reset`, which would empty the whole undo buffer.
4. ~~**Delegate to their plugin for the domains we do not cover.**~~ **Done.** `unreal_epic` speaks
   MCP as a client to `127.0.0.1:8000/mcp` and mirrors Epic's three meta-tools, so the ~800 tools are
   reachable without one schema entering the context window. It lives in a deferred group, so it
   costs nothing until asked for - which matters because their plugin is opt-in and does not
   auto-start, making "not running" the normal case. The wire contract was read from their source and
   adversarially verified, but is **not** yet exercised against a live editor.
5. ~~**Image results.**~~ **Already had it.** `unreal_take_screenshot` returns an MCP image content
   block; the claim that it did not was a stale-checkout artefact. Epic's per-asset and per-widget
   captures remain theirs, and are reachable through `unreal_epic`.
