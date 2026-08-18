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
| Profile | `UNREAL_MCP_PROFILE=lazy` (23 tools, ~7.3k tokens of definitions) |
| Mode | `standard` |

## Results

Run five times each, because a single run proves nothing. `--runs 5` reports the pass rate and the
run-by-run pattern.

**Task 1 — create a Blueprint, add a float variable, compile, save: 0/5.**

The first version of this document reported this task as PASSED on the strength of **one** run. It
is not reproducible. Five runs, same model, same temperature, same prompt: `FFFFF`. The single
green run was luck, and reporting it was the mistake the variance warning further down was already
warning about.

What actually happens is consistent and more interesting than a bare failure:

```
[0] unreal_create_blueprint(...)  -> ok
[1] model says: DONE                              <- after one of four steps
[2] unreal_create_blueprint(...)  -> ERR package_already_exists
[3] unreal_create_blueprint(BP_BenchTarget_New)   -> ok
[4] model says: DONE
```

The model completes step one, declares the whole task finished, and when told specifically what is
still missing ("the Health variable was never added") it **creates another Blueprint** rather than
adding the variable. It fixates on the first tool it used successfully.

This survives being told exactly what to do next. The harness re-checks the project on every "DONE"
and feeds back the precise gap — the same thing `unreal_review_blueprint` exists to provide — and
the model still does not switch tools.

**Task 2 — wire an event to a Print String: 0/5.** Same shape.

**The honest conclusion: `qwen2.5-coder:7b` cannot sustain a four-step task through this server, and
no amount of tool design fixes that.** It is not failing on schemas, names, or engine specifics —
it is failing to track multi-step progress. The tooling removed every failure mode it could; what
is left is model capability.

That is useful to know precisely because it is a boundary the tooling cannot move, and it says what
to target: single-step-per-turn use, or a larger model.

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
