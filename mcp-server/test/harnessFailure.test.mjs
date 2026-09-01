import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startServer } from "../scripts/lib/mcpStdio.mjs";

// A measurement harness that goes quiet when the thing it measures is dead is worse than one that
// crashes, because silence reads as success.
//
// This is not hypothetical. A startup crash - a const read before its initialisation, which
// TypeScript compiles without complaint - killed the server, `initialize` never resolved, node's
// event loop emptied, and measure-profiles.mjs printed NOTHING and exited 0. Twenty minutes went
// into "why is the table empty" before anyone suspected the server.
//
// The failure mode is silence, so nothing would notice it coming back. Hence a test.

// async/await, not try/finally around a returned promise: the first version deleted the temp
// directory the instant body() handed back its promise, so the child started against a file that no
// longer existed and every failure read as MODULE_NOT_FOUND.
const withBrokenServer = async (body, script) => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-harness-"));
  const path = join(dir, "broken-server.mjs");
  writeFileSync(path, script);
  try {
    return await body(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a server that dies at startup is reported, not waited on forever", async () => {
  await withBrokenServer(async (path) => {
    const server = startServer({}, path);
    await assert.rejects(
      () => server.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } }),
      (err) => {
        assert.match(err.message, /exited/, `expected an exit report, got: ${err.message}`);
        // The server's own words, not a generic failure - which half is broken is the whole
        // question when this fires.
        assert.match(err.message, /deliberate startup failure/);
        return true;
      }
    );
  }, 'console.error("deliberate startup failure"); process.exit(1);\n');
});

test("a request sent after the server is gone fails immediately", async () => {
  await withBrokenServer(async (path) => {
    const server = startServer({}, path);
    await server.request("initialize", {}).catch(() => {});
    await assert.rejects(
      () => server.request("tools/list", {}),
      (err) => {
        assert.match(err.message, /already exited/);
        return true;
      }
    );
  }, 'process.exit(3);\n');
});

test("a server with nothing on stderr still says so rather than nothing at all", async () => {
  await withBrokenServer(async (path) => {
    const server = startServer({}, path);
    await assert.rejects(
      () => server.request("initialize", {}),
      (err) => {
        assert.match(err.message, /wrote nothing to stderr/);
        return true;
      }
    );
  }, "process.exit(2);\n");
});
