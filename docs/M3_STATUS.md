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

- No short generic names added (`MakeHit`, `PinTypeToString`, `ParamToJson`/`FromJson`
  etc. are all specific enough not to collide with anything in Core, and none of them
  are named `Check`/`Verify`/`MakeError`/`MakeOk`).
- Everything still runs on the game thread — `FMCPProjectIndex`'s own doc comment calls
  this out explicitly: both the TCP server's tick and the AssetRegistry's delegates fire
  on the game thread, so `Entries` needs no locking.
- Same build-verification bar: isolated `RunUAT BuildPlugin` + direct build against the
  real `AntiVirusSquadUE58.uproject`, both required and both run this session.

### MCP server — 3 new tools + optional enrichment stage

`unreal_get_project_overview`, `unreal_search_project`, `unreal_find_references` added
to `mcp-server/src/index.ts`, result types added to `types.ts`. `npm run build` and
`npx tsc --noEmit` both clean.

**`mcp-server/src/enrichment.ts` (new file)** — the local-model pluggability seam from
the brief. If `UNREAL_MCP_LOCAL_LLM_URL` is unset (default), `isEnrichmentEnabled()`
returns false and `enrichSearchHits()` is a pure pass-through — zero network calls, zero
setup, zero behavior change. If set, `unreal_search_project`'s handler calls
`enrichSearchHits()` on the bridge's raw hits before returning them: up to
`UNREAL_MCP_LOCAL_LLM_MAX_PER_CALL` (default 8) hits get a POST to
`<url>/chat/completions` (OpenAI-compatible — works with Ollama's `/v1` endpoint out of
the box), asking for a one-line natural-language guess at what the item does, attached
as a `summary` field. Any failure for an individual hit (unreachable endpoint, timeout,
malformed response) silently falls back to no summary for that hit — enrichment can
never break a search result. Results are cached in-memory per-process, keyed by the
hit's own structural content, so repeat searches don't re-call the local model.

The response's `enrichment` field (`"local-llm"` or `"none"`) tells the calling model
whether enrichment actually ran, so it isn't left guessing why some hits do or don't
have a `summary`.

## Verification performed this session

1. **Isolated plugin package build** (`RunUAT BuildPlugin`): `Result: Succeeded`,
   `BUILD SUCCESSFUL`, first attempt.
