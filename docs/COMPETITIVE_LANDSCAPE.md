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

---

## Per-project notes

### chongdashu/unreal-mcp
The project most people mean when they say "Unreal MCP" right now by star count, but stale for
over a year. C++ `UEditorSubsystem` running a TCP server on port 55557, paired with a Python
FastMCP server that loads tool modules from a `tools/` directory. Its Blueprint feature set is
entirely about **creating and configuring** Blueprints/components/nodes — every bullet in its
README's "Blueprint Node Graph" section is an add/create/connect verb; there is no read-existing-
structure-back-out tool at all, consistent with the task brief's note that it doesn't parse
existing Blueprint structure. No mention of token/context efficiency anywhere. README claims MIT
(badge + text) but there is no LICENSE file anywhere in the repo (checked LICENSE, LICENSE.md,
LICENSE.txt, and a full root-directory listing) — GitHub's own detector agrees, reporting no
license.

What's genuinely good: the bundled ready-to-open `MCPGameProject` sample project (plugin
pre-installed) lowers time-to-first-success — a new user can see it work before touching their
own project. Its per-MCP-client config table (client name → exact config file path per OS) is a
small, high-value documentation pattern that several later, more sophisticated projects
independently converged on too.

### sam-david/unreal-mcp
Tiny adoption (4 stars) despite a sophisticated pitch. Its core idea is the most interesting thing
about it: **no mandatory C++ plugin at all.** It drives the engine through two things every stock
UE install already ships — the Python Editor Script Plugin's Remote Execution (UDP multicast +
inverted TCP) and the Remote Control API (HTTP REST) — and only reaches for an optional C++
plugin when it needs K2 graph-node manipulation specifically. The server "probes all transports on
startup" and degrades gracefully if one isn't available. Its own README comparison table claims
127 tools across 16 subsystems beat every other repo in this survey on tool count, and the
per-module counts in that table do sum to exactly 127 — internally consistent, though unverified
against actual source. No mention of token/context efficiency; no read-existing-structure
compaction described beyond generic Remote Control property gets. README claims MIT; no LICENSE
file exists anywhere in the repo.

What's genuinely good: "prefer the engine's own built-in scripting surface over a custom native
plugin, and only add compiled code for the one thing the built-ins can't reach" is a legitimately
good minimal-friction install strategy — zero build step for ~95% of functionality. The tradeoff
(UDP multicast Remote Execution is fragile behind VPNs/Tailscale/multiple NICs — the README's own
troubleshooting section documents this at length) is real and worth taking seriously before
copying the pattern.

### remiphilippe/mcp-unreal
Single statically-linked Go binary, zero external runtime dependencies, prebuilt cross-platform
