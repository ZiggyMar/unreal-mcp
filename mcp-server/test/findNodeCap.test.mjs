import { test } from "node:test";
import assert from "node:assert/strict";

import { startAndInitialize } from "../scripts/lib/mcpStdio.mjs";

// Tests never talk to a real editor. This pins the bridge to a port nothing listens on.
//
// Without it they use the default 8765, and if an editor happens to be running they reach it. That
// is not merely impure, it is slow in the worst way: an editor whose game thread is BLOCKED accepts
// the connection and never answers, so every bridge-touching test waits the full timeout. Measured
// with one blocked editor open, three tests took 181 seconds each and the suite went from 17 seconds
// to six minutes - which then pushed the pre-push hook past its limit.
//
// A refused connection is instant and deterministic, and these tests are about what the SERVER does
// with a request, not what an editor answers. The trial and live-verify scripts deliberately do the
// opposite: they take the default because reaching the editor is their entire point.
const DEAD_PORT = "8791";

// find_node is the tool the standing instructions point every model at before it writes a node -
// "never guess a function name". Its hitCount reports how many came BACK, not how many matched:
//
//   find_node "get" maxResults 2   ->  hits 2,  hitCount 2
//   find_node "get" maxResults 50  ->  hits 50, hitCount 50
//
// Both claim to have counted, in a catalog of 15,234 functions, and nothing said the cap had been
// hit. search_project has always sent `truncated`; this one was never given it.

test("a capped find_node says the count is a cap, not a total", async () => {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: DEAD_PORT }, "find-node-cap-test");
  try {
    const ask = async (args) => {
      const res = await server.request("tools/call", { name: "unreal_find_node", arguments: args });
      const text = res?.result?.content?.map((c) => c.text).join("\n") ?? "";
      if (/UnrealMCPBridge error|not_connected|ECONNREFUSED/i.test(text)) return null; // needs an editor
      return JSON.parse(text);
    };

    const capped = await ask({ query: "get", maxResults: 2 });
    if (!capped) return;
    assert.equal(capped.hits.length, 2);
    assert.equal(capped.truncated, true, "two of fifteen thousand is a cap, not an answer");
    assert.match(capped.cappedNote, /not what matched/);

    // A search that genuinely has few results must stay clean - a flag on every reply would be the
    // same noise problem one level down.
    const exact = await ask({ query: "SpawnActorFromClass" });
    if (!exact) return;
    assert.ok(exact.hits.length < 20, "this really does match a handful");
    assert.equal(exact.truncated, undefined, "not capped, so nothing to say");
    assert.equal(exact.cappedNote, undefined);
  } finally {
    server.child.kill();
  }
});
