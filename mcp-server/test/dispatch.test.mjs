import { test } from "node:test";
import assert from "node:assert/strict";

import { startAndInitialize, listTools } from "../scripts/lib/mcpStdio.mjs";

// unreal_call_tool exists for one reason: to run a tool WITHOUT changing the advertised tool list,
// because that list sits ahead of everything else in a request and changing it invalidates the
// prompt cache for the whole conversation.
//
// So the assertion that matters is not "the dispatcher returns something" - that is visible in the
// source. It is that the tool list is byte-for-byte identical afterwards, which is not.
//
// These drive the real server over stdio and need no editor: every tool dispatched to here is
// composed on the server side.

const call = async (server, name, args = {}) => {
  const res = await server.request("tools/call", { name, arguments: args });
  return {
    text: res?.result?.content?.[0]?.text ?? JSON.stringify(res?.result ?? res),
    isError: res?.result?.isError === true,
  };
};

test("dispatching does not move the tool list, but enabling does", async () => {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const before = await listTools(server);
    assert.ok(
      before.tools.some((t) => t.name === "unreal_call_tool"),
      "search must advertise the dispatcher, or nothing below is reachable"
    );

    // unreal_guide is off on `search` and composed entirely on the server, so this is a real
    // dispatch to a disabled tool with no bridge involved.
    const dispatched = await call(server, "unreal_call_tool", { tool: "unreal_guide", args: { topic: "handbook" } });
    assert.equal(dispatched.isError, false, dispatched.text.slice(0, 200));

    const after = await listTools(server);
    assert.equal(
      JSON.stringify(after.tools),
      JSON.stringify(before.tools),
      "dispatching changed the advertised tool list, which is the one thing it must never do"
    );

    // The contrast, in the same test, so the saving is never asserted in the abstract.
    await call(server, "unreal_enable_tools", { tools: ["unreal_guide"] });
    const afterEnable = await listTools(server);
    assert.notEqual(
      JSON.stringify(afterEnable.tools),
      JSON.stringify(before.tools),
      "enabling must change the tool list - if it stopped doing so this comparison proves nothing"
    );
  } finally {
    server.child.kill();
  }
});

test("a disabled tool's schema can be read without switching it on", async () => {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const before = await listTools(server);
    const described = await call(server, "unreal_list_tools", { schema: "unreal_guide" });
    assert.equal(described.isError, false, described.text.slice(0, 200));
    assert.match(described.text, /unreal_guide/);
    assert.match(described.text, /parameters/);
    // "on": false is the point - this is the schema of something switched OFF.
    assert.match(described.text, /"on":\s*false/);

    const after = await listTools(server);
    assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools));
  } finally {
    server.child.kill();
  }
});

test("the dispatcher validates arguments exactly as the tool would", async () => {
  // Two ways to call one tool that disagree about its arguments is the defect class this project
  // keeps finding. A dispatcher is the easiest possible place to reintroduce it.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const bad = await call(server, "unreal_call_tool", {
      tool: "unreal_guide",
      args: { definitelyNotAParameter: 1 },
    });
    assert.ok(
      bad.isError || /bad_args|not a parameter|unrecognized/i.test(bad.text),
      `unknown argument was accepted: ${bad.text.slice(0, 200)}`
    );
  } finally {
    server.child.kill();
  }
});

test("an unknown tool name suggests the near miss instead of a lecture", async () => {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const miss = await call(server, "unreal_call_tool", { tool: "unreal_guid" });
    assert.match(miss.text, /unknown_tool/);
    assert.match(miss.text, /unreal_guide/, "a one-character typo should name the tool it meant");
  } finally {
    server.child.kill();
  }
});

test("the dispatcher refuses to call itself", async () => {
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const loop = await call(server, "unreal_call_tool", { tool: "unreal_call_tool" });
    assert.match(loop.text, /cannot call itself/);
  } finally {
    server.child.kill();
  }
});

test("registration stays the permission boundary on a fixed profile", async () => {
  // `minimal` promises a small surface. A dispatcher that quietly reached past it would turn a
  // documented tool budget into a suggestion, so the dispatcher is not registered there at all.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "minimal" }, "dispatch-test");
  try {
    const listed = await listTools(server);
    assert.equal(
      listed.tools.some((t) => t.name === "unreal_call_tool"),
      false,
      "minimal must not carry the dispatcher: there is nothing deferred for it to reach"
    );
  } finally {
    server.child.kill();
  }
});
