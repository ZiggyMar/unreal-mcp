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
