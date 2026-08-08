# Feature backlog

Candidate work beyond the current milestones. Two sources: findings from reading this codebase and
the real engine headers directly (Part 1, new), and patterns already surveyed from competing
projects (Part 2, see [COMPETITIVE_LANDSCAPE.md](COMPETITIVE_LANDSCAPE.md) for the full writeup).

Part 1 items were each verified against the actual code or engine headers rather than assumed. The
verification is recorded inline so a future reader can check it rather than trust it.

## Part 1: findings from this pass

### 1. Stable node identity via `NodeGuid` (DONE)

**Shipped.** Node ids are now `NodeGuid`, legacy `"n<index>"` ids are still accepted for one
release but never returned, and `remove_node` captures the id before deletion rather than
dereferencing a freed node. The original writeup follows for context.

**Today:** node ids are `"n<index>"`, a raw index into `UEdGraph::Nodes` at read time.
`mcp-server/README.md` and `docs/M2_STATUS.md` both document the consequence: ids do not survive an
editor restart, and **removing a node shifts every later index in that graph**. M2's status doc
calls this "a real sharp edge." The current mitigation is advisory only: re-read the graph after
any `remove_node`.

**The finding:** UE already persists exactly the identifier needed. In
`Runtime/Engine/Classes/EdGraph/EdGraphNode.h`:

```cpp
/** GUID to uniquely identify this node, to facilitate diffing versions of this graph */
UPROPERTY()
FGuid NodeGuid;
```

It is a `UPROPERTY()`, so it is serialized with the asset and survives editor restarts. Epic's own
comment states its purpose is uniquely identifying a node. `MCPCommandHandler.cpp` **already calls
`NewNode->CreateNewGuid()`** on every node `add_node` creates, so the GUIDs already exist and are
already being written. Nothing is currently reading them back.

**Proposal:** return `NodeGuid` as the node id, and accept it wherever a node id is taken. Keep
accepting `"n<index>"` for one release so existing callers do not break, and resolve GUID first.
This removes the sharp edge entirely rather than documenting around it, and it removes the
"re-read the graph after every removal" tax on every multi-step edit.

This also unblocks a prerequisite the M5 handoff notes flagged: stable cross-session node
references.

### 2. Transactional writes, so a human can undo what the agent did (DONE)

**Shipped.** Every write opens a named `FScopedTransaction` ("MCP: Add Node", ...) and calls
`Modify()` before mutating. Regression-verified live; the Ctrl+Z keypress itself still awaits a
human check. The original writeup follows for context.

**The finding:** `MCPCommandHandler.cpp` contains **zero** occurrences of `FScopedTransaction`,
`Modify()`, or `GEditor`. Verified by search across the whole file.

UE's standard idiom for mutating editor state is to open an `FScopedTransaction` and call
`Object->Modify()` before mutating, which is what registers the change with the editor's undo
buffer. Because the plugin does neither, **none of `add_node`, `connect_pins`,
`set_pin_default_value`, `remove_node`, or `add_variable` can be undone with Ctrl+Z** by a human
working alongside the agent.

This matters more here than in most projects, for reasons the project already acknowledges
elsewhere: these are destructive in-place writes to real Blueprint assets, and
`COMPETITIVE_LANDSCAPE.md` already flags adding a backup/source-control disclaimer as an action
item. Undo is the better answer than a disclaimer, and it is the behavior a user reasonably
expects from anything modifying their Blueprints.

