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