2. **Direct build against the real project** (`UnrealBuildTool` against
   `AntiVirusSquadUE58.uproject`): `Result: Succeeded`, exit code 0, ~92s (incremental —
   recompiled `Module.UnrealMCPBridge.cpp`, `MCPCommandHandler.cpp`, `MCPProjectIndex.cpp`
   [new], `UnrealMCPBridgeModule.cpp`, relinked). Updated
   `UnrealEditor-UnrealMCPBridge.dll` is live in the project's
   `Plugins\UnrealMCPBridge\Binaries\Win64\`.
3. **TypeScript**: `npm run build` and `npx tsc --noEmit` both clean for the whole
   16-tool server.
4. **Full MCP protocol test against a fake bridge** (extending the M1/M2 technique): a
   hand-written TCP server replays `get_project_overview`/`search_project`/
   `find_references` response shapes. The real compiled `dist/index.js` was spawned and
   driven with the SDK `Client` over real stdio: confirmed all 16 tools registered (no
   more, no less), and each of the 3 new tools called with realistic arguments returned
   correctly-shaped results.
5. **Dedicated enrichment test, all three states**:
   - **Disabled (default)**: confirmed `unreal_search_project` returns hits with no
     `summary` field and `enrichment: "none"` when `UNREAL_MCP_LOCAL_LLM_URL` is unset —
     the zero-setup default path.
   - **Enabled and working**: a fake OpenAI-compatible `/chat/completions` server was
     stood up; confirmed hits under the per-call cap (5 of 8) all get a `summary` field
     and `enrichment: "local-llm"`, AND confirmed the cap itself works correctly with 12
     hits (over the default cap of 8) — exactly 8 got summaries, the other 4 passed
     through untouched rather than being dropped.
   - **Enabled but unreachable**: pointed `UNREAL_MCP_LOCAL_LLM_URL` at a port nothing is
     listening on; confirmed the tool call still succeeds, still reports
     `enrichment: "local-llm"` (it did attempt to run), and every hit comes back with no
     `summary` — i.e. a broken/offline local model degrades gracefully and never breaks
     the underlying search.

This confirms the TS <-> TCP <-> JSON plumbing, and the entire enrichment seam's
control flow (on/off/cap/failure), are all correct. It does **not** confirm the C++
index's actual runtime output against real project data — see below.

## What is stubbed / unverified

Everything below requires a live Unreal Editor session, which this environment cannot
drive:

- **The index has never actually been built from real data.** `RebuildFull()` compiles
  and its logic is a straightforward extension of already-compiling M1/M2 code (same
  `StaticLoadObject`, same `GetAllGraphs`, same `NewVariables` iteration used
  elsewhere), but whether it produces sensible output for `AntiVirusSquadUE58`'s actual
  content — correct function param/return types via `FProperty::GetCPPType()`, correct
  interface names, a folder breakdown that actually reflects the project's structure —
  is unverified. `FProperty::GetCPPType()` in particular can produce verbose/unexpected
  strings for some property types (e.g. `TSubclassOf<T>`, soft references, containers of
  structs) that I have not been able to check against a real function signature.
- **The incremental delegates have never fired.** `OnAssetAdded`/`Removed`/`Renamed`/
  `Updated` all compile against the signatures I expected, but I have not created,
  deleted, renamed, or edited a single real Blueprint while the plugin was loaded — so
  whether the index actually stays fresh as claimed (the whole point of doing this
  incrementally instead of re-scanning) is unverified. If these delegates don't fire the
  way I expect (wrong signature accepted by luck, wrong event semantics, etc.), the
  index would silently go stale rather than error — this is the single most important
  thing to check first per "Manual steps" below.
- **`find_references`'s `GetReferencers`/`GetDependencies` calls compiled against the
  simplest 2-argument overload** (`(FName PackageName, TArray<FName>& Out)`), which
  exists in UE 5.8 alongside more specific category-filtered overloads. This should
  return "all dependency categories," but whether that's the most *useful* answer (e.g.
  whether it includes soft/editor-only references a user might not care about) is
  unverified against real project references.
- **Disk persistence round-trip** (`SaveToDisk`/`LoadFromDisk`) has never actually run —
  compiles clean, logic is straightforward JSON, but no `Saved/UnrealMCPBridge/index.json`
  has ever been written or read back for real. First run will both create and
  immediately exercise this.
- **Enrichment against a real local model** (as opposed to this session's fake HTTP
  stand-in) is unverified — the fake server proved the *protocol* (request shape sent,
  response shape expected) matches what Ollama's OpenAI-compatible endpoint documents,
  but has not been checked against an actual running Ollama instance.
- **Enrichment cache is in-memory/per-process only**, not persisted to disk. A follow-up
  could persist it alongside `index.json` (keyed the same way, invalidated the same way
  on structural change) so summaries survive an MCP server restart — not done this
  milestone since the brief was explicit about not blocking on this feature.

## Manual steps required from the user (do these in order)

1. **Open `AntiVirusSquadUE58.uproject` in UE 5.8.** All three milestones' plugin code
   has been compiled directly into the project already — no first-compile prompt
   expected.
2. **Confirm the bridge is listening** (same check as M1/M2): Output Log should show
   `UnrealMCPBridge: listening on 127.0.0.1:8765`.
3. **Call `unreal_get_project_overview` first.** This is the cheapest possible check —
   confirm `blueprintCount` roughly matches what you'd expect for this project, and that
   `folders`/`byParentClass` look like real data, not zeros or garbage. This one call
   exercises the full first-build path: `EnsureBuilt()` -> `LoadFromDisk()` fails (no
   cache yet) -> `RebuildFull()` -> scans + loads every Blueprint -> `SaveToDisk()`. If
   this looks right, the riskiest untested path in this milestone just got confirmed in
   one shot.
4. **Check that `Saved/UnrealMCPBridge/index.json` now exists** in the project folder,
   and has plausible contents (blueprint paths, function names you recognize). This
   confirms the persistence half works, independent of the in-memory data being correct.
5. **Call `unreal_search_project` with a query you know should match something** (a
   Blueprint name, a function name you know exists) and confirm the hits make sense.
6. **The most important check**: with the editor still open, **create, rename, or
   delete a Blueprint** (or add a variable to an existing one) directly in the editor —
   not through the MCP tools — then immediately call `unreal_search_project` again for
   something related to that change, **without restarting the editor**. If the change
   shows up without needing to trigger a rebuild, the incremental AssetRegistry delegate
   wiring actually works as designed. If it doesn't show up, the index has gone stale
   silently, which would be the highest-priority bug to report back.
7. **Try `unreal_find_references`** on a Blueprint you know is used somewhere (e.g.
   referenced in a level, or a parent of another Blueprint) and confirm `referencedBy`
   actually lists the right thing.
8. **Optional**: set up Ollama (see `mcp-server/README.md`'s enrichment section) and
   confirm `unreal_search_project` results start including a `summary` field that
   actually reads sensibly for real blueprint/function names, not just the fake-server
   echo this session's tests used.
9. Report back anything that looks wrong — a stale index after step 6 is the single
   highest-value thing to know about, since it would silently undermine the entire
   point of this milestone (avoiding re-enumeration) without being obviously broken.

## Blockers

**None that stopped progress.** All three build verifications across all three
milestones have now succeeded — this milestone's on the first attempt for both, despite
having the largest and riskiest new API surface yet (5 AssetRegistry delegate
signatures, dependency-graph queries, reflection-based function signature extraction).
The engine reference source clone remains broken and was, again, a non-blocking gap —
noted again here for completeness since it's still relevant to the numeric-type-mapping
caveat carried over from M2.

The single most important open item across all three milestones remains the same, and
is now more consequential than ever: **nobody has opened the live editor.** Every
milestone's structural correctness (does it compile, does it round-trip the right JSON)
is proven; every milestone's actual runtime behavior against real project data is not.
Given M3 is specifically about *staying* correct over time (the incremental index), step
6 above — edit something live and confirm the index notices — is the single most
important manual check across all three milestones combined.

## File map (additions since M2_STATUS.md)

```
UnrealMCP/
