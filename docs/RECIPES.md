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
3. `unreal_add_input_mapping` — kind `action`, name `Interact`, key `E`
4. On the player: the graph below.

**The graph** (player EventGraph):

```
InputAction Interact
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
