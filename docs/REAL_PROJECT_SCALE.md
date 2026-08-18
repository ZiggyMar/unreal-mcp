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

## What this does not show

It does not show a local model doing any of this end to end. These are measurements of the tools,
taken directly. The largest graph here is 104 nodes; a heavily built player Blueprint is several
times that, and the explanation scales with entry points rather than nodes, which is the right
direction but is not the same as proven.
