# Roadmap

Where the project is and where it goes next, roughly in the order things make sense. The
milestone framing here comes from [HANDOFF.md](HANDOFF.md), which has the fuller rationale.

## The goal this is all working toward

Give the assistant a one-line feature request and have it understand the project well enough,
across every Blueprint, Map/Level, and GameMode, to implement that feature the way you would have
built it yourself: clean, commented, organized Blueprint graphs, not spaghetti. Two things stand
between here and there, and they are what the milestones below attack: models burn their whole
context window trying to read an existing project's Blueprints, and no general-purpose model
reliably knows UE's exact node names, pin names, and function signatures.

## Done

- **M1: tiered read-only Blueprint introspection.** List blueprints → list a blueprint's graphs →
  read a graph summary → read one node's full detail, so a small question never costs a whole
  graph's raw data. See [docs/M1_STATUS.md](docs/M1_STATUS.md).
- **M2: write/edit commands.** `create_blueprint`, `add_node`, `connect_pins`,
  `set_pin_default_value`, `remove_node`, `add_variable`, `compile_blueprint` (structured
  errors/warnings), `save_blueprint`. See [docs/M2_STATUS.md](docs/M2_STATUS.md).
- **M3: persistent project index.** `FMCPProjectIndex` indexes every Blueprint's functions,
  variables, graphs, and interfaces once, caches to `Saved/UnrealMCPBridge/index.json`, and stays
  fresh via `IAssetRegistry` delegates rather than polling. Backs `search_project`,
  `find_references`, and `get_project_overview`. See [docs/M3_STATUS.md](docs/M3_STATUS.md).
- **Live-editor verification on UE 5.8.** The whole pipeline was exercised against a real running
  editor with a real ~20-Blueprint game project: reads returned correct data, a full write round
  trip produced a working graph, and the incremental index picked up a newly created Blueprint
  without an editor restart. It also caught a real bug that compiling and protocol testing could
  not (`add_node` duplicating an already-present override-event node). See
  [docs/LIVE_VERIFICATION.md](docs/LIVE_VERIFICATION.md).
- **M4: UE 5.6 support, live-verified and released.** The plugin source needs zero changes for 5.6;
  the same source builds for both. One real bug had to be fixed to get there, and only live
  verification could have found it: the `.uplugin` hard-pinned `EngineVersion` to `5.8.0`, which
  every build check ignored but the runtime plugin loader did not, leaving the 5.6 editor stuck on
  a modal incompatibility dialog before the bridge could start. 21 of 21 live checks pass on 5.6.
  See [docs/UE56_STATUS.md](docs/UE56_STATUS.md).
- **M5 first increment: the node/function ground-truth catalog.** `FMCPNodeCatalog` reads the
  running engine's real Blueprint-callable function surface via reflection: 12,402 functions on
  5.6 and 15,775 on 5.8, built in about 0.1s. Backs `find_node` and `get_node_signature`, and makes
  `add_node` return `didYouMean` near-misses instead of a bare `function_not_found`. Live-verified
  39/39 on 5.6 and 40/40 on 5.8. See [docs/M5_STATUS.md](docs/M5_STATUS.md).
- **Persistent node ids, undo transactions, and control-flow nodes.** Node ids are the node's
  serialized `NodeGuid` (removals no longer invalidate other ids); every write runs inside a named
  editor transaction so a human can Ctrl+Z the agent's work; and `add_node` places `Branch`,
  `Sequence`, `Cast`, and standard-library macros, verified by building and compiling a real
  conditional graph through the bridge alone. Live-verified on both engines.
