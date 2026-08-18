#!/usr/bin/env node
// Refuse to test against a binary older than the source.
//
// This plugin is built against two engine versions. A change built for one and then exercised
// against the other fails in a way that looks exactly like a broken feature, and the instinct is to
// go and fix code that was never wrong. That has now cost time three times:
//
//   - a guard "that could not fire on a fresh project" (it could; the binary predated it)
//   - `add_variable did not report the parent class` (it did; built for 5.6, run on 5.8)
//   - and once before that, chasing a hang that was a modal dialog
//
// The editor cannot tell you its plugin is stale. The plugin can, so `ping` reports when it was
// compiled and this compares that against the newest source file. It is deliberately a hard failure
// rather than a warning: a warning at the top of a hundred lines of passing checks is a warning
// nobody reads.
//
// Usage: node scripts/check-binary-fresh.mjs

import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(here, "..", "..", "UnrealMCPBridge", "Source");

/** Newest modification time across the plugin's C++ sources. */
function newestSourceTime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceTime(full));
    } else if (/\.(cpp|h|cs)$/i.test(entry.name)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** `__DATE__ __TIME__` looks like "Aug 18 2026 11:53:19" and Date can parse that directly. */
function parseBuildStamp(stamp) {
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? null : parsed;
}

async function main() {
  const bridge = new UnrealBridgeClient({
    host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
    port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
  });

  let info;
  try {
    info = await bridge.send("ping", {});
  } catch (err) {
    console.error(`no editor to check: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    process.exit(2);
  }

  if (!info.pluginBuiltAt) {
    console.error(
      "This editor's plugin does not report pluginBuiltAt, which means it predates that field - " +
        "so it is certainly older than the source. Rebuild it."
    );
    process.exit(1);
  }

  const built = parseBuildStamp(info.pluginBuiltAt);
  const newestSource = newestSourceTime(SOURCE_ROOT);
  const project = info.project ?? "(unknown project)";
  const engine = info.engineVersion ?? "(unknown engine)";

  if (built === null) {
    console.log(`could not parse the build stamp "${info.pluginBuiltAt}"; skipping the freshness check`);
    return;
  }

  // A minute of slack: the compiler stamps each translation unit as it reaches it, so a build that
  // began before the last save can still contain the change.
  const SLACK_MS = 60_000;
  if (built + SLACK_MS < newestSource) {
    const behind = Math.round((newestSource - built) / 60_000);
    console.error(
      `stale plugin binary` +
        `\n  editor:       ${project} on ${engine}` +
        `\n  plugin built: ${info.pluginBuiltAt}` +
        `\n  newest source is ${behind} minute(s) newer` +
        `\n` +
        `\nThe running editor is not testing the code you just wrote. Rebuild the plugin for THIS` +
        `\nengine and restart the editor. Two engine versions means two builds; a build for one of` +
        `\nthem proves nothing about the other.`
    );
    process.exit(1);
  }

  console.log(`binary fresh: ${project} on ${engine}, plugin built ${info.pluginBuiltAt}`);
}

main().catch((err) => {
  console.error(`freshness check failed: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
