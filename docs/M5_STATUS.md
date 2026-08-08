# Milestone 5 Status: node/function ground-truth catalog

Last updated: 2026-08-08

Status: **first increment complete and live-verified on both UE 5.6 and UE 5.8.**
Design: [M5_DESIGN.md](M5_DESIGN.md).

## TL;DR

- **The catalog is real and cheap.** 12,402 Blueprint-callable functions on UE 5.6 and 15,775 on
  UE 5.8, built by walking live reflection in **0.11s and 0.14s** respectively.
- **That speed changed the design.** M5_DESIGN.md assumed the catalog would need an on-disk cache
  keyed by engine version and module set, mirroring `FMCPProjectIndex`. At ~0.1s it does not.
  There is no cache file, no cache-invalidation logic, and no incremental-update path to keep
  correct. Building lazily once per session is simply cheaper than the machinery to avoid it.
- **Live-verified 39/39 on UE 5.6 and 40/40 on UE 5.8**, counting both the new M5 suite and a full
  M1-M3 regression run to confirm nothing broke.
- **The payoff works**: `add_node` given `PrintSting` now returns `didYouMean: [PrintString]`
  instead of a bare `function_not_found`.

## Why this milestone exists

A model writing Blueprint logic gets node names, pin names, and signatures wrong constantly. Not
from bad reasoning, but because no general-purpose model was trained reliably on any one engine
version's exact Blueprint surface, and that surface is enormous and shifts between versions.
Training per engine version is not realistic.

The bridge runs inside the editor with full C++ reflection access, so it can read the real answer
off the running engine. The catalog is correct by construction for whatever version is open.

## What shipped

### `FMCPNodeCatalog` (`MCPNodeCatalog.h`/`.cpp`, new)

Walks `UClass`/`UFunction` reflection for every function flagged `BlueprintCallable`,
`BlueprintPure`, or `BlueprintEvent`, recording exact parameter names, C++ types, directions
(in/out/return), and defaults via the same `TFieldIterator<FProperty>` + `FProperty::GetCPPType()`
pattern `MCPProjectIndex` already uses for a Blueprint's own functions, widened to every engine and
game class.

Two filters that matter for correctness:

- **Generated and stale classes are excluded.** `TObjectIterator<UClass>` surfaces `SKEL_`,
  `REINST_`, `TRASHCLASS_`, `PLACEHOLDER-`, `HOTRELOADED_`, and `LIVECODING_` classes that
  accumulate after Blueprint recompiles, plus anything flagged `CLASS_NewerVersionExists`. Without
  this the catalog fills with duplicate and garbage entries as soon as a user recompiles anything.
- **Hidden functions are excluded.** `DeprecatedFunction` and `BlueprintInternalUseOnly` are
  visible to reflection but deliberately absent from the editor's node palette. Suggesting them
  would send a caller somewhere the editor itself will not go.

Functions are iterated with `EFieldIteratorFlags::ExcludeSuper`, so each is recorded once on the
class that declares it rather than once per inheriting subclass.

### New commands and tools

| Bridge command | MCP tool | Purpose |
|---|---|---|
| `find_node` | `unreal_find_node` | Search by intent or partial name. Returns exact `functionName`/`classPath` values `add_node` accepts. |
| `get_node_signature` | `unreal_get_node_signature` | Exact pins for one function: name, type, direction, default. |

Search ranks exact, then prefix, then contains, matching `search_project`'s existing convention,
and prefers shorter names within a tier so `SpawnActor` outranks
`SpawnActorFromClassDeferredWithScale`.

### `add_node` now fails usefully

The highest-value part of the milestone. A close-but-wrong function name was previously a dead end:

```
function_not_found: PrintSting on KismetSystemLibrary
```

It now carries near-misses drawn from the catalog, so the most common failure mode is
self-correcting without the caller having had to call `find_node` first:

```json
{
  "ok": false,
  "error": "function_not_found: PrintSting on KismetSystemLibrary",
  "didYouMean": [{ "functionName": "PrintString", "className": "/Script/Engine.KismetSystemLibrary" }]
}
```

## Token efficiency

The catalog runs to five figures, so it is never returned whole. `find_node` hits carry a
`paramCount` and omit pin lists; full pins come only from `get_node_signature`, one function at a
time. Same tiered shape as the M1 reads.

## Verification

Build-verified against both engines via isolated `RunUAT BuildPlugin` runs (`Result: Succeeded`,
first attempt on both). TypeScript typechecks clean across all 18 tools.

Live-verified by speaking the bridge protocol **directly over the loopback socket**, bypassing
`mcp-server`, so any failure would be unambiguously the C++ plugin.

| Engine | M5 suite | M1-M3 regression | Catalog size | Build time |
|---|---|---|---|---|
| UE 5.6 | 18/18 | 21/21 | 12,402 | 0.11s |
| UE 5.8 | 19/19 | 21/21 | 15,775 | 0.14s |

What the M5 suite actually checks, beyond the obvious: that an exact-name query ranks the exact
match first; that the intent query "spawn actor" surfaces spawn functions; that `PrintString`'s
returned pins really are `WorldContextObject, InString, bPrintToScreen, bPrintToLog, TextColor,
Duration, Key`; that the catalog correctly reports `static=true` and
`/Script/Engine.KismetSystemLibrary` as the owner; that a typo returns usable suggestions from both
`get_node_signature` and `add_node`; and that **catalog output fed straight back into `add_node`
produces a node that compiles**, which is the end-to-end claim that matters.

A separate check confirmed the catalog emits no duplicate `(classPath, functionName)` pairs across
705 hits from 8 queries. Same-name functions on different classes do appear more than once, which
is correct: `SpawnActorFromClass` genuinely exists on both `EditorLevelLibrary` and
`EditorActorSubsystem`, and a caller needs to see both to pick the right one.

## Known limitations and next steps

- **Function catalog only, not the full node palette.** This increment covers
  `UFunction`-backed nodes. It does not yet enumerate native `UK2Node` types (branches, loops,
  casts, math operators) via `FBlueprintActionDatabase`/`UBlueprintNodeSpawner`, which is the more
  valuable and more expensive half described in M5_DESIGN.md. The verified design path for that is
  recorded there and unchanged.
- **Suggestion ranking is imperfect.** `SuggestSimilar` treats a clean prefix relationship as
  distance 0, which can rank a short generic name above the true edit-distance match. The right
  answer still lands in the top 5, but the ordering could be better.
- **Intent search is literal.** Matching is substring-based over names, display names, keywords,
  and owning class. It does not bridge intent to name semantically ("make a thing appear" will not
  find `SpawnActor`). The optional local-model enrichment seam from M3 is the natural place to
  improve this without adding a hard dependency.
- **Events are not covered by suggestions.** `add_node`'s `event_function_not_found` path does not
  attach `didYouMean` yet, since event names resolve against the Blueprint's parent class rather
  than the whole catalog.

## Leftover test content

The 5.8 test project gained `BP_M5Verify58`, `BP_RegressM5_58`, and `BP_RegressM5_58b` under
`Content/_MCPTest/`, alongside the pre-existing `BP_MCPLiveTest`/`BP_MCPLiveTest2`. The 5.6 project
gained `BP_RegressM5` under `Content/_MCPTest56/`. All are isolated scratch folders in throwaway
duplicate projects and are left in place as evidence, matching prior milestones' precedent.
