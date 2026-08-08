# Recommended agent workflow

How an AI assistant should drive these tools to build Blueprint logic reliably. This exists
because the difference between a smooth run and a flailing one is almost never model quality, it
is tool-call order. Ship this to your agent as context (a system prompt block, a Claude Code
Skill, or CLAUDE.md section) when working on an Unreal project through this MCP server.

## The golden path for building a feature

1. **Orient once, cheaply.** `unreal_get_project_overview` first. It costs one index lookup and
   tells you the project's shape: how many Blueprints, in which folders, derived from what.
2. **Find, don't enumerate.** `unreal_search_project` to locate the Blueprints, functions, and
   variables relevant to the request. Never list everything and read through it.
3. **Read tiered, narrow as you go.** `unreal_list_blueprint_graphs` for a Blueprint you will
   touch, `unreal_read_blueprint_summary` for the one graph that matters,
   `unreal_read_node_detail` only for nodes you will wire into. Do not pull full graphs you do
   not need; that cost is exactly what this server exists to avoid.
4. **Check reality before writing.** For any function call you are not certain about,
   `unreal_find_node` (search by intent) then `unreal_get_node_signature` (exact pins). Guessing
   Unreal's API surface from memory is the single most common cause of a failed edit. If you do
   guess and miss, the error's `didYouMean` list is there to correct you in one step; use it
   rather than retrying blind.
5. **Write in small batches.** `unreal_add_node` / `unreal_connect_pins` /
   `unreal_set_pin_default_value` for one coherent piece of logic at a time. Node ids returned by
   `unreal_add_node` are persistent GUIDs; hold onto them instead of re-reading the graph.
6. **Compile after every batch.** `unreal_compile_blueprint`, always, before telling the user
   anything is done. A graph can look structurally fine and still fail to compile. Zero errors is
   the definition of done for a batch, not "the calls returned ok".
7. **Save when a unit of work is complete.** `unreal_save_blueprint`. Edits live only in editor
   memory until saved.

## Sharp edges that remain

Learned by building a full replicated multiplayer feature through these tools; every item below
cost one failed call to discover:

- **The target pin on function calls is named `self`**, even though the editor displays it as
  "Target". Wire component and object targets to `.self`.
- **Cast output pins on Blueprint classes contain spaces**: casting to `BP_VacuumPlayer` yields
  a pin named `AsBP Vacuum Player`, not `AsBP_VacuumPlayer`. Native classes have no spaces
  (`AsPawn`).
- **Struct pin defaults are comma triples**: vectors and rotators take `"0, -90, 0"`, never the
  named form `"(Pitch=0,Yaw=-90)"`. Rotator order is Pitch, Yaw, Roll.
- **Enum pin defaults take the entry name**: `"SnapToTarget"`, `"MOVE_Falling"`.
- **Create events before their callers.** A `CallFunction` for a CustomEvent (or a function from
  `unreal_create_function`) resolves against the skeleton class, which updates when the event is
  created, so within one `build_graph` batch order the event node earlier in the `nodes` array.
- **Re-runs are not free.** A script that dies mid-way and is re-run will re-create every
  CustomEvent it already made (auto-renamed `Name_0`, `Name_1`) and orphan the old chains as
  dead spaghetti. Before re-running authoring steps, read the graph and skip what already
  exists, or clean up duplicates deliberately. Verify object-property sets took effect by
  checking the echoed value; a path that fails to resolve is an error, not a success.

- **Exec pin names are not uniform.** Regular nodes use `execute` (in) and `then` (out). Branch
  outputs are `then`/`else`. Sequence outputs are `then_0`/`then_1`. **Macro nodes (ForEachLoop,
  WhileLoop, ...) use `Exec` with a capital E** as their input. When unsure, read the node's
  detail; its pins are ground truth.
- **`set_pin_default_value` refuses connected pins** (`pin_is_connected`). Disconnect first, or
  reconsider which pin you meant.
- **Variables must exist before `VariableGet`/`VariableSet` nodes reference them**, via
  `unreal_add_variable`. Inherited parent-class variables are not supported yet.
- **`CallFunction` needs `className` for static library functions.** `PrintString` lives on
  `/Script/Engine.KismetSystemLibrary`, not on your Blueprint. `unreal_find_node` gives you the
  right `className` so you never guess.
- **Position nodes as you place them.** `x`/`y` cost nothing and are cosmetic to the compiler,
  but a human will open this graph later. Lay nodes left to right in execution order.

## Working in a real project (not a scratch one)

- **Touch only what the task names.** If movement already works, do not rebuild movement. Read
  first (`search_project`, graph summaries), reuse existing functions and events, and add the
  smallest graph that delivers the request. The owner's test of good judgment: "if I don't need
  to touch a system that's already in the event graph, I won't touch it."
- **Read the graph before placing nodes.** Fresh Actor Blueprints ship with stub events
  (BeginPlay, Overlap, Tick) near the origin, and existing projects have real logic there. Take
  the max extents from `read_blueprint_summary` and place new work clear of them, or your nodes
  will land on top of theirs.
- **Comment boxes carry the narrative; node comments carry the why.** Fill both. A box whose
  text is just "Comment" is worse than no box.

## Performance judgment (Blueprint cost is real)

- **`GetAllActorsOfClass` is not free**, and neither is anything else that scans the world. Never
  put it on Tick. Prefer a looping timer (0.1-0.2s is imperceptible for gameplay scans) that only
  exists while the feature is active: start it in the event that turns the feature on, clear it in
  the event that turns it off. Caching a found actor is even cheaper, but remember late joiners.
- **Keep casts out of hot loops** where the design allows: filter cheaply first (distance, tags),
  cast last, or type the data so no cast is needed.
- **Treat compile warnings as failures** for graphs you author. `unreal_compile_blueprint` returns
  `warningCount` and messages; "references unknown Axis" is a warning, and it means input is
  silently dead. Zero errors AND zero warnings is the definition of done.

## Cost discipline (tokens are money)

- Prefer `search_project` and `find_node` over any read that returns more than you need.
- `find_node` hits are deliberately compact (no pin lists). Only call `get_node_signature` for
  functions you will actually place.
- If the user runs a local Ollama model, the server enriches search hits with one-line summaries
  for free; nothing needs to change in how you call the tools.

## Honesty rules

- Never report a feature as built until `unreal_compile_blueprint` returned zero errors on every
  Blueprint you touched.
- If a call fails, say what failed and what you did about it. The error strings here are designed
  to be actionable (`didYouMean`, available-macro lists, schema explanations for rejected pin
  connections); act on them, then report.
- Your edits are undoable: each write lands in the editor's undo history under an "MCP:" prefix.
  Tell the user this if they seem hesitant about letting you edit their project.
