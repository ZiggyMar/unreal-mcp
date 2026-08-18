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

## What this does not show

It does not show a local model doing any of this end to end. These are measurements of the tools,
taken directly. The largest graph here is 104 nodes; a heavily built player Blueprint is several
times that, and the explanation scales with entry points rather than nodes, which is the right
direction but is not the same as proven.
