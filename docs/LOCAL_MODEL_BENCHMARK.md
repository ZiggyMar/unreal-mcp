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

**Task 1 — create a Blueprint, add a float variable, compile, save: PASSED.**

```
[0] unreal_create_blueprint(...)  -> ERR package_already_exists: /Game/Bench/BP_BenchTarget
[1] unreal_create_blueprint(...)  -> ok  BP_BenchTarget_1
[2] unreal_add_variable(...)      -> ok  { "added": true, "name": "Health", "type": "float" }
[3] unreal_compile_blueprint(...) -> ok  { "errorCount": 0, "success": true }
[4] unreal_save_blueprint(...)    -> ok  { "saved": true }
TASK COMPLETED
```

Step 0 to 1 is the part worth noticing. The model hit a name collision, **read the error, and
recovered by renaming, unprompted**. That is the self-correction the error-message design exists
for, demonstrated by a 7B rather than assumed.

**Task 2 — wire an event to a Print String in a graph: FAILED.**

The model creates the Blueprint and places nodes, but cannot reliably connect an event to a
function call in one atomic call. It splits the work across calls and ends with
`connectionsMade: 0`.

That is an honest boundary: **at 7B, asset-level work is reliable and graph wiring is not.**

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

## Running it yourself

```bash
ollama pull qwen2.5-coder:7b
npm run bench:local -- --model qwen2.5-coder:7b --task health
npm run bench:local -- --model qwen2.5-coder:7b --task graph
```

Needs Ollama running and an editor open with the plugin. Assets are created under `/Game/Bench` and
deleted afterwards.
