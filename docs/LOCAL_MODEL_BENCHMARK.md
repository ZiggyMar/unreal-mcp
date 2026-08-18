# Battle-testing with a local model

The project claims to work "no matter how dumb or smart the model is". That claim had been argued
for, designed for, and never tested. A frontier model succeeding proves nothing about it.

So `npm run bench:local` drives this MCP server with a **local 7B on a consumer GPU** through a real
agent loop: the model gets the actual tool schemas, its tool calls are executed against a live
editor, results are fed back, and the outcome is checked **against the project rather than the
transcript**.

## Setup

| | |
| --- | --- |
| Model | `qwen2.5-coder:7b` (4.7 GB, Q4) via Ollama |
| GPU | RTX 3060 12 GB, **shared with the running Unreal Editor** |
| Profile | `UNREAL_MCP_PROFILE=lazy` (26 tools, ~9.5k tokens of definitions) |
| Mode | `standard` |

## Results

A local 7B builds working Blueprints reliably, once the tools are shaped for it.

| Task | Before | After |
| --- | --- | --- |
| Create a Blueprint, add a typed variable, compile, save | **0/5** | **5/5** |
| Create a Blueprint and wire BeginPlay to a Print String | **0/5** | **5/5** |
| A component with a property, a variable, and **two** wired handlers | — | **5/5** |

