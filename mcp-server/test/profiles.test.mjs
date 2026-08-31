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
  const full = toolsFrom(await callServer("full", [listRequest(2)]), 2);

  // Expressed as a ratio rather than a fixed count: the point is that lazy is substantially
  // cheaper than full, and a hardcoded number just needs bumping every time a core tool is added,
  // which quietly turns the check into a formality.
  assert.ok(
    names.length <= full.length * 0.45,
    `lazy should be well under half of full; got ${names.length} of ${full.length}`
  );
  for (const essential of [
    "unreal_ping",
    "unreal_doctor",
    "unreal_enable_tools",
    "unreal_get_project_overview",
    "unreal_find_node",
    // unreal_create_blueprint is deliberately NOT here: it makes an empty Blueprint and a weak
    // model picks it over scaffold_blueprint and then cannot finish. scaffold_blueprint is the
    // authoring path this profile carries.
    "unreal_scaffold_blueprint",
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
  // Listed once and counted from that list. The count used to be hardcoded as +4, so adding a tool
  // to the group failed this test for the wrong reason - it read as "enabling ui leaked something"
  // when the group had simply grown.
  const uiTools = [
    "unreal_scaffold_widget",
    "unreal_create_widget_blueprint",
    "unreal_add_widget",
    "unreal_list_widgets",
    "unreal_set_widget_property",
  ];
  for (const ui of uiTools) {
    assert.ok(after.includes(ui), `${ui} did not appear after enabling "ui"`);
  }
  assert.ok(!after.includes("unreal_spawn_actor"), "enabling ui also enabled scene");
  assert.ok(!after.includes("unreal_create_struct"), "enabling ui also enabled data");
  assert.equal(
    after.length,
    before.length + uiTools.length,
    "enabling ui changed the tool count by something other than the ui group"
  );
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

test("all three guides are served as prompts, in every profile", async () => {
  const GUIDES = [
    { name: "unreal_workflow", mustMention: "unreal_review_blueprint" },
    { name: "unreal_handbook", mustMention: "exec pins" },
    { name: "unreal_recipes", mustMention: "K2_DestroyActor" },
  ];
  for (const profile of ["full", "lazy", "core"]) {
    const messages = await callServer(profile, [
      { jsonrpc: "2.0", id: 2, method: "prompts/list" },
      { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "unreal_workflow" } },
      { jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: "unreal_handbook" } },
      { jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "unreal_recipes" } },
    ]);

    const listed = messages.find((m) => m.id === 2)?.result?.prompts ?? [];
    for (const guide of GUIDES) {
      assert.ok(
        listed.some((p) => p.name === guide.name),
        `${profile} does not offer ${guide.name}`
      );
    }

    // A model with no Unreal training depends on these arriving intact, so check content, not
    // just that something came back.
    for (const [id, guide] of [[4, GUIDES[1]], [5, GUIDES[2]]]) {
      const text = messages.find((m) => m.id === id)?.result?.messages?.[0]?.content?.text ?? "";
      assert.ok(text.length > 3000, `${guide.name} served only ${text.length} chars in ${profile}`);
      assert.ok(text.includes(guide.mustMention), `${guide.name} is missing "${guide.mustMention}"`);
    }

    const text = messages.find((m) => m.id === 3)?.result?.messages?.[0]?.content?.text ?? "";
    // The fallback string exists so a missing file degrades instead of breaking; if we are
    // serving it, the real guide did not ship next to the server, which is worth failing on.
    assert.ok(text.length > 5000, `${profile} served only ${text.length} chars: the guide did not load`);
    assert.ok(text.includes("unreal_review_blueprint"), "the guide must carry the review gate");
    assert.ok(text.includes("unreal_doctor"), "the guide must carry the doctor step");
  }
});

