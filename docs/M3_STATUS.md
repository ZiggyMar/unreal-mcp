# Milestone 3 Status — Project-wide index, search, references, local-model enrichment

Last updated: 2026-08-07

> **Update 2026-08-08**: the highest-priority open question from this document — whether the
> incremental index actually stays fresh via AssetRegistry delegates, without restarting the editor
> — has been tested against a real live editor and **confirmed working**. See
> [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md). Everything below reflects the pre-live-test state.

## TL;DR

- **The persistent, incrementally-updated project index compiles successfully against
  the real stock UE 5.8 install**, verified the same two ways as M1/M2 (isolated
  `RunUAT BuildPlugin` + direct build against `AntiVirusSquadUE58`). Both succeeded on
  the **first attempt**, despite this milestone touching the riskiest new API surface
  yet: `IAssetRegistry`'s `OnAssetAdded`/`OnAssetRemoved`/`OnAssetRenamed`/
  `OnAssetUpdated`/`OnFilesLoaded` delegates, `GetReferencers`/`GetDependencies`, and
  `FProperty::GetCPPType()` via `TFieldIterator`.
- **All 3 new MCP tools (16 total: 5 M1 + 8 M2 + 3 M3) verified end-to-end over real MCP
  stdio**, including a dedicated set of tests for the local-model enrichment seam
  covering all three states: enrichment disabled (default pass-through), enrichment
  enabled and working, and enrichment enabled but the local model unreachable (graceful
  degradation — confirmed the tool still returns clean results, just without summaries).
- **Not verified: any of this has ever run against a live Unreal Editor.** Same gap as
  M1 and M2, restated here because it now applies to the feature that matters most for
  the user's actual stated problem — losing track of what's connected to what across a
  large project. The index's *shape* is provably correct (compiles, round-trips JSON
  correctly); whether `RebuildFull()` actually produces sensible data for
  `AntiVirusSquadUE58`'s real content, and whether the AssetRegistry delegates actually
  fire and keep it fresh as the user edits, is **completely unverified** pending that one
  manual step. See "Manual steps" below for exactly how to check this first.

## What's new

### C++ plugin — project index (`MCPProjectIndex.h`/`.cpp`, new files)

Location (source of truth): `F:\!Projects\UnrealMCP\UnrealMCPBridge\Source\UnrealMCPBridge\`
Deployed/build copy: `A:\UnrealProjects\AntiVirusSquadUE58\Plugins\UnrealMCPBridge\`

`FMCPProjectIndex` is a singleton owned by `FUnrealMCPBridgeModule` (`Initialize()` in
`StartupModule`, `Shutdown()` in `ShutdownModule` — see `UnrealMCPBridgeModule.cpp`).
Design choices, matching the M3 brief:

- **On editor startup**: only registers the 5 AssetRegistry delegates (cheap — no
  scanning). **On first request** (`search_project` or `get_project_overview` calling
  `EnsureBuilt()`): tries to load the on-disk cache first; if that fails or doesn't
  exist, does a full scan (`RebuildFull()`) — enumerates every `/Game` Blueprint via
  `IAssetRegistry::GetAssets`, loads each one (`StaticLoadObject`), and extracts:
  - Path, name, parent class, implemented interfaces (`Blueprint->ImplementedInterfaces`)
  - Every function in `Blueprint->FunctionGraphs`, with **real param/return types** —
    pulled from the compiled generated class's `UFunction` via `TFieldIterator<FProperty>`
    + `FProperty::GetCPPType()`, not re-derived from graph pins
  - Every variable in `Blueprint->NewVariables` (name, type via a pin-type-to-string
    helper, category)
  - Every graph (`Blueprint->GetAllGraphs()`), with node count and a **node-type
    histogram** (`TMap<FString, int32>`, e.g. `{"K2Node_CallFunction": 8, "K2Node_IfThenElse": 2}`)
    — cheap, no per-node detail, per the brief.
- **Persisted to disk** at `<ProjectDir>/Saved/UnrealMCPBridge/index.json` (via
  `FPaths::ProjectSavedDir()`), hand-rolled JSON (de)serialization using the same
  `FJsonObject` Set/TryGet pattern as the rest of the plugin — deliberately not
  `USTRUCT`/`UPROPERTY` + `FJsonObjectConverter`, to avoid introducing UHT reflection
  into a module that currently has none of its own reflected types. `Saved/` is already
  the standard UE gitignore convention, so this cache is expected to never be committed.
- **Kept fresh incrementally**: `OnAssetAdded`/`OnAssetRemoved`/`OnAssetRenamed`/
  `OnAssetUpdated` each re-index (or remove) just the one affected Blueprint and
  re-save the cache — no full rescan on every edit. `OnFilesLoaded` triggers exactly one
  authoritative `RebuildFull()` if the index was built while the AssetRegistry's initial
  project scan was still in progress (tracked via `bAssetRegistryStillScanning`, also
  surfaced in `get_project_overview`'s response so a model can tell if it might be
  looking at a partial picture).

New commands in `MCPCommandHandler.cpp` (dispatch-only; all real logic lives in
`FMCPProjectIndex` or, for `find_references`, directly against `IAssetRegistry`):

| Command | What it does |
|---|---|
| `get_project_overview` | Calls `EnsureBuilt()` then returns `FMCPProjectIndex::GetOverview()`: total counts, folder breakdown, parent-class breakdown, scanning flag. |
| `search_project` | Calls `EnsureBuilt()` then `FMCPProjectIndex::Search()`: case-insensitive substring match across blueprint/function/variable names and parent-class names, capped and clamped to `[1, 500]`. |
| `find_references` | **Does not use the index at all** — calls `IAssetRegistry::GetReferencers`/`GetDependencies` directly on the given package, so it works for any asset (not just indexed Blueprints) and needs no prior index build. Filters out `/Script/` engine-internal packages to stay focused on project content. |

### Ground rules from M1/M2 — honored
