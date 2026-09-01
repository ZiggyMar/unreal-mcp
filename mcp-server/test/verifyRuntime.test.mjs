import { test } from "node:test";
import assert from "node:assert/strict";

import { summariseRuntime } from "../dist/verifyRuntime.js";

// This summariser decides whether a change gets reported as working, so its two ways of being wrong
// matter more than its right answers. Both were real: the first version cried wolf on every
// multi-actor value, and flagged a value that was correct throughout as suspicious.

test("actor names differing between worlds is not a disagreement", () => {
  // PIE gives the same pawn a different suffix in each world - C_3 on the server is C_2 on the
  // client - so comparing the labelled strings reported a replication bug on every value with more
  // than one actor, every single time.
  const verdict = summariseRuntime([
    { watch: "BP_Player.PlayerName", role: "Authority", first: "x", last: "2 actors differ: BP_Player_C_1=Bunny | BP_Player_C_3=Squiddy", changed: true },
    { watch: "BP_Player.PlayerName", role: "Client0", first: "x", last: "2 actors differ: BP_Player_C_1=Bunny | BP_Player_C_2=Squiddy", changed: true },
  ]);
  assert.equal(verdict.agreement[0].agreed, true, verdict.verdict);
  assert.match(verdict.verdict, /agreed across all running worlds/);
});

test("a genuine split between roles is still reported", () => {
  const verdict = summariseRuntime([
    { watch: "BP_Player.PlayerName", role: "Authority", first: "a", last: "2 actors differ: BP_Player_C_1=Bunny | BP_Player_C_3=Devil", changed: true },
    { watch: "BP_Player.PlayerName", role: "Client0", first: "a", last: "2 actors differ: BP_Player_C_1=None | BP_Player_C_2=Bunny", changed: true },
  ]);
  assert.equal(verdict.agreement[0].agreed, false);
  assert.match(verdict.verdict, /differ between roles/);
  // The names survive into the report even though they are ignored for the comparison: which copy is
  // wrong is the thing a caller acts on.
  assert.match(JSON.stringify(verdict.agreement[0].byRole), /BP_Player_C_1=None/);
});

test("a value that was correct from the first sample is not called unwritten", () => {
  // Stable is not the same as unwritten. Reporting a correct value as suspicious is how a check
  // stops being read.
  const verdict = summariseRuntime([
    { watch: "BP_Player.PlayerName", role: "Authority", first: "Starry", last: "Starry", changed: false },
    { watch: "BP_Player.PlayerName", role: "Client0", first: "Starry", last: "Starry", changed: false },
  ]);
  assert.deepEqual(verdict.neverChanged, []);
  assert.match(verdict.verdict, /agreed across all running worlds/);
});

test("a value that stayed empty all session is called out", () => {
  // This is the orphaned-event shape: nothing ever wrote it, and saying so points at the cause.
  const verdict = summariseRuntime([
    { watch: "BP_Player.PlayerName", role: "Authority", first: "None", last: "None", changed: false },
    { watch: "BP_Player.PlayerName", role: "Client0", first: "None", last: "None", changed: false },
  ]);
  assert.deepEqual(verdict.neverChanged, ["BP_Player.PlayerName"]);
  assert.match(verdict.verdict, /never changed/);
  assert.match(verdict.verdict, /trace_function_calls/);
});
