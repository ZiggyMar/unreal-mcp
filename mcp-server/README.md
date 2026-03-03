# unreal-mcp-server

Node/TypeScript MCP (Model Context Protocol) server that exposes Unreal Engine Blueprint
introspection **and edit** tools to an MCP client (Claude Code, Claude Desktop, etc).
It is a thin translator: every tool call opens a short-lived TCP connection to the
`UnrealMCPBridge` C++ editor plugin on `127.0.0.1:8765`, sends one line of JSON, reads one
line of JSON back, and reshapes it into a compact result for the model.

This process does **not** talk to Unreal directly via any engine SDK. It only speaks the
bridge's tiny line-delimited JSON protocol over a loopback TCP socket. The Unreal Editor
(with the `UnrealMCPBridge` plugin enabled) must already be running for any tool except
`unreal_ping` to return useful data; `unreal_ping` itself will simply report the connection
error if the editor/bridge isn't up.

## Prerequisites

- Node.js >= 18
- The `UnrealMCPBridge` plugin built and enabled in the target `.uproject`, with the
  Unreal Editor open on that project (see `../docs/M1_STATUS.md` for the current build
  status and manual steps).

## Setup

```bash
cd mcp-server
npm install
npm run build        # compiles src/ -> dist/
npm run typecheck    # tsc --noEmit, no build artifacts
```

Run it standalone (mostly useful for manually checking it starts without error — a real
MCP client normally launches this itself over stdio):

```bash
npm start
```

## Tools exposed

### Read-only (Milestone 1)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_ping` | `ping` | Liveness check for the editor bridge. |
| `unreal_list_blueprints` | `list_blueprints` | Project-wide (or path-scoped) list of Blueprint assets: name, path, parent class. |
| `unreal_list_blueprint_graphs` | `list_blueprint_graphs` | Graph names + node counts for one Blueprint. |
| `unreal_read_blueprint_summary` | `read_blueprint_graph_summary` | Compact per-node summary of one graph: id, type, title, connected pins only (no position/cosmetic metadata). |
| `unreal_read_node_detail` | `read_blueprint_node_detail` | Full pin/property detail for exactly one node by id. |

These mirror the tiered-read strategy in `../ARCHITECTURE.md`: list graphs -> summarize one
graph -> drill into one node, instead of ever dumping a whole Blueprint's raw engine JSON.

### Write/edit (Milestone 2)

| Tool | Bridge command | Purpose |
|---|---|---|
| `unreal_create_blueprint` | `create_blueprint` | Create a new Blueprint asset at a path with a given parent class; saves to disk by default. |
| `unreal_add_node` | `add_node` | Add an Event/CustomEvent/CallFunction/VariableGet/VariableSet node; returns its new node id immediately. |
| `unreal_connect_pins` | `connect_pins` | Connect an output pin to an input pin (exec or data), via the graph schema. |
| `unreal_set_pin_default_value` | `set_pin_default_value` | Set a literal default on an unconnected input pin. |
| `unreal_remove_node` | `remove_node` | Remove a node by id, breaking its links first. |
| `unreal_add_variable` | `add_variable` | Add a member variable (compact type descriptor: `bool`, `int`, `float`, `vector`, `object:<Class>`, ...). |
| `unreal_compile_blueprint` | `compile_blueprint` | Compile and return structured errors/warnings. **Run this after every batch of edits** — see below. |
| `unreal_save_blueprint` | `save_blueprint` | Save the Blueprint's package to disk. |

**Always call `unreal_compile_blueprint` after a batch of `add_node`/`connect_pins`/
`add_variable` calls, before reporting success to the user.** A graph can look
