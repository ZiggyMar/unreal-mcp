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
- **Releases published**: [v0.1.0-ue5.8](https://github.com/ZiggyMar/unreal-mcp/releases/tag/v0.1.0-ue5.8)
  and [v0.1.0-ue5.6](https://github.com/ZiggyMar/unreal-mcp/releases/tag/v0.1.0-ue5.6).
- **Competitive survey** of 9 other Unreal MCP projects, including which of their ideas are worth
  adopting. See [docs/COMPETITIVE_LANDSCAPE.md](docs/COMPETITIVE_LANDSCAPE.md).

## M4: finish UE 5.6 support

The plugin compiles clean against UE 5.6 with **zero source changes** (verified by diffing all 10
plugin source files against the 5.6 test project's deployed copy: the only differences were
comment prose, since the source of truth had newer em-dash cleanup). The 5.6 build is genuine and
distinct, not a stale 5.8 artifact: `BuildId` 43139311 against 5.8's 55116800, different DLL
hashes, and the test project pins `"EngineAssociation": "5.6"`.

What remains: live-editor verification on 5.6 the same way 5.8 got it, then package and publish
`v0.1.0-ue5.6`, then write `docs/UE56_STATUS.md`.

## M5: the node/function ground-truth catalog

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
