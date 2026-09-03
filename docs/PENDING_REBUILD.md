# Changes waiting on a plugin rebuild

C++ in `UnrealMCPBridge` only takes effect when the plugin is compiled, and compiling needs the
editor closed. Everything here is written, reviewed against the engine headers, and **not run**.

Killing the editor to rebuild has destroyed unsaved work in this project before — an asset that had
never been written to disk, where `dv status` showed clean *because* nothing had been written. So
these wait for the editor to be closed deliberately, by its owner, rather than being forced through.

Until then the TypeScript side degrades on purpose: `tidy_layout` drops the moves that needed a
resize instead of carrying nodes out of their comment boxes, and says the plugin needs rebuilding.

## What is queued

### 1. `resize_comment_box` — a new `organize_graph` action

`MCPCommandHandler.cpp`, beside `add_comment_box`. Sets `NodeWidth`/`NodeHeight` (and optionally
`NodePosX`/`NodePosY`) on an existing `UEdGraphNode_Comment`, inside an `FScopedTransaction` so it
is undoable. Each dimension is optional; absent means unchanged, not zero.

**Why:** a comment box owns the nodes inside it. When a straightened chain grows past the box's
edge, the fix is to widen the box — what a person does. Without this the tidier could only refuse
the move and leave the wire bent.

**The workaround, until it is built.** A box can be widened with the tools that already exist:
`unreal_remove_node` on the box, then `unreal_organize_graph add_comment_box` at the new size. A
comment box carries only geometry and text, so nothing is lost as long as both are preserved — read
them first, and use the rectangle `tidy_layout` reports in `growths`, which has already been checked
against every other box and node. Used once on `BP_Player`: "Nearest Pool" 2904 → 3210 wide, after
which tidying took that system from four backward wires to zero.

Two reasons this is not automated. The recreated box gets a new node id, so anything holding the old
one is stale. And it drops `NodesUnderComment`, which is the only record of what the box used to own
— the very thing the second change below exists to read. A person doing it deliberately is fine; a
layout pass doing it silently is not.

**Verify after rebuild:**

1. `unreal_review_layout` with `path` on any blueprint with boxes — note a box's `id`, `width`, `height`.
2. Call `unreal_organize_graph` with `action: "resize_comment_box"`, that `nodeId`, and the box's
   **current** width and height. Expect `{id, x, y, width, height}` back, unchanged. Nothing in the
   graph should move.
3. Repeat with `width` 200 larger. Re-read the summary: the box is wider, no node has moved.
4. Ctrl+Z in the editor. The box returns to its old width — this is what proves the transaction.
5. Call it with an ordinary node's id. Expect `not_a_comment_box`, not a silent success.
6. Call it with `width: 0`. Expect `bad_param`.
7. `unreal_tidy_layout` on a scope whose chain overruns its box. Expect `boxesGrown` in the result
   and **no** `resizeUnavailable`.

### 2. `holds` — `NodesUnderComment` in the graph summary

`MCPCommandHandler.cpp`, in `HandleReadBlueprintGraphSummary`'s comment-node branch. Emits the ids
of the nodes a box believes it holds, omitted entirely when the list is empty.

`GetNodesUnderComment()` returns `const FCommentNodeSet&`, which is a `TArray<UObject*>` despite the
name — raw pointers, which can be stale if a node was deleted since the box last recorded it, so
each is cast and null-checked rather than trusted. (The first draft of this used `TSoftObjectPtr`
and `.Get()`; reading the engine header is what caught it.)

**Why:** a whole-graph relayout moves nodes and leaves comment boxes where they are. Measured in
`GM_Gameplay`: 63 of 206 nodes at x=0, only 21 distinct x values across a 6928-unit span — column
grid output — and **eleven** boxes left naming empty rectangles, `Countdown` and `Win Screen`
among them. Once the nodes have moved, nothing in their positions or their wiring says which box
used to own them. `NodesUnderComment` is the only surviving record, so this is what makes the repair
possible: move the box back over the nodes it still lists, rather than deleting a box somebody meant.

**Verify after rebuild:**

1. Read any blueprint summary with `withPositions: true`. Boxes that hold nodes now carry `holds`;
   boxes that hold none carry no `holds` key at all.
2. Cross-check one box: every id in `holds` should be a node whose x/y is inside that box's extent.
   A graph nobody has relaid out should agree exactly.
3. Read `GM_Gameplay`. The eleven boxes `review_layout` reports as `emptyBox` are the interesting
   case — if their `holds` lists are populated, the stranded nodes are recoverable and the repair
   can be built. **If those lists are empty too, the record did not survive and the boxes can only
   be deleted, not restored.** That question is open until this runs.

## How to rebuild

**Compile it first, without going near the project.** Copying unverified C++ into a project's
`Plugins/` folder risks the editor failing to open next time — Unreal rebuilds a changed plugin on
startup, and a compile error there is a locked door.

```
npm run check:engines          # RunUAT BuildPlugin, public engine APIs only, no project touched
```

**Done, 2026-09-03: both changes compile.** `node scripts/build-engines.mjs --only 5.6 --isolated`
returned `5.6 ok (131s)` with the `resize_comment_box` action and the `NodesUnderComment` read in
place. So the remaining risk is not "does this build" but "does it behave", which is what the
verification steps below are for. Reading the engine header rather than guessing is what got it
there: the first draft iterated `TSoftObjectPtr` and called `.Get()`, and `FCommentNodeSet` is a
`TArray<UObject*>`.

**Then copy it in.** A project does not read this repo; the plugin is *copied* into
`<Project>/Plugins/UnrealMCPBridge`, and that copy is what builds and runs. This step was missing
from these instructions and the omission is not academic: at the time of writing the game project's
copy was 83 lines behind this repo, so a rebuild would have compiled the old source and reported
success while changing nothing.

```
Copy-Item -Recurse -Force UnrealMCPBridge "M:\Unreal Projects\Anti-VirusSquad\Plugins\"
```

**Then rebuild, with the editor closed:**

```
"M:/Unreal/UE_5.6/Engine/Build/BatchFiles/Build.bat" AVSEditor Win64 Development -Project="<the .uproject>" -WaitMutex
```

The editor currently in use is **UE 5.6** (`M:\Unreal\UE_5.6`), not the 5.8 install on `F:`. Build
against the one the project actually opens with.

To confirm which copy a project has, grep it rather than assuming:

```
grep -c resize_comment_box "<Project>/Plugins/UnrealMCPBridge/Source/UnrealMCPBridge/Private/MCPCommandHandler.cpp"
```

## Retitling a comment box works today, without the rebuild

`organize_graph` in the project's plugin copy accepts only `set_node_comment`, `add_comment_box` and
`move_node` — `resize_comment_box` is one of the two changes waiting on the rebuild, and asking for
it there returns `unknown_action`.

A comment box IS a node, though, and its text is its comment. So `set_node_comment` with the box's
node id retitles it, which is what `auto_layout_graph` leaves you needing: it names a box after the
entry event it found ("Event BeginPlay"), and the house style wants a feature name. Measured on
BP_TrailerDirector and BP_TrailerFighter today — both went from an auto-named box to "Start The
Round" and "Fight The Nearest Virus" that way.

What still needs the rebuild is GROWING a box. Without `resize_comment_box` the only way to bring a
stray node inside is to move the NODE, which is fine for one or two and wrong for a system.
