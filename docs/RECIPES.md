# Verified recipes

Complete builds of the systems people actually ask for, in the order the tools should be called.

**Every function name in the tables below is checked against the running engine** by
`npm run verify:handbook`, which asks the live node catalog whether each one exists on the class it
claims. A recipe that references a function the engine does not have fails that check. This matters
more than it sounds: a handbook of plausible-looking node names is worse than no handbook, because a
model will follow it confidently.

Adapt names to the project's own conventions. If `unreal_map_system` says a system already exists,
extend that instead of building one of these from scratch.

---

## 1. Health and damage, done with an interface

The system nearly every project needs, built so that adding a new damageable thing later costs
nothing.

**Why an interface:** without one, every damage source needs a cast chain — is it an enemy? a
barrel? the player? — and every new damageable type means editing every damage source. With one,
the damage source calls a function on anything that implements it and never learns what it hit.

**Assets**

1. `unreal_create_blueprint` — `/Game/BP/BPI_Damageable`, parent class `Interface`
2. `unreal_create_function` on the interface — `ApplyDamage`, input `Amount` (`float`),
   input `Instigator` (`object:Actor`)
3. On each damageable actor: `unreal_add_variable` — `Health` (`float`, default 100),
   `MaxHealth` (`float`, default 100)
4. Implement the interface function on each damageable actor and build the graph below.

**The damage handler graph** (on the damageable actor, in the `ApplyDamage` function):

```
entry -> Set Health (Health - Amount, clamped at 0)
      -> Branch (Health <= 0)
           true  -> OnDeath custom event
           false -> OnDamaged custom event   (for hit reactions, UI updates)
```

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| Subtract damage | `Subtract_DoubleDouble` | `KismetMathLibrary` |
| Clamp at zero | `FClamp` | `KismetMathLibrary` |
| Compare to zero | `LessEqual_DoubleDouble` | `KismetMathLibrary` |
| Destroy on death | `K2_DestroyActor` | `Actor` |

**Notes**

- Clamp before storing, not when displaying. A health bar reading a negative value is a symptom;
  the stored value is the bug.
- Put `OnDamaged`/`OnDeath` in as custom events even if they are empty at first. They are the hooks
  every later feature (sound, VFX, score, ragdoll) attaches to, and adding them later means editing
  this graph again.
- In multiplayer, health changes on the **server**. Mark `Health` replicated and let clients read it.

---

## 2. Interaction: look at a thing, press a key, it responds

**Assets**

1. `unreal_create_blueprint` — `/Game/BP/BPI_Interactable`, parent `Interface`
2. `unreal_create_function` on it — `Interact`, input `Interactor` (`object:Actor`)
3. A key binding. **Check which input system the project uses first** — the two are not
   interchangeable and the wrong one binds a key nothing ever reads:
   - **Enhanced Input** (everything made in UE5, and what `unreal_list_input_mappings` returning an
     empty list means): the project already has an `InputMappingContext`. Find it with
     `unreal_list_assets` `className=InputMappingContext`, read it with
     `unreal_read_input_context`, create an `InputAction` asset for `Interact` if there is not one,
     and bind with `unreal_map_input_key`. The event node in the graph is **Enhanced Input Action
     IA_Interact**, not `InputAction Interact`.
   - **Legacy project-settings input**: `unreal_add_input_mapping` — kind `action`, name `Interact`,
     key `E`, and the event node is `InputAction Interact` as written below.
4. On the player: the graph below.

**The graph** (player EventGraph):

```
InputAction Interact                 (legacy; on Enhanced Input this node is
                                     "Enhanced Input Action IA_Interact")
  -> LineTraceByChannel  (start = camera location, end = start + forward * 300)
  -> Branch (Return Value)
       true -> Does Implement Interface (BPI_Interactable) on Hit Actor
                 true -> Interact (message call) on Hit Actor
```

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| The trace | `LineTraceSingle` | `KismetSystemLibrary` |
| Camera position | `GetActorEyesViewPoint` | `Actor` |
| Forward direction | `GetForwardVector` | `KismetMathLibrary` |
| Reach along that direction | `Multiply_VectorFloat` | `KismetMathLibrary` |
| End point | `Add_VectorVector` | `KismetMathLibrary` |
| Type check without casting | `DoesImplementInterface` | `KismetSystemLibrary` |

**Notes**

- Trace **by channel**, not "for objects", unless you specifically want object types. `Visibility`
  is the usual channel for "can I see it".
- Use the interface check rather than a cast. That is the whole point: a door, a chest, and an NPC
  are all just interactables.
- 300 units is roughly arm's reach. A player-height character is ~180 units.

---

