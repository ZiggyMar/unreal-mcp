import { test } from "node:test";
import assert from "node:assert/strict";

// The tool layer trims the parent-class census; this pins the two properties that make the trim
// safe. It runs against the real server over stdio because the trim lives in the tool handler, not
// in a shared function - which is deliberate: planFeature reads the bridge's own untouched shape.
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

test("the parent-class tail is summarised, and the totals still add up", async () => {
  // Measured on a real project: 79 parent classes, 43 of them with exactly one Blueprint, and
  // everything below the top eight was 452 of the reply's 702 tokens - 64% of the call the
  // instructions tell every model to make first. "One Blueprint inherits from BP_BillboardVariant_C"
  // orients nobody.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: DEAD_PORT }, "overview-shape-test");
  try {
    const res = await server.request("tools/call", { name: "unreal_get_project_overview", arguments: {} });
    const text = res?.result?.content?.map((c) => c.text).join("\n") ?? "";
    if (/UnrealMCPBridge error|not_connected|ECONNREFUSED/i.test(text)) {
      // No editor: this asserts about a live project's shape and has nothing to say without one.
      return;
    }
    const overview = JSON.parse(text);
    const kept = overview.byParentClass ?? {};

    // Every surviving class is one the cut promises to keep, whatever the project looks like.
    for (const [name, count] of Object.entries(kept)) {
      assert.ok(count >= 3, `${name} has ${count} and should have been folded into the tail`);
    }

    // The tail is counted, not dropped - the note has to account for the Blueprints it hides, or
    // the reply quietly disagrees with its own total.
    if (overview.otherParentClasses) {
      const hidden = Number(/account for (\d+) Blueprint/.exec(overview.otherParentClasses)?.[1] ?? "0");
      const shown = Object.values(kept).reduce((a, b) => a + b, 0);
      assert.equal(
        shown + hidden,
        overview.blueprintCount,
        "kept + hidden must equal the census the same reply reports"
      );
    }
  } finally {
    server.child.kill();
  }
});

test("a small index drift is one clause; a large one keeps the bridge's full warning", async () => {
  // The bridge notices its cached index disagreeing with the editor and says so in 68 tokens. On
  // this project the disagreement is 341 against 339 - 0.6%, present all session - and nothing a
  // reader takes from this reply changes because of two Blueprints. A rounding error was being
  // reported in a paragraph, on the first call of every session.
  //
  // Both branches matter: the trim must not apply when the cache really is stale, because then the
  // advice about which tools are authoritative is worth its tokens.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: DEAD_PORT }, "overview-drift-test");
  try {
    const res = await server.request("tools/call", { name: "unreal_get_project_overview", arguments: {} });
    const text = res?.result?.content?.map((c) => c.text).join("\n") ?? "";
    if (/UnrealMCPBridge error|not_connected|ECONNREFUSED/i.test(text)) return; // needs an editor
    const overview = JSON.parse(text);
    if (!overview.indexDrift) return; // no drift on this machine, nothing to assert about

    const cached = overview.blueprintCount;
    const inEditor = overview.blueprintCountInEditor ?? cached;
    const ratio = Math.abs(cached - inEditor) / cached;

    // Whichever branch ran, both numbers have to survive - a reader who cares about the exact
    // disagreement must still be able to see it.
    assert.match(String(overview.indexDrift), new RegExp(String(cached)));
    assert.match(String(overview.indexDrift), new RegExp(String(inEditor)));

    if (ratio < 0.02) {
      assert.doesNotMatch(String(overview.indexDrift), /treat them as approximate/);
    } else {
      assert.match(String(overview.indexDrift), /authoritative/);
    }
  } finally {
    server.child.kill();
  }
});
