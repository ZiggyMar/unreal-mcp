# Blueprint handbook for a model that was never trained on Unreal

You can already program. This is the Unreal-specific knowledge you are missing, in the order you
need it. Nothing here is about how to code; it is about the shape of the engine, the names it uses,
and the traps that cost a call each to discover.

Read this once at the start of a session. It is written to be enough on its own: if you follow it
you will not need to guess, and guessing is the only way to fail badly here.

## 1. The mental model

A **Blueprint** is a class. It compiles to a real class the engine instantiates, exactly like a
C++ class. It has:

- **member variables** (fields)
- **functions** (methods) — each is a separate graph
- **an EventGraph** — where event handlers live, roughly a set of entry points, not a main loop
- **components** — child objects attached to it (a mesh, a collision shape, a camera). Composition,
  not inheritance.
- **class defaults** — the values every new instance starts with. The Class Default Object, or CDO.

The one genuinely unusual thing: **execution is a wire, not an order.** A graph has two kinds of
connection running through it:

- **exec pins** (white, thick): the order statements run in. If nothing is wired to a node's exec
  input, that node never runs. This is the single most common cause of "the code does nothing".
- **data pins** (coloured, thin): values. These are pull-based. A data node computes when whatever
  consumes it runs. A data-only node with nothing consuming it is dead.

So a Blueprint node graph is a statement list drawn as a chain, with expressions hanging off it.

## 2. The class hierarchy you actually need

```
UObject            everything
 └─ AActor         anything that can exist in a level
     └─ APawn      an actor that can be possessed/controlled
         └─ ACharacter   a pawn with a humanoid movement component and capsule
```

Alongside those:

- **AController / APlayerController** — the thing that possesses a pawn. Input, camera, UI ownership
  live here. It persists when the pawn dies; the pawn does not.
- **AGameModeBase** — server-side rules: which pawn class to spawn, scores, win conditions. Exists
  only on the server in multiplayer.
- **AGameStateBase** — state everyone is allowed to see.
- **APlayerState** — per-player state everyone can see (name, score).
- **UActorComponent / USceneComponent** — behaviour attached to an actor. `USceneComponent` has a
  transform; `UActorComponent` does not.
- **UUserWidget** — a UI widget (see the UMG section of AGENT_WORKFLOW.md).

**Choosing a parent class is the highest-leverage decision in a Blueprint.** Getting it wrong is
expensive to undo. Rules of thumb:

- Player or enemy that walks: `Character`
- Vehicle, turret, drone, anything controlled but not humanoid: `Pawn`
- Door, pickup, trigger, prop: `Actor`
- Reusable behaviour you want on many actors: `ActorComponent`
- Something with no world presence (a manager, a data holder): `Object`, or better, a
  `GameInstanceSubsystem`

## 3. Events: your entry points

- `Event BeginPlay` — the actor exists and the level is running. Set-up goes here.
- `Event Tick` — every frame. **Treat as a last resort.** See the performance section.
- `Event ActorBeginOverlap` / `EndOverlap` — something entered a collision volume.
- `Event Hit` — a physics blocking hit.
- `Event Destroyed`
- **Input events** — from a mapping added with `unreal_add_input_mapping`.
- **Custom events** — your own named entry points. Also how you do RPCs.

There is no `main()`. If logic is not reachable from an event, it does not run.

## 4. Getting a reference to something else

This is where a model without Unreal training usually stalls. The options, best first:

1. **A variable you set deliberately.** Add an `object:<Class>` variable and assign it on
   BeginPlay or when spawning. Explicit, cheap, and survives refactoring.
2. **`Get Player Character` / `Get Player Controller`** — for the local player. Cheap and common.
3. **Component lookups** — `Get Component By Class` on an actor you already have.
4. **Overlap/hit events** — the other actor arrives as a pin on the event. Use it.
5. **`Get All Actors Of Class`** — works, but it walks every actor in the level. Acceptable once in
   BeginPlay; never in Tick.

To use a generic reference as a specific type you must **cast**. A cast has two exec outputs, and
the failure one is the trap:

- `Cast To BP_Player` succeeds → continue on the main exec output
- **Cast Failed** → wire this to *something*, even a Print String during development. An unhandled
  cast failure is silent: the rest of the chain simply never runs, and nothing tells you why.

Cast output pin names on Blueprint classes contain spaces: casting to `BP_VacuumPlayer` produces a
pin called `AsBP Vacuum Player`. Native classes do not: `AsPawn`.

## 5. Interfaces: how to talk to something without knowing what it is

A **Blueprint Interface** is a set of function signatures a class promises to implement. It is the
correct answer to "how does my bullet damage anything damageable without knowing every type".