## 3. Pickup: walk into it, it does something, it disappears

**Assets**

1. `unreal_create_blueprint` — `/Game/BP/BP_Pickup`, parent `Actor`
2. `unreal_add_component` — `SphereComponent` named `PickupCollision`
3. `unreal_add_component` — `StaticMeshComponent` named `Mesh`, parent `PickupCollision`
4. `unreal_set_component_property` — `PickupCollision.SphereRadius` = `100`

**The graph**

```
Event ActorBeginOverlap
  -> Cast To BP_Player (Other Actor)
       Cast Failed -> (nothing; a non-player touched it)
       success     -> apply the effect
                   -> Destroy Actor
```

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| Remove the pickup | `K2_DestroyActor` | `Actor` |
| Optional pickup sound | `PlaySoundAtLocation` | `GameplayStatics` |

**Notes**

- Wire **Cast Failed** even though doing nothing is correct here, or use a `DoesImplementInterface`
  check instead. A dangling Cast Failed is flagged by `unreal_review_blueprint` for a reason: it is
  indistinguishable from having forgotten the case.
- Destroy **after** applying the effect. Destroying first can invalidate references the effect needs.
- Rotating pickups: do it in the material or with a `RotatingMovementComponent`, not on Tick.

---

## 4. A HUD that shows a value

**Assets**

1. `unreal_create_widget_blueprint` — `/Game/UI/W_HUD`
2. `unreal_add_widget` — `ProgressBar` named `HealthBar`
3. `unreal_set_widget_property` — anchor it to a corner (see the UMG notes in AGENT_WORKFLOW.md);
   fixed coordinates will not survive a different resolution
4. In the PlayerController or player Character: create it and add it to the viewport

**The graph** (player, on BeginPlay):

```
Event BeginPlay
  -> Create Widget (class = W_HUD)
  -> Set HUDWidget variable   (keep the reference: you need it to update anything)
  -> Add to Viewport
```

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| Show it | `AddToViewport` | `UserWidget` |
| Update the bar | `SetPercent` | `ProgressBar` |

Create Widget is a **native node**, not a function call. See "Nodes that are not functions" below.
`unreal_find_node` will never return it, and searching harder will not help.

**Notes**

- **Store the created widget in a variable.** Without the reference you cannot update it, and
  re-creating it every time is how you end up with forty stacked HUDs.
- Update the bar when health *changes*, not on Tick. The damage handler in recipe 1 already has the
  hook for it.
- A widget never added to the viewport is invisible. This is the most common reason UI work appears
  to have done nothing at all.

---

## 5. Doing something repeatedly without Tick

Most "every frame" logic does not need to be every frame, and Tick is the first thing a performance
pass deletes.

```
Event BeginPlay
  -> Set Timer by Event (time = 0.2, looping = true) -> bound to a custom event
```

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| Start the timer | `K2_SetTimerDelegate` | `KismetSystemLibrary` |
| Stop it | `K2_ClearTimerDelegate` | `KismetSystemLibrary` |
| One-off delay instead | `Delay` | `KismetSystemLibrary` |

**Notes**

- Store the returned timer handle if you will ever need to stop it.
- 0.2s is invisible to a player for most checks (proximity, regeneration, AI re-evaluation) and is
  five times cheaper than ticking.

---

## 6. Spawning an actor at runtime

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| Where to spawn | `K2_GetActorLocation` | `Actor` |
| Build the transform | `MakeTransform` | `KismetMathLibrary` |

**Spawn Actor from Class is a native node**, not a function on `GameplayStatics`. The catalog does
contain `SpawnActorFromClass` on `EditorActorSubsystem` and `EditorLevelLibrary` - those are
**editor-only** and will not work at runtime. Taking the search result at face value here produces
a Blueprint that compiles and does nothing in a packaged game. See below.

**Notes**

- Use a `class:<Class>` variable for what to spawn rather than hard-coding it. That one decision is
  the difference between a spawner and *the* spawner for one enemy type.
- Deferred spawn (begin, set properties, finish) is for when the actor needs values *before*
  BeginPlay runs. Otherwise the simple spawn is fine.
- In multiplayer, spawn on the **server**. A client-spawned actor exists only on that client.

---

## 7. Saving and loading

**Nodes used**

| Purpose | functionName | className |
| --- | --- | --- |
| Create the save object | `CreateSaveGameObject` | `GameplayStatics` |
| Write it | `SaveGameToSlot` | `GameplayStatics` |
| Read it | `LoadGameFromSlot` | `GameplayStatics` |
| Check first | `DoesSaveGameExist` | `GameplayStatics` |

**Notes**

