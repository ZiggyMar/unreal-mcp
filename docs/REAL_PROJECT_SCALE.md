# Measured on a real project

Every number in `LOCAL_MODEL_BENCHMARK.md` comes from a scratch project with under ten assets.
That is a fair test of whether the tools work and no test at all of whether they work at the size
people actually have. This is the second measurement, taken against a **copy of a real
eight-month-old game project** — 289 assets, 43 Blueprints, 186 graphs, 1,494 nodes.

The copy exists because opening someone's working project in an editor can resave assets on load.
The measurements are read-only; the risk was in the editor, not the commands.

## The question this had to answer

> "Say I have an error I cannot diagnose. I tell the model in plain words what is wrong. How does
> it scan through all the Blueprints to find it? If there are three hundred Blueprints, how does it
> find the right one?"

The answer has to be that **the model never loads the project into context**. An index answers
questions; only the two Blueprints that matter get opened. Here is what that costs, measured.

## Understanding a whole project: 176 tokens

| Call | Time | Cost |
| --- | --- | --- |
| `get_project_overview` | 3.8s | **~176 tokens** |
| `project_health` (every Blueprint scanned) | 263ms | ~439 tokens |
| `list_blueprints` | 93ms | ~1,269 tokens |

The overview names every folder, parent class, and the totals — the shape of the entire project —
for the price of a short paragraph. None of it opens a graph.

## Finding the right Blueprint from a vague sentence

Given nothing but the word "vacuum", `search_project` returned `BP_VacuumPlayer` and
`GM_VacuumArena` in **316ms**. No Blueprint was named in the request and no graph was opened to
answer it.

## The wall, and what it cost to get past it

Then the honest part. Reading one real graph:

```
BP_VacuumPlayer EventGraph: 104 nodes  ->  8,838 tokens
```

That is **larger than the entire `lazy` tool payload**, and larger than the whole context a 14B has
on a 12 GB card. So "can it handle large Blueprints" had the answer *no* — not because the graph is
complicated, but because describing it structurally is expensive.

Breaking down where those tokens went made the fix obvious:

| Part of the payload | Cost | Share |
| --- | --- | --- |
| 32-character node GUIDs (326 of them) | 2,608 tok | **30%** |
| Repeated JSON key names (`"pin"` appears 428 times) | 3,158 tok | **36%** |
| Everything that is actually information | ~3,000 tok | 34% |

**Two thirds of the cost was identifiers and punctuation.**

## `unreal_explain_graph`: 8,838 tokens becomes 915

Rather than compressing the structure, this returns what the structure *means* — each entry point
and the ordered chain of what it does:

| | Tokens | |
| --- | --- | --- |
| `read_blueprint_graph_summary` | 8,838 | the wiring diagram |
| `unreal_explain_graph` | **915** | **9.7x smaller** |
| ...its `text` field alone | **357** | **24.8x smaller** |

Here is the whole of that 104-node graph, in the 357-token version:

```
EventGraph: 104 nodes, 13 entry point(s).
- Event BeginPlay: nothing wired to it.
- Event ActorBeginOverlap: nothing wired to it.
- Event Tick -> Branch -> Branch -> Set Actor Location And Rotation
- InputAxis VC_MoveForward -> AddMovementInput
- Server_VacuumPressed -> Branch -> Cast To BP_VacuumPlayer -> Set bVacuumOn ->
    Line Trace By Channel -> Set Timer by Function Name -> BeLaunched -> Set CapturedVictim
- VacuumScan -> GetAllActorsOfClass -> For Each Loop -> Branch -> Cast To BP_VacuumPlayer ->
    Branch -> Branch -> BeCaptured -> LaunchCharacter -> Set CapturedVictim
- BeCaptured -> Set CapturedBy -> Set bIsCaptured -> DisableMovement -> SetActorEnableCollision
Not reached by any event chain: Get Actor Location (x4), vector * float (x4), ... and 20 more.
```

