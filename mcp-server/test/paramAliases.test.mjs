import test from "node:test";
import assert from "node:assert/strict";

import { startAndInitialize, listTools } from "../scripts/lib/mcpStdio.mjs";

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

// check:params proves the alias is in the SCHEMA. It cannot prove the handler reads it.
//
// Those are two different failures and only one of them is visible to a caller: a tool that
// advertises `name`, accepts it without complaint, and then sends `undefined` to the bridge is worse
// than one that never offered the alias at all - the model gets a confusing error from a call it had
// every reason to believe was well formed.
//
// These drive the real server over stdio. No editor is needed: both assertions are about what
// happens BEFORE the bridge is dialled.

const call = async (server, name, args) => {
  const res = await server.request("tools/call", { name, arguments: args });
  return res?.result?.content?.[0]?.text ?? "";
};

test("create_function accepts `name` for `functionName`, and the handler reads it", async () => {
  // Fifteen tools call the thing they act on `name`. create_function was the only tool naming
  // exactly one thing that would not answer to it - found by check:params once it read the schemas
  // the server sends instead of a regex over the source, which had been matching the nested `name`
  // fields inside the `inputs` and `outputs` arrays and calling that an alias.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: DEAD_PORT }, "param-alias-test");
  try {
    const { tools } = await listTools(server);
    const schema = tools.find((t) => t.name === "unreal_create_function").inputSchema;
    assert.ok(schema.properties.name, "the alias is not in the schema");
    assert.ok(schema.properties.functionName, "the original spelling must stay - renaming breaks callers");
    assert.deepEqual(schema.required, ["path"], "neither spelling may be required, or the other one cannot be used");

    // Passing ONLY the alias must get past validation and reach the bridge. With no editor running
    // that is a connection error, which is exactly the proof wanted: the handler resolved the name
    // and got as far as dialling out.
    const viaAlias = await call(server, "unreal_create_function", { path: "/Game/X", name: "HandleDamage" });
    assert.ok(
      !/needs a function name/.test(viaAlias),
      `the alias was advertised and then ignored by the handler: ${viaAlias.slice(0, 160)}`
    );
  } finally {
    server.child.kill();
  }
});

test("giving neither spelling says so, and says nothing ran", async () => {
  // The second line of defence. This server's standing instructions promise that a failed call
  // names the parameter it wanted and states plainly that nothing happened, because a model that
  // cannot tell a rejected call from a half-applied one has to go and look.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full", UNREAL_MCP_BRIDGE_PORT: DEAD_PORT }, "param-alias-test");
  try {
    const text = await call(server, "unreal_create_function", { path: "/Game/X" });
    assert.match(text, /needs a function name/);
    assert.match(text, /functionName/);
    assert.match(text, /name/);
    assert.match(text, /Nothing ran/);
  } finally {
    server.child.kill();
  }
});