- Make a Blueprint with parent class `SaveGame`, and put the saved fields on it as variables.
- **Always `DoesSaveGameExist` before loading.** Loading a slot that is not there returns null, and
  the following nodes then silently do nothing — the same silent-failure shape as an unhandled cast.
- A struct (`unreal_create_struct`) is the right way to save a group of related values together.

---

## 8. Effects, sound, and animation with assets that already exist

You do not need a VFX or animation authoring tool to use VFX and animation. Almost everything a
feature needs is *attaching and driving assets that are already in the project*, and that works
today through components.

**Attach it** (on a Blueprint):

1. `unreal_add_component` — `NiagaraComponent`, `AudioComponent`, or `SkeletalMeshComponent`
2. `unreal_set_component_property` — point it at the asset:
   - Niagara: property `Asset`, value a `NiagaraSystem` path
   - Audio: property `Sound`, value a `SoundBase`/`SoundCue` path
   - Skeletal mesh: property `SkeletalMeshAsset`, and `AnimClass` for the Anim Blueprint
3. Find the real paths first with `unreal_list_assets` (`NiagaraSystem`, `SoundWave`, `SkeletalMesh`,
   `AnimBlueprint`). A path that does not resolve is refused rather than silently set to None.

**Drive it** (in a graph):

| Purpose | functionName | className |
| --- | --- | --- |
| Spawn an effect at a point | `SpawnSystemAtLocation` | `NiagaraFunctionLibrary` |
| Swap the effect on a component | `SetAsset` | `NiagaraComponent` |
| Turn a component on or off | `Activate` | `ActorComponent` |
| Play a sound in the world | `PlaySoundAtLocation` | `GameplayStatics` |
| Play a UI sound | `PlaySound2D` | `GameplayStatics` |
| Play a montage on a Character | `PlayAnimMontage` | `Character` |
| Set the skeletal mesh | `SetSkeletalMeshAsset` | `SkeletalMeshComponent` |
| Set the Anim Blueprint | `SetAnimInstanceClass` | `SkeletalMeshComponent` |

**Notes**

- **`SetSkeletalMeshAsset`, not `SetSkeletalMesh`.** The obvious name exists on three unrelated
  editor classes and none of them is the component you have. This is exactly the trap
  `unreal_find_node` exists for.
- Prefer spawning a one-shot effect (`SpawnSystemAtLocation`) over keeping a permanent component
  for something that happens occasionally.
- What is *not* covered: authoring a Niagara system, an animation sequence, or an Anim Blueprint
  state machine from nothing. Those are separate authoring surfaces. Using assets an artist made,
  or that came with a marketplace pack, is covered completely.

---

## 9. A nametag above every player, with the name fetched once

The recipe that exercises every judgment call in section 8b of the handbook at the same time, which
is why it is written out rather than left to instinct.

**The shape**

1. **A widget** (`unreal_scaffold_widget`) — a `UserWidget` whose root is a `SizeBox` or
   `VerticalBox` containing one `TextBlock` called `NameText`. Give it one variable, `DisplayName`
   (text), so the owner can set it from outside rather than the widget going looking.
2. **A WidgetComponent on the pawn** (`unreal_add_component`, class `WidgetComponent`) attached
   above the capsule. Set its `Space` to `World`, its `WidgetClass` to the widget above, and its
   relative location to roughly the top of the mesh.
3. **The name itself** — read from `PlayerState`, not from the pawn and not from the widget.

**Why each of those, specifically**

- The widget takes the name as a **variable rather than fetching it**. A widget that fetches is a
  widget that fetches once per instance, per respawn, forever. A widget that is *told* is fetched
  once by whoever owns the truth.
- The name lives on **PlayerState** because it must survive the pawn dying, and because other
  players need to see it. Both of those are the definition of PlayerState in the handbook table.
  Putting it on the Character means every nametag is wrong for one frame after every respawn.
- If the name comes from an online subsystem, read it **once** in the GameInstance at startup and
  hand it to the PlayerState. Replication then delivers it to everyone for free.

**Placement**

Put the WidgetComponent's relative Z near the top of the capsule rather than guessing at the mesh:
`Get Capsule Component` -> its half-height is the number you want, plus a small margin. A hardcoded
Z that looks right on one character is wrong on the next one.

**The check that matters**

Play with two players. The nametag should be correct **immediately** after a respawn, and correct
on the *other* player's screen, not just your own. If it is right locally and wrong remotely, the
name is being read on the wrong side - see the multiplayer section of the handbook.

## 10. A change request, end to end: guarding a value that can be empty

Not every job is "build me a feature". A common one is "this data can be blank and the game breaks
when it is" — and it is worth writing down because the shape recurs and because getting the *type*
right is the whole job.

