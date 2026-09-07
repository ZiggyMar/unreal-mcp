/**
 * The only interesting thing about writing a config file is what it does to a file that is already
 * there. Writing a fresh one is trivial and cannot really go wrong; clobbering somebody's other
 * three MCP servers can, and it is silent when it happens, because the symptom shows up in a
 * different tool an hour later.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeClientConfig,
  writeAllClientConfigs,
  SERVER_ENTRY_NAME,
  CLIENT_IDS,
} from "../dist/clientConfig.js";

const ENTRY = {
  command: "C:\\node\\node.exe",
  args: ["C:\\server\\index.js"],
  env: { UNREAL_MCP_PROFILE: "lazy" },
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "unreal-mcp-cfg-"));
}

test("a fresh directory gets a complete, valid config", () => {
  const dir = tmp();
  const r = writeClientConfig("claude-code", ENTRY, dir);

  assert.equal(r.status, "written");
  const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(parsed.mcpServers[SERVER_ENTRY_NAME], ENTRY);
});

test("an existing config keeps its other servers", () => {
  const dir = tmp();
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } }, someOtherKey: 1 })
  );

  const r = writeClientConfig("claude-code", ENTRY, dir);

  assert.equal(r.status, "merged");
  const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(parsed.mcpServers.github, { command: "gh-mcp" }, "sibling server survived");
  assert.equal(parsed.someOtherKey, 1, "unrelated top-level keys survived");
  assert.deepEqual(parsed.mcpServers[SERVER_ENTRY_NAME], ENTRY);
});

test("re-running replaces our own entry rather than duplicating it", () => {
  const dir = tmp();
  writeClientConfig("claude-code", ENTRY, dir);
  const changed = { ...ENTRY, args: ["C:\\server\\other.js"] };
  writeClientConfig("claude-code", changed, dir);

  const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.equal(Object.keys(parsed.mcpServers).length, 1);
  assert.deepEqual(parsed.mcpServers[SERVER_ENTRY_NAME], changed);
});

test("malformed JSON is refused, not overwritten", () => {
  const dir = tmp();
  const path = join(dir, ".mcp.json");
  const broken = '{ "mcpServers": { "github": { "command": "gh-mcp" },, } }';
  writeFileSync(path, broken);

  const r = writeClientConfig("claude-code", ENTRY, dir);

  assert.equal(r.status, "skipped");
  assert.equal(readFileSync(path, "utf8"), broken, "the user's file is untouched");
});

test("an empty file is not treated as malformed", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".mcp.json"), "");

  const r = writeClientConfig("claude-code", ENTRY, dir);

  assert.notEqual(r.status, "skipped");
  const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(parsed.mcpServers[SERVER_ENTRY_NAME], ENTRY);
});

test("VS Code uses its own root key", () => {
  const dir = tmp();
  writeClientConfig("vscode", ENTRY, dir);
  const parsed = JSON.parse(readFileSync(join(dir, ".vscode", "mcp.json"), "utf8"));
  assert.ok(parsed.servers[SERVER_ENTRY_NAME], "VS Code reads `servers`, not `mcpServers`");
  assert.equal(parsed.mcpServers, undefined);
});

test("codex TOML is written once and then left alone", () => {
  const dir = tmp();
  const first = writeClientConfig("codex", ENTRY, dir);
  assert.equal(first.status, "written");

  const path = join(dir, ".codex", "config.toml");
  const written = readFileSync(path, "utf8");
  assert.match(written, /\[mcp_servers\.unreal\]/);

  const second = writeClientConfig("codex", ENTRY, dir);
  assert.equal(second.status, "skipped", "TOML cannot be safely merged");
  assert.equal(readFileSync(path, "utf8"), written);
  assert.match(second.reason, /\[mcp_servers\.unreal\]/, "the skip tells you what to paste");
});

test("the sweep never touches the global Claude Desktop config", () => {
  const dir = tmp();
  const results = writeAllClientConfigs(ENTRY, dir);

  assert.ok(
    !results.some((r) => r.client === "claude-desktop"),
    "a per-project setup must not edit a machine-wide file as a side effect"
  );
  assert.ok(results.length >= 4);
  assert.ok(results.every((r) => r.status === "written" || r.status === "merged"));
  // Every file the sweep claims to have written is inside the directory it was pointed at.
  assert.ok(results.every((r) => r.path.startsWith(dir)));
});

test("claude-desktop is still reachable when asked for by name", () => {
  assert.ok(CLIENT_IDS.includes("claude-desktop"));
});

test("nested client directories are created", () => {
  const dir = tmp();
  mkdirSync(join(dir, "sub"));
  const r = writeClientConfig("cursor", ENTRY, join(dir, "sub"));
  assert.equal(r.status, "written");
  assert.ok(readFileSync(join(dir, "sub", ".cursor", "mcp.json"), "utf8").includes("unreal"));
});

test("a JSONC config is refused with the right reason, and its comments survive", () => {
  // VS Code reads .vscode/mcp.json as JSONC, so comments are legal there and common in a
  // hand-edited file. Calling that "malformed" tells the user their working config is broken.
  const dir = tmp();
  const withComments = '{\n  // my servers\n  "servers": { "other": { "command": "x" } },\n}\n';
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(join(dir, ".vscode", "mcp.json"), withComments);

  const r = writeClientConfig("vscode", ENTRY, dir);

  assert.equal(r.status, "skipped");
  assert.match(r.reason, /comments or trailing commas/);
  assert.match(r.reason, /by hand/, "and it hands over the entry to paste");
  assert.equal(readFileSync(join(dir, ".vscode", "mcp.json"), "utf8"), withComments, "not rewritten");
});

test("genuinely broken JSON still gets the malformed message, not the JSONC one", () => {
  const dir = tmp();
  mkdirSync(join(dir, ".vscode"));
  writeFileSync(join(dir, ".vscode", "mcp.json"), '{ "servers": ,,, }');
  const r = writeClientConfig("vscode", ENTRY, dir);
  assert.equal(r.status, "skipped");
  assert.match(r.reason, /not valid JSON/);
  assert.doesNotMatch(r.reason, /comments or trailing commas/);
});

test("a URL containing // is not mistaken for a comment", () => {
  // The scanner has to respect string literals, or a config with an http:// value lands on the
  // wrong branch and gets the wrong advice.
  const dir = tmp();
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { remote: { url: "http://example.com/mcp" } } }));
  const r = writeClientConfig("claude-code", ENTRY, dir);
  assert.equal(r.status, "merged", "valid JSON with a URL is just valid JSON");
  const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.equal(parsed.mcpServers.remote.url, "http://example.com/mcp");
});
