# Milestone 2 Status — Blueprint create/edit commands

Last updated: 2026-08-07

> **Update 2026-08-08**: the write path in this document has now been exercised against a real,
> live Unreal Editor — see [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md). A real bug was found and
> fixed (`add_node` duplicating an already-present override-event node). Everything below reflects
> the pre-live-test state; treat LIVE_VERIFICATION.md as the current source of truth on what
> actually works against a running editor.

## TL;DR

- **All 8 new write/edit commands compile successfully against the real stock UE 5.8
  install**, verified the same two ways as M1: an isolated `RunUAT BuildPlugin` package
  build, and a direct `UnrealBuildTool` build against the actual `AntiVirusSquadUE58`
  project. Both succeeded on the **first attempt** this time (M1's `MakeError` naming
  collision lesson was applied from the start — see "Ground rules" below).
- **All 13 MCP tools (5 from M1 + 8 new) verified end-to-end over the real MCP stdio
  protocol** against a fake TCP bridge server that mimics every new command's exact
  response shape. `initialize`, `tools/list`, and `tools/call` all confirmed for every
  tool, including realistic argument passing (node ids, pin names, type strings).
- **Not verified: any of this has ever run against a live Unreal Editor or touched a
  real Blueprint asset.** Same gap as M1, now with much higher stakes — M1's read
  commands could only return wrong data; M2's write commands can corrupt a Blueprint.
  `unreal_compile_blueprint` exists specifically to catch that, but **it too has never
  actually run**. This is the single most important thing for the user to smoke-test
  first, in the exact order suggested at the bottom of this doc.

## What's new

### C++ plugin — 8 new commands in `MCPCommandHandler.cpp`

