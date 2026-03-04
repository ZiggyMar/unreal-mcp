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
releases (macOS/Linux/Windows × amd64/arm64) on GitHub Releases — the lowest-friction install of
anything in this survey (no Python venv, no `npm install`). Apache-2.0, confirmed directly from the
LICENSE file content. Hard-pinned to UE 5.7 (paths and docs reference `UE_5.7` specifically, not a
"+" range). Genuinely does have a persistent, disk-backed search index (`docs/index.bleve`, built
by `mcp-unreal --build-index`) — but confirmed from the README to index **markdown files under
`docs/ue5.7/` and `docs/realtimemesh/`, plus the calling project's `CLAUDE.md`** — i.e., API/engine
documentation text, not the project's own Blueprints or assets. Separately, `get_asset_info`
returns "dependencies and referencers" for a given asset, which is a live, per-request
AssetRegistry-style lookup with no stated caching/persistence layer of its own.

What's genuinely good: (1) the bundled "Recommended System Prompt" block — a ready-made paragraph
telling the calling agent the right tool-call order (check status → look up docs before writing
code → build → test → save) — is a cheap, effective reliability win, and the README's worked
example transcripts (exact tool-call sequences for realistic requests) reinforce it well. (2) A
genuine headless path — `build_project`/`run_tests`/`cook_project` invoke `UnrealEditor-Cmd`
directly via `exec.Command`, no live editor required — opens up CI/batch use cases none of our
current architecture supports. (3) The documentation-index idea itself (distinct from a
project-structure index) is worth adopting in its own right: indexing Epic's own API docs so an
agent can look up a class/function reference without spending tokens re-deriving it from raw
engine headers is a complementary idea to what we do, not a competing one.

