import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");

const NEWLINE = String.fromCharCode(10);

/**
 * Drive the real MCP server over stdio and return everything it sent back.
 *
 * These assertions are about the wire, not about internal state: what a client actually receives
 * is the only thing that determines the context cost, so it is the only thing worth asserting.
 *
 * Requests are sent strictly one at a time, each awaiting its response. The server answers
 * tools/list from whatever state it is in, so firing a list alongside an enable call races the
 * enable and reads the stale list.
 */
function callServer(profile, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, UNREAL_MCP_PROFILE: profile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const messages = [];
    const waiters = new Map();

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf(NEWLINE)) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        messages.push(msg);
        if (msg.id !== undefined && waiters.has(msg.id)) {
          waiters.get(msg.id)();
          waiters.delete(msg.id);
        }
      }
    });
    child.on("error", reject);
    child.on("close", () => resolve(messages));

    const send = (obj) =>
      new Promise((done) => {
        if (obj.id === undefined) {
          child.stdin.write(JSON.stringify(obj) + NEWLINE);
          done();
          return;
        }
        waiters.set(obj.id, done);
        child.stdin.write(JSON.stringify(obj) + NEWLINE);
      });

    (async () => {
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      for (const req of requests) await send(req);
      child.stdin.end();
    })().catch(reject);
  });
}

const listRequest = (id) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const enableRequest = (id, groups) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "unreal_enable_tools", arguments: { groups } },
});
const toolsFrom = (messages, id) => {
  const msg = messages.find((m) => m.id === id && m.result?.tools);
  assert.ok(msg, `no tools/list response for id ${id}`);
  return msg.result.tools.map((t) => t.name);
};

test("the full profile exposes every tool", async () => {
  const names = toolsFrom(await callServer("full", [listRequest(2)]), 2);
  assert.ok(names.length >= 49, `expected the whole set, got ${names.length}`);
  assert.ok(names.includes("unreal_add_widget"));
  assert.ok(names.includes("unreal_start_pie"));
});

test("the lazy profile starts small but still carries the whole authoring path", async () => {
  const names = toolsFrom(await callServer("lazy", [listRequest(2)]), 2);

  assert.ok(names.length < 20, `lazy should start small, got ${names.length}`);
  for (const essential of [
    "unreal_ping",
    "unreal_doctor",
    "unreal_enable_tools",
    "unreal_get_project_overview",
    "unreal_find_node",
    "unreal_create_blueprint",
    "unreal_build_graph",
    "unreal_compile_blueprint",
    "unreal_save_blueprint",
    "unreal_auto_layout_graph",
    "unreal_review_blueprint",
  ]) {
    assert.ok(names.includes(essential), `lazy is missing ${essential}`);
  }
  // ...and the optional groups must genuinely be absent, or none of this saves anything.
  for (const deferred of ["unreal_add_widget", "unreal_create_struct", "unreal_spawn_actor", "unreal_add_node"]) {
    assert.ok(!names.includes(deferred), `${deferred} should not be on until asked for`);
  }
});

test("enabling a group makes exactly that group appear, and nothing else", async () => {
  const messages = await callServer("lazy", [listRequest(2), enableRequest(3, ["ui"]), listRequest(4)]);
  const before = toolsFrom(messages, 2);
  const after = toolsFrom(messages, 4);

  assert.ok(!before.includes("unreal_add_widget"));
  for (const ui of [
    "unreal_create_widget_blueprint",
    "unreal_add_widget",
    "unreal_list_widgets",
    "unreal_set_widget_property",
  ]) {
    assert.ok(after.includes(ui), `${ui} did not appear after enabling "ui"`);
  }
  assert.ok(!after.includes("unreal_spawn_actor"), "enabling ui also enabled scene");
  assert.ok(!after.includes("unreal_create_struct"), "enabling ui also enabled data");
  assert.equal(after.length, before.length + 4);
});

test("enabling several groups at once works, and re-enabling is harmless", async () => {
  const messages = await callServer("lazy", [
    enableRequest(3, ["ui", "data"]),
    enableRequest(4, ["ui"]),
    listRequest(5),
  ]);

  const second = messages.find((m) => m.id === 4);
  const payload = JSON.parse(second.result.content[0].text);
  assert.deepEqual(payload.newlyEnabled, [], "re-enabling an on group should turn nothing new on");
  assert.equal(payload.alreadyOn, true);

  const names = toolsFrom(messages, 5);
  assert.ok(names.includes("unreal_add_widget"));
  assert.ok(names.includes("unreal_create_struct"));
});

test("the server tells the client the tool list changed", async () => {
  const messages = await callServer("lazy", [enableRequest(3, ["scene"])]);
  const notified = messages.some((m) => m.method === "notifications/tools/list_changed");
  assert.ok(notified, "a client that is never notified would never see the new tools");
});

test("every tool is reachable: none is stranded outside core and every group", async () => {
  const fullMessages = await callServer("full", [listRequest(2)]);
  const full = toolsFrom(fullMessages, 2);
  const lazyStart = toolsFrom(await callServer("lazy", [listRequest(2)]), 2);

  // Read the groups off the tool's own schema rather than hardcoding them. A hardcoded list goes
  // stale the moment a group is added, and then this test reports a stranded tool that is really
  // just a group the test had not heard of - which is exactly what happened when "materials"
  // was added.
  const enableTool = fullMessages
    .find((m) => m.id === 2)
    .result.tools.find((t) => t.name === "unreal_enable_tools");
  const groups = enableTool.inputSchema.properties.groups.items.enum;
  assert.ok(groups.length >= 5, `expected several groups, got ${groups.join(", ")}`);

  const everythingOn = toolsFrom(await callServer("lazy", [enableRequest(3, groups), listRequest(4)]), 4);

  const missing = full.filter((name) => !everythingOn.includes(name));
  assert.deepEqual(missing, [], `these tools are in no group and can never be enabled: ${missing.join(", ")}`);
  assert.equal(everythingOn.length, full.length);
  assert.ok(lazyStart.length < full.length);
});

test("the workflow guide is served as a prompt, in every profile", async () => {
  for (const profile of ["full", "lazy", "core"]) {
    const messages = await callServer(profile, [
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
      { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "unreal_workflow" } },
    ]);

    const listed = messages.find((m) => m.id === 2)?.result?.prompts ?? [];
    assert.ok(
      listed.some((p) => p.name === "unreal_workflow"),
      `${profile} does not offer the workflow prompt`
    );

    const text = messages.find((m) => m.id === 3)?.result?.messages?.[0]?.content?.text ?? "";
    // The fallback string exists so a missing file degrades instead of breaking; if we are
    // serving it, the real guide did not ship next to the server, which is worth failing on.
    assert.ok(text.length > 5000, `${profile} served only ${text.length} chars: the guide did not load`);
    assert.ok(text.includes("unreal_review_blueprint"), "the guide must carry the review gate");
    assert.ok(text.includes("unreal_doctor"), "the guide must carry the doctor step");
  }
});