Location (source of truth): `F:\!Projects\UnrealMCP\UnrealMCPBridge\Source\UnrealMCPBridge\`
Deployed/build copy: `A:\UnrealProjects\AntiVirusSquadUE58\Plugins\UnrealMCPBridge\`

| Command | What it does | Key APIs |
|---|---|---|
| `create_blueprint` | Creates a new Blueprint asset at a package path with a given parent class; saves to disk by default (`save: false` to skip). | `FKismetEditorUtilities::CreateBlueprint`, `CreatePackage`, `FAssetRegistryModule::AssetCreated`, `UPackage::SavePackage` via a shared `SaveBlueprintPackage()` helper |
| `add_node` | Adds one node: `Event` (override a parent-class function like `ReceiveBeginPlay`/`ReceiveTick`), `CustomEvent`, `CallFunction` (by function name + optional owning class), `VariableGet`/`VariableSet` (this Blueprint's own variables only). Returns the new node's id immediately. | `UK2Node_Event`, `UK2Node_CustomEvent`, `UK2Node_CallFunction::SetFromFunction`, `UK2Node_VariableGet`/`Set` |
| `connect_pins` | Connects an output pin on one node to an input pin on another (exec or data), via the graph's schema, with a clear `incompatible_pins` error including the schema's own explanation when it's disallowed. | `UEdGraphSchema::CanCreateConnection` / `TryCreateConnection` |
| `set_pin_default_value` | Sets a literal default on an unconnected input pin; refuses (`pin_is_connected`) if the pin already has a link. | `UEdGraphPin::DefaultValue` + `UEdGraphNode::PinDefaultValueChanged` |
| `remove_node` | Breaks all links on a node, then removes it. | `UEdGraphNode::BreakAllNodeLinks`, `FBlueprintEditorUtils::RemoveNode` |
| `add_variable` | Adds a member variable with a compact type descriptor (`bool`, `byte`, `int`, `int64`, `float`, `double`, `string`, `name`, `text`, `vector`, `rotator`, `transform`, `object:<Class>`, `class:<Class>`), optional category + default value. Rejects duplicates. | `FBlueprintEditorUtils::AddMemberVariable`, `SetBlueprintVariableCategory` |
| `compile_blueprint` | Compiles and returns structured `{severity, text}` messages plus `errorCount`/`warningCount`/`success`/`status`. **This is the safety net for everything above it.** | `FKismetEditorUtilities::CompileBlueprint` with an `FCompilerResultsLog` |
| `save_blueprint` | Saves the Blueprint's package to disk (same helper `create_blueprint` uses internally). | `UPackage::SavePackage` |

Shared new helpers added to `FMCPCommandHandler`: `FindGraphByName`, `FindNodeById` (both
factored out of the M1 read handlers too, behavior unchanged), `ResolveClassByName` (short
native name with A-/U- prefix guessing, or a full `/Script/...`/`/Game/...` path), and
`ResolvePinType` (the compact type-descriptor parser used by `add_variable`).

**Node id scheme is unchanged from M1** (`"n<index>"` into `UEdGraph::Nodes`, not
persisted) — per the M2 brief, `add_node` returns the new id in its response so a model
can chain `add_node` -> `connect_pins` -> `set_pin_default_value` within one conversation
without re-reading the graph. Ids still do not survive an editor restart or a
`remove_node` elsewhere in the same graph (removing a node shifts every later index) —
**this is a real sharp edge**, called out again under "Known limitations" below.

Build.cs change: added the `MessageLog` module (needed for `FTokenizedMessage`/
`EMessageSeverity`, used by `compile_blueprint`'s structured error reporting).

### Ground rules carried over from M1 (and honored)

- No short generic helper names — `MakeOkResponse`/`MakeErrorResponse` reused as-is,
  no new same-risk names introduced (checked: nothing named `Check`, `Verify`, `MakeError`,
  `MakeOk` was added this milestone).
- `FMCPTcpServer` still ticks on the game thread (untouched this milestone) — every new
  handler above calls Kismet2/EdGraph/AssetRegistry APIs directly, no `AsyncTask`
  marshaling anywhere.
- Same build-verification bar as M1: both an isolated `RunUAT BuildPlugin` package build
  and a direct `UnrealBuildTool` build against the real `AntiVirusSquadUE58.uproject`.

### MCP server — 8 new tools in `mcp-server/src/index.ts`

`unreal_create_blueprint`, `unreal_add_node`, `unreal_connect_pins`,
`unreal_set_pin_default_value`, `unreal_remove_node`, `unreal_add_variable`,
`unreal_compile_blueprint`, `unreal_save_blueprint` — same thin-translator pattern as the
M1 tools (`mcp-server/src/bridgeClient.ts` is completely unchanged; only `index.ts` and
`types.ts` grew). `npm run build` and `npx tsc --noEmit` both clean.

`unreal_compile_blueprint`'s tool description explicitly instructs the model to run it
after any batch of edits before telling the user something is done — this was a
deliberate choice given the M2 brief's emphasis on it being the safety net.

## Verification performed this session

1. **Isolated plugin package build** (`RunUAT BuildPlugin`, fresh `HostProject`, same as
   M1's Verification 1): `Result: Succeeded`, `BUILD SUCCESSFUL`, first attempt — no
   compile errors at all despite ~10 previously-unverified UE APIs in this milestone
   (`FindFirstObject`, `FSavePackageArgs`, `EPinContainerType`,
   `FBlueprintEditorUtils::FindUniqueKismetName`/`SetBlueprintVariableCategory`,
   `FKismetEditorUtilities::CanCreateBlueprintOfClass`, `FCompilerResultsLog`,
   `EBlueprintStatus` enumerators, the `UK2Node_*` construction pattern, and the
   `UEdGraphSchema_K2::PC_*` type constants).
2. **Direct build against the real project** (`UnrealBuildTool` against
   `AntiVirusSquadUE58.uproject`, same as M1's Verification 2): `Result: Succeeded`, exit
   code 0, ~94s (incremental — only the 4 changed files recompiled:
   `Module.UnrealMCPBridge.cpp`, `MCPCommandHandler.cpp`, `MCPTcpServer.cpp`, plus
   relink). Updated `UnrealEditor-UnrealMCPBridge.dll` is live in
   `A:\UnrealProjects\AntiVirusSquadUE58\Plugins\UnrealMCPBridge\Binaries\Win64\` —
   again, the user should not see a first-compile prompt.
3. **TypeScript**: `npm run build` and `npx tsc --noEmit` both clean, zero errors, for
   all 13 tools combined.
4. **Full MCP protocol test against a fake bridge**, extending the same technique from
   M1: a hand-written TCP server replays exact response shapes for all 8 new commands
   (`create_blueprint`, `add_node`, `connect_pins`, `set_pin_default_value`,
   `remove_node`, `add_variable`, `compile_blueprint`, `save_blueprint`). The real
   compiled `dist/index.js` was spawned as a child process and driven with the SDK's
   `Client` over real stdio: `tools/list` confirmed exactly 13 tools registered (5 M1 +
   8 M2, no more, no less), and every one of the 8 new tools was called with realistic
   arguments and its parsed JSON result checked against the expected shape (e.g.
   `unreal_add_node` returning `id: "n7"`, `unreal_compile_blueprint` returning a
   `messages` array with the right `severity`/`text` fields). All passed.

This confirms the TS <-> TCP <-> JSON plumbing is correct for the new commands. It does
**not** confirm the C++ side's actual runtime behavior against a live editor and a real
Blueprint — see below.

## What is stubbed / unverified

Everything in this list requires a live Unreal Editor session, which this environment
cannot drive (no GUI automation available here) — same constraint as M1, now covering
much riskier operations:

- **No real Blueprint has ever actually been created, edited, or compiled by this
  plugin.** Every command above compiles and, per the fake-bridge test, round-trips the
  right JSON shape — but the actual engine-side behavior (does `UK2Node_Event` with
  `bOverrideFunction=true` really produce a working `BeginPlay` override node when
  `AllocateDefaultPins()` runs against a real graph; does `add_variable`'s `vector` type
  resolution via `FindObject<UScriptStruct>(nullptr, "/Script/CoreUObject.Vector")`
  actually resolve; does `connect_pins` correctly reject a bool-to-float connection with
  a sensible message) is **completely unverified**. This is the biggest open risk in the
  whole project so far, precisely because these are write operations.
- **`compile_blueprint`'s error/warning reporting is unverified** — the JSON shape is
  right (confirmed via the fake-bridge test), but whether `FCompilerResultsLog::Messages`
  actually populates the way I expect for a real broken graph, and whether the
  `severity`/`text` mapping reads sensibly, has never been checked against a real
  compiler run. Per the M2 brief, this is called out as the top thing to test first.
- **`ResolveClassByName`'s short-name resolution** (`"Actor"` -> tries `AActor`, then
  `UActor`, then bare `Actor`, via `FindFirstObject<UClass>`) is a heuristic, not a
  guaranteed-correct resolver. It will work for common native classes but could pick an
  unexpected match for ambiguous short names, or fail for classes that don't follow the
  `A`/`U` prefix convention (e.g. structs misused as a class name, or interfaces prefixed
  `I`). Untested against real class name collisions in this project's content.
- **`add_variable`'s numeric type mapping** (`float` -> `PC_Real` + `PC_Float`
  subcategory, `double` -> `PC_Real` + `PC_Double`) reflects UE5's post-4.x split of the
  old single `float` pin category into a `real` category with a float/double
  subcategory. This is standard UE5 behavior as far as I know, but I could not check it
  against engine source this session (see below), so treat the exact subcategory
  behavior as best-effort until confirmed against a real variable in the editor's My
  Blueprint panel.
- **Node id fragility under `remove_node`**: removing a node shifts every subsequent
  node's index-based id within the same graph. A model that reads a graph summary,
  removes `n3`, then tries to use a previously-noted `n7` from the same read will hit
  either the wrong node or a stale reference. Nothing currently detects or prevents
  this — it's a known gap, not a bug fix targeted for this milestone. Recommendation for
  a model (and for M3): re-read `list_blueprint_graphs`/`read_blueprint_graph_summary`
  after any `remove_node` before referencing further node ids in that graph.
- **`unreal_read_blueprint_summary`/`unreal_read_node_detail` were not re-verified this
  session** beyond the type-check — they are unchanged from M1 except for the
  `FindGraphByName`/`FindNodeById` refactor (pure extraction, same logic, both build
  clean), so M1's existing verification status still applies to them unchanged.

## Engine reference source — still broken, still not a blocker

`A:\UnrealEngineSource\UnrealEngine-5.8` was checked again this session and remains
**not a valid git repository** (a separate re-clone is reportedly in progress outside
this task, per instruction to not wait on or fix it). As in M1, none of this milestone's
C++ used it — all API usage came from general UE knowledge and was validated by getting
real compiler errors (there were none this time) from the actual installed engine. The
one place this matters most — numeric pin subcategory behavior for `add_variable` — is
flagged above as best-effort specifically because I couldn't cross-check it against
source.

## Manual steps required from the user (do these in order)

1. **Open `AntiVirusSquadUE58.uproject` in UE 5.8**, if not already open from M1. The
   plugin (including all M2 commands) has already been compiled directly into the
   project this session — no first-compile prompt should appear (see Verification 2
   above for the exact build result).
2. **Confirm the bridge is listening** (same check as M1): Output Log should show
   `UnrealMCPBridge: listening on 127.0.0.1:8765`.
3. **Smoke-test `unreal_compile_blueprint` first, before anything else** — this is the
   M2 brief's explicit priority, and it's good advice: it's the one command every other
   M2 command implicitly depends on for safety. Simplest path:
   a. `unreal_create_blueprint` with `packagePath: "/Game/_MCPTest/BP_SmokeTest"`,
      `parentClass: "Actor"`.
   b. `unreal_compile_blueprint` on that path immediately, with zero nodes added yet —
      confirm it reports `success: true`, `errorCount: 0`, and a sensible `status`
      (expect `"UpToDate"` or similar) for a freshly created, empty Blueprint.
   c. `unreal_add_node` with `nodeType: "Event"`, `eventName: "ReceiveBeginPlay"` on its
      `EventGraph`, then `unreal_add_node` with `nodeType: "CallFunction"`,
      `functionName: "PrintString"` (on `KismetSystemLibrary`; if `className` is left
      unset, the bridge will look for `PrintString` on the Blueprint's own generated
      class first, which won't have it — pass
      `className: "/Script/Engine.KismetSystemLibrary"` explicitly for this smoke test).
   d. `unreal_connect_pins` from the event node's exec output to the function call's
      exec input, then `unreal_compile_blueprint` again — confirm it now reports 0
      errors (a `PrintString` call with no `InString` connected/set should compile fine
      since it has a default).
   e. Only after that round-trip looks right, try the riskier paths: `add_variable`
      with each type descriptor at least once (especially `vector` and `object:` — the
      two most likely to have a subtle bug per "What is stubbed" above), and
      deliberately create a broken graph (e.g. connect two incompatible-type pins, or
      leave a required pin disconnected) to confirm `compile_blueprint` actually
      surfaces the error instead of silently reporting success.
4. **Delete `/Game/_MCPTest/` when done** (or leave it — it's an isolated scratch
   folder under the throwaway `AntiVirusSquadUE58` duplicate project, not the user's
   real content).
5. Report back anything that looks wrong — wrong pin names, a `class_not_found` for a
   class that should resolve, `compile_blueprint` missing an error it should have
   caught, or any crash. Given the volume of first-time-exercised API in this milestone,
   a crash on some specific node type combination is the likeliest failure mode to watch
   for, more so than a wrong-but-harmless JSON field.

## Blockers