The real case: a wave system read enemy types from a Data Table and fed each one to
`SpawnActorFromClass`. A designer emptied one row's class to take that enemy out of the game. The row
survived, still passed the wave gate, and contributed a **null** — which spawns nothing, logs
nothing, and still increments the spawned counter, so the wave never completed.

**Read before you write.** `unreal_read_blueprint_summary` on the function gives every node and how
it is wired:

```
Break S_EnemyType.MinimumWave -> integer <= integer .A
Get Round                     -> integer <= integer .B
integer <= integer.ReturnValue -> Branch.Condition
Branch.then -> For Loop -> Add (NewItem <- Break.EnemyType)
```

**Get the pin's type before choosing the node.** `unreal_read_node_detail` on the Break node reports
`category: "softclass"`, not `class`. That decides everything: `IsValid` is for objects, `IsValidClass`
is for hard class references, and neither is correct here. `unreal_find_node` and
`unreal_get_node_signature` confirm the right one against the running engine:

```
KismetSystemLibrary::IsValidSoftClassReference(SoftClassReference) -> bool   (pure, static)
```

Guessing here produces a graph that compiles and is wrong, which is the expensive kind of wrong.

**Make the edit in one call.** `unreal_build_graph` accepts existing node ids in place of refs, so an
edit to an existing graph is the same call as building a new one. Both new nodes are pure, so no exec
wiring is needed:

```
nodes:       isvalid = CallFunction IsValidSoftClassReference (KismetSystemLibrary)
             and     = CallFunction BooleanAND               (KismetMathLibrary)
connections: <break>.EnemyType_... -> isvalid.SoftClassReference
             <compare>.ReturnValue -> and.A
             isvalid.ReturnValue   -> and.B
             and.ReturnValue       -> <branch>.Condition
```

Connecting to `Branch.Condition` **replaces** the existing link, because an input pin holds one
connection. That is what turns `MinimumWave <= Round` into
`(MinimumWave <= Round) AND EnemyType is set` without deleting anything.

**Verify the wiring, not just the compile.** A clean compile only proves the graph is legal. Re-read
the summary and check the links actually say what you intended — the branch now reading its condition
from the AND, and the AND reading from the comparison and the validity check. Then
`unreal_compile_blueprint`, then `unreal_save_blueprint`.

The result: an empty reference now skips its row instead of poisoning the pool. The mistake stops
being possible rather than being fixed once.


## Nodes that are not functions

This is the trap that most reliably defeats a model with no Unreal training, and no amount of
searching escapes it: **several of the most important Blueprint nodes are not `UFunction`s at all.**
They are native `K2Node` types. `unreal_find_node` searches the engine's function catalog, so it
will never return them, and a model that concludes "this does not exist" or invents a plausible
function name has already lost.

Place these with `unreal_build_graph` / `unreal_add_node` using `nodeType`, not `functionName`:

| Node | `nodeType` | Extra params |
| --- | --- | --- |
| Branch (if) | `Branch` | - |
| Sequence | `Sequence` | - |
| Cast To *X* | `Cast` | `targetClass` |
| ForEachLoop, WhileLoop, ... | `Macro` | `macroName` |
| Self reference | `Self` | - |
| Event (BeginPlay, Tick, ...) | `Event` | `eventName` |
| Your own event | `CustomEvent` | `eventName` |
| Get / Set a variable | `VariableGet` / `VariableSet` | `variableName` |

Create Widget and runtime Spawn Actor from Class are also native nodes. Where a recipe needs them,
it says so rather than pretending a function exists.

**The general rule:** if `unreal_find_node` returns nothing for something you are certain Unreal
can do, it is probably a native node rather than a missing feature. Check this table before
inventing a name.

Related trap, visible in the spawn recipe above: a name existing in the catalog does **not** mean it
is the right one. `SpawnActorFromClass` exists on `EditorActorSubsystem` and `EditorLevelLibrary`,
and both are editor-only. Using them produces a Blueprint that works in the editor and does nothing
in a packaged game. Check the owning class, not just the name.

## How to use a recipe

1. `unreal_map_system` with the concept first. **If it already exists, extend it instead.**
2. Create the assets in the order listed.
3. Build each graph with **one `unreal_build_graph` call**, passing no `x`/`y` — layout is automatic.
4. `unreal_review_blueprint` and act on the findings.
5. `unreal_start_pie` and actually run it.

If a function name here does not resolve, the engine has the final word: `unreal_find_node` with
the intent, then `unreal_get_node_signature` for the exact pins. Do that rather than guessing a
variation of the name.