Read that back and notice what it hands you **for free**, without opening anything:

- **Two dead events.** `BeginPlay` and `ActorBeginOverlap` exist and are wired to nothing.
- **Work on Tick.** `Event Tick -> Branch -> Branch -> Set Actor Location And Rotation`, which is
  the first thing the handbook's performance section tells you to avoid.
- **`GetAllActorsOfClass` inside the vacuum scan**, the other named anti-pattern, in a chain that
  runs on a timer.

That is a code review of a real system, from a description that costs less than a page of text.

## The whole diagnosis, end to end

| Step | Cost |
| --- | --- |
| Understand the project | 176 |
| Find the system from the word "vacuum" | 1,592 |
| Understand what it does | 915 |
| Score it and get one next action | ~100 |
| **Total** | **~2,700 tokens** |

`review_blueprint` scored the real Blueprints 74 and 91, each with a specific next action.

## What running on 5.8 for the first time found

The behavioural suite had only ever run on 5.6. UE 5.8 was build-verified every single time and
never *exercised*. Running it against this project immediately found two things:

**Node titles are not stable across engine versions.** 5.6 renders the print node as
`Print String`; 5.8 renders it `PrintString`. Every assertion matching the spaced form was silently
5.6-only.

**The folder guard could not fire on a fresh project.** `path_is_a_folder` checked the filesystem,
and a directory only appears on disk once something in it has been *saved*. On a project where the
folder existed only in memory, an asset was created at the folder's own path — and then every later
operation that treated that path as a folder broke. It now consults the asset registry as well:
the registry knows about paths with no files yet, the filesystem knows about paths from projects
never opened, and neither alone is enough.

Both were found by pointing the suite at a real project for one afternoon.

## The heavy Blueprint, built on purpose

The real project's largest graph is 104 nodes. A player Blueprint that has absorbed a dozen systems
is several times that, so `npm run stress` builds one deliberately — many independent systems, each
an event with a branch and state — and measures what reading it costs. It scales with `--systems`,
so the numbers can be plotted rather than asserted once.

| Graph | Structure | Explained (text) | Ratio |
| --- | --- | --- | --- |
| 104 nodes (real, `BP_VacuumPlayer`) | 8,838 tok | 357 tok | 24.8x |
| 171 nodes (12 systems) | 12,358 tok | 689 tok | 17.9x |
| 423 nodes (60 systems) | 30,768 tok | 1,693 tok | 18.2x |

The per-node rate is what matters, and it is stable: **~73 tokens per node structurally, ~4 tokens
per node explained.** So a 1,000-node monster costs roughly 73,000 tokens to read and roughly 4,000
to understand. One of those fits on a 12 GB card and one does not.

## Can a 7B edit a Blueprint that big?

A `heavy` benchmark task builds a twelve-system player Blueprint and asks for one more system,
without touching the rest.

**It never broke anything.** Across every run, at every success rate below, the twelve existing
systems and their variables survived intact. The failures were always "did not finish", never "took
something out" — which is the failure mode that matters, since a feature not added costs an
afternoon and a system silently removed costs a week.

## Three attempts to stop a model looping, and the one that worked

The same failure has now been measured four times, in four unrelated tools: `add_variable` called
20 times against a Blueprint that did not exist, `doctor` 19 times after the work was done,
`plan_feature` 20 times with byte-identical arguments, and `doctor` again on the smallest profile.

**Attempt 1 — say it in the tool.** `doctor`'s healthy verdict was changed to state outright that
calling it again returns the same answer. **No effect.**

**Attempt 2 — say it everywhere.** A general repeat guard now watches every tool call and appends a
notice when the same call is made with identical arguments twice: *"you have made this exact call
twice and received the same answer; act on it or stop."* Verified end to end — the notice is
emitted from the second call onward and reaches the client. **No effect on the 7B whatsoever.**

Verifying that took a fourth harness bug of the same family: the benchmark read only
`content[0].text`, so anything a tool appended to its own result was silently discarded. The notice
had been invisible.

