import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

import { readSessionToken, sessionFileCandidates, SessionTokenCache } from "../dist/sessionToken.js";
import { UnrealBridgeClient } from "../dist/bridgeClient.js";

function withSessionFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "unreal-mcp-tok-"));
  const path = join(dir, "session.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  return { dir, path, env: { UNREAL_MCP_SESSION_FILE: path } };
}

test("an explicit session file wins over every platform guess", () => {
  const { dir, path, env } = withSessionFile({ port: 8765, token: "abc" });
  try {
    assert.deepEqual(sessionFileCandidates(8765, env), [path]);
    assert.equal(readSessionToken(8765, env).token, "abc");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the platform guesses are keyed by port, because the port is all a client knows yet", () => {
  const paths = sessionFileCandidates(9001, {});
  assert.ok(paths.length > 0);
  for (const p of paths) {
    assert.match(p, /session-9001\.json$/);
    assert.match(p, /UnrealMCPBridge/);
  }
});

test("a missing file is null, not an error, so an older plugin build still works", () => {
  const env = { UNREAL_MCP_SESSION_FILE: join(tmpdir(), "definitely-not-here-4831.json") };
  assert.equal(readSessionToken(8765, env), null);
});

test("a half-written file is skipped rather than throwing", () => {
  // The editor writes this at startup and a client can read it mid-write.
  const { dir, env } = withSessionFile('{"port": 8765, "tok');
  try {
    assert.equal(readSessionToken(8765, env), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file left behind by an editor on another port is not used", () => {
  const { dir, env } = withSessionFile({ port: 8999, token: "stale" });
  try {
    assert.equal(readSessionToken(8765, env), null, "authenticating against the wrong editor is worse than not authenticating");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty token is treated as no token", () => {
  const { dir, env } = withSessionFile({ port: 8765, token: "" });
  try {
    assert.equal(readSessionToken(8765, env), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cache reads once and forget makes it read again", () => {
  const { dir, path, env } = withSessionFile({ port: 8765, token: "first" });
  try {
    const cache = new SessionTokenCache();
    assert.equal(cache.get(8765, env).token, "first");

    writeFileSync(path, JSON.stringify({ port: 8765, token: "second" }), "utf8");
    assert.equal(cache.get(8765, env).token, "first", "the token changes only when the editor restarts");

    cache.forget(8765);
    assert.equal(cache.get(8765, env).token, "second", "a rejected call must be able to pick up a rotated token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Capture the exact line a client puts on the wire. */
async function captureRequestLine(env) {
  let seen = null;
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      seen = chunk.toString("utf8").trim();
      socket.write(JSON.stringify({ ok: true, id: "x", result: {} }) + "\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  // The port is chosen by the OS, so point the explicit-file env at a file describing THAT port.
  const previous = process.env.UNREAL_MCP_SESSION_FILE;
  if (env) {
    process.env.UNREAL_MCP_SESSION_FILE = env.file;
    writeFileSync(env.file, JSON.stringify({ port, token: env.token }), "utf8");
  } else {
    delete process.env.UNREAL_MCP_SESSION_FILE;
  }

  try {
    const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    await client.send("ping");
    return JSON.parse(seen);
  } finally {
    if (previous === undefined) delete process.env.UNREAL_MCP_SESSION_FILE;
    else process.env.UNREAL_MCP_SESSION_FILE = previous;
    server.close();
    await once(server, "close");
  }
}

test("the token actually reaches the wire when there is one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unreal-mcp-wire-"));
  try {
    const sent = await captureRequestLine({ file: join(dir, "s.json"), token: "sekrit-123" });
    assert.equal(sent.auth_token, "sekrit-123", "the whole point: both halves exist, not just the bridge's");
    assert.equal(sent.cmd, "ping");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no token file means no auth_token field, not an empty one", async () => {
  const sent = await captureRequestLine(null);
  assert.equal("auth_token" in sent, false, "an empty token would look like a failed auth rather than none");
  assert.equal(sent.cmd, "ping");
});

// --- where the client looks, and what it will believe when the bridge tells it ------------------
//
// These are the half of the feature that can be checked without an Unreal install. The other half,
// what FPlatformProcess::UserSettingsDir() actually returns, is what scripts/run-automation.mjs is
// for. Everything here is a pure function of (port, env), which is why the platform branches can be
// exercised at all on a machine running only one platform.

import { sessionSettingsRoots, isAcceptableSessionPath, readSessionTokenAt } from "../dist/sessionToken.js";
import { mkdirSync } from "node:fs";
import { sep } from "node:path";

/** A home directory that is not the one running the tests, so nothing here depends on this machine. */
function fakeHome() {
  const dir = mkdtempSync(join(tmpdir(), "unreal-mcp-home-"));
  return {
    dir,
    env: {
      HOME: dir,
      USERPROFILE: dir,
      LOCALAPPDATA: join(dir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dir, ".config"),
    },
  };
}

test("the candidates cover both the bare settings root and its Epic subdirectory", () => {
  // UE's own editor config lands in ~/Library/Application Support/Epic/UnrealEngine on macOS but
  // %LOCALAPPDATA%/UnrealEngine on Windows, which is what an Epic segment that exists on some
  // platforms and not others looks like from out here. Nothing on this side can settle which, so
  // both are searched: being wrong costs two stat calls, and used to cost the whole integration.
  const { dir, env } = fakeHome();
  try {
    const paths = sessionFileCandidates(8765, env);
    assert.ok(paths.some((p) => p.includes(`${sep}Epic${sep}`)), `no Epic variant in ${paths.join(", ")}`);
    assert.ok(paths.some((p) => !p.includes(`${sep}Epic${sep}`)), `no bare variant in ${paths.join(", ")}`);
    for (const path of paths) {
      assert.ok(path.startsWith(dir), `${path} escaped the fake home`);
      assert.match(path, /session-8765\.json$/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every path the client would search is a path it would accept from the bridge", () => {
  // If these two disagreed, the bridge naming its own file would be refused by the client, and the
  // self-correction this whole mechanism rests on would be dead code.
  const { dir, env } = fakeHome();
  try {
    for (const path of sessionFileCandidates(8765, env)) {
      assert.ok(isAcceptableSessionPath(path, 8765, env), `${path} is searched but would be refused`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the bridge's hint may disambiguate among settings directories, never point outside them", () => {
  // The hint arrives from a peer that has not authenticated - that is the entire reason it is being
  // sent - so following it blindly would let a process squatting the port name any file the user
  // can read and have its token field handed straight back over the same socket.
  const { dir, env } = fakeHome();
  try {
    const root = sessionSettingsRoots(env)[0];

    assert.ok(
      isAcceptableSessionPath(join(root, "SomeOtherLayout", "session-8765.json"), 8765, env),
      "a path under a settings root but not on the candidate list is exactly what the hint is for"
    );

    const refused = {
      "outside every settings root": join(dir, "elsewhere", "session-8765.json"),
      "a traversal back out of one": join(root, ...Array(12).fill(".."), "etc", "session-8765.json"),
      "a relative path": join("relative", "session-8765.json"),
      "a file for another port": join(root, "UnrealMCPBridge", "session-9999.json"),
      "a file with any other name": join(root, "UnrealMCPBridge", "credentials.json"),
      "nothing at all": "",
    };
    for (const [why, path] of Object.entries(refused)) {
      assert.equal(isAcceptableSessionPath(path, 8765, env), false, `accepted ${why}: ${path}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit session file is the user's own decision, and outranks the allow-list", () => {
  const { dir, path, env } = withSessionFile({ port: 8765, token: "abc" });
  try {
    assert.ok(isAcceptableSessionPath(path, 8765, env));
    assert.equal(
      isAcceptableSessionPath(join(dir, "something-else", "session-8765.json"), 8765, env),
      false,
      "setting the variable pins the path; it does not open the allow-list up"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading one named file applies the same rules as reading the candidate list", () => {
  const { dir, env } = fakeHome();
  try {
    const named = join(sessionSettingsRoots(env)[0], "Named", "session-8765.json");
    mkdirSync(dirname(named), { recursive: true });

    writeFileSync(named, JSON.stringify({ port: 8765, token: "from-the-hint" }), "utf8");
    assert.equal(readSessionTokenAt(named, 8765).token, "from-the-hint");

    writeFileSync(named, JSON.stringify({ port: 9999, token: "wrong-editor" }), "utf8");
    assert.equal(readSessionTokenAt(named, 8765), null);

    writeFileSync(named, "{ not json", "utf8");
    assert.equal(readSessionTokenAt(named, 8765), null);

    assert.equal(readSessionTokenAt(join(dirname(named), "absent.json"), 8765), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