test("--print-config emits a usable client config with absolute paths", async () => {
  // Hand-editing this JSON is its own category of failure: a missing comma breaks the file, a
  // relative path silently does not resolve, and a bare "node" may not be on the client's PATH.
  // None of that should be typed by someone whose goal is to make a game.
  const { execFileSync } = await import("node:child_process");
  // Scrubbed, not inherited. These tests assert on the DEFAULT the server chooses, and a developer
  // machine that happens to export UNREAL_MCP_PROFILE would otherwise fail them for a reason that
  // has nothing to do with the code.
  const env = { ...process.env };
  delete env.UNREAL_MCP_PROFILE;
  delete env.UNREAL_MCP_MODE;
  const out = execFileSync(process.execPath, [serverPath, "--print-config"], { encoding: "utf8", env });

  const json = JSON.parse(out.slice(out.indexOf("{")));
  const server = json.mcpServers?.unreal;
  assert.ok(server, `no unreal server entry: ${out.slice(0, 200)}`);

  // The node that printed this is guaranteed to exist and be the right one; "node" is not.
  assert.equal(server.command, process.execPath);
  assert.ok(server.args[0].endsWith("index.js"));
  assert.ok(
    server.args[0].includes(":") || server.args[0].startsWith("/"),
    `the script path must be absolute, got ${server.args[0]}`
  );
  // Not merely "some profile is set". This asserts WHICH one, because the defect this guards was
  // exactly that: a truthy check passed happily for years while the printed config handed every
  // frontier client "lazy", a profile measured and chosen for small local models. The value here is
  // a decision about who the default install is for, and it should not be changeable by accident.
  assert.equal(
    server.env.UNREAL_MCP_PROFILE,
    "search",
    "the printed config is what Claude Desktop, Claude Code and Cursor users actually run"
  );

  // The instructions must mention the step everyone misses.
  assert.match(out, /FULLY QUIT/i);
});

test("--print-config supports the clients people actually use", async () => {
  const { execFileSync } = await import("node:child_process");
  for (const client of ["claude-desktop", "cursor", "claude-code"]) {
    const out = execFileSync(process.execPath, [serverPath, "--print-config", "--client", client], {
      encoding: "utf8",
    });
    assert.ok(JSON.parse(out.slice(out.indexOf("{"))).mcpServers?.unreal, `${client} produced no config`);
    assert.match(out, /Paste this into|claude mcp add-json/);
  }
});

test("individual tools can be enabled by name, not only whole groups", async () => {
  // The saving this exists for. `core` is 32 tools and about 11.6k tokens of definitions, and a
  // session that reads a project and builds one graph touches a fraction of them - while paying for
  // all of them on every turn for the rest of the conversation.
  const wanted = [
    "unreal_get_project_overview",
    "unreal_search_project",
    "unreal_build_graph",
    "unreal_compile_blueprint",
  ];
  const messages = await callServer("search", [
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unreal_enable_tools", arguments: { tools: wanted } } },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  ]);

  const listed = messages.find((m) => m.id === 3).result.tools.map((t) => t.name);
  for (const name of wanted) {
    assert.ok(listed.includes(name), `${name} should be enabled by name`);
  }
  // Four always-on plus the four asked for, and nothing else from their groups came along.
  assert.equal(listed.length, 8, `expected only the named tools, got: ${listed.join(", ")}`);
  assert.ok(!listed.includes("unreal_spawn_actor"), "asking for one scene tool must not enable the whole scene group");
});

test("a misspelled tool name is reported rather than silently doing nothing", async () => {
  // A typo that enables nothing is a tool call spent for no effect, and the caller cannot tell that
  // from "it was already on".
  const messages = await callServer("search", [
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "unreal_enable_tools", arguments: { tools: ["unreal_bild_graph"] } },
    },
  ]);
  const body = JSON.parse(messages.find((m) => m.id === 2).result.content[0].text);
  assert.deepEqual(body.unknownTools, ["unreal_bild_graph"]);
  assert.match(body.unknownNote, /unreal_list_tools/);
});

test("groups still work, and both can be asked for at once", async () => {
  const messages = await callServer("search", [
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "unreal_enable_tools", arguments: { groups: ["materials"], tools: ["unreal_build_graph"] } },
    },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  ]);
  const listed = messages.find((m) => m.id === 3).result.tools.map((t) => t.name);
  assert.ok(listed.includes("unreal_create_material"), "the group should be on");
  assert.ok(listed.includes("unreal_build_graph"), "the named tool should be on");
});