**Attempt 3 — remove the tool.** `doctor` takes no arguments, which makes it the easiest thing in
the world to emit when a model has finished and not realised it. Taking it out of the `minimal`
profile — where a model mid-task has no use for it anyway — moved the same tasks from **20 calls to
3-6**, immediately, with no change in pass rate.

> A weak model does not act on being told, and does act on not being offered. Three for three now:
> `create_blueprint`, the UMG composite, and this.

The repeat guard is kept, with a kill switch and its own tests, because it is correct and a stronger
model may well use it. But it is recorded as **measured to do nothing here**, not as a fix.

Setup diagnosis did not disappear with it: `node dist/index.js --doctor` is the documented path, and
it is a thing a human runs before the agent starts rather than a tool a model reaches for mid-task.

## A confound worth naming

The first version of this comparison was invalid. Benchmark numbers from earlier in the day were
taken on a small 5.6 test project, and the new ones on the 5.8 copy of the real project — different
engine, different project size, different node titles. Comparing across them measured the
environment, not the change. Every number above was re-taken on the 5.6 project that every prior
number came from.

## Making "AAA" a check rather than an opinion

The handbook has a table saying where state belongs and a section on what runs every frame. A table
is advice, and this project has now measured three times that **a weak model does not act on
advice**. So the advice became checks, which work for every model including the ones nobody can
fine-tune.

Five new findings, all computed from reads that were already happening:

| Check | Severity | Why |
| --- | --- | --- |
| `level-sweep-every-frame` | error | `Get All Actors Of Class` reachable from Tick walks every actor in the level 60+ times a second |
| `spawn-every-frame` | error | spawning or destroying actors per frame is the most expensive thing a Blueprint can do |
| `cast-every-frame` | warning | a cast is not free and the answer does not change |
| `level-sweep-maybe-repeating` | info | a timer and a level sweep in the same graph |
| `state-outlives-owner` | warning | a score, name, team or progression living on a Pawn, which is destroyed on death |

The last one is the judgment question: **a pawn is destroyed and recreated when the player dies, so
anything that must outlive the body does not belong on the body.** Score on a Character reads as
correct until the first respawn, weeks after it was written, in a place nobody associates with the
cause. It needed the parent class, which `list_variables` now returns alongside the variables -
they are the same question, since whether state is in the right place depends entirely on what is
holding it.

### What it found on the real project, and what it correctly did not

Run against `BP_VacuumPlayer`:

```
[info] level-sweep-maybe-repeating: This graph both sets a timer and calls
       Get All Actors Of Class 1 time(s).
```

That is the real cost in that Blueprint, and `explain_graph` had already shown the shape of it:
`Set Timer by Function Name` starting a scan, and the scan walking every actor.

Just as important is what stayed quiet. The per-frame checks did **not** fire, because the sweep is
not reachable from Tick - it is on a timer. And `state-outlives-owner` found nothing, because that
Blueprint's variables (`bVacuumOn`, `CapturedVictim`, `bIsCaptured`, `CapturedBy`) all genuinely
belong on the body. **No false positives on real code**, which matters more than the finding: a
report that cries wolf teaches a caller to ignore all of it.

### Saying what cannot be proven

`level-sweep-maybe-repeating` is phrased as a question and rated `info` on purpose. Proving the
timer drives *that particular* chain needs the timer's function-name pin value, and a graph summary
deliberately omits pin values - that omission is what makes it cheap. So the check reports that both
things are present and asks the reader to check the link, rather than asserting one it cannot see.

An unproven link must not outrank a real defect, and a guess dressed as a finding is worse than
silence.

## The bugs that only appear when a second player connects

Multiplayer mistakes survive everything else in this project. They compile. They review clean. They
behave perfectly in the editor with one player. Then two people join and the game is quietly wrong,
in a place nobody thinks to look because nothing ever flagged it.

