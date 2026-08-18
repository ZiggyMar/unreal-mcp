# Live Verification: first real session against a running Editor

Date: 2026-08-08. Target: `A:\UnrealProjects\AntiVirusSquadUE58` (UE 5.8, stock launcher install),
a real ~20-Blueprint game project, not a synthetic test project.

Every milestone up to this point had been build-verified and protocol-verified, but never run
against an actual open Unreal Editor (see the "unverified" sections of `M1_STATUS.md`,
`M2_STATUS.md`, and `M3_STATUS.md`). This session closes that gap.

## What was tested, against real project data

1. **Editor loads the plugin correctly.** Output Log confirmed:
   ```
   LogPluginManager: Mounting Project plugin UnrealMCPBridge
   LogModuleManager: InternalLoadLibrary: 'UnrealMCPBridge' (...UnrealEditor-UnrealMCPBridge.dll)
   LogMCPBridge: UnrealMCPBridge: listening on 127.0.0.1:8765
   ```
2. **Read path (M1), against real data**: `ping`, `get_project_overview`, `list_blueprints`,
   `search_project`, `list_blueprint_graphs`, `find_references`, `read_blueprint_graph_summary`
   all returned correct, sane results against the real project: 19 real Blueprints (e.g.
   `AVS_GameInstance`, `BP_Vacuum`, `WB_MainMenu`), correct parent classes, correct graph/node
   counts (134+ graphs, 1200+ nodes project-wide).
3. **Write path (M2), live**: `create_blueprint` → `add_node` (Event) → `compile_blueprint` →
   `save_blueprint` all succeeded against the real editor, producing a real, saved, compiling
   Blueprint asset (`/Game/_MCPTest/BP_MCPLiveTest2`). Then `add_node` (CallFunction: PrintString)
   → `set_pin_default_value` → `connect_pins` → `compile_blueprint` → `save_blueprint` produced a
   real, working `BeginPlay → Print String` graph. The screenshot below is that exact graph, opened
   in the real Blueprint editor.
4. **Index freshness (M3), live, without restarting the editor**: `get_project_overview`'s
   `blueprintCount` incremented immediately after `create_blueprint`, and `search_project` found
   the new Blueprint by name immediately, confirming the `IAssetRegistry` delegate-driven
   incremental index actually works, not just compiles. This was the single highest-priority
   unverified claim across all three milestones.

## Bug found and fixed during this session

`add_node` with `nodeType: "Event"` created a **duplicate** override-event node instead of
reusing an existing one. This only shows up against a real editor: new Actor-derived Blueprints
come with pre-populated, disconnected stub event nodes (`BeginPlay`, `ActorBeginOverlap`, `Tick`)
that don't exist in a synthetic/mocked graph. The first live `add_node(eventName="ReceiveBeginPlay")`
call created a second `Event BeginPlay` node alongside the existing one instead of recognizing it.

Fixed in `MCPCommandHandler.cpp`'s `HandleAddNode`: before creating a new override-event node, the
graph's existing nodes are checked for a `UK2Node_Event` with a matching `EventReference`. If one
exists, its id is returned with `alreadyExisted: true` instead of creating a duplicate, matching
how the real Blueprint editor behaves when you re-add an event that's already there. Verified fixed
via Live Coding-style rebuild + relaunch + a repeat test showing the node count staying at 3 (not 4)
with `alreadyExisted: true` in the response.

## Screenshot

![Live Blueprint graph, created entirely via MCP tool calls](images/live_blueprint_graph.png)

This is the real Unreal Editor, real Blueprint editor, showing `BP_MCPLiveTest2`'s `EventGraph`
after the tool calls above, not a mockup. The greyed-out `ActorBeginOverlap`/`Tick` nodes are
UE's own default stub events, unconnected and correctly reported as disabled by the engine itself.

## What's still not covered

- Only `create_blueprint`, `add_node` (Event + CallFunction), `set_pin_default_value`,
  `connect_pins`, `compile_blueprint`, `save_blueprint`, and all of M1/M3's read commands have run
  live. `add_variable`, `remove_node`, `read_blueprint_node_detail`, and `add_node` with
  `CustomEvent`/`VariableGet`/`VariableSet` have not yet been exercised against a live editor.
- Only tested on UE 5.8. UE 5.6 build/live-test still outstanding.
- Only tested against one project. Behavior against Blueprints with more exotic node types
  (macros, timelines, interfaces with default implementations) is unverified.

## Two engines means two builds

This plugin supports UE 5.6 and 5.8. Keeping both honest used to be a human remembering to do the
second one, and that failed three times - each time producing a failure that looked like broken code
and was really a binary older than the change:

- a guard that "could not fire on a fresh project" (it could; the binary predated it)
- `add_variable did not report the parent class` (it did; built for 5.6, exercised on 5.8)
- and an hour spent on a hang that turned out to be a modal dialog on a force-killed editor

Each one sent the investigation into the wrong codebase, which is the expensive part. So it is now
impossible to do quietly.

### `npm run build:engines`

Syncs the plugin source into every configured project and builds against every engine, and
**refuses to report success unless every target actually built** - a partial success reported as
success is the original problem restated. It requires both a zero exit code and `Result: Succeeded`
in the output, because trusting an exit code alone is its own genre of bug.

Targets live in `mcp-server/build-targets.json`, since engine and project paths are specific to a
machine:

```json
{
  "targets": [
    { "name": "5.6", "engine": "M:/Unreal/UE_5.6", "project": "A:/.../Test56.uproject" },
    { "name": "5.8", "engine": "F:/UE_5.8",        "project": "A:/.../Real58.uproject" }
  ]
}
```

### The binary says how old it is

The editor cannot tell you its plugin is stale, but the plugin can: `ping` now reports
`pluginBuiltAt`, stamped at compile time.

`live-verify` checks that before running anything and **fails outright** if the running plugin is
older than the newest source file. A warning at the top of a hundred passing checks is a warning
nobody reads; refusing to start is a sentence somebody acts on:

```
the running plugin was built Aug 18 2026 09:14:02, which is older than the newest
source. This editor is not running the code you just wrote - rebuild for 5.8 and
restart.
```

There is a minute of slack, because the compiler stamps each translation unit as it reaches it, so
a build that began just before the last save can still contain the change.

`npm run check:fresh` runs the same check on its own.

### Why this is in a project about Blueprints

It is not really about engine versions. It is the same rule the rest of this project keeps
rediscovering: **a check that can be skipped by a person having a bad day is not a check.** The
parity guard, the docs guard, the profile budget and this all exist for the same reason, and each
was added after the thing it prevents had already happened at least once.
