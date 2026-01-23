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

## Summary table

| Project | License | Architecture | Tool count | UE versions | Token/context-efficiency focus? | Persistent project index? | Link |
|---|---|---|---|---|---|---|---|
| chongdashu/unreal-mcp | **Claimed MIT, no LICENSE file** (unverified) | C++ `UEditorSubsystem` TCP bridge (:55557) + Python FastMCP server | ~20, not enumerated | 5.5+ | No | No | [github.com/chongdashu/unreal-mcp](https://github.com/chongdashu/unreal-mcp) |
| sam-david/unreal-mcp | **Claimed MIT, no LICENSE file** (unverified) | TS server, 4 transport layers; built-in Python Remote Execution + Remote Control API cover ~95%, C++ plugin optional (K2 graph editing only) | 127 across 16 modules | 5.3+, validated on 5.6 | No | No | [github.com/sam-david/unreal-mcp](https://github.com/sam-david/unreal-mcp) |
| remiphilippe/mcp-unreal | **Apache-2.0** (confirmed) | Single Go binary + optional C++ editor plugin (HTTP :8090) + UE Remote Control API (:30010) + headless `UnrealEditor-Cmd` invocation | 49 | 5.7 only | No | Partial — persistent Bleve index, but of **docs text**, not project assets | [github.com/remiphilippe/mcp-unreal](https://github.com/remiphilippe/mcp-unreal) |
| ChiR24/Unreal_mcp | **MIT** (confirmed) | C++ "MCP Automation Bridge" plugin, dual transport (native HTTP/SSE or TS/WebSocket bridge); single `unreal` gateway tool → search/describe/execute/configure over 23 canonical tools | 23 canonical (1 exposed) | 5.0–5.8 | Partial — explicit, but at tool-catalog level, not blueprint-payload level | No — 10s TTL in-memory cache only | [github.com/ChiR24/Unreal_mcp](https://github.com/ChiR24/Unreal_mcp) |
| GenOrca/unreal-mcp | **Apache-2.0** (confirmed, `LICENSE.txt`) | Python (built-in Python Editor Script Plugin) + optional C++ helper; 1 MCP tool per domain, `action` sub-dispatch | 253 actions / 21 domain tools | 5.6+ | Partial — explicit, but at tool-catalog level, not blueprint-payload level | Partial — live `find_referencers`/`get_dependencies`, no evidence of persistence/incrementality | [github.com/GenOrca/unreal-mcp](https://github.com/GenOrca/unreal-mcp) |
| avdo403/UnrealMCP | **Claimed MIT, no LICENSE file** (unverified) | C++ Editor Subsystem (:55557) + Python FastMCP server; optional Redis/Prometheus/Grafana stack | Not enumerated; dozens across 5+ categories | 5.x, tested 5.3–5.5 | No | No | [github.com/avdo403/UnrealMCP](https://github.com/avdo403/UnrealMCP) |
| kvick-games/UnrealMCP | **Functionally MIT** — full text embedded in README, no dedicated LICENSE file (GitHub shows "none") | C++ plugin (TCP bridge) + Python client scripts; in-editor toolbar start/stop UI | Small, unenumerated; Blueprints marked not-yet-done in its own roadmap | 5.5 only (only version tested) | No | No | [github.com/kvick-games/UnrealMCP](https://github.com/kvick-games/UnrealMCP) |
| lilklon/UEBlueprintMCP | **Claimed MIT, no LICENSE file, no grant text** (weakest of the "claimed" group — bare word only) | C++ plugin (`FEditorAction` subclasses, persistent TCP :55558) + Python server | 60+ | 5.7+ | No | No | [github.com/lilklon/UEBlueprintMCP](https://github.com/lilklon/UEBlueprintMCP) |
| mirno-ehf/ue5-mcp | **MIT** (confirmed) | C++ editor-subsystem plugin (HTTP :9847, zero overhead in-editor) + TS wrapper; optional headless commandlet fallback when editor is closed | 38 | 5.4+ | No | No evidence found | [github.com/mirno-ehf/ue5-mcp](https://github.com/mirno-ehf/ue5-mcp) |

**Popularity vs. currency** (supplementary — not requested but directly relevant to positioning):

| Project | Stars | Forks | Last push (as of 2026-08-07) |
|---|---|---|---|
| chongdashu/unreal-mcp | 2,057 | 340 | 2025-04-22 — **~16 months stale** |
| ChiR24/Unreal_mcp | 821 | 152 | 2026-08-07 — same day as this survey |
| kvick-games/UnrealMCP | 604 | 80 | 2025-06-22 — **~14 months stale** |
| GenOrca/unreal-mcp | 133 | 18 | 2026-07-07 — active |
| mirno-ehf/ue5-mcp | 68 | 18 | 2026-05-27 — active |
| remiphilippe/mcp-unreal | 63 | 12 | 2026-02-20 — moderately active |
| lilklon/UEBlueprintMCP | 36 | 7 | 2026-02-18 — moderately active |
| sam-david/unreal-mcp | 4 | 2 | 2026-03-28 — active, but tiny adoption |
| avdo403/UnrealMCP | 4 | 0 | 2026-03-04 — active, but tiny adoption |

The two highest-starred repos in the survey have both gone quiet for over a year. The
most-recently-active and most professionally engineered repo (ChiR24) is mid-tier by star count.
Star count in this space currently lags actual maintenance activity — worth remembering when
sizing up "the competition."

