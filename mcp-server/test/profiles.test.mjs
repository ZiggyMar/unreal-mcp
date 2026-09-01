import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
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

  // `lazy` with every group on is a SUPERSET of `full`, not an equal, and the difference is
  // deliberate: unreal_call_tool stands wherever tools are deferred and is switched off on `full`,
  // where everything is already on and dispatching would be a hop for no gain. Asserting equality
  // here would force the dispatcher onto a profile it does nothing for.
  const extra = everythingOn.filter((name) => !full.includes(name));
  assert.deepEqual(
    extra.sort(),
    ["unreal_call_tool"],
    `lazy has tools full does not, and only the dispatcher is meant to: ${extra.join(", ")}`
  );
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
  // Five always-on - ping, doctor, list_tools, enable_tools and the call_tool dispatcher - plus the
  // four asked for, and nothing else from their groups came along.
  assert.equal(listed.length, 9, `expected only the named tools, got: ${listed.join(", ")}`);
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

  // list_tools' own `group` filter was a FOURTH copy of this list and the stalest - it offered seven
  // of the twelve, so a model reading it learned that filtering by "input" or "anim" was impossible.
  // It is derived now, and this holds it to the same set.
  const listTool = messages.find((m) => m.id === 3).result.tools.find((t) => t.name === "unreal_list_tools");
  const filterable = listTool.inputSchema.properties.group.description;
  const unfilterable = advertised.filter((g) => !filterable.includes(g));
  assert.deepEqual(
    unfilterable,
    [],
    `list_tools offers a group filter that does not mention: ${unfilterable.join(", ")}`
  );

  // And the price is real, not the "~?" that a missing measurement produces.
  const unpriced = Object.entries(census.groups).filter(([, line]) => line.includes("~? tok"));
  assert.deepEqual(unpriced.map(([g]) => g), [], "a group with no measured cost is one nobody can choose sensibly");
});

