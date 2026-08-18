# Auditing a whole project

The tools here answer questions one Blueprint at a time. That is the right shape for an agent
mid-task and the wrong shape for the question people actually arrive with:

> *"My game has bugs and a showcase in two weeks. Where do I look?"*

`npm run audit` walks every Blueprint, runs every check that exists, and sorts the result by **what
the finding is likely to cost** rather than by how loud it is. It reads nothing an agent would not
read - the same index and graph summaries - so the cost is bounded rather than "read everything".

## Measured against a real 339-Blueprint game

A UE 5.6 project with a deadline, audited from a duplicate:

| | |
| --- | --- |
| Blueprints | 339 |
| Graphs | 1,195 |
| Nodes | 16,187 |
| **Time** | **24 seconds** |
| Findings | 818, across 258 Blueprints |

The ordering matters more than the count. Ranked by accumulated cost, the top three were the
player character, the gameplay GameState and the gameplay GameMode - which is where anyone would
want to spend a limited afternoon, and is not what a severity-sorted list would have said.

## What it found, and why the order is that order

`unhandled-cast-failure` leads the list at **119 occurrences**, and it is first for a reason that is
not obvious from the name: **a failed cast does not error.** The execution chain simply stops. There
is no log line, no warning, and nothing to search for - the feature just does not happen, sometimes,
for some players.

## The one that would have shipped

The most valuable finding was a single cast in the player's death sequence:

```
KillPlayer -> Do Once -> KillPlayerMC -> CheckEndInteract -> Delay -> Disable Movement
  -> SetAliveStatus -> KillPlayerClient -> Cast To GM_Gameplay -> SpawnSpectator
  -> EndVaccum -> ResetFire -> Clear and Invalidate Timer -> Set bDirector_IsFiring
  -> CE_CloseWidget
```

The cast to the GameMode sits immediately after `KillPlayerClient`, so it runs **on the client** -
and a GameMode exists only on the server. On every machine that is not the host, that cast fails
silently and **everything after it never runs**: no spectator, the vacuum never ends, fire never
resets, a timer is never cleared, a widget never closes.

One player sees a working death. Everyone else sees a stuck one. That is the exact shape of "bugs
that contradict each other and make gameplay feel weird", and it is invisible to single-player
testing - which is how it survives to a showcase.

Finding it took two commands and no human reading of a graph. The graph in question is **802 nodes**,
described by `explain_graph` in **1,877 tokens**.

## What the audit could not do here, and why that is also a result

The project's installed plugin was months old, so `list_variables` was missing and the
state-placement and multiplayer checks silently had nothing to work with. `--doctor` said so
outright:

```
[FAIL] plugin features: The plugin is missing 3 command(s) this server uses:
       list_variables, create_data_table, save_asset.
```

That check was written the day before, for exactly this - a current server against an old plugin,
where every other check passes and the failure arrives later as `unknown_cmd` with no explanation.
It earned itself the first time it met a real project it had not been written against.

## Two findings about the project's build, from the outside

Neither is a Blueprint bug, and both are the kind of thing only a fresh clone reveals:

- **An orphaned plugin.** `WwiseMotionOpenXRHelpers` has a `.uplugin`, so it auto-enables, and it
  references `AkAudio` from Wwise - which is disabled and moved aside. A build from a clean
  `Intermediate` fails outright; the working tree only builds because a cached makefile hides it.
- **Duplicate modules.** Regenerating the action graph reports the same file written twice, the
  usual signature of a Lyra-derived project carrying plugins the engine also ships.

Both are invisible day to day and both will surface the first time someone clones the repo onto a
new machine - a week before a showcase, for instance.


## Every command was costing a third of a second, and it was a checkbox

Auditing 339 Blueprints took twelve minutes, which is far too slow for a tool whose whole argument
is that it is cheap. Rather than guess, the calls were timed individually:

```
list_blueprint_graphs      84ms
list_variables            332ms
describe_class            335ms
59 graph summaries      19670ms   (333ms each)
```

Those numbers are the tell. Wildly different amounts of work, all landing on **the same ~333ms** -
and `ping`, which does nothing at all, answering in 8ms. That is not work. 333ms is 3Hz, and 3Hz is
a tick rate.

The cause is an editor setting called **"Use Less CPU when in Background"**
(`bThrottleCPUWhenNotForeground`), which defaults to on and collapses the editor's tick rate
whenever it is not the foreground window.

That is a sensible default for a person and precisely wrong here, because **an agent always drives a
backgrounded editor** - the human is in a chat client, not in Unreal. Every single command waited
for the next slow tick before it was even read.

The bridge now turns it off for the session, logs why, and writes nothing to the user's config.
`-MCPKeepEditorThrottle` opts out.

| | before | after |
| --- | --- | --- |
| One graph summary | 333ms | **20ms** |
| 59 graphs (BP_Player) | 19,670ms | **1,207ms** |
| Full 339-Blueprint audit | ~12 minutes | **74 seconds** |

**16x, on every command, for every user.** Nothing about the work changed; the editor was simply
asleep between requests.

It is worth being clear about how this was found, because the same shape will hide other things: a
set of measurements that differ in what they do but agree on how long they take is never about the
work. The fixed part is the clue.

## Casting to something that only exists on the server
### Naming the chain, and not crying wolf

"This Blueprint casts to a GameMode" is true and hard to act on. The finding now names the entry
point that reaches the cast, which turns it into something you can open:

```
BP_Player                KillPlayer
PC_Base                  Event BeginPlay
GS_Gameplay              Event BeginPlay
BP_ShopComponent         Event Begin Play, Event Tick
BP_BaseEnemy             Event BeginPlay
BP_terminal              Interacted
```

Read those chains rather than the class names. A PlayerController and a GameState both exist on
clients, so casting to the GameMode **from their BeginPlay** fails on every client.
`BP_ShopComponent` does it from **Tick**, so it fails every frame, on every client, forever.

The same pass removed a false positive, which matters more than finding one more bug.
`PC_Lobby` casts to its GameMode from `CE_Server_FinishedCutscene` - a server RPC, where that
cast is entirely correct. Two refinements fixed it, and both DETECT a guard rather than assume
its absence:

- The server-event convention is anchored at a word start rather than the string start, because
  real projects prefix their custom events (`CE_Server_...`). `Observer` still does not match:
  the prefix has to end at an underscore, and there is a test for exactly that.
- A chain starting at a server event counts as server-guarded, the same way one behind
  `Switch Has Authority` does.

Twelve findings, each naming its chain, and the one that was wrong is gone. A check that cries wolf
once is a check people stop reading.


The audit's highest-cost check now catches the class of bug found by hand earlier, generalised:

```
cast-to-server-only-class  (13)  [cost 100]
  BP_Player, PC_Base, PC_Gameplay, PC_Lobby, GS_Gameplay, BP_BaseEnemy,
  BP_MomBase, BP_ShopComponent, BP_terminal, ...
```

Thirteen Blueprints cast to a GameMode from code that also runs on clients. Answering "is this class
server-only" by name would have been a guess - the project's GameModes are called `AVSBaseGameMode`
and `GM_Gameplay`, neither containing "GameModeBase" - so `describe_class` asks the running engine
for the real ancestry instead.

Two things keep it honest: a GameMode casting to a GameMode is fine, and a cast behind
`Switch Has Authority` is fine. Both are detected rather than assumed, which is why the count came
out at 13 rather than the 24 a naive scan reported.