Without an interface you get a chain of casts: is it an enemy? is it a barrel? is it a player? That
chain grows forever and every new damageable thing means editing the bullet. With an interface, the
bullet calls `Apply Damage` on anything implementing `BPI_Damageable` and never learns what it hit.

If you find yourself writing a third cast in a row, you want an interface.

## 6. Variables, types, and the type descriptors this server uses

Where a type string is taken (`unreal_add_variable`, function inputs and outputs, struct fields):

```
bool  byte  int  int64  float  double  string  name  text
vector  rotator  transform
object:<Class>     a reference to an actor/component/object, e.g. object:StaticMeshComponent
class:<Class>      a class itself, not an instance, e.g. class:Actor  (for "what should I spawn?")
struct:<Name>      your own struct, e.g. struct:S_ItemData
enum:<Name>        your own enum, e.g. enum:E_WeaponState
```

`text` is for anything a player reads (it can be localised). `string` is for identifiers and
debugging. `name` is a cheap immutable identifier used for bones, sockets, and tags.

**Structs and enums are not optional polish.** Six loose variables that always travel together are
one struct. An integer standing for a state is an enum. A model that skips this produces a project
nobody can maintain, and the user will not refactor it later.

## 7. Multiplayer, in one page

Skip this if the project is single-player, but check first, because retrofitting is painful.

- The **server** is authoritative. Clients ask; the server decides.
- **`bReplicates`** on the class defaults makes an actor exist on clients at all.
- **Replicated variables** sync server → client. Never client → server.
- **Custom events** carry a replication setting:
  - *Run on Server* — a client asking the server to do something. Needs the calling actor to be
    owned by that client.
  - *Multicast* — server telling everyone. For cosmetic effects.
  - *Run on Owning Client* — server telling one player.
- **Cosmetic things** (sounds, particles, camera shake) belong in multicast or in a replicated
  variable's OnRep, not in the authoritative path.

The rule that prevents most bugs: **decide on the server, show on every client.**

### The one that costs a day

A `Server_` event that sets a variable which is not marked Replicated. The server changes its own
copy; no client ever sees it; the bug reports as "it works for the host". `unreal_review_blueprint`
checks for exactly this and names the variable, because it is invisible to every other signal you
get - it compiles, it reviews clean everywhere else, and one-player testing cannot reveal it.

### Moving another player over the network

The bug that looks like lag and is not.

A character being pushed, pulled, dragged or launched by something else stutters and rubber-bands on
every machine except the host. People reach for "netcode is hard" or blame their connection. It is
almost always this:

**Character movement is predicted on the owning client.** The client simulates its own movement
immediately and the server corrects it when they disagree. That is what makes normal movement feel
instant. It also means that if a force is applied to a character **only on the server**, the owning
client predicts standing still, the server says otherwise, and the client is snapped back several
times a second. The visible result is a stuttering camera and a sliding model - exactly what a bad
connection looks like, on a LAN with no packet loss at all.

The trap is that the movement code itself is usually correct. What is missing is on the other side:

```
Event Tick -> DraggedByVacuum -> Branch -> Branch -> Add Force
                                   ^         ^
                       reads VaccumDragStrength and LocationDragged
                       ...both of which are not replicated
```

Tick runs everywhere, so this LOOKS like it runs on the client too. It does - and does nothing,
because the values it branches on are still at their defaults there. Only the server has them, so
only the server applies the force.

**What to check, in order:**

1. Every variable the movement branches on or scales by - is it replicated? If the client cannot
   see the inputs, it cannot predict the movement.
2. Where the force is applied. Server-only means guaranteed correction.
3. Whether the state that says "I am being dragged" is replicated at all. If it lives in a component
   as a plain array, clients do not know the drag is happening.

**Ways to fix it, cheapest first:**

- **Replicate the inputs.** If the owning client can see the same drag strength and target, its Tick
  applies the same force, and prediction agrees with the server. Smallest change, and usually enough
  to remove the gross rubber-banding.
- **Drive it through a replicated state change** - a replicated bool with `OnRep`, or a custom
  movement mode - rather than a per-frame force that only one machine knows about.
- **For a one-off shove, use LaunchCharacter on the owning client as well as the server.** A single
  impulse both sides agree on beats a per-frame force only one side applies.

The general rule, which is worth more than the specific fix:

> **If the client cannot see the inputs, it cannot predict the outcome, and it will be corrected.**
> Replicate what the movement reads, not just what the movement did.

## 8. Performance judgment

Blueprint execution cost is real but it is almost never the node count. It is:

- **Tick.** Every node under Event Tick runs 60+ times a second per instance. Twenty ticking
  actors is a thousand executions a second. Prefer: events, timers (`Set Timer by Event`),
  overlaps, and `OnRep` callbacks.
- **`Get All Actors Of Class`** in a hot path. It walks the level.
- **Casting every frame** instead of caching the result in a variable.
- **Spawning and destroying** repeatedly instead of pooling, for anything frequent like bullets.