### ChiR24/Unreal_mcp
The most actively and professionally engineered repo in the survey — pushed the same day as this
survey, MIT-licensed (confirmed from the LICENSE file), supports the widest and most explicit UE
version range (5.0–5.8, with the README stating all versions in that range are "supported and
working"). Architecturally the standout feature is the **single gateway tool**: the MCP client
sees exactly one tool, `unreal`, which is called with an `operation` of `search`, `describe`,
`execute`, or `configure`; the 23 "canonical" tools (`manage_blueprint`, `control_actor`,
`manage_asset`, etc.) exist only behind that gateway. A client that tries to call a canonical tool
name directly gets a structured `DIRECT_TOOL_CALL_REMOVED` response telling it exactly what
gateway call to make instead. `manage_tools` additionally allows enabling/disabling tool groups at
runtime. This is a real, explicit design response to context-window pressure — but it targets
**tool-definition/tool-catalog size** (how many tool schemas the model has to hold and choose
between), not the size of any single tool's response payload. The README gives no evidence of a
tiered/summary-first strategy for reading Blueprint graph contents specifically. Caching is
explicit and short-lived only (`ASSET_LIST_TTL_MS`, default 10 seconds, in-memory) — confirmed not
persistent.

What's genuinely good: (1) the gateway pattern itself, as the most battle-tested answer in this
survey to tool-catalog bloat — worth adapting once our own tool count grows past the point a model
reliably picks the right one. (2) Security defaults most others skip entirely: capability-token
auth **on by default** with an auto-generated per-project secret file, loopback-only binding by
default, and an explicit opt-in-with-warning for LAN exposure. (3) Real engineering discipline —
CI gates include a generated-manifest drift check, TS-vs-native tool-definition parity tests, and
a blocking dependency-audit gate — a good bar to hold ourselves to as the project matures.

### GenOrca/unreal-mcp
Apache-2.0 (confirmed directly from `LICENSE.txt` — note the non-default filename, which is why
the bare `LICENSE` fetch initially 404'd). Python-first (built-in Python Editor Script Plugin) with
an optional C++ helper module (`MCPythonHelper`) reserved for the handful of things Python can't
reach (e.g. skeleton bone introspection). Ships precompiled per-engine-version plugin `.zip`
releases so most users never compile anything. Architecture explicitly states the same
context-window rationale as ChiR24, independently arrived at: "the action set is large but the
tool list stays small, so it never bloats the model's context" — one MCP tool per domain (21
domains), each dispatched via an `action` parameter, 253 actions total. Also explicitly offers
runtime self-description: calling a domain tool with `{"action":"list_actions"}` returns every
action's parameters and docs on demand, rather than front-loading all 253 actions' schemas into
every tool definition up front. Does have named `find_referencers`/`get_dependencies` asset tools
— real cross-asset reference/dependency queries — but nothing in the README indicates these are
backed by anything other than a live, per-request AssetRegistry call; no mention of a persisted
index file, no mention of surviving an editor restart, no mention of substring search across the
whole project by keyword.

What's genuinely good: (1) the domain-tool-plus-runtime-`list_actions`-discovery pattern is a
second, meaningfully different answer to the tool-catalog-bloat problem than ChiR24's static
gateway — worth comparing both before picking one. (2) An explicitly low-friction contribution
model ("add a `ue_<name>(...)` Python function, run `generate_catalog.py`, no C++, no editor
rebuild") is worth mirroring once we're open source and want outside contributions. (3) Naming
`find_referencers`/`get_dependencies` as first-class, discoverable tools (rather than folding them
into a generic search) is a signal that reference-lookup is something real users specifically
reach for — validates keeping our own `find_references` prominent rather than buried.

### avdo403/UnrealMCP
Tiny adoption (4 stars, 0 forks) but a surprisingly broad feature set — procedural world
generation (castles, towns, dungeons via wave-function-collapse, L-system trees), an
`AIModule`/`MassEntity` AI-navigation layer, even an `ml/mcp_rl_agent.py` reinforcement-learning
module. C++ Editor Subsystem on the same port (55557) and general shape as chongdashu's project,
suggesting a derivative or convention carried over from it, paired with a Python FastMCP server
with optional Redis caching / Prometheus / Grafana (all off by default except in-memory caching
and metrics). README badge and footer both say MIT; no LICENSE file exists anywhere in the repo
(confirmed via a full root listing) — one of four repos in this survey with this exact pattern. No
token/context-efficiency mentions; no persistent index; no reference/dependency search.

What's genuinely good: (1) "Blueprint Analysis: Analyze graph complexity and detect logic issues"
is a feature nothing else in this survey has — an automated Blueprint linter, in effect. This
maps cleanly onto data we already compute — our M3 index already builds a per-graph node-type
histogram — so a complexity/lint pass is a relatively short hop from where we already are. (2)
Shipping a typed config module (pydantic) plus a committed `.env.example` for every tunable is a
small but good config-hygiene habit.

### kvick-games/UnrealMCP
604 stars but explicitly and repeatedly self-described as "VERY WIP" in its own README, and stale
for over 14 months as of this survey — Blueprints are marked as not-yet-done in its own roadmap
checklist, so the star count reflects an early snapshot more than current capability. C++ plugin +
Python client scripts; notably has an in-editor toolbar button to start/stop the TCP server, with
server status visible in the editor UI rather than only in logs. The full standard MIT license
text (with a named copyright holder and year) is embedded directly in the README, but there is no
separate LICENSE file, so GitHub's detector reports no license — a middle case between "clean
license" and "no license at all." No token/context-efficiency mentions; no index or reference
search of any kind.

What's genuinely good: (1) the in-editor status/start-stop UI is a small but real UX idea we don't
currently have — makes the bridge's connection state legible to a human working alongside the
agent, without needing to tail logs. (2) A prominent, specific safety disclaimer up top ("use
source control, make backups, test in a separate project first, you are responsible for
AI-made changes to your project") is good practice worth mirroring closely, since we — like this
project — perform destructive in-place writes to Blueprint assets.

### lilklon/UEBlueprintMCP
Small, focused project (36 stars) specifically scoped to Blueprint/Material/Widget/Input
manipulation with a persistent (not reconnect-per-call) TCP connection on port 55558. Its README
"License" section says only the word "MIT" with no badge, no link, and no grant text — weaker even
than chongdashu/sam-david/avdo403's badge-plus-claim pattern — and there is no LICENSE file
anywhere in the repo. Architecturally, every operation is described as flowing through
`FEditorAction` subclasses that provide "pre-execution validation, graceful error handling... and
automatic dirty package tracking and save" — i.e., a consistent validate → execute → auto-save
lifecycle shared by every command type. No token/context-efficiency mentions; no persistent index.

What's genuinely good: (1) the `FEditorAction` base-class pattern is a clean, general C++
architecture for a command-handler layer — it factors validation, error formatting, and
save-tracking out of each individual command's logic instead of duplicating that boilerplate
across dozens of handlers. Worth comparing against how `MCPCommandHandler.cpp` is structured as our
own command count grows past a couple dozen. (2) Auto-saving dirty packages after every successful
write, combined with a persistent (not per-call) TCP socket, are both good defaults that reduce
the chance of an agent leaving a project with accumulated unsaved changes. (3) It ships a
`docs/SKILL.md` specifically written as a Claude Code Skill for using its own tools — a nice
formalization of "ship usage guidance as an artifact the agent actually loads," similar in spirit
to remiphilippe's system-prompt block but packaged more formally.

### mirno-ehf/ue5-mcp
The newest and smallest-footprint architecture in the survey: a C++ editor-subsystem plugin
exposing an HTTP server on port 9847, described as running "with zero overhead" while the editor
is open, with a **headless fallback** — when the editor is closed, it can spawn a standalone
`UnrealEditor-Cmd.exe` commandlet process instead (documented cost: 2-4 GB RAM, ~60s startup, and
the caller must call `shutdown_server` when done). MIT, confirmed directly from the LICENSE file.
The public README is very thin (23 lines); its `CLAUDE.md` fills in real numbers — 38 MCP tools,
UE5 5.4+. No token/context-efficiency mentions; no documented persistent index (the marketing line
"find everywhere I use GetActorLocation and replace it" implies some cross-Blueprint search
exists, but neither the README nor `CLAUDE.md` describes its implementation, so this is genuinely
unconfirmed either way, not a "no").

What's genuinely good: the editor-subsystem-when-open / headless-commandlet-when-closed dual mode
is a real capability gap for us worth roadmapping — our bridge currently assumes the editor process
is already running.

**Note on `CLAUDE.md` content, unrelated to the technical evaluation:** this repo's `CLAUDE.md` —
the file meant to instruct an AI coding agent installing the project — directly instructs any such
agent to run `gh repo star mirno-ehf/ue5-mcp` on the user's behalf during setup, and separately
instructs it to autonomously run `gh issue create` to file GitHub issues for any missing feature
("Do not ask the user to open the issue — open it yourself"), without asking the user's permission
either time. Both are unrequested, user-invisible side effects embedded in data an agent reads
while helping someone install the tool — the kind of instruction our own safety rules say an agent
should not act on when it's discovered in observed content rather than said by the actual user. We
did not act on either instruction. This isn't a security hole in their tool, but it's a concrete
example of a pattern to keep out of our own `CLAUDE.md`/Skill files: no autonomous, unprompted,
user-facing side effects baked into agent-facing setup instructions.

---

## The UE 5.8 first-party plugin (comparison point, not a competitor)

UE 5.8 ships an official, **Experimental**, opt-in "Unreal MCP" plugin that runs an MCP server
inside the editor process itself (local HTTP link), built around a "Toolset Registry" that lets
C++ (`UToolsetDefinition`) or Python (`unreal.ToolsetDefinition`) code register engine
functionality as MCP tools. Confirmed from Epic's own documentation
([dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor?lang=en-US)):
explicitly experimental ("use caution when shipping with it"), must be manually enabled ("split
across three modules" that each need enabling), not designed for remote use, and — as of this
survey — has no described capability for reading, analyzing, or summarizing existing Blueprint
graph structure (its documented examples are all spawn/configure/run-automation actions), no