The most common of them by a distance: **a server RPC that sets a variable nobody replicated.** The
server changes its own copy, every client keeps the old value forever, and the symptom reported is
"it works for the host".

`server-writes-unreplicated` walks execution forward from every `Server_`-named custom event,
collects what it writes, and checks each against the variable's replication flag - which
`list_variables` now returns, alongside `repNotify`.

```
"Server_ShieldPressed" runs on the server and sets "bShieldOn", which is not
replicated. The server will change its own copy and no client will ever see it.

Fix: Mark "bShieldOn" as Replicated (or RepNotify if clients need to react to the
change). Until then this works for whoever is hosting and silently does nothing
for everyone else.
```

The mirror image is also checked, as `info`: replicated state written where nothing runs on the
server, which a client changes locally and the next server update overwrites.

### Verified by being wrong on purpose

The real project's vacuum system replicates all four of its variables correctly, so the check stays
silent on it - which is the right answer and proves nothing. So a deliberately broken Blueprint was
built against the live editor: a `Server_` event setting an unreplicated bool. The check catches it,
names the variable, and says what to do. That case is now a permanent live check rather than a thing
someone once tried by hand.

Two guards keep it from becoming noise:

- **Silent on single-player.** With no server, client or multicast event and nothing replicated,
  none of this applies, and a multiplayer warning on every single-player project would be ignored
  everywhere including where it matters.
- **Silent on variables it does not know.** Inherited and component variables have no entry to
  check, and inventing a verdict for them is exactly the false positive that teaches a caller to
  distrust the whole report.

### A score nobody can explain is worse than no score

Wiring this up exposed a real defect in the review from the previous change: the state-placement and
multiplayer findings were being counted toward the score and used to choose `nextAction`, while
appearing **nowhere a caller could read them**. The score moved for reasons the report did not
contain.

`BlueprintReview` now carries a `blueprint` array for findings about the asset as a whole rather
than about one graph. They are kept separate from `graphs` because they are not about a graph, and
filing them under an arbitrary one would be a lie.

## Saying it where the decision was made

Every check described above lives in `unreal_review_blueprint`, and review only speaks when it is
called. A model that does not know it should call it never hears any of this — which is most of the
point of having built it.

So the findings now travel with the writes that cause them:

- **`unreal_add_variable`** returns the misplaced-state warning with the write itself. The parent
  class rides along in the bridge response, so there is **no extra round trip**, and nothing is
  added at all when there is nothing to say.
- **`unreal_scaffold_blueprint`** returns the Blueprint-level findings with its result, alongside
  the score and next action it already reported.

```
add_variable Score (on a Character)
  -> "Score" looks like a score, and it lives on Character, which is destroyed and
     recreated when the player dies or respawns.
     Fix: Move it to PlayerState.

add_variable Health (on a Character)
  -> (nothing)
```

Putting state in the wrong place is the most expensive thing in a Blueprint to retrofit, so the
moment to mention it is the moment it happens, not whenever somebody later thinks to ask.

### What this is not claimed to do

**Its effect on a weak model is unmeasured, and probably small.** Two previous attempts to change a
7B's behaviour by telling it things — a reworded verdict, then a general repeat notice — both
measured as doing nothing, and there is no reason to assume this one is different.

The justification is different, though, and worth separating from the hope. The previous two were
trying to *stop* a behaviour by explanation. This one makes information **exist at all** in a
transcript where it otherwise would not: a person reading back through what an agent did now sees
the warning at the point of the mistake, and a stronger model has it in front of it without needing
to know that a review tool exists.

Measured as not making things worse, which for an addition to every write is the bar that matters:
all four benchmark tasks still pass at the same call counts.

## What this does not show

It does not show a local model doing any of this end to end. These are measurements of the tools,
taken directly. The largest graph here is 104 nodes; a heavily built player Blueprint is several
times that, and the explanation scales with entry points rather than nodes, which is the right
direction but is not the same as proven.
