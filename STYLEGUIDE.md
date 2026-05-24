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
