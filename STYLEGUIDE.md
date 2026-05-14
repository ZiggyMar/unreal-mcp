# Style Guide

The conventions this codebase already follows, written down so they stay consistent as the
project grows and as new contributions (human or AI) land. If you're fixing style drift, this is
the reference to check against.

## C++ (`UnrealMCPBridge/`)

Follows Epic's own Unreal Engine coding standard, since that's what every UE developer already
expects and what the engine's own headers model throughout the codebase:

- **Naming**: `PascalCase` for types, functions, and methods. `F` prefix for plain structs/classes
