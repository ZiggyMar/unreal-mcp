import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";

/**
 * Stand up a fake bridge that writes a scripted reply, and let the test choose how that reply is
 * chopped into TCP writes.
 *
 * The point of the split control is that the real bug only appears at a chunk boundary, and a
 * boundary is a delivery detail the client does not get to choose. A test that writes the reply in
 * one go passes with or without the fix, which is exactly how this survived so long.
 */
async function withFakeBridge(replyBytes, splits, run) {
  const server = createServer((socket) => {
    socket.once("data", async () => {
      let at = 0;
      for (const cut of splits) {
        socket.write(replyBytes.subarray(at, cut));
        at = cut;
        // A real gap, not just separate write() calls. Without it Node coalesces the writes into
        // one segment, the client sees a single data event, and the test passes whether or not the
        // bug is present - which is exactly the trap this test exists to avoid.
        await new Promise((r) => setTimeout(r, 15));
      }
      socket.write(replyBytes.subarray(at));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("a reply split mid-character is decoded correctly, not turned into U+FFFD", async () => {
  // Emoji and accented Latin: 4-byte and 2-byte sequences, so several places to cut badly.
  const name = "/Game/Ürsprung/Blueprints/BP_Kämpfer_🗡️.BP_Kämpfer_🗡️";
  const reply = Buffer.from(JSON.stringify({ ok: true, id: "x", result: { path: name } }) + "\n", "utf8");

  // Cut inside the multi-byte sequences rather than at a tidy offset.
  const first = reply.indexOf(Buffer.from("Ü", "utf8"));
  const sword = reply.indexOf(Buffer.from("🗡", "utf8"));
  assert.ok(first > 0 && sword > first, "the fixture should actually contain the characters under test");

  const got = await withFakeBridge(reply, [first + 1, sword + 2], async (port) => {
    const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    return client.send("ping");
  });

  assert.equal(got.path, name, "the path must survive a split that lands inside a UTF-8 sequence");
  assert.ok(!JSON.stringify(got).includes("�"), "no replacement characters should appear");
});

test("a reply delivered in one write still works", async () => {
  const reply = Buffer.from(JSON.stringify({ ok: true, id: "x", result: { ok: 1 } }) + "\n", "utf8");
  const got = await withFakeBridge(reply, [], async (port) => {
    const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    return client.send("ping");
  });
  assert.deepEqual(got, { ok: 1 });
});

// --- following the bridge's hint about where its token lives ------------------------------------
//
// sessionToken.ts guesses at UE's per-platform settings directory and nothing on this side can
// check that guess. When it is wrong the bridge refuses the call and names the file it actually
// wrote; these assert that the client reads that file and sends the command again, and that it
// refuses to be pointed anywhere else.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionSettingsRoots } from "../dist/sessionToken.js";

/**
 * A bridge that answers each request from a script and keeps every request line it was sent.
 *
 * Keeping the lines is the point: the claim being tested is about what goes on the wire and how
 * many times, which a test that only inspects the returned value cannot make.
 */
async function withScriptedBridge(reply, run) {
  const seen = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        seen.push(request);
        socket.write(JSON.stringify(reply(request, seen.length)) + "\n");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await run(port, seen);
  } finally {
    server.close();
    await once(server, "close");
  }
}

/**
 * Run with a home directory that is not this machine's, and with no explicit session file, so the
 * candidate list and the allow-list are both hermetic and the same on every platform.
 */
async function withFakeHome(run) {
  const dir = mkdtempSync(join(tmpdir(), "unreal-mcp-hint-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    UNREAL_MCP_SESSION_FILE: process.env.UNREAL_MCP_SESSION_FILE,
  };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.LOCALAPPDATA = join(dir, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(dir, ".config");
  delete process.env.UNREAL_MCP_SESSION_FILE;
  try {
    return await run(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
test("a refusal that names the token file is retried against that file, once", async () => {
  await withFakeHome(async () => {
    // Assigned once the OS has chosen a port, and read by the reply closure at call time. The file
    // sits under a settings root, so the client will read it, but is not on the candidate list, so
    // the first attempt could not have found it: that is the exact shape of a wrong guess at what
    // FPlatformProcess::UserSettingsDir() returns.
    let hinted = null;

    await withScriptedBridge(
      (request, nth) =>
        nth === 1
          ? { ok: false, id: request.id, error: "unauthorized", session_file: hinted }
          : { ok: true, id: request.id, result: { status: "ok" } },
      async (port, seen) => {
        hinted = join(sessionSettingsRoots(process.env)[0], "SomewhereElse", `session-${port}.json`);
        mkdirSync(dirname(hinted), { recursive: true });
        writeFileSync(hinted, JSON.stringify({ port, token: "found-by-following-the-hint" }), "utf8");

        const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
        assert.deepEqual(await client.send("ping"), { status: "ok" });

        assert.equal(seen.length, 2, "exactly one retry, not zero and not a loop");
        assert.equal(seen[0].auth_token, undefined, "the first attempt had no token to send");
        assert.equal(seen[1].auth_token, "found-by-following-the-hint", "the second used the hinted file");
        assert.equal(seen[1].cmd, "ping");
      }
    );
  });
});

test("a bridge that refuses forever stops after one retry, without a counter to get wrong", async () => {
  // The termination argument is that the second attempt only asks for another retry if the bridge
  // names a DIFFERENT path than the one just used, and it never will, because it only ever names
  // its own. This is the test of that claim: a bridge that refuses every request while hinting at a
  // perfectly good file must still be given up on.
  await withFakeHome(async () => {
    let hinted = null;
    await withScriptedBridge(
      (request) => ({ ok: false, id: request.id, error: "unauthorized", session_file: hinted }),
      async (port, seen) => {
        hinted = join(sessionSettingsRoots(process.env)[0], "SomewhereElse", `session-${port}.json`);
        mkdirSync(dirname(hinted), { recursive: true });
        writeFileSync(hinted, JSON.stringify({ port, token: "always-refused" }), "utf8");

        const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
        await assert.rejects(() => client.send("ping"), /unauthorized/i);
        assert.equal(seen.length, 2, "one attempt, one retry, then stop");
        assert.equal(seen[1].auth_token, "always-refused", "the retry did happen; it just did not help");

        // The realistic version of this is an editor that restarted and reissued its token. Saying
        // the client refused to read a file it had just read would send someone hunting the wrong bug.
        await assert.rejects(
          () => client.send("ping"),
          (err) => {
            assert.match(err.message, /which is the file this call read/);
            assert.doesNotMatch(err.message, /could not be read|outside every settings directory/);
            return true;
          }
        );
      }
    );
  });
});

test("a refusal pointing outside the settings directories is not followed", async () => {
  await withFakeHome(async (dir) => {
    // A file that exists, is readable, and holds a token, but sits somewhere the bridge has no
    // business naming. A process squatting the port must not be able to have this read back to it.
    const planted = join(dir, "not-a-settings-dir", "session-1.json");
    mkdirSync(dirname(planted), { recursive: true });
    writeFileSync(planted, JSON.stringify({ token: "should-never-be-sent" }), "utf8");

    await withScriptedBridge(
      (request) => ({ ok: false, id: request.id, error: "unauthorized", session_file: planted }),
      async (port, seen) => {
        const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
        await assert.rejects(() => client.send("ping"), /unauthorized/i);
        assert.equal(seen.length, 1, "no retry, so the planted token never reached the wire");
        assert.equal(
          seen.every((request) => request.auth_token === undefined),
          true,
          "and nothing read from it was sent to anyone"
        );
      }
    );
  });
});

test("a refusal with no hint at all names every path that was searched", async () => {
  await withFakeHome(async () => {
    await withScriptedBridge(
      (request) => ({ ok: false, id: request.id, error: "unauthorized" }),
      async (port, seen) => {
        const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
        await assert.rejects(
          () => client.send("ping"),
          (err) => {
            assert.match(err.message, /Looked in:/);
            assert.match(err.message, new RegExp(`session-${port}\\.json`));
            assert.match(err.message, /older than\s+this feature/, "an unhinted refusal means an old plugin build");
            return true;
          }
        );
        assert.equal(seen.length, 1, "with no hint there is nothing to retry against");
      }
    );
  });
});
