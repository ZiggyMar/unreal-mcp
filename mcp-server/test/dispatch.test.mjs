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

test("the first dispatch to an authoring tool still delivers the exact pin names", async () => {
  // A hole the dispatcher opened. On `search` the pin-name ground truth is kept out of standing
  // context and handed over by enable_tools when an authoring tool switches on. Dispatching never
  // switches anything on, so without this the caller would guess pin names - which costs a failed
  // call each time, and is the exact expense unreal_call_tool exists to avoid.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const res = await server.request("tools/call", {
      name: "unreal_call_tool",
      // build_graph with no arguments fails validation, and that is fine: the ground truth rides on
      // the reply either way, and asserting it here needs no editor.
      arguments: { tool: "unreal_build_graph", args: {} },
    });
    const blocks = (res?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    assert.match(blocks, /Exact names, sent once/);
    assert.match(blocks, /exec/i, "the ground truth should carry the real pin names");

    // Once, not on every call - it is standing-context-sized and repeating it defeats the purpose.
    const again = await server.request("tools/call", {
      name: "unreal_call_tool",
      arguments: { tool: "unreal_build_graph", args: {} },
    });
    const secondBlocks = (again?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    assert.doesNotMatch(secondBlocks, /Exact names, sent once/);
  } finally {
    server.child.kill();
  }
});

test("a symptom match points at the tools it named, not at the groups holding them", async () => {
  // This file's own header says the dispatcher exists so a call does not change the tool list. The
  // discovery reply that leads a caller here was arguing the other way: having named three tools by
  // name, it ended with enable_tools({groups: [...]}) FIRST and call_tool second, as equals.
  //
  // Measured on the search profile, for the sentence "the tutorial level doesn't spawn a player":
  //
  //   baseline                       5 tools,  1,536 tokens
  //   enable the 3 tools it named    8 tools,  2,544 tokens   (+1,008)
  //   enable the 2 groups it advised 51 tools, 17,917 tokens  (+16,381)
  //
  // Measured with the repo's own estimateTokens, not an ad-hoc len/3.6 - the first version of this
  // comment carried figures about 10% high from a hand-rolled estimator. The 16x ratio is the same
  // either way, which is exactly why a ratio is the safer thing to quote than an absolute.
  //
  // Same answer either way. The expensive one was recommended first, in the reply that serves the
  // one request this project exists for, and it stays in the prompt for the rest of the session.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const { text } = await call(server, "unreal_list_tools", {
      match: "the tutorial level doesn't spawn a player",
    });
    const next = JSON.parse(text).next;
    assert.ok(next.includes("unreal_call_tool"), "the cheapest route is not offered at all");
    assert.ok(
      !/enable_tools\(\{\s*groups:/.test(next),
      `a reply that named specific tools still advised enabling their groups: ${next}`
    );
    assert.ok(
      next.indexOf("unreal_call_tool") < next.indexOf("unreal_enable_tools"),
      "the route that changes nothing must be offered before the one that changes the tool list"
    );
  } finally {
    server.child.kill();
  }
});

test("a discovery reply explains itself once, then answers", async () => {
  // Measured over four discovery calls on `search`: 2,008 tokens of replies, 842 of them - 42% - the
  // same `next` guidance repeated verbatim. The intent essay, the "keyword match, not understanding"
  // paragraph and the argument for naming tools over enabling groups are worth reading once and are
  // dead weight on the fourth call, on the profile --print-config emits.
  //
  // What must NOT be dropped is anything the caller needs in order to act: which tools, how to run
  // them, and that the match was on keywords. Those ship every time.
  const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-test");
  try {
    const ask = async (match) => {
      const { text } = await call(server, "unreal_list_tools", { match });
      return JSON.parse(text).next;
    };

    const first = await ask("the game crashes when I press play");
    assert.match(first, /not an understanding of the sentence/, "the first reply must still explain itself");
    assert.match(first, /Prefer that to groups/, "and still make the case for naming tools");

    const second = await ask("add a shop upgrade that increases fire rate");
    assert.ok(second.length * 3 < first.length, `second reply was ${second.length} vs first ${first.length}`);

    // Everything needed to act, still present.
    assert.match(second, /unreal_call_tool/, "the cheapest route must survive the trim");
    assert.match(second, /unreal_enable_tools\(\{ tools: \[/, "with the tool names filled in");
    assert.match(second, /unreal_plan_feature/, "and the actual tools named");
    assert.match(second, /matchedSymptomWords/, "and the caveat that this was a keyword match");
    // The intent READING survives even though its argument does not: a session can move from a bug
    // report to a feature request, and the approach differs.
    assert.match(second, /BUILD/, "the intent must still be stated");
  } finally {
    server.child.kill();
  }
});
