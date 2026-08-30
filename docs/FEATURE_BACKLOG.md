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

1. **Batch graph op. (DONE)** `build_graph` ships: nodes with caller refs, "ref.pin" connections,
   pin defaults, compile-by-default, one call. Atomicity is real and hand-implemented, since
   `FScopedTransaction::Cancel` turns out to discard only the undo record, not the mutations
   (verified against engine source after the live suite caught orphaned nodes). A failed batch
   leaves the graph byte-for-byte unchanged.
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

## Part 1c: from the owner's vacuum-challenge review (2026-08-08)

1. **Enhanced Input support.** The challenge used legacy action/axis mappings because they needed
   the least new tooling; that is the wrong default for UE5-era projects. Needed: create
   InputAction and InputMappingContext assets, an EnhancedInputAction event node type, and an
   AddMappingContext convenience. Rule until then: in an existing project, detect and conform to
   whatever input system the project already uses.
2. **Blueprint lint command.** Server-side detection of the antipatterns any general model
   produces because it thinks engine calls are free: GetAllActorsOfClass (or other world scans)
   driven by Tick, casts inside hot loops, missing authority checks around server-only mutations,
   unconsumed pure nodes. The owner's friend put it best: "AI seems to think GetAllActorsOfClass
   is nearly free." Rides on data the reads already expose.
3. **Engine patterns cheat sheet ("what does the engine offer").** A curated, searchable map from
   need to engine facility: tabular game data -> Data Tables, designer-tuned curves -> Curve
   Tables, persistent state -> SaveGame, decoupling -> interfaces/dispatchers/tags, shop-style
   systems -> Data Table + struct rows, and so on. It must GUIDE, not GATE: the model consults it
   before architecting but is never told "it's not in the sheet, so don't." Pairs with the
   competitive-survey docs-index idea and the M5 palette remainder.
4. **PIE input automation.** The challenge's runtime proof booted a 2-player session and checked
   for errors, but nobody pressed F; simulating input in PIE would close that gap.
5. **Spawn-complete pattern in the workflow doc.** For cache-once designs, fire an event once all
   expected players have spawned (GameMode PostLogin count), query once, cache. Avoids both the
   per-tick scan and the first-tick race where clients have not spawned yet.

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

---

## Gameplay Ability System (identified 2026-08-30, from Epic's 5.8 toolset list)

**The finding:** Epic's first-party plugin ships an `AttributeSetToolset` in a `GASToolsets` plugin.
This bridge has nothing for GAS — verified by grep across the whole repo, C++ and TypeScript: no
mention of `GameplayAbility`, `AttributeSet`, or gameplay effects anywhere.

**Why it matters:** GAS is how a large share of serious UE projects model health, damage, cooldowns,
stats and status effects. On such a project, "reduce the player's health when hit" is not a
Blueprint variable question at all — it is an attribute set, a gameplay effect and an ability. A
bridge that cannot see any of that will confidently give the wrong answer rather than say it cannot
look, which is worse than not supporting it.

**Scope, honestly:** this is a subsystem, not a tool. A useful first cut is read-only — list the
attribute sets a project defines, their attributes and defaults, and which gameplay effects modify
them — because reading is where this project's leverage has always been, and it is what makes the
"I tell it a bug in plain text" workflow work on a GAS project at all. Authoring effects and
abilities is a larger second step.

**Not started.** Recorded here so it is tracked rather than rediscovered.

---

## Asset-type coverage (measured 2026-08-30)

Counted rather than guessed at. Asking the real project this is developed on what it actually
contains gives a list of what "supports everything a normal human would have for this engine" has to
mean. 38 asset classes are present; these are the ones that matter, with what the bridge can do.

| class | count | reachable? |
|---|---|---|
| Blueprint | many | **full** — read, author, compile, review |
| WidgetBlueprint | 152 | **full** — tree, properties, bindings |
| MaterialFunction | 54 | partial — materials and instances yes, function graphs no |
| **DataAsset** | **41** | **full** — read/set properties (added on the strength of this count) |
| InputAction | 35 | partial — mappings can be listed and added |
| **AnimMontage** | **27** | **none** |
| World | 25 | partial — actors, components, spawn, levels |
| SkeletalMesh | 22 | none (referenced only) |
| **BlendSpace** (+1D, +AimOffset) | **29** | **none** |
| SoundCue | 20 | none |
| DataTable | 20 | **full** |
| UserDefinedStruct / Enum | 26 | **full** |
| NiagaraSystem / Emitter | 17 | none |
| **AnimBlueprint** | **6** | **none** |
| LevelSequence | 9 | none |
| BehaviorTree / Blackboard | 3 | none |

**Animation was the largest gap and the read half is now closed** — `unreal_read_anim_blueprint`
returns state machines, states and the conditions on every transition, verified against this
project's `ABP_NewPlayer` (2 machines, 15 states, 1,807 tokens). What remains unread is Montages (27)
and Blend Spaces (29) as assets in their own right, and nothing can AUTHOR animation at all. The
original note follows.

**The largest remaining gap is animation: 62 assets across AnimBlueprints, Montages and Blend
Spaces, and nothing can read any of them.** For a game whose enemies walk, "the enemy is not
animating" is a question this bridge cannot even look at — it can see the Blueprint that sets a
variable and not the state machine that reads it. That is the next thing worth building, and the
useful first cut is read-only: list an AnimBlueprint's state machines, their states and the
transition rules, the way `read_blueprint_summary` does for an Event Graph.

Niagara (17) and Level Sequences (9) are real but narrower; Behavior Trees (3) are barely used here
and would matter much more on a project built around them.
