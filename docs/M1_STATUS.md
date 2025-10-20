# Milestone 1 Status — Read-only Blueprint introspection, end-to-end

Last updated: 2026-08-07

> **Update 2026-08-08**: the read path in this document has now been exercised against a real,
> live Unreal Editor with real project data — see [LIVE_VERIFICATION.md](LIVE_VERIFICATION.md).
> Everything below reflects the pre-live-test state.

## TL;DR

- **C++ plugin (`UnrealMCPBridge`) compiles successfully against a real, stock-launcher
  UE 5.8 install** (`F:\UE_5.8`) — verified twice: once as a standalone `RunUAT BuildPlugin`
  package, and once built directly into the target project (`AntiVirusSquadUE58`) via
  `UnrealBuildTool`. See "Verified" below for exact commands/output.
- **MCP server (`mcp-server/`) builds, type-checks, and was verified end-to-end over the
  real MCP stdio protocol** (initialize handshake, `tools/list`, `tools/call`) using the
  official SDK's `Client` against the compiled `dist/index.js`.
- **Not verified: an actual live read from inside a running Unreal Editor session.**
  I cannot launch and drive the full graphical Editor from this environment. The TCP
  wire protocol between the plugin and the server was verified against a hand-written
  fake server that mimics the bridge's exact framing, but the real `FMCPTcpServer` has
  never accepted a real connection or served a real Blueprint. **This is the one thing
  the user must confirm manually** — see "Manual step required" below.
- Engine reference source clone (`A:\UnrealEngineSource\UnrealEngine-5.8`) is **broken**
  (partial/corrupt clone, not a valid git repo) and was not used for this milestone. All
  C++ was written from public UE API knowledge and corrected against real compiler errors
  from the actual engine install, which is a stronger signal than source-reading anyway.

## What compiles / runs (verified)

### C++ plugin — `UnrealMCPBridge/`

Location: `F:\!Projects\UnrealMCP\UnrealMCPBridge\` (source of truth), copied to
`A:\UnrealProjects\AntiVirusSquadUE58\Plugins\UnrealMCPBridge\` (build/runtime location).

Engine install used: `F:\UE_5.8` (found via
`C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat` — a stock Epic Games
Launcher install, `UE_5.8`, changelist `55116800`, `IsPromotedBuild: 1`). A UE 5.6 install
also exists at `M:\Unreal\UE_5.6` but was not used since the target project pins
`"EngineAssociation": "5.8"`.

Compiler toolchain: Visual Studio 2022 Community (MSVC 14.44.35207) at `D:\community`,
found automatically by UBT.
