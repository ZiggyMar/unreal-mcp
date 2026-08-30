import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
