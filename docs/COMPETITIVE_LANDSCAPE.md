# Competitive Landscape — Unreal Engine MCP Servers

Survey date: 2026-08-07. Scope: the 9 third-party GitHub repos identified as of this date as
competing/related "MCP server for Unreal Engine" projects, plus Epic's own first-party
experimental plugin in UE 5.8 as a non-competitor comparison point.

**Methodology.** For each repo: fetched repo metadata via the GitHub REST API
(`api.github.com/repos/<owner>/<repo>`, which includes GitHub's own license-file detection),
fetched `LICENSE`/`LICENSE.md`/`LICENSE.txt` directly from `raw.githubusercontent.com` (trying
all three filenames, not just trusting the API's detector), and fetched `README.md` plus, for a
few repos, one supporting file (`CLAUDE.md`, etc.) the same way. No repository was cloned. All
figures (stars, forks, tool counts) are a point-in-time snapshot and, for tool/action counts, are
self-reported by each project's own README unless noted otherwise — none of this was verified
against actual source. Nothing in this document reproduces source code from any surveyed repo;
architectural ideas are described in our own words for evaluation purposes.

**Where we are for comparison.** Per `ARCHITECTURE.md` and `docs/M1_STATUS.md` /
`docs/M2_STATUS.md`: a C++ editor plugin (`UnrealMCPBridge`) + Node/TypeScript MCP server,
targeting stock-launcher UE 5.6/5.8 with no engine source dependency. M1 (tiered read-only
Blueprint introspection) and M2 (structured write/edit commands) are built and compile-verified
against a real UE 5.8 install. M3 — `MCPProjectIndex` (`UnrealMCPBridge/Source/UnrealMCPBridge/`)
— is also built: an in-memory index of every Blueprint's functions/variables/graphs/node-type
histograms, persisted to `Saved/UnrealMCPBridge/index.json`, kept fresh via `IAssetRegistry`'s
`OnAssetAdded`/`Removed`/`Renamed`/`Updated` delegates (no polling), backing a substring `Search()`
and a `find_references` command that calls the AssetRegistry's real `GetReferencers`/
`GetDependencies` at the package level.

---
