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

**Verification 1 — isolated plugin package build** (proves the plugin is self-contained
and correct against public APIs only):

```
F:\UE_5.8\Engine\Build\BatchFiles\RunUAT.bat BuildPlugin ^
  -Plugin="A:\UnrealProjects\AntiVirusSquadUE58\Plugins\UnrealMCPBridge\UnrealMCPBridge.uplugin" ^
  -Package="<scratch>\PluginBuild\UnrealMCPBridge" ^
  -TargetPlatforms=Win64
```

Result: `BUILD SUCCESSFUL`. Produced
`UnrealEditor-UnrealMCPBridge.dll` + `.pdb` for Win64 Development.

**Verification 2 — built directly against the target project**, i.e. what actually
happens when the project's editor target compiles with this plugin enabled:

```
F:\UE_5.8\Engine\Build\BatchFiles\Build.bat UnrealEditor Win64 Development ^
  -Project="A:\UnrealProjects\AntiVirusSquadUE58\AntiVirusSquadUE58.uproject" ^
  -TargetType=Editor -Progress -NoHotReloadFromIDE
```

Result: **`Result: Succeeded`**, exit code 0, total execution time ~130s. Output binary
confirmed at `A:\UnrealProjects\AntiVirusSquadUE58\Plugins\UnrealMCPBridge\Binaries\Win64\UnrealEditor-UnrealMCPBridge.dll`
(+ `.pdb`), i.e. the binaries are already sitting in the actual target project, not just a
scratch package — the user should not need to trigger a first-time compile prompt at all.
As a side effect this build also compiled the project's other existing plugins that needed
it (e.g. modules named `Kronos`/`KronosEditor` already present in the project), which
happened cleanly alongside `UnrealMCPBridge` — good evidence our plugin doesn't conflict
with anything already in the project.

Note: `AntiVirusSquadUE58` is a **Blueprint-only project** — it has no `Source/` directory
of its own. Before this milestone it had no reason to ever compile anything. Adding
`UnrealMCPBridge` as a C++ plugin makes this the *first* thing in the project that
requires a build step.

Fix applied during this milestone: the first build attempt failed with C2440/C2679 errors
because a local helper function named `MakeError(...)` collided with Unreal's own global
`MakeError()` template from `Templates/ValueOrError.h` (pulled in transitively) — overload
resolution silently preferred UE's version, which returns a `TValueOrError_ErrorProxy<T>`,
not our `TSharedRef<FJsonObject>`. Renamed our helpers to `MakeOkResponse` /
`MakeErrorResponse` throughout `MCPCommandHandler.cpp` and the isolated build then
succeeded cleanly. Worth remembering for M2: avoid short generic names like `MakeError`,
`MakeOk`, `Check`, `Verify`, etc. in files that transitively include Core headers.

**Plugin registration**: `UnrealMCPBridge.uplugin` sets `"EnabledByDefault": true`, and
`AntiVirusSquadUE58.uproject`'s `Plugins` array was updated to explicitly list
`{ "Name": "UnrealMCPBridge", "Enabled": true, "TargetAllowList": ["Editor"] }` so the
plugin loads automatically — the user should not need to enable it manually via
Edit > Plugins.

### MCP server — `mcp-server/`

Location: `F:\!Projects\UnrealMCP\mcp-server\`.

- `npm install` — succeeded, 96 packages, 0 vulnerabilities.
- `npm run build` (`tsc -p tsconfig.json`) — succeeded, produced `dist/*.js` + source maps.
- `npx tsc --noEmit` — clean, zero errors.
- `node dist/index.js` — starts, connects an MCP stdio transport, logs
  `unreal-mcp-server: connected via stdio; bridge target 127.0.0.1:8765`, and stays
  running waiting for MCP client input (did not crash).

**Protocol-level verification performed this session** (both using throwaway scripts, not
checked into the repo):

1. A fake TCP server was written that replies to `ping` / `list_blueprints` / an
   intentionally-failing command using the exact line-delimited JSON framing
   `FMCPTcpServer` implements (`{id, cmd, params}\n` in, `{id, ok, result|error}\n` out).
   The real, compiled `UnrealBridgeClient` (`dist/bridgeClient.js`) was driven against it
   directly: successful responses parsed correctly, the error-response path rejected with
   the bridge's error message, and a connection-refused case (nothing listening) produced
   the expected human-readable connection error. All 4 cases passed.
2. The real compiled server (`dist/index.js`) was spawned as a child process and driven
   with the official `@modelcontextprotocol/sdk` `Client` over a real stdio transport:
   `initialize` handshake succeeded, `tools/list` returned exactly the 5 expected tools
   (`unreal_ping`, `unreal_list_blueprints`, `unreal_list_blueprint_graphs`,
   `unreal_read_blueprint_summary`, `unreal_read_node_detail`), and calling `unreal_ping`
   with no bridge listening returned a graceful `isError: true` MCP tool result (not a
   crash or protocol violation) with the expected connection-refused message.

This confirms the MCP <-> TCP <-> JSON plumbing is correct on the server side. It does
**not** confirm the C++ side of that same protocol against a live editor — see below.

## What is stubbed / unverified

- **Live end-to-end read from a running Editor.** Nobody has opened
  `AntiVirusSquadUE58.uproject` in the actual Unreal Editor GUI during this milestone, so:
  - `FMCPTcpServer::Start()` binding port 8765 inside a real running editor process has