test("an expensive read tells you how to ask for less, and a cheap one does not", async () => {
  // The three biggest reads all had a filter that answers a targeted question for a fraction of the
  // cost, and none of their replies mentioned it. Measured on a real Blueprint:
  //
  //   list_variables      2,397 whole   599 replicatedOnly   172 with a match
  //   read_class_defaults 4,685 whole                        292 with a match
  //   list_blueprints     2,669 whole                      1,932 fields:["path"]
  //
  // A model asking "what can a client see" was paying four times over for an answer it then had to
  // find by reading. The hint lives in the reply rather than the description because the arithmetic
  // for the description does not work: ~25 tokens on every request against a saving on some calls.
  //
  // This test does not need an editor. It checks the SHAPE of the rule - that the hint is keyed on
  // size and on no filter having been given - against the handler's own source.
  const source = readFileSync(join(REPO_ROOT, "mcp-server/src/index.ts"), "utf8").replace(/\r\n/g, "\n");
  const hints = [...source.matchAll(/cheaper:\s*\n?\s*`/g)];
  assert.ok(hints.length >= 5, `expected every expensive read to advise, found ${hints.length}`);

  // Each hint must be gated on the reply actually being large, or it fires on a two-variable
  // Blueprint where the advice costs more than it can save. One shared constant rather than three
  // literals, so the rule is in one place and this can check it is the rule being used.
  //
  // The first version of this assertion matched the source for `.length >= <number>`, which is
  // testing syntax rather than behaviour: one of the three sites spelled the same rule differently
  // and the test failed for a reason that had nothing to do with the property it cares about.
  //
  // Two gates, because there are two kinds of expensive. Most replies cost in proportion to how many
  // rows came back, and ADVISE_WHEN_ROWS_AT_LEAST is the rule for those. list_data_table_rows does
  // not: DT_UniversalActions is NINE rows and 6,985 tokens, because one untouched FSlateBrush column
  // exports as 900 characters. A row-count gate stays silent on exactly the table that needed the
  // advice, so that one is keyed on the size of the reply instead.
  const byRows = [...source.matchAll(/ADVISE_WHEN_ROWS_AT_LEAST/g)].length;
  const bySize = [...source.matchAll(/HEAVY_REPLY_CHARS/g)].length;
  assert.ok(
    byRows + bySize >= hints.length,
    `each of the ${hints.length} hints must be gated on reply size or row count; found ${byRows} + ${bySize}`
  );
  assert.ok(bySize > 0, "the read whose cost is unrelated to row count must be gated on size");
});

test("one data table row can be read by name, in full, without paging to it", () => {
  // There was no way to read one row. The only read was paged, so "what is WeaponDmg's price" meant
  // paging a table that costs 7,040 tokens to find one row that costs 933. A change request against
  // a Data Table - one of the three jobs this server exists for - started with that.
  //
  // No bridge command was needed: the filter is free on this side, so it works against a plugin that
  // predates it. This checks the SHAPE of the rule from the handler's own source, which is what a
  // test can do without an editor.
  const source = readFileSync(join(REPO_ROOT, "mcp-server/src/index.ts"), "utf8").replace(/\r\n/g, "\n");
  // Anchored on the REGISTRATION, not the first mention. The tool name also appears in a group list
  // near the top of the file, and slicing from there covers a region that has nothing to do with the
  // handler - which is how the first version of this test failed, for its own reason rather than the
  // code's. Source-text tests are brittle exactly here.
  const NEEDLE = `register(\n  "unreal_list_data_table_rows"`;
  const start = source.indexOf(NEEDLE);
  assert.ok(start > 0, "could not find the list_data_table_rows registration");
  const end = source.indexOf(`\nregister(`, start + 10);
  const handler = source.slice(start, end > start ? end : undefined);

  assert.match(handler, /rowName/, "the tool must take a row name");

  // Both halves of the targeted rule, and both matter. Paging past the default page, or the row is
  // missed for being row 400 of 900. And full fidelity, because a field omitted for being at its
  // default is exactly the field somebody asking by name is about to change.
  assert.match(handler, /wantedRow \? 5000 : limit/, "a targeted read must not be limited to one page");
  assert.match(handler, /omitDefaults: wantedRow \? false/, "a targeted read must not omit defaults");

  // A miss lists the names rather than a count. The whole reason a caller is here is that they do
  // not know what the row is called.
  assert.match(handler, /rowNames/, "a name that matches nothing must say which names exist");
});

test("a class read out of a C++ header resolves, prefix and all", () => {
  // The mirror of the find_source fix, and worse. UClass::GetName() carries no prefix, so
  // describe_class("ACharacter") failed - the most common class name in all of Unreal C++, what
  // every header and every tutorial writes, and what find_source now hands back after resolving a
  // Blueprint's parentClass. The two tools disagreed about the same class.
  //
  // The bridge strips prefixes now. This checks the transitional shim on this side, which is what
  // makes the chain work against a plugin older than the server - the same reason asTypeDescriptor
  // reads both `container` and the older `isArray`.
  const source = readFileSync(join(REPO_ROOT, "mcp-server/src/index.ts"), "utf8").replace(/\r\n/g, "\n");
  const NEEDLE = `register(\n  "unreal_describe_class"`;
  const start = source.indexOf(NEEDLE);
  assert.ok(start > 0, "could not find the describe_class registration");
  const handler = source.slice(start, source.indexOf(`\nregister(`, start + 10));

  // Only on class_not_found, and only for a name that actually looks prefixed. Retrying every
  // failure would turn a typo into a different class quietly.
  assert.match(handler, /class_not_found/, "the retry must be gated on the specific failure");
  assert.match(handler, /\[AUFEIST\]\[A-Z\]/, "and on the name looking like an Unreal C++ spelling");
  assert.match(handler, /foundAs/, "and must say which name it actually resolved");
});

test("the bridge resolves the C++ spelling too, so the shim can eventually go", () => {
  // The shim covers one tool. The resolver covers every call site that takes a class name -
  // add_node's className, create_blueprint's parentClass, spawn_actor's actorClass, Cast's
  // targetClass - so the fix belongs there and the shim is the transitional half.
  const handler = readFileSync(
    join(REPO_ROOT, "UnrealMCPBridge/Source/UnrealMCPBridge/Private/MCPCommandHandler.cpp"),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const resolver = handler.slice(handler.indexOf("UClass* FMCPCommandHandler::ResolveClassByName"));
  const body = resolver.slice(0, resolver.indexOf("\n}\n"));
  assert.match(body, /ClassName\.Mid\(1\)/, "the resolver must try the name with its prefix removed");
  // The exact name has to be tried first, or stripping could shadow a class genuinely called AFoo.
  assert.ok(
    body.indexOf('Prefixes[] = { TEXT("")') < body.indexOf("ClassName.Mid(1)"),
    "the exact name must be tried before any stripping"
  );
});
