# Style Guide

The conventions this codebase already follows, written down so they stay consistent as the
project grows and as new contributions (human or AI) land. If you're fixing style drift, this is
the reference to check against.

## C++ (`UnrealMCPBridge/`)

Follows Epic's own Unreal Engine coding standard, since that's what every UE developer already
expects and what the engine's own headers model throughout the codebase:

- **Naming**: `PascalCase` for types, functions, and methods. `F` prefix for plain structs/classes
  (`FMCPProjectIndex`), `U` for `UObject`-derived classes, `T` for templates (`TArray`, `TMap`,
  `TUniquePtr`, `TSharedPtr`), `E` for enums, `b` prefix for booleans (`bBuilt`,
  `bAssetRegistryStillScanning`). Local variables and function parameters are also `PascalCase`
  (this is Epic's convention, not a typo) — `PascalCase` for everything except member fields with
  no prefix, which don't exist here since every field either has a type prefix or is private.
- **Braces**: Allman style — opening brace on its own line, for functions, classes, and control
  flow alike:
  ```cpp
  if (!Blueprint)
  {
      return MakeErrorResponse(LoadError);
  }
  ```
- **Indentation**: tabs, not spaces (matches Epic's own source and `.editorconfig` defaults for UE
  projects).
- **Headers**: `#pragma once`, not include guards. Forward-declare where possible (see
  `MCPTcpServer.h`'s `class FSocket;` etc) instead of including headers a `.h` doesn't need.
- **Error handling**: commands return `bool` with an `FString& OutError` output parameter rather
  than throwing or asserting — every command path in `MCPCommandHandler.cpp` reports failures back
  as a structured JSON error (`{"ok": false, "error": "..."}`) instead of crashing the editor.
  Never use engine `check()`/`ensure()` on data that comes from an MCP request; those are for
  programmer errors, not malformed input from a client.
- **Comments**: `/** ... */` Doxygen-style block comments on classes and non-obvious public
  methods, explaining *why* something exists or a non-obvious constraint (see `MCPProjectIndex.h`'s
  class comment). Single-line `//` comments inline only when the *why* isn't obvious from the code
  itself — not restating what the next line does. No em dashes in comments; use a period, comma, or
  colon instead, whichever reads most naturally. No emoji.
- **Response builders**: use the shared `MakeOkResponse` / `MakeErrorResponse` helpers rather than
  building `FJsonObject`s inline, and avoid short generic helper names (`MakeError`, `Check`,
  `Verify`, etc.) in files that transitively include Core headers — this collided with UE's own
  `Templates/ValueOrError.h` once already (see `docs/M1_STATUS.md`).
- **Threading**: everything in this plugin runs on the game thread by design (the TCP server ticks
  via `FTSTicker`, AssetRegistry delegates fire on the game thread) specifically so command
  handlers can call Editor/Kismet2/AssetRegistry APIs directly with no locking. Don't introduce a
  background thread without re-checking this assumption project-wide.

## TypeScript (`mcp-server/`)

- **Formatting**: 2-space indentation, double quotes for strings, semicolons, trailing commas in
  multi-line literals.
- **Naming**: `camelCase` for variables and functions, `PascalCase` for interfaces and types
  (`BridgeRequest`, `SearchHit`). Interfaces over `type` aliases for object shapes; `type` for
  unions/utility types.
- **Types**: explicit return types on exported functions. Prefer `unknown` over `any`; narrow with
  a real check or a cast with a comment explaining why the cast is safe.
- **Async**: `async`/`await` throughout, except where wrapping a callback-based Node API
