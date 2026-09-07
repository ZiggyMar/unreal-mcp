/**
 * What can be tested without Epic's plugin running, which is the state almost every session is in.
 *
 * The plugin is Experimental, opt-in, and does not auto-start, so "not there" is not an edge case
 * here - it is the default. These tests cover that path and the configuration around it. The wire
 * protocol itself needs a running editor and is not faked: a mock that agrees with my reading of
 * Epic's server would prove only that I am consistent with myself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EpicClient,
  epicTargetFromEnv,
  epicUrl,
  EPIC_META,
  ENABLE_HINT,
  EPIC_DEFAULT_PORT,
} from "../dist/epicDelegate.js";

/** A port nothing is on. 9 is discard; picking a high unlikely one keeps the refusal instant. */
const DEAD = { host: "127.0.0.1", port: 59_237, path: "/mcp" };

test("the defaults match what Epic documents", () => {
  const target = epicTargetFromEnv({});
  assert.equal(target.host, "127.0.0.1");
  assert.equal(target.port, EPIC_DEFAULT_PORT);
  assert.equal(target.port, 8000);
  assert.equal(target.path, "/mcp");
  assert.equal(epicUrl(target), "http://127.0.0.1:8000/mcp");
});

test("the host stays literal 127.0.0.1 rather than localhost", () => {
  // Epic's HTTP listener binds the IPv4 loopback. "localhost" can resolve to ::1 first, which is a
  // different socket and a connection refused that looks exactly like the plugin being off.
  assert.match(epicUrl(epicTargetFromEnv({})), /^http:\/\/127\.0\.0\.1:/);
});

test("the target is configurable, and junk falls back rather than breaking the URL", () => {
  const custom = epicTargetFromEnv({
    UNREAL_MCP_EPIC_HOST: "127.0.0.2",
    UNREAL_MCP_EPIC_PORT: "9001",
    UNREAL_MCP_EPIC_PATH: "/other",
  });
  assert.equal(epicUrl(custom), "http://127.0.0.2:9001/other");

  for (const bad of ["", "not-a-number", "0", "-1"]) {
    const t = epicTargetFromEnv({ UNREAL_MCP_EPIC_PORT: bad });
    assert.equal(t.port, EPIC_DEFAULT_PORT, `"${bad}" should fall back, not produce a broken URL`);
  }
});

test("status answers rather than throwing when nothing is listening", async () => {
  const client = new EpicClient(DEAD);
  const result = await client.status();

  assert.equal(result.reachable, false, "absence is an answer, not a failure");
  assert.equal(result.url, epicUrl(DEAD));
  assert.ok(result.hint, "a refusal has to say what to do about it");
});

test("the hint names the actual steps, not the socket error", async () => {
  const result = await new EpicClient(DEAD).status();
  // The reader does not know that 8000 is Epic's plugin, that it is opt-in, or that it does not
  // start by itself. ECONNREFUSED tells them none of that.
  assert.match(result.hint, /Edit > Plugins/);
  assert.match(result.hint, /All Toolsets/);
  assert.match(result.hint, /StartServer/);
  assert.equal(result.hint, ENABLE_HINT);
});

test("status is fast when the port is dead, because that is the normal case", async () => {
  const client = new EpicClient(DEAD);
  const started = process.hrtime.bigint();
  await client.status();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // A refused loopback connect returns in about a millisecond. The bound here is loose enough not
  // to be flaky and tight enough to catch a regression that waits out the full probe timeout.
  assert.ok(ms < 2_000, `status took ${Math.round(ms)}ms; absence must not cost the caller a wait`);
});

test("repeated status calls stay cheap and keep answering", async () => {
  const client = new EpicClient(DEAD);
  for (let i = 0; i < 3; i++) {
    const r = await client.status();
    assert.equal(r.reachable, false, `call ${i + 1} should still answer`);
  }
});

test("a real call fails with the enable hint, not a raw transport error", async () => {
  const client = new EpicClient(DEAD);
  await assert.rejects(
    () => client.listTools(),
    (err) => {
      assert.match(err.message, /Edit > Plugins/);
      return true;
    }
  );
});