**Proposal:** wrap each write command in an `FScopedTransaction` with a descriptive name (so the
editor's undo history reads "MCP: Add Node" rather than a generic entry) and call `Modify()` on the
graph and Blueprint before mutation. Consider a single transaction spanning a batch of edits, which
would let a human undo an entire agent-authored feature in one step.

### 3. Dry-run / preview mode

Given (1) and (2), a natural third step: let a write command report what it *would* do without
doing it. Cheap to add once writes are transactional, and it fits the "read before write" workflow
guidance worth shipping to the calling agent anyway.

## Part 1b: gaps identified by asking "what would a human coder reach for next?"

Added 2026-08-08 at the owner's request to surface things not yet targeted. Ordered by how hard
they block the "AI does everything a coder does" goal, crossed with token savings.

1. **Batch graph op.** One command that takes a list of nodes, wires, and pin defaults and builds
   them in a single transaction. Today a 10-node graph costs ~25 round trips; batching cuts that
   to 1, which is the single biggest token/latency saver available. Also makes one Ctrl+Z undo an
   entire authored feature.
2. **Class defaults (CDO) editing.** Set any property on a Blueprint's class defaults
   (`bReplicates`, movement speeds, a mesh reference). Without it, half of what a designer tweaks
   per-Blueprint is unreachable.
3. **Components.** Add and list SCS components (StaticMesh, Collision, Audio, custom). An Actor
   Blueprint without components is a brain with no body; this is likely the biggest remaining
   capability gap after functions.
4. **Project settings and INI access.** Read/write config-backed settings objects (default
   GameMode, maps, input). Explicitly requested by the owner ("change settings... the INI").
5. **Blueprint Interfaces and Event Dispatchers.** Create/implement interfaces, add dispatchers,
   bind events. Core to how well-architected Blueprint projects decouple systems, and exactly the
   kind of structure an AI should be encouraged to build.
6. **Enum and Struct assets.** UserDefinedEnum/UserDefinedStruct creation, since real game logic
   grows data types alongside graphs.
7. **Enhanced Input assets.** InputAction + InputMappingContext creation and wiring, since 5.x
   gameplay code starts at input.
8. **Asset management verbs.** Rename/move/duplicate/delete with reference fixup via
   AssetTools, so refactoring is not editor-only.
9. **Blueprint snapshot/diff.** Capture a compact structural snapshot before a batch of edits and
   diff after, so an agent can show "here is what I changed" and a human can review before save.
10. **Event didYouMean.** `add_node`'s `event_function_not_found` should list the parent class's
    overridable events the way function lookups already suggest near-misses.

## Part 2: carried from the competitive survey

Full rationale for each is in [COMPETITIVE_LANDSCAPE.md](COMPETITIVE_LANDSCAPE.md). Listed here so
one document holds the whole backlog.

| Idea | Source | Why it matters |
|---|---|---|
| Gateway or namespaced tool pattern | ChiR24, GenOrca | Shrinks the tool catalog as the tool count grows. Addresses a different context axis than the tiered reads. |
| Bundled agent-workflow doc or Skill | remiphilippe, lilklon | Gives the calling agent the right tool-call order without rediscovering it each session. |
| Blueprint complexity/lint pass | avdo403 | Builds directly on the per-graph node-type histogram M3 already computes. |
| In-editor status UI | kvick-games | Makes bridge state legible to a human without tailing logs. |
| Headless / editor-not-running mode | mirno-ehf, remiphilippe | Current architecture assumes a running editor. Blocks CI and batch use. |
| Documentation index (distinct from the project index) | remiphilippe | Complements M5: engine API docs rather than the project's own structure. |
| Security posture for any non-loopback transport | ChiR24 | Adopt before shipping any networked transport, not after. |
| Precompiled per-engine-version release binaries | GenOrca | Already the practice for 5.8; keep it up for 5.6 and beyond. |

## Suggested ordering

1. **Node identity (`NodeGuid`)** first. It is small, it is closer to a bug fix than a feature, it
   removes a documented sharp edge, and M5 wants stable node references anyway.
2. **Transactional writes** second. Safety-relevant, and independently useful to any human sharing
   the editor with the agent.
3. **M5 node catalog** as the main event (see [M5_DESIGN.md](M5_DESIGN.md)).
4. Everything else as it becomes relevant, with the agent-workflow Skill worth doing early since it
   is nearly free and improves real-world reliability.
