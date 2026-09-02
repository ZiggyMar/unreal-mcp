import { test } from "node:test";
import assert from "node:assert/strict";

import { startAndInitialize } from "../scripts/lib/mcpStdio.mjs";

// The doctor TOOL compacts a healthy report and must never compact an unhealthy one. The healthy
// half needs a live editor; this half does not, and it is the half where being wrong does damage -
// a diagnostic that gets terser exactly when something breaks is worse than no diagnostic.
//
// Pointed at a port nothing is listening on, which is a real failure rather than a simulated one.

test("a report that is not ready keeps every check, in full", async () => {
  const server = await startAndInitialize(
    { UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: "8799" },
    "doctor-degraded-test"
  );
  try {
    const res = await server.request("tools/call", { name: "unreal_doctor", arguments: {} });
    const text = res?.result?.content?.map((c) => c.text).join("\n") ?? "";
    const report = JSON.parse(text);

    assert.notEqual(report.verdict, "ready", "nothing is listening on 8799, so this cannot be ready");
    assert.ok(Array.isArray(report.checks), "the checks array is the whole value of a failed report");
    assert.ok(report.checks.length > 0);
    assert.equal("checksPassed" in report, false, "a failed report must not be summarised into a count");
    assert.ok(report.nextAction, "a failed report has to say what to do about it");
  } finally {
    server.child.kill();
  }
});

test("the compact form is opt-out, and verbose brings the checks back", async () => {
  // Also on the unreachable port: `verbose` must not change a failed report, because a failed
  // report was never compacted in the first place. Same shape either way is the assertion.
  const server = await startAndInitialize(
    { UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: "8799" },
    "doctor-verbose-test"
  );
  try {
    const ask = async (args) => {
      const res = await server.request("tools/call", { name: "unreal_doctor", arguments: args });
      return JSON.parse(res?.result?.content?.map((c) => c.text).join("\n") ?? "{}");
    };
    const plain = await ask({});
    const verbose = await ask({ verbose: true });
    assert.equal(plain.verdict, verbose.verdict);
    assert.equal(Array.isArray(plain.checks), true);
    assert.equal(Array.isArray(verbose.checks), true);
  } finally {
    server.child.kill();
  }
});