Re-measured after the tool surface changed, which is the only reason those numbers can be trusted:
a passing benchmark that is never run again is a claim, not a measurement. Re-running it found
three real defects and one false one — see [What re-running it found](#what-re-running-it-found).

Same model, same hardware, same prompts. The graph task had never passed once.

The third task was added afterwards to find where the ceiling had moved to, and it did not find one:
a `SphereComponent` with `SphereRadius` set, a float variable, and both a BeginPlay and an
ActorBeginOverlap handler each printing a different message — the shape of a real small feature —
passes every time. Verified by reading the component list and the graph back, including that both
handlers are actually wired rather than merely present.

### The three changes, in order of how much they mattered

**1. Removing the worse path.** This was the decisive one, and it is the smallest. The `minimal`
profile offered both `unreal_create_blueprint` (which makes an *empty* Blueprint) and
`unreal_scaffold_blueprint` (which makes a complete one). The model reliably chose the familiar
one, created an empty asset, and declared the task finished — which is precisely the measured
failure. Dropping `create_blueprint` from that profile took the task from 2/5 to **5/5**.

> A profile built for weak models should contain the **best path for each job, not every path.**
> Offering a worse-but-familiar option is offering a way to fail.

**2. One call instead of four.** `unreal_scaffold_blueprint` builds the Blueprint, its variables,
its components and its event handlers in one call, in the right order — state before behaviour, a
single compile at the end, then layout, review and save. A model that cannot hold a plan across
turns does not need to. This took 0/5 to 2/5.

**3. A pointer from where the model was already looking.** Adding the scaffold changed nothing
until a one-line note went at the top of `create_blueprint`'s own description. That happened twice
in this benchmark — the same was true of `add_event_handler` — which makes it a pattern rather than
an anecdote: **a better path that is not advertised at the point of confusion does not get taken.**

### What this does and does not show

It shows a 7B on a consumer GPU can build correct, compiled, laid-out Blueprints through this
server, at ~20 tok/s, with zero malformed arguments and zero invented tool names.

It does not show that a 7B can design a system. Both tasks are single features with a clear
description. The earlier finding still stands: a small model cannot hold a plan across turns. What
changed is that it no longer has to.

## What re-running it found

The suite had been green for a while. Re-running it after four tools were added took the
three-part feature task from **5/5 to 0/3**, and chasing that down produced three genuine bugs and
one lesson about the benchmark itself.

### 1. A profile that offered a way to fail

The trace showed every failing run doing the same thing: calling `unreal_create_blueprint`, which
makes an **empty** Blueprint, and then looping compile/save/review without ever adding the
component it had been asked for. It could not have added one — `add_component` is not in the `lazy`
surface either, so a Blueprint created that way has no route to a component at all.

This project had already written the rule down when `minimal` was built, and then applied it only
there:

> A profile built for weak models should contain the **best path for each job, not every path.**
> Offering a worse-but-familiar option is offering a way to fail.

`lazy` still offered both. Removing `create_blueprint` from it took the feature task to **3/3**, and
from 16 calls to 9. It is still reachable through `unreal_enable_tools`, and `full` still has it.

### 2. A folder path silently became an asset

Removing that tool then broke the *simplest* task, which is the sort of result worth reading
carefully rather than reverting. The trace showed the model calling:

```
unreal_scaffold_blueprint {"packagePath":"/Game/Bench", ...}
```

`/Game/Bench` is the **folder**. The asset name had been dropped — "create BP_Thing in /Game/Bench"
is one sentence containing two things, and the model split it wrongly. Every validation passed: it
is a valid long package name whose short name is `Bench`. So an asset called `Bench` was created
next to the folder `Bench`, the intended Blueprint never existed, and every later call against it
failed with `blueprint_not_found`.

That is a product defect, not a model quirk — nothing stops a person making the same mistake, and
the result is a junk asset and a confusing error. A folder on disk at that exact path is
unambiguous evidence, since you cannot mean to create an asset *at* a directory, only inside one.
`path_is_a_folder` now refuses it and names the fix. The check lives in the shared path validator,
so it protects Blueprints, structs, enums, materials, levels and Data Tables at once.

### 3. An error message with no next action

`blueprint_not_found: /Game/Bench/BP_X.BP_X` is true and useless. Measured behaviour: **twenty
consecutive identical `add_variable` calls** against a Blueprint that was never created, until the
step limit stopped it. The same lesson this project learned on pin names, in a new place — *a
message that **contains** the answer is not the same as a message a caller can **act on***, except
this one did not even contain it. It now names both possible causes and what to do about each.

### 4. The benchmark was blaming the model for its own bug

Some "failures" were not failures. The verifier confirmed a variable by searching the project
index, which updates **asynchronously**, so a query issued right after a write could report "no"
about a variable that was plainly there.

That is worse than a missing test, because it sends you off fixing something that was never broken
— which is exactly what it did here for two runs. The cause was a real gap: components were
listable and variables were not, so there was no direct way to ask. `list_variables` fixes both the
gap and the verifier.

**After all four: 5/5, 5/5, 5/5**, fifteen consecutive passes.

## The `minimal` profile, finally measured

Every result above was measured on `lazy`. The `minimal` profile — the one that exists specifically
because a 14B on a 12 GB card loads at 8k context and fails at 16k — had never been benchmarked at
all. Its whole justification was an argument.

It is the best-performing profile by a distance:

| Profile | health | graph | feature | Calls per task | Errored calls |
| --- | --- | --- | --- | --- | --- |
| `minimal` (10 tools, ~3.6k tok) | **3/3** | **3/3** | **3/3** | **1** | **0** |
| `lazy` (25 tools, ~9.2k tok) | 3/3 | 3/3 | 3/3 | 1–16 | 0–7 |

Same model, same hardware, same tasks, run back to back.

**`minimal` completes every task in exactly one call, with no failed calls, every time.** `lazy`
also passes everything, but takes up to sixteen calls and burns up to seven failures getting there,
because the extra tools give the model more ways to go wrong before it finds the one that works.

That is worth stating plainly, because it inverts the usual assumption:

> A smaller tool surface is not a compromise you make for weak models. Here it is **cheaper and
> more reliable at the same time** — a third of the token cost and a sixteenth of the calls.

The reason is `unreal_scaffold_blueprint`. `minimal` contains it and does not contain a worse
alternative, so the model reaches the good path first and the whole feature — component, property,
variable, two wired handlers, compile, layout, review, save — lands in a single call.

## The benchmark bug that made all of this look worse than it was

The first `minimal` run passed 9/9 and used **exactly 20 calls every single time**, which is the
step limit. The trace showed the model doing the entire job in one call and then calling
`unreal_doctor` nineteen times.

The obvious reading was that the model could not tell it had finished, so a completion signal was
added to the scaffold result. Call counts halved and that looked like a confirmation.

It was not. The real cause was in the harness:

```js
if (/\bDONE\b/i.test(text))   // what was meant
if (/<0x08>DONE<0x08>/i.test(text))   // what was there
```

An editing slip had turned the `\b` word boundaries into literal **backspace bytes**, so the regex
could never match. Every `DONE` the model sent was ignored, and the harness answered each one by
telling the model to keep calling tools. The model was not failing to stop. It was being told not
to.

With one byte fixed, every task drops to **one call**.

Two things worth keeping from that:

**An A/B was run afterwards rather than assumed.** With the harness fixed, the completion signal
was measured with and without: **no difference, 1 call either way**. It could not have made one —
the harness decides completion by inspecting the project, so nothing a tool result says can
influence it. The change is kept anyway, deliberately shortened, because a real client has no
verifier and the model itself has to decide when to stop; but it is documented as unmeasured rather
than credited with a result it did not produce.

**A benchmark bug that mimics a model failure is the worst kind**, because every instinct sends you
to fix the wrong codebase — and it nearly did. The harness now prints why a `DONE` was rejected, so
the next time this happens the answer is on screen instead of inferred.

## The brownfield task: editing what already exists

Every task above builds something from nothing, which is the easy half of the job and not the half
people have. The situation that actually matters is an existing project full of Blueprints someone
else wrote, where the request is "add X to the thing that already works" — and where the failure
that costs a day is not a missing feature, it is the agent quietly removing something.

So this task is scored on what **survives** as much as on what gets added. The harness builds a
Blueprint with a `Health` variable, a `Body` component and a BeginPlay handler that prints
`existing`, then asks the model to add a `Stamina` variable and an overlap handler — without
breaking anything.

| Profile | Result | Calls |
| --- | --- | --- |
| `minimal` | **5/5** | 3 (one run took 20) |
| `lazy` | **3/3** | 4–19 |

A 7B extends an existing Blueprint correctly, in about three calls, without destroying anything.
The two calls that matter are exactly the right two: `add_variable`, then `add_event_handler`.

Verification is deliberately strict, and checks the printed **text** of the original handler rather
than the node count — a node can survive with its inputs reset, which looks intact in a summary and
is not.

### It reported a destroyed Blueprint three times. The Blueprint was fine.

Worth writing down, because the failure mode is more instructive than the result.

The first version searched the graph **summary** for the text `existing`. The summary carries node
types, titles and connections and deliberately *not* pin values — that is the entire point of the
tiered read — so it could never match. Three runs reported `DESTRUCTIVE: the existing BeginPlay
logic is gone` about a Blueprint that was perfectly intact, on runs where the model had done the
right thing in two calls.

The second version read the pin value properly and still failed, which looked like confirmation
that the alarm was real. It was not: writes accept `"In String"` because pin resolution is
forgiving, while reads report the canonical `"InString"`. **The input side is lenient and the
output side is canonical, and a test that assumes those are the same string breaks.**

Before believing any of it, `build_graph` was checked directly: 4 nodes → 5 nodes, nothing
replaced. The product was additive the whole time.

Two things came out of that:

**A false destructive alarm is the worst bug a benchmark can have.** It is the single claim here
most likely to be believed without checking, and it points at the wrong codebase. This is the third
time in two days a harness bug has impersonated a product failure — the DONE regex, the lagging
index, and now this.

**The guarantee is now a permanent test rather than a hand check.** `live-verify` asserts that a
second `build_graph` adds to the graph instead of replacing it, and that the original handler still
prints what it printed before.

## UMG: the composite pattern, confirmed on a second content type

`unreal_scaffold_blueprint` exists because a small model cannot hold a plan across turns. UMG had
no equivalent — building a screen was create, add, add, set, compile, save — so it was the clearest
untested case of the same pattern. This measured it rather than assuming it.

| | Before | After |
| --- | --- | --- |
| Build a HUD with a labelled TextBlock and a Button | **0/3** | **3/3** |

`unreal_scaffold_widget` builds the Widget Blueprint and everything inside it in one call, and the
7B emits that call perfectly formed — root panel, both widgets, the label's text — on its first
attempt.

It is also in the `minimal` profile, which previously had no widget tool at all: **the smallest and
most reliable configuration could not build a user interface.** Making room meant trimming
descriptions, which is its own lesson — `scaffold_blueprint`'s description was 3365 characters, much
of it explaining *why the tool exists*. That reasoning is paid on every request by every client,
while a reader pays for it once. It now lives in the source and in this document, and the profile
came in under budget with a whole new tool added.

### Three real bugs, and one honest null result

**A trap asset.** Asked to make a widget after its first attempt failed, the model fell back to
`create_blueprint` with `parentClass: UserWidget`. The engine accepts that and produces a plain
Blueprint that **cannot open in the UMG designer and cannot contain widgets** — every call reports
success and the asset is useless in a way nothing reveals until someone tries to use it. Now
refused, naming `create_widget_blueprint` instead.

**A stale tool list.** The model worked out on its own that it needed the `ui` group and enabled it
correctly — and then every follow-up call was silently discarded. The server sends
`notifications/tools/list_changed`, and the benchmark harness ignored it. Worse, the path that
recovers tool calls from message text filters against that same stale list, so a newly enabled tool
was invisible twice over. **The lazy-loading feature worked; the client measuring it did not.**

**A hardcoded test count.** `enabling a group makes exactly that group appear` asserted `+4` for the
`ui` group, so adding a tool to that group failed the test for the wrong reason — it read as a leak
when the group had simply grown. It now counts the list it already asserts.

**And a null result worth stating.** The 7B still uses its entire step budget on this task: the
passing work is done in two calls, and the remaining eighteen are unrequested variables and a loop
on `unreal_doctor`, which takes no arguments and is the easiest thing to emit when a model has
finished and not realised it. `doctor`'s healthy answer now says outright that calling it again
returns the same thing. **It did not measurably help.** It is kept because the sentence is true,
not because it fixed anything, and the loop remains a model behaviour this tool surface has not yet
found a lever on.

## Which model tier actually works

Three models, on the same 12 GB card:

| Model | Loads? | Speed | Four-step task |
| --- | --- | --- | --- |
| `qwen2.5-coder:7b` (4.7 GB) | yes, at 16k context | ~20 tok/s | **0/5** |
| `qwen2.5-coder:14b` (9.0 GB) | **only at ≤8k context** | ~10 tok/s | **0/2** |
| `qwen3.8-27b` (16 GB) | **no tool template at all** | — | cannot be driven |

Three separate findings, each actionable:

**A 14B is capped by context, not just by size.** It loads at 4096 and 8192 and fails outright at
16384 on a 12 GB card. That matters enormously here, because the `lazy` profile is ~9.5k tokens of
tool definitions *by itself* — the tool list alone would consume the entire budget a 14B has
available. **Tool payload size does not merely cost tokens; it decides which models you can run at
all.** That measurement is what the `minimal` profile (10 tools, ~3.6k tokens) exists for.

**The 27B has no tool template**, so Ollama rejects the request outright: `does not support tools`.
The harness falls back to describing tools in the prompt, which is what a user of such a model has
to do, but it is worth checking before choosing a model.

**Doubling the parameters did not fix the failure.** The 14B fails in exactly the same way as the
7B, at half the speed. This is not a model-size problem at this scale: both complete step one,
declare the task finished, and repeat their first successful call. The tier that reliably drives
these tools is a frontier model, and saying so is more useful than implying a local model will do.

## Measurements

| | |
| --- | --- |
| Generation speed | **~16 tok/s** |
| Malformed arguments | 0 |
| Invented tool names | 0 |
| Tool calls via the structured tool API | **0** |
| Tool calls recovered from message text | **all of them** |

Three of those deserve comment.

**~16 tok/s, not the 40+ a 7B usually manages.** The model is fully on the GPU; the Unreal Editor
is sharing that GPU. This is the number for the situation people are actually in, and it is the one
worth planning around.

**Zero malformed arguments and zero invented tools, across every run.** The schemas and naming are
not where a small model struggles. That is the part of the design that is working.

**Not one call came through the structured tool-calling API.** `qwen2.5-coder:7b` emits tool calls
as JSON in the message body. Any client driving a small local model needs to parse that, and the
benchmark harness does. If you are choosing a local model, check this before anything else.

## What the benchmark changed

It found a failure no amount of reasoning had: given the wrong exec pin name, the model reissued
**the identical failing call eleven times** until the step limit stopped it. The error was already
correct and already named the answer:

```
output pin 'done' not found (available: then)
```

A message that *contains* the answer is not the same as a message a weak model can *act on*. So pin
resolution now accepts a near-miss and reports the correction:

- case- and separator-insensitive matches (`InString` resolves to `In String`)
- common aliases for an execution pin (`done`, `out`, `next`, `completed`)
- and, **only when the node has exactly one execution pin of that direction**, that pin — because
  then there is nothing else the caller could have meant

Every correction comes back in `pinNamesCorrected`, so the caller learns the real name instead of
being silently carried. A Branch has two execution outputs, so nothing is guessed there; the caller
gets the list.

The result: the eleven-call loop became a single successful call, and that task's runtime dropped
from 115s to 22s.

An empty pin list in an error message was fixed at the same time. `available: ` told a caller
nothing; it now says the node has no pins of that kind at all, so the node reference is wrong.

## What came next: the tool the benchmark asked for

The graph failure was a tooling problem, not a model one. The model knows an event should lead to a
print; it fails because `unreal_build_graph` asks it to get node refs, execution pin names, and a
nested JSON shape all correct at once, and any one of them being wrong fails the whole call.

So `unreal_add_event_handler` takes only the part a caller actually knows:

```
event "BeginPlay" -> [ PrintString("hello") ]
```

No pin names, no refs, no connection array — nothing in the input to get wrong. It places the
event, places each call, chains the execution pins in order, applies parameter defaults, looks up
each function's class in the live engine, and compiles. Verified end to end: BeginPlay and Print
String placed, **wired**, compiled clean, in one call.

## Two further findings, both uncomfortable

**A tool nobody finds does not exist.** After adding it, the model kept reaching for
`build_graph` anyway, because that is what it already knew and the task said "add graph logic". The
fix was a one-line pointer *inside `build_graph`'s own description*, where the model was already
looking. Building the better path is only half the work; the redirect has to be at the point of
confusion.

**Description length is a real cost at 7B, not a theoretical one.** The first version of that
pointer was a paragraph, and the extra ~600 characters pushed the model into truncating its output
mid-JSON — it went from working tool calls to none at all. Trimming it back to one sentence
restored it. On a small model, shorter and sharper genuinely beats complete, and this is the
concrete version of the context-bloat complaint the project had only measured in the abstract.

**Run-to-run variance at 7B is high.** With temperature 0.1 and identical input, the same model
sometimes drives the task correctly and sometimes replies "DONE" without calling anything. Any
claim about a small model's success rate needs several runs behind it, and a single green run
proves very little.

## Running it yourself

```bash
ollama pull qwen2.5-coder:7b
npm run bench:local -- --model qwen2.5-coder:7b --task health
npm run bench:local -- --model qwen2.5-coder:7b --task graph
```

Needs Ollama running and an editor open with the plugin. Assets are created under `/Game/Bench` and
deleted afterwards.