test("Epic's meta-tool names are spelled exactly as their source spells them", () => {
  // From ModelContextProtocolToolSearch.cpp. A typo here produces "unknown tool" from a server the
  // user cannot debug, so they are named once and asserted rather than typed at each call site.
  assert.deepEqual(EPIC_META, {
    listToolsets: "list_toolsets",
    describeToolset: "describe_toolset",
    callTool: "call_tool",
  });
});

test("the tool-search mode probe is cached, not re-asked per call", async () => {
  // The first version listed tools before EVERY delegated call - two round trips to the editor's
  // game thread where one would do, on the path whose entire reason for existing is that round
  // trips are expensive. This asserts the cache exists by counting how often the wire is touched.
  const client = new EpicClient(DEAD);
  let listCalls = 0;
  client.listTools = async () => {
    listCalls++;
    return [{ name: "call_tool" }];
  };

  assert.equal(await client.usesToolSearch(), true);
  assert.equal(await client.usesToolSearch(), true);
  assert.equal(await client.usesToolSearch(), true);
  assert.equal(listCalls, 1, "three calls, one round trip");
});

test("a dropped connection re-asks the mode rather than trusting a stale answer", async () => {
  // Tool Search is a user preference they can flip in Editor Preferences, and Epic only broadcasts
  // the change into an already-open stream, so we would miss it. Tying the cache to the connection
  // means a restarted editor - which is when it would actually have changed - re-asks.
  const client = new EpicClient(DEAD);
  let listCalls = 0;
  client.listTools = async () => {
    listCalls++;
    return [{ name: "call_tool" }];
  };

  await client.usesToolSearch();
  assert.equal(listCalls, 1);

  // status() on a dead port resets the connection, which must clear the cached mode with it.
  await client.status();
  await client.usesToolSearch();
  assert.equal(listCalls, 2, "the mode is re-asked after the connection is dropped");
});

/**
 * Retry safety. The previous version retried on ANY rejection, which meant a delegated call that
 * timed out - while the editor was still executing it on the game thread - was sent again and ran
 * twice. Epic's toolsets create assets, add Sequencer tracks and spawn PCG content.
 */

test("a timeout is never repeated, because the editor may still be running it", async () => {
  const client = new EpicClient(DEAD);
  let attempts = 0;
  client.connect = async () => ({
    callTool: async () => {
      attempts++;
      throw new Error("MCP error -32001: Request timed out");
    },
  });

  await assert.rejects(() => client.callTool("create_asset", { name: "BP_Hero" }));
  assert.equal(attempts, 1, "a timed-out mutating call must be attempted exactly once");
});

test("a stale session is retried for a read, and not repeated for a call", async () => {
  const stale = new Error("HTTP 404: session not found");

  const reader = new EpicClient(DEAD);
  let readAttempts = 0;
  reader.connect = async () => ({
    listTools: async () => {
      readAttempts++;
      if (readAttempts === 1) throw stale;
      return { tools: [{ name: "call_tool" }] };
    },
  });
  const tools = await reader.listTools();
  assert.equal(readAttempts, 2, "a read is safe to repeat, so a dead session reconnects");
  assert.equal(tools[0].name, "call_tool");

  const writer = new EpicClient(DEAD);
  let writeAttempts = 0;
  writer.connect = async () => ({
    callTool: async () => {
      writeAttempts++;
      throw stale;
    },
  });
  await assert.rejects(
    () => writer.callTool("create_asset", {}),
    (e) => {
      assert.match(e.message, /did not run/, "it must say the call did not run");
      assert.match(e.message, /Send it again/, "and hand the decision back");
      return true;
    }
  );
  assert.equal(writeAttempts, 1, "a mutating call is never repeated automatically");
});

test("an error the server deliberately returned is not dressed up as a missing plugin", async () => {
  // A typo in a tool name used to tear down a healthy session, ask twice, and answer with 380
  // characters about enabling a plugin that was working, with the real cause at the very end.
  const client = new EpicClient(DEAD);
  let attempts = 0;
  client.connect = async () => ({
    callTool: async () => {
      attempts++;
      throw new Error("MCP error -32602: Unknown tool: unreal.spawn_actorr");
    },
  });

  await assert.rejects(
    () => client.callTool("unreal.spawn_actorr", {}),
    (e) => {
      assert.match(e.message, /Unknown tool/);
      assert.doesNotMatch(e.message, /Edit > Plugins/, "this is not a setup problem");
      return true;
    }
  );
  assert.equal(attempts, 1, "and it is not retried");
});
