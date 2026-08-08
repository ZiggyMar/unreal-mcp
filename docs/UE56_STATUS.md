# UE 5.6 support status (Milestone 4)

Last updated: 2026-08-08

Status: **complete and live-verified.** Released as
[v0.1.0-ue5.6](https://github.com/ZiggyMar/unreal-mcp/releases/tag/v0.1.0-ue5.6).

## TL;DR

- **The plugin source needs zero changes for UE 5.6.** The same source that builds for 5.8 builds
  for 5.6. Verified by diffing all 10 plugin source files, not assumed.
- **One real bug had to be fixed**, and only live verification could have found it: the `.uplugin`
  hard-pinned `EngineVersion` to `5.8.0`, which every build check happily ignored but the runtime
  plugin loader did not.
- **Live-verified against a real running UE 5.6 editor: 21 of 21 checks passed**, including the
  full write round trip and the incremental index staying fresh with no editor restart.
- Engine used: `M:\Unreal\UE_5.6`, reporting `5.6.0-43139311+++UE5+Release-5.6`.
  Test project: `A:\UnrealProjects\UnrealMCPTest56` (fresh minimal project, not a duplicate of the
  5.8 game project, whose content is already 5.8-serialized and unsafe to open in 5.6).

## The bug live verification caught

The `.uplugin` contained:

```json
"EngineVersion": "5.8.0",
```

UnrealBuildTool does not consult that field. As a result:

- `RunUAT BuildPlugin` against 5.6 succeeded.
- A full editor-target build against the 5.6 test project succeeded.
- The compiled DLL was correct and carried the right `BuildId`.

Every build-level signal said 5.6 support worked. But `FPluginManager` **does** consult
`EngineVersion` at load time, so opening the project produced:

```
LogPluginManager: Warning: Plugin 'UnrealMCPBridge' requires engine version '5.8.0'
and may not be compatible with the current engine version '5.6.0-43139311+++UE5+Release-5.6'
```

and the editor stopped on a modal incompatibility dialog. The bridge never started, and the
process sat idle at 1.7s CPU until the dialog was dismissed.

**The lesson, restated because it keeps proving itself: compiling cleanly is not the same as
loading cleanly.** This is the second time a live-editor pass has caught something no amount of
compiling or protocol testing would have (the first was `add_node` duplicating an already-present
override-event node, in M2).

**Fix:** removed `EngineVersion` from the source `.uplugin` entirely rather than changing it to
`5.6.0`. Pinning a single version is wrong for a plugin that deliberately targets both 5.6 and 5.8.
`RunUAT BuildPlugin` stamps the correct `EngineVersion` into each packaged release automatically,
so the released 5.6 zip correctly declares `5.6.0` and the 5.8 zip declares `5.8.0`, while the
source itself carries no constraint.

## Verification performed

### 1. Source equivalence between 5.6 and 5.8

All 10 plugin source files (`*.cpp`, `*.h`, `*.cs`, `*.uplugin`) were compared between the repo
source of truth and the 5.6 test project's deployed copy. Only 3 differed, and every difference was
comment prose (the source of truth had newer em-dash cleanup). **No functional difference, and no
5.6-specific code path exists or is needed.**

### 2. Isolated plugin package build

```
M:\Unreal\UE_5.6\Engine\Build\BatchFiles\RunUAT.bat BuildPlugin ^
  -Plugin="A:\UnrealProjects\UnrealMCPTest56\Plugins\UnrealMCPBridge\UnrealMCPBridge.uplugin" ^
  -Package="F:\rb\56" -TargetPlatforms=Win64
```

`Result: Succeeded`, `BUILD SUCCESSFUL`, `ExitCode=0`. All five translation units compiled and
linked cleanly, first attempt, in 2m31s. Run from a clean output directory, not incrementally.

### 3. Editor-target build against the test project

`Result: Succeeded`, exit code 0, 727 actions, ~19 minutes. The plugin itself finished at action
438; the remaining actions were the MetaHuman plugin suite, which this 5.6 install builds from
source and which is unrelated to this plugin.

### 4. Build genuinely distinct from the 5.8 build

Not a stale 5.8 artifact:

| | UE 5.6 | UE 5.8 |
|---|---|---|
| `BuildId` in `UnrealEditor.modules` | 43139311 | 55116800 |
| DLL MD5 | 6A922FA2BB7EB07AD35A5605509F35ED | 20D13B5FE6E35B4C41FFD47E05E5F2CD |
| Project `EngineAssociation` | 5.6 | 5.8 |

The 5.6 `BuildId` matches the engine's own reported changelist (`5.6.0-43139311`).

### 5. Live editor verification

Editor opened on the real project, and the log confirmed the bridge started:

```
LogMCPBridge: UnrealMCPBridge: listening on 127.0.0.1:8765
```

A verification client then spoke the bridge's line-delimited JSON protocol **directly over the
loopback socket**, deliberately bypassing `mcp-server`, so that any failure would be unambiguously
the C++ plugin rather than the TypeScript translator. Parameter and response field names were read
out of `MCPCommandHandler.cpp` and `MCPProjectIndex.cpp` rather than guessed.

**Result: 21 of 21 passed.**

| Area | Checks |
|---|---|
| Liveness | `ping` returns the expected plugin identity and protocol version |
| Index build | `get_project_overview` forces the first build (`EnsureBuilt` to `LoadFromDisk` miss to `RebuildFull` to `SaveToDisk`) |
| Reads | `list_blueprints` on an empty project returns a clean empty list, not an error |
| Write round trip | `create_blueprint`, `add_node` (Event), `add_node` (CallFunction), `connect_pins`, `set_pin_default_value`, `add_variable`, `compile_blueprint` (0 errors, `UpToDate`), `save_blueprint` |
| M2 regression guard | Re-adding the same override event returns `alreadyExisted: true` rather than duplicating the node |
| Tiered reads | `list_blueprint_graphs`, `read_blueprint_graph_summary` (4 nodes), `read_blueprint_node_detail` with full pin data |
| **Incremental index** | `search_project` finds the newly created Blueprint **and** a newly added variable with no editor restart; `blueprintCount` grew 0 to 1 |
| References | `find_references` returns structured referencer/dependency counts |
| Error handling | A bad function name returns a structured `function_not_found` error, and the editor stays responsive afterward |

The created Blueprint persisted to disk as a real 32,465-byte
`Content/_MCPTest56/BP_Verify56.uasset`, so the write path produced actual serialized content
rather than only in-memory state.

The incremental-index checks matter most. That was the highest-risk unverified claim in the project
when M3 was written, and it now holds on both engine versions.

## Leftover test content

`A:\UnrealProjects\UnrealMCPTest56\Content\_MCPTest56\BP_Verify56` is left in place as evidence of
the verified round trip, matching the precedent set by the 5.8 test project's `_MCPTest` folder.
It is an isolated scratch folder in a throwaway project.

## Known cosmetic issue, not a blocker

`RunUAT BuildPlugin` drops `EnabledByDefault` from the packaged `.uplugin`. Users installing the
prebuilt release may need to enable the plugin explicitly via Edit > Plugins or list it in their
`.uproject`. This is pre-existing behavior and affects the already-published 5.8 release
identically, so it is not a 5.6 regression. Both releases' notes call it out.
