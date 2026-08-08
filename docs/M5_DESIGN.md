# Milestone 5 design: node/function ground-truth catalog

Status: design, verified against real engine headers. No code written yet.

## The problem this solves

A model writing Blueprint logic gets node names, pin names, and function signatures wrong
constantly. Not because it reasons badly, but because no general-purpose model was trained
specifically and reliably on any one engine version's exact Blueprint surface, and that surface is
enormous and changes between versions. Training a model per engine version is not a realistic
answer.

The bridge already runs inside the live editor with full C++ reflection access. That means it can
enumerate the actual installed engine version's real node catalog directly from the engine, which
is by definition correct for whatever version is running. No training, no scraping, no guessing.

## What was verified before designing this

All of the following was checked against the real installed engine headers, not recalled:

- `FBlueprintActionDatabase` is public in `Engine/Source/Editor/BlueprintGraph/Public/` in **both**
  UE 5.6 and UE 5.8.
- Diffing that header between 5.6 and 5.8 shows the only difference is Epic's mechanical `UE_API`
  export-macro refactor (`class BLUEPRINTGRAPH_API F...` became `#define UE_API BLUEPRINTGRAPH_API`
  plus per-method `UE_API`). Every method name, signature, and type is identical. **The catalog can
  be written once and compile against both versions with no version-specific code.**
- `BlueprintGraph` is already in `PrivateDependencyModuleNames` in `UnrealMCPBridge.Build.cs`.
  **This milestone needs no new module dependencies.**

## Where the data comes from

`FBlueprintActionDatabase` is the exact system backing the editor's own right-click "search for a
node" palette. Reading it means the catalog is not an approximation of what a human sees, it is
literally the same data.

```
FBlueprintActionDatabase::Get().GetAllActions()
  -> TMap<FObjectKey, TArray<TObjectPtr<UBlueprintNodeSpawner>>>
```

For each `UBlueprintNodeSpawner` in that registry:

| Want | Source |
|---|---|
| Node type | `Spawner->NodeClass` (a `TSubclassOf<UEdGraphNode>`) |
| Menu name, category, tooltip, keywords | `Spawner->PrimeDefaultUiSpec()` returns an `FBlueprintActionUiSpec` with `MenuName`, `Category`, `Tooltip`, `Keywords` |
| Exact pins | `Spawner->GetCachedTemplateNode()` gives a template node; enumerate its `Pins` for real pin names, types, and directions |
| Exact function params | For `UK2Node_CallFunction` spawners, walk the underlying `UFunction` with `TFieldIterator<FProperty>` + `FProperty::GetCPPType()` |

`PrimeDefaultUiSpec(UEdGraph* TargetGraph = nullptr)` matters specifically because it fills in
missing UI fields by polling a template node, so a useful spec comes back without constructing a
full `FBlueprintActionContext`.

The `TFieldIterator<FProperty>` + `GetCPPType()` pattern in the last row is already proven in this
codebase: `MCPProjectIndex.cpp` uses exactly it to extract a Blueprint's own function signatures.
M5 widens the same technique from one Blueprint's functions to every engine and game class.

Respect the editor's own visibility rules rather than inventing our own, using the permission
checks the database already exposes:

```cpp
FBlueprintActionDatabase::IsFunctionAllowed(Func, FBlueprintActionDatabase::EPermissionsContext::Node)
```

## Cost, and why the catalog must be cached

`FBlueprintActionDatabase::Get()` populates by looping over every known class. It is expensive on
first touch. This is the same cost the editor itself pays the first time you open a node menu, so
it is not avoidable, only payable once.

That makes the caching story the same shape as M3's, and it should reuse M3's proven approach:

- Build lazily on first catalog request, never at editor startup.
- Persist to `Saved/UnrealMCPBridge/nodecatalog.json`, alongside the existing `index.json`, so a
  fresh editor session skips the rebuild.
- Key the cache by engine version **and** a hash of the loaded module set, since installing a
  plugin changes the available node surface. A cache built under a different module set must be
  discarded, not trusted.
- Stay fresh incrementally via the database's own `OnEntryUpdated()` / `OnEntryRemoved()`
  multicast delegates, exactly as `FMCPProjectIndex` uses the AssetRegistry delegates. No polling,
  no full rebuild per edit.

Everything runs on the game thread, consistent with the rest of the plugin, so no locking is
needed. `FBlueprintActionDatabase` is an `FTickableEditorObject`, so it is already game-thread.

## New commands and tools

| Bridge command | MCP tool | Purpose |
|---|---|---|
| `find_node` | `unreal_find_node` | Search by intent ("spawn actor", "line trace") and get back exact node names with their pin signatures, ranked. |
| `get_node_signature` | `unreal_get_node_signature` | Given an exact node or function name, return its exact expected pins, types, and defaults. |

Ranking for `find_node` should reuse the exact-then-prefix-then-contains ordering already
implemented for `search_project`, so search behavior stays consistent across the tool surface.

## Making `add_node` fail usefully

Today `add_node` returns `function_not_found: <name> on <class>` when a function name is close but
wrong, which tells the model nothing actionable. With the catalog available, it should validate
against the catalog first and return the near-misses:

```json
{
  "ok": false,
  "error": "function_not_found: PrintSting on KismetSystemLibrary",
  "didYouMean": [
    { "functionName": "PrintString", "className": "/Script/Engine.KismetSystemLibrary" },
    { "functionName": "PrintText",   "className": "/Script/Engine.KismetSystemLibrary" }
  ]
}
```

This is the single highest-value part of the milestone. It converts the most common failure mode
from a dead end into a self-correcting one, without the model needing to have called
`find_node` first.

## Token efficiency

The catalog is large: thousands of Blueprint-callable functions across the engine, plus whatever
the game project adds. It gets the same treatment as everything else here, and the rule is
absolute:

**Never return the whole catalog.** `find_node` returns a capped, ranked hit list with compact
entries. `get_node_signature` returns exactly one node's detail. This mirrors the M1 tiered-read
strategy (list → summary → detail) rather than reinventing it.

## Open questions to settle during implementation

- **Template node cost.** `GetCachedTemplateNode()` caches, but priming a template node for every
  spawner in the database may be too slow to do eagerly for all of them. Likely answer: extract
  cheap fields (menu name, category, node class) for everything at build time, and resolve full
  pin detail lazily on `get_node_signature`, caching the result. Needs measurement against a real
  project before committing.
- **Search quality without a local model.** Substring matching over `MenuName`/`Keywords` may not
  bridge intent to node name well ("spawn a thing" versus "SpawnActorFromClass"). The optional
  local-model enrichment seam from M3 (`mcp-server/src/enrichment.ts`) is the natural place to
  improve this without adding a hard dependency or spending API tokens.
- **Scope of the first cut.** The `UFunction` reflection half is straightforward and reuses proven
  code. The `FBlueprintActionDatabase` half is more valuable but more expensive. It may be worth
  shipping the function catalog first and adding the full node palette second, so `add_node`
  validation lands earlier.

## Verification bar

Same as every milestone here, and the live step is not optional: build-verified, protocol-verified,
and live-verified in a real editor on both 5.6 and 5.8 before this is called done. The M2 live test
is the precedent for why, since it caught a duplicate-node bug that compiling and protocol testing
both missed.
