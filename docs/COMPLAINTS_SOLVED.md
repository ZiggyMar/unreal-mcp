# Every complaint people actually have about Unreal MCP servers, and what this project does about it

A living matrix. Each row is a complaint sourced from a real bug report, forum thread, or issue
tracker (linked), not a hypothetical. Status is written honestly: **Solved** means the fix is in
this repo and verified, **Partly** means it is reduced but not eliminated, **Open** means it is
still true here and is on the backlog.

The goal this feeds: someone with zero coding skill points any AI model at their project, asks for
a feature, and gets a working, readable Blueprint. Every row below is something that currently
stops that from feeling like magic.

Last updated 2026-08-17.

## A. Getting connected at all

This is the single largest category. Most people who try an Unreal MCP server never get past it.

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| A1 | Server starts, then "instantly drops connections" from Claude, Cursor, VS Code, Roo Code. `Connection closed Error -32000`. No workaround found. | [Epic forums, UE 5.8 experimental MCP](https://forums.unrealengine.com/t/5-8-experimental-modelcontextprotocol-mcp-server-instantly-drops-connections/2729488) | **Solved (by design)** | This project does not use HTTP/SSE. The transport is stdio to the MCP client and one line-delimited JSON request per TCP connection to the editor. There is no long-lived stream to drop, and no SSE keepalive to starve. |
| A2 | "MCP server connects but does nothing useful" until you manually enable Toolset registries. | [Epic forums](https://forums.unrealengine.com/t/5-8-experimental-modelcontextprotocol-mcp-server-instantly-drops-connections/2729488) | **Solved** | Enabling the plugin is the only step. There is no second opt-in registry, no per-toolset enablement, and every capability the plugin implements is exposed as a tool (enforced by `npm run check:parity`). |
| A3 | `Connection refused` with no indication of which of the five possible causes it is. | [PearceMullins/ue5-mcp troubleshooting](https://github.com/PearceMullins/ue5-mcp/blob/main/troubleshooting.md), [remiphilippe/mcp-unreal](https://github.com/remiphilippe/mcp-unreal) | **Solved** | `ECONNREFUSED` returns an ordered checklist naming the exact log line to look for (`UnrealMCPBridge: listening on 127.0.0.1:<port>`), the env var to fix a port mismatch, and the modal-dialog case. It also states plainly that nothing was sent, so nothing changed. |
| A4 | `MCP Unreal: Unexpected token 'C', Connection...` — the client got non-JSON and reported a parse error with no diagnosis. | Community reports, multiple projects | **Solved** | A non-JSON reply is diagnosed as "something other than the bridge is on this port, or the plugin build is older than this server", and echoes the first 200 bytes received. |
| A5 | Requires the Python Editor Script Plugin plus Remote Execution enabled in project settings. | [runreal/unreal-mcp](https://github.com/runreal/unreal-mcp), [kvick-games/UnrealMCP](https://github.com/kvick-games/UnrealMCP) | **Solved (by design)** | No Python. The bridge is C++ against Kismet2/EdGraph/AssetRegistry, so there is no scripting plugin to enable and no `execute_python` path to crash in. |
| A6 | Zombie Node processes have to be killed by hand; both the editor and the client need a full restart to reconnect. | [runreal/unreal-mcp](https://github.com/runreal/unreal-mcp) | **Solved** | The MCP server holds no editor connection between calls, so it cannot go stale. Restart the editor whenever you like; the next tool call reconnects. |
| A7 | "Unable to start" / "Can't connect to MCP server in Cursor" with no further detail. | [chongdashu/unreal-mcp #32, #23](https://github.com/chongdashu/unreal-mcp/issues) | **Partly** | Every socket error code now maps to a specific, actionable message. Still missing: a single `unreal_doctor` preflight that reports engine version, plugin version, project name, and index state in one call. On the backlog. |

## B. Engine version fragility

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| B1 | Plugin fails to compile on the user's engine version (≤5.4, 5.5+, 5.6, 5.7.4 all reported separately). | [chongdashu #48, #43, #31](https://github.com/chongdashu/unreal-mcp/issues), [ChiR24 #542, #492](https://github.com/ChiR24/Unreal_mcp/issues) | **Partly** | One source tree builds for both UE 5.6 and 5.8 with zero source changes, verified by live sessions on both. Prebuilt binaries are published per engine version so most users never compile anything. Not yet verified on 5.7. |
| B2 | The plugin silently refuses to load because `.uplugin` pins an `EngineVersion` the build tools ignore but the runtime loader honors. | Found in this project's own UE 5.6 bring-up | **Solved** | The hard pin was removed. This one is worth naming because every build check passed while the editor stopped on a modal incompatibility dialog and the bridge never started, which presents to the user as complaint A3. |
| B3 | A C++ signature change leaves Blueprints full of `in use pin X no longer exists, please refresh node`. | Widely reported UE-wide, not MCP-specific | **Solved** | `unreal_refresh_blueprint` performs the right-click Refresh Nodes repair across a Blueprint and reports the before/after error count. |

## C. Stability and destructiveness

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| C1 | The editor hard-crashes on node creation (`K2Node_SpawnActorFromClass`). | [ChiR24 #499](https://github.com/ChiR24/Unreal_mcp/issues) | **Partly** | Node creation goes through `unreal_find_node`'s reflection-verified catalog, and an unknown name fails with `didYouMean` rather than reaching the engine with garbage. No fuzz suite over every spawnable node type yet. |
| C2 | `execute_python` fatal crashes are undiagnosable. | [ChiR24 #525](https://github.com/ChiR24/Unreal_mcp/issues) | **Solved (by design)** | There is no arbitrary code execution path. Every command is a typed operation with structured errors. |
| C3 | The agent modified my Blueprints and I cannot get back to where I was. | Recurring concern across projects; flagged in this project's own competitive survey | **Solved** | Every write runs inside a named `FScopedTransaction` ("MCP: Add Node"), so a human can Ctrl+Z the agent's work in the editor. |
| C4 | The agent deleted something still in use. | Recurring concern | **Solved** | `unreal_delete_asset` is blocked by default if anything outside the delete set still references the target, and returns the blocking referencers. `force: true` is required to override. |
| C5 | An asset path the model invented silently resolves to `None`, leaving a broken Blueprint that still compiles. | Found in this project's own live sessions | **Solved** | Property writes fail loudly on an unresolved asset path instead of setting `None`, and the error points at `unreal_list_assets` for the real path. |
| C6 | A timeout leaves the caller unsure whether the write landed, so it retries and applies it twice. | Generic to every MCP over a stateful editor | **Solved** | Timeouts are per-command and sized to the operation, and the timeout message states explicitly that a timeout is not a rollback and that current state must be read before retrying a write. |

## D. Token cost and context bloat

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| D1 | "Your MCP server is eating your context window": tool definitions alone consume the budget before the user's message is read. | [apideck](https://www.apideck.com/blog/mcp-server-eating-context-window-cli-alternative), [Albato on MCP context bloat](https://albato.com/blog/publications/embedded-mcp-context-bloat-hallucinations) | **Partly** | Measured, not guessed: the full set is 39 tools and ~11.8k tokens. `UNREAL_MCP_PROFILE=core` exposes 16 tools for ~5.0k (58% less) while still covering the whole authoring path. Cutting the instructive descriptions was rejected deliberately: they are why a weaker model succeeds, so the trade is offered to the user rather than forced on everyone. A gateway/namespaced pattern would go further and is still open. |
| D2 | Reading an existing Blueprint dumps enormous raw engine data. | The problem this project was started for | **Solved** | Tiered reads: list Blueprints, then graphs, then a per-node summary with connected pins only, then full detail for exactly one node. No raw engine dump is ever returned. |
| D3 | Re-scanning the project on every question. | Competitive survey of 9 projects | **Solved** | `FMCPProjectIndex` builds once, caches to disk, and stays fresh from `AssetRegistry` delegates rather than polling or rescanning. |
| D4 | Mechanical indexing work burns frontier-model tokens. | This project's design goal | **Solved (optional)** | Point `UNREAL_MCP_LOCAL_LLM_URL` at Ollama or anything OpenAI-compatible and indexing summaries are generated locally, for free. Entirely optional. |

## E. The model does not know Unreal

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| E1 | The model invents node names, function names, and pin names that do not exist. | Universal; the most common cause of a failed edit | **Solved** | `unreal_find_node` and `unreal_get_node_signature` read the running engine's real Blueprint-callable surface via reflection (12,402 functions on 5.6, 15,775 on 5.8). Answers are correct for the engine version actually open, not recalled from training. |
| E2 | Wrong function name produces a cryptic engine error and a dead end. | Same | **Solved** | `unreal_add_node` returns `didYouMean` near-misses from the catalog. The mistake is recoverable in one step. |
| E3 | The calling agent has to rediscover the right tool-call order every session. | Adopted from the competitive survey | **Solved** | [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) ships the working call order, the exec-pin sharp edges, and the compile-before-claiming-done rule. |
| E4 | Can't create a Blueprint from a specific parent class (e.g. Character). | [chongdashu #21](https://github.com/chongdashu/unreal-mcp/issues) | **Solved** | `unreal_create_blueprint` takes any parent class by name or path, resolved through the engine's own class registry. |

## F. Output quality: functional but not AAA

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| F1 | "Blueprint spaghetti that spirals out of control" — AI output compiles but no human can read it. | [StraySpark, Aura vs MCP 2026](https://www.strayspark.studio/blog/aura-vs-mcp-ai-assistants-unreal-engine-2026) | **Solved** | `unreal_build_graph` auto-lays-out what it built, by default, with no coordinates from the caller: layered left-to-right ranking, crossing reduction, exec-chain straightening, and vertical separation between chains. The model cannot emit a pile at the origin even if it tries, because it does not choose the positions. |
| F2 | Generated graphs have no comments, default positions, no grouping, no naming discipline. | Same, and this project's own M7 milestone | **Solved** | Positions and grouping come from auto-layout; naming discipline is now checked: `unreal_review_blueprint` flags placeholder names (`NewVar`, `Temp`, `Test`), unlabelled sections, dead nodes, and empty events, each with the fix. Per-node explanatory comments remain the model's call, but a graph that lacks structure no longer passes silently. |
| F3 | A compiled Blueprint is treated as a finished feature, without anyone checking it runs. | Generic | **Solved** | `unreal_start_pie` / `unreal_pie_status` / `unreal_stop_pie` run the game, including multi-client sessions for replication. Compiling proves validity; running proves it works. |
| F4 | Nothing tells the model its output is bad, so it declares victory on work a reviewer would reject. | Generic to AI-authored code; the root cause behind F1/F2 | **Solved** | `unreal_review_blueprint` is the missing feedback signal: dead nodes, unhandled `Cast Failed` paths, leftover `Print String`, placeholder names, empty events, heavy Tick, oversized graphs. Findings carry the fix and the node ids; the report carries one `nextAction`. `unreal_build_graph` attaches it to its own result unasked, because the model most in need of the feedback is the one that would never ask. |

## G. Missing capability

| # | Complaint | Source | Status | What this project does |
| --- | --- | --- | --- | --- |
| G1 | Everything needed to turn a Blueprint into something that runs (levels, actors, components, class defaults, input, PIE) was implemented in the plugin but unreachable from any AI client. | Found in this repo, 2026-08-17 | **Solved** | 14 commands were registered as MCP tools, and `npm run check:parity` now fails the build if the two sides ever diverge again. |
| G2 | UMG / widget authoring support requested. | [chongdashu #26](https://github.com/chongdashu/unreal-mcp/issues) | **Open** | Widget Blueprints are readable, but there is no widget-tree authoring tool. Backlog. |
| G3 | Blueprint-to-C++ conversion requested. | [chongdashu #28](https://github.com/chongdashu/unreal-mcp/issues) | **Open** | Out of scope for now; noted. |
| G4 | Linux support unclear / undocumented. | [chongdashu #35](https://github.com/chongdashu/unreal-mcp/issues) | **Open** | The plugin has no platform-specific code and the server is Node, so it should work; nothing has been verified on Linux, so nothing is claimed. |
| G5 | Struct and enum authoring fails or is missing. | [ChiR24 #566, #510](https://github.com/ChiR24/Unreal_mcp/issues) | **Open** | No `UUserDefinedStruct` / `UUserDefinedEnum` authoring here yet. Worth adopting; the reported 5.8 `SetEnums` overload trap is worth knowing about before starting. |
| G6 | Headless / editor-not-running mode. | Competitive survey | **Open** | The architecture requires a running editor. A real limitation, stated rather than hidden. |

## How to add to this document

Add a row when you find a complaint in the wild, with its link, even if the answer is "Open". A
complaint with no row is a complaint nobody is tracking. Update the status when the code changes,
and keep **Open** rows honestly open: the value of this file is that it can be trusted.