If something must be per-frame, ask whether it can run every 0.2s on a timer instead. Usually it
can, and nobody can tell.

## 8b. Where state belongs, and doing the work once

This is the decision that separates a Blueprint that works from one a team can live with, and it is
the one a model is least likely to get right by instinct. Ask two questions in order.

**1. How long must it live?**

| It must survive... | Put it in |
| --- | --- |
| the whole session, across level loads | **GameInstance** (or a `GameInstanceSubsystem`) |
| one level, visible to every player | **GameState** |
| one level, server-authoritative rules | **GameMode** |
| one player, visible to other players (name, score, team) | **PlayerState** |
| one player, local only (input, camera, UI ownership) | **PlayerController** |
| the pawn's own body (health while alive, movement) | **Pawn / Character** |

The trap: a pawn is destroyed on death and respawn. **Anything that must outlive the body does not
belong on the body.** Score on a Character is a bug that only appears the first time someone dies.

**2. How often does it change?**

If the answer is "once", fetch it once. The pattern:

- Fetch on `BeginPlay` (or on the subsystem's init), store it in a variable, and read the variable
  everywhere else.
- Never re-fetch per frame, per tick, or per widget refresh.

Worked example — an online display name, the case that catches everyone:

> A name comes from the online subsystem, which is a *call*, and it does not change during play.
> Fetch it **once** into the GameInstance (or read it from the PlayerState, which replicates it for
> free), store it, and have every nametag widget read the stored value. Fetching it per widget, per
> tick, is the same answer computed hundreds of times.

The general rule, which applies far beyond names:

> **Anything that does not change should be read once and stored. Anything that changes rarely
> should be pushed when it changes, not polled.** Polling is what Tick is for, and Tick is what you
> are trying to avoid.

For "push when it changes": a replicated variable's `OnRep` callback, a dispatcher/delegate, or a
Blueprint Interface call. All three cost nothing when nothing happens.

## 8c. What "AAA" means for a Blueprint

Not visual polish — that is art. For Blueprints it means **someone else can extend this in six
months without being afraid of it.** Concretely:

- **One Blueprint, one job.** If it does inventory *and* combat *and* UI, it will be edited by three
  people and merged by none.
- **State lives where it belongs** (8b). This is the single most expensive thing to retrofit.
- **No logic in Tick that does not need to be there.** See section 8.
- **Talk through interfaces, not casts,** whenever the other side might be more than one class.
  A cast hard-wires two Blueprints together; an interface does not (section 5).
- **Named things, not `NewVar_3`.** A variable's name is documentation that cannot go stale.
- **Grouped and commented.** Related nodes inside a comment box with a sentence saying *why*. The
  what is visible in the nodes; the why is not, and the why is what a reader needs.
- **Fails safely.** A null check before a cast result is used; a valid check before a reference is
  followed. The question to ask of every branch is "what happens the first time this is empty?"
- **Nothing left half-wired.** An unconnected exec pin is a feature that silently does nothing.

`unreal_review_blueprint` checks the mechanical half of this list and scores it. The judgment half —
one job, state in the right place, interface versus cast — is why this section exists in writing:
a small model cannot derive it, but it can follow it.

## 9. The traps that cost one failed call each

These are specific, and they are why an untrained model flails:

- **The target pin is called `self`**, even though the editor displays it as "Target".
- **Exec pin names are not uniform.** Ordinary nodes: `execute` in, `then` out. Branch: `then` and
  `else`. Sequence: `then_0`, `then_1`. Loop macros (ForEachLoop, WhileLoop): **`Exec`** with a
  capital E.
- **Struct pin defaults are comma triples**: `"0, -90, 0"`, never `"(Pitch=0,Yaw=-90)"`. Rotator
  order is Pitch, Yaw, Roll.
- **Enum pin defaults take the entry name**: `"SnapToTarget"`.
- **Static library functions need their `className`.** `PrintString` lives on
  `KismetSystemLibrary`, not on your Blueprint.
- **Variables must exist before a Get/Set node can reference them.**
- **A Widget Blueprint that is never added to the viewport is invisible.**

## 10. How to not guess

You do not have to remember any function name in this document. The engine will tell you:

- `unreal_find_node("spawn actor")` — search the *running engine's* real catalog by intent. The
  answers are correct for the exact engine version open, not recalled from training.
- `unreal_get_node_signature("SpawnActorFromClass")` — exact pins, types, and defaults.
- `unreal_list_assets(className: "StaticMesh")` — real asset paths, never invented ones.

**Guessing an Unreal API from memory is the single most common cause of a failed edit.** Every one
of these calls is cheap. Use them.

See [RECIPES.md](RECIPES.md) for complete, verified builds of the systems people actually ask for.