test("list_tools answers with a census, not every tool, unless asked", async () => {
  // Measured and embarrassing: listing all 88 tools cost 5,523 tokens - more than four times the
  // entire `search` profile this tool exists to protect. A discovery mechanism that costs more than
  // the thing it discovers defeats its own purpose, and a model on `search` paid it on the first
  // call of every session.
  const messages = await callServer("search", [
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unreal_list_tools", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unreal_list_tools", arguments: { all: true } } },
  ]);

  const census = JSON.parse(messages.find((m) => m.id === 2).result.content[0].text);
  const everything = JSON.parse(messages.find((m) => m.id === 3).result.content[0].text);

  // A map from group name to one line about it, not rows of {group, count, costTokens, what} - those
  // four keys were 146 tokens of a 716-token reply, on the one call whose entire job is to cost less
  // than the profile it protects.
  const groupNames = Object.keys(census.groups);
  assert.ok(groupNames.length >= 5, `the default answer is the groups, got ${groupNames.join(", ")}`);
  // The price has to survive the compaction. Choosing a group without it is choosing blind, which is
  // the whole reason this reply carries costs at all.
  for (const [name, line] of Object.entries(census.groups)) {
    assert.match(line, /^\d+ tools, ~\d+ tok - /, `${name} must still say what it costs`);
  }
  assert.equal(census.tools, undefined, "the default answer must not carry every tool");
  assert.ok(census.totalTools > 50, `the census still reports the total, got ${census.totalTools}`);
  assert.match(census.next, /match/, "and says how to narrow");

  assert.ok(Array.isArray(everything.tools), "all:true still lists every tool");
  assert.ok(everything.tools.length > 50);

  const censusSize = JSON.stringify(census).length;
  const fullSize = JSON.stringify(everything).length;
  assert.ok(
    censusSize * 5 < fullSize,
    `the census must be dramatically cheaper: ${censusSize} vs ${fullSize} chars`
  );
});

test("filtering list_tools still returns actual tools", async () => {
  const messages = await callServer("search", [
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unreal_list_tools", arguments: { match: "data table" } } },
  ]);
  const body = JSON.parse(messages.find((m) => m.id === 2).result.content[0].text);
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "a filter means you want the tools");
  assert.ok(body.tools.every((t) => /data|table/i.test(t.name + t.summary)));
});

test("every group the census reports is one enable_tools will accept and describe", async () => {
  // The group list lived in three places - TOOL_GROUPS, the enable_tools enum, and
  // measure-groups.mjs - and adding "input" updated one of them. The census advertised a group that
  // enable_tools then rejected as an invalid value, and measure-groups never measured it, so the
  // census reported its price as "~? tok" to a model deciding what to switch on.
  //
  // Two of those are derived now. This covers the third, which is prose and cannot be: the
  // description enumerates the groups by hand, and a group missing from it is invisible to any model
  // that reads the tool rather than calling it.
  const messages = await callServer("search", [
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "unreal_list_tools", arguments: {} } },
    listRequest(3),
  ]);
  const census = JSON.parse(messages.find((m) => m.id === 2).result.content[0].text);
  const enableTool = messages.find((m) => m.id === 3).result.tools.find((t) => t.name === "unreal_enable_tools");
  const accepted = enableTool.inputSchema.properties.groups.items.enum;

  const advertised = Object.keys(census.groups);
  const notAccepted = advertised.filter((g) => !accepted.includes(g));
  assert.deepEqual(notAccepted, [], `the census offers groups enable_tools refuses: ${notAccepted.join(", ")}`);

  const undescribed = advertised.filter((g) => !enableTool.description.includes(`"${g}"`));
  assert.deepEqual(undescribed, [], `groups exist but the description never mentions them: ${undescribed.join(", ")}`);

  // And the price is real, not the "~?" that a missing measurement produces.
  const unpriced = Object.entries(census.groups).filter(([, line]) => line.includes("~? tok"));
  assert.deepEqual(unpriced.map(([g]) => g), [], "a group with no measured cost is one nobody can choose sensibly");
});
