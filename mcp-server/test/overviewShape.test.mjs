import { test } from "node:test";
import assert from "node:assert/strict";

// The tool layer trims the parent-class census; this pins the two properties that make the trim
// safe. It runs against the real server over stdio because the trim lives in the tool handler, not
// in a shared function - which is deliberate: planFeature reads the bridge's own untouched shape.
import { startAndInitialize } from "../scripts/lib/mcpStdio.mjs";

test("the parent-class tail is summarised, and the totals still add up", async () => {
  // Measured on a real project: 79 parent classes, 43 of them with exactly one Blueprint, and
  // everything below the top eight was 452 of the reply's 702 tokens - 64% of the call the
  // instructions tell every model to make first. "One Blueprint inherits from BP_BillboardVariant_C"
  // orients nobody.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "overview-shape-test");
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