- **Releases published**: [v0.2.0-ue5.8](https://github.com/ZiggyMar/unreal-mcp/releases/tag/v0.2.0-ue5.8)
  and [v0.2.0-ue5.6](https://github.com/ZiggyMar/unreal-mcp/releases/tag/v0.2.0-ue5.6)
  (v0.1.0 releases remain available).
- **Competitive survey** of 9 other Unreal MCP projects, including which of their ideas are worth
  adopting. See [docs/COMPETITIVE_LANDSCAPE.md](docs/COMPETITIVE_LANDSCAPE.md).

- **The token cost of using this server, measured end to end and guarded.** This was the largest
  gap in the project and it was invisible because nothing measured it. Tool definitions cost 25,477
  tokens on every request; the `search` profile stands four tools at ~1,203 and hands back real typed
  schemas on demand. Worse was hiding in the replies: `read_blueprint_summary` on a real 807-node
  graph returned **126,477 tokens** — 63% of a 200k window in one call, from a project whose premise
  is that a model never sees a raw engine dump. Now **2,121**, and **700** when filtered to what was
  actually asked for, with the full graph one parameter away.
  `list_blueprints` 15,149 → 4,508 (472 searching by name), `explain_graph` 13,294 → 3,804,
  `list_tools` 5,523 → 338, `enable_tools` 700 → 71. Standing cost before a word is typed: 30,111 →
  **2,373**. Four unbounded reads, bounded in four different ways, because the
  breakdown of each said something different. Guarded by `check:profiles` and `check:replies` in CI,
  and by `measure:reads` against a live editor.
- **The server tells the model how to work.** MCP's `instructions` field was empty, so call order and
  the exact strings no model can recall (`self`, `then_0`, `Exec`) arrived only via a prompt the
  model had to choose to pull, or via a failed call. It is profile-aware, and on `search` it explains
  why only four tools are listed.
- **Data Tables are a first-class surface**: read, add, change (`set_data_table_row`) and delete
  (`remove_data_table_row`, which returns what it deleted so the delete is reversible). Plus
  `check_data_tables`, which finds rows whose asset reference is empty while sibling rows fill it in.
  All of it exists because a shipped build lost most of its enemy spawns to exactly that, and the
  audit that answers "where are the bugs" read only Blueprint graphs and looked straight past it.
- **The C++ half of a project is reachable.** `find_source` maps the modules and locates the file and
  line that declares a symbol, returning locations rather than contents — every client that drives
  this already reads files better than a tool wrapper could; what none of them knew was *where*.
- **A model can look at the viewport.** `screenshot` returns a downscaled frame, because there is a
  class of question — did that enemy move, did the widget land right — that text cannot settle.
- **Compile errors name the node and the pin** they are about, instead of prose naming a node title
  that occurs nine times in the graph.
- **`verify_feature`**: one call that compiles and reviews every asset written this session, taken
  from the change journal rather than from memory, and sweeps Data Tables too.
- **`find_orphans`**: actors that lost the partner they depend on, paired by position rather than by
  the reference — because the reference is the broken thing. Found a real one in a shipped level.


## Where the ceiling actually is

Everything above is about reading and writing **assets**. That is now good: a bug described in plain
text gets found, changed, and re-verified without a human opening the editor, across Blueprints, Data
Tables, Data Assets and C++.

The remaining gap is a different kind. Ranked by how much each one costs, measured against real
requests rather than guessed:

1. **Watching the game run.** Written, not yet proven. `watch_runtime` samples variables on live
   actors during PIE in every world, labelled by net role, and `pie_status` now reports that
   topology - so "Authority: 0 → 47, Client0: 0 → 0" is a replication bug observed rather than
   argued. It compiles on 5.8 and **has not yet been run against a live PIE session**, which is the
   only thing that would make it real. Until then it is a claim, and this file should keep saying so.
2. **Driving the game.** Sampling state is half of it. Nothing here can press a key, click a widget,
   or move a character, so any bug that only appears after an interaction still needs a person to
   reproduce it. This is the single largest remaining item and it is what separates "verifies its own
   fix" from "gets you to the last step".
3. **Memory between sessions.** Every session re-derives the project from scratch. Which system is
   live and which was abandoned, what was decided and why - that currently survives only in documents
   written by hand and re-read on purpose (`docs/AVS_SKIN_SYSTEM.md` exists because getting this
   wrong cost a whole iteration of work on a dead system). A lead programmer's real value is
   accumulated context, and none of it is accumulating.
4. **Subsystems with no coverage at all:** Gameplay Ability System, State Trees, EQS, AnimGraph
   *authoring* (state machines can be read, not built), material node graphs beyond parameters, and
   level geometry.

The honest summary: for "here is a bug, fix it" and "add this to what exists", the loop closes. For
anything whose answer is "run it and see", it stops one step short.


## M4: finish UE 5.6 support

The plugin compiles clean against UE 5.6 with **zero source changes** (verified by diffing all 10
plugin source files against the 5.6 test project's deployed copy: the only differences were
comment prose, since the source of truth had newer em-dash cleanup). The 5.6 build is genuine and
distinct, not a stale 5.8 artifact: `BuildId` 43139311 against 5.8's 55116800, different DLL
hashes, and the test project pins `"EngineAssociation": "5.6"`.

What remains: live-editor verification on 5.6 the same way 5.8 got it, then package and publish
`v0.1.0-ue5.6`, then write `docs/UE56_STATUS.md`.

## M5 remainder: the native node palette

**The function half of this is done and shipped** (see Done above and
[docs/M5_STATUS.md](docs/M5_STATUS.md)). What remains is the second, more valuable and more
expensive half: enumerating native `UK2Node` types (branches, loops, casts, math operators) via
`FBlueprintActionDatabase` / `UBlueprintNodeSpawner`, which back the editor's own right-click
palette. The verified design path for that is in [docs/M5_DESIGN.md](docs/M5_DESIGN.md).

One design assumption already fell: the shipped catalog needs no on-disk cache, because the
reflection walk costs about 0.1s. Whether that holds for the action-database half is an open
question, since priming template nodes for every spawner is a different cost profile.

The original framing of the problem, kept because it still explains why this matters most:

The largest unsolved problem, and the one that most directly limits how useful this is in
practice. No general-purpose model reliably knows the exact node names, pin names, and
input/output signatures across UE's enormous Blueprint surface, and training a model specifically
on one engine version is not a realistic answer.

The bridge already runs inside the live editor with full C++ reflection access, so it can
enumerate the actual installed engine version's real node catalog directly from the engine, which
is by definition correct for whatever version is running:

- Every `UFunction` marked `BlueprintCallable`/`BlueprintPure`/`BlueprintImplementableEvent`
  across every loaded `UClass`, with exact parameter names, types, defaults, and pin categories.
  `MCPProjectIndex.cpp` already does a narrower version of this reflection walk for a Blueprint's
  own functions; this widens it to every engine and game class.
- Every native `UK2Node` type and what it exposes. The harder but more valuable target is
  `FBlueprintActionDatabase` / `UBlueprintNodeSpawner`, which back the editor's own
  right-click node palette. Querying that produces literally the same catalog the human-facing UI
  uses, which is the strongest ground truth available.
- New tools: `unreal_find_node` (search by intent, e.g. "spawn actor", and get the exact node name
  and pin signature) and `unreal_get_node_signature` (given an exact name, return its exact pins).
  `add_node` should then validate against this catalog and fail fast with a suggestion instead of
  surfacing a cryptic engine error when a function name is close but wrong.

This catalog is large (thousands of Blueprint-callable functions), so it needs the same
token-efficiency treatment as everything else here: index it, cache it, make it searchable, and
never dump the whole thing into a response.

## M6: expand context scope beyond Blueprints

**Partly done.** Data Tables, level actors and native C++ are reachable now (see Done above).
What is still Blueprint-only is `FMCPProjectIndex` itself: Levels, GameMode/GameState class
assignments and project settings are read live per call rather than indexed, so they cannot be
searched the way Blueprints can.

`FMCPProjectIndex` currently indexes only Blueprint assets. "Understands the project better than
you do" requires more than graph structure: Level/World assets (actors placed in a level, their
classes and key properties), GameMode/GameState/PlayerController class assignments, and probably
Data Tables and key project settings such as input mappings.

## M7: enforce AAA-quality output, not just functional correctness

The write commands currently produce functionally correct but visually bare graphs: no comment
boxes, no node comments, default cosmetic positions. Blueprints support comment boxes, per-node
comments, function categories and tooltips, and meaningful variable grouping. A future milestone
should make the tools (or a higher-level "build this feature well" wrapper) use these
deliberately: sensible node layout rather than everything at the origin, comment boxes grouping
related logic, and meaningful naming as the graph is built rather than after.

## M8: the actual agentic loop

**Partly done, and the remaining half is not a tool.** The loop now has its missing pieces:
`plan_feature` to start, `build_graph` to author, compile errors that name the node when it goes
wrong, `verify_feature` to answer "is this actually finished", and `screenshot` to look at the
result. What has not been done is running an assistant unsupervised across a real feature and
measuring where it still fails - which, as the note below already said, costs nothing to attempt
and should happen before any "plan and execute" meta-tool is built.

Once M5 and M6 exist, "give a one-line feature request, get a correct and complete implementation
back" becomes a question of good agent behavior on top of solid tools rather than a new
capability. Worth trying the assistant unsupervised against M1 through M7's tools first, since
that costs nothing to attempt, before building a higher-level "plan and execute a feature"
meta-tool.

## Ideas from the competitive survey, slotted in

[docs/COMPETITIVE_LANDSCAPE.md](docs/COMPETITIVE_LANDSCAPE.md) ends with ten adoptable patterns
and the milestone each belongs to. The ones most worth remembering here:

- **Gateway or namespaced tool pattern** (ChiR24, GenOrca) to keep the tool catalog small as the
  tool count grows. This addresses a different context-efficiency axis than the tiered reads do,
  and both are worth having.
- **Bundled "recommended agent workflow" doc or Skill**, so the calling agent gets the right
  tool-call order without rediscovering it each session.
- **Blueprint complexity/lint pass**, which builds directly on the per-graph node-type histogram
  M3 already computes.
- **In-editor status UI** so a human working alongside the agent can see bridge state without
  tailing logs.
- **Headless / editor-not-running mode**, which the current architecture does not support at all.

## Distribution

- **Fab (Epic's marketplace)**: free listing, once live-verified. Code plugins are distributed as a zipped plugin folder; see [Fab's asset structure requirements](https://dev.epicgames.com/documentation/fab/asset-file-format-and-structure-requirements-in-fab?lang=en-US) and [publishing for free download](https://dev.epicgames.com/documentation/fab/publishing-assets-for-sale-or-free-download-in-fab). Needs an Epic developer account and goes through Fab's review, so budget time for that.
- **MCP registries / awesome-mcp-servers lists**: submit once the repo has a working demo, for organic discovery.

## Visibility

- Launch posts (Show HN, r/unrealengine, X): drafted once there's something real to demo, reviewed and posted by hand, not automated. No bought/farmed engagement (see project conventions).
- [Claude for Open Source Program](https://claude.com) application: realistic path is the "doesn't quite fit the exact thresholds, tell us about the gap it fills" route, once there's real usage/traction to point to, not before.
