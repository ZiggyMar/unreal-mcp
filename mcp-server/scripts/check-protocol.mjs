#!/usr/bin/env node
// Behave like a strict MCP client, and fail on anything a lenient one would forgive.
//
// Everything in this project has been measured through its own benchmark harness or through Claude
// Code. Both are lenient in ways a stricter client is not, and every bug found by changing vantage
// point - a real project instead of a scratch one, a stranger's clone instead of the working copy -
// was invisible from the old vantage point.
//
// The harness has already been wrong four times in ways that looked like product failures: a DONE
// regex that could not match, a stale tool list after enable_tools, reading only the first content
// part, and a verifier checking a pin name the way it is written rather than the way it reads back.
// Each was a client-side assumption. This checks the assumptions that a real client would make and
// this project has never had to satisfy.
//
// Needs no editor: everything here is protocol, not engine.
//
// Usage: node scripts/check-protocol.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Overridable so the checker itself can be tested against a deliberately broken server. A checker
// nobody has ever seen fail is a checker nobody should believe.
const serverPath = process.env.UNREAL_MCP_SERVER_PATH ?? join(here, "..", "dist", "index.js");
const NL = String.fromCharCode(10);

const problems = [];
const note = (message) => problems.push(message);

function startServer(profile = "full") {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, UNREAL_MCP_PROFILE: profile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = new Map();
  const notifications = [];
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf(NL)) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        note(`the server wrote a line that is not JSON: ${line.slice(0, 120)}`);
        continue;
      }
      if (message.id !== undefined && waiters.has(message.id)) {
        waiters.get(message.id)(message);
        waiters.delete(message.id);
        continue;
      }
      if (message.method) notifications.push(message);
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + NL);
      // A strict client does not wait forever; a server that never answers is a broken server.
      setTimeout(() => {
        if (waiters.has(id)) {
          waiters.delete(id);
          resolve({ error: { message: `no response to ${method} within 15s` } });
        }
      }, 15_000);
    });

  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + NL);

  return { child, request, notify, notifications };
}

async function main() {
  const server = startServer();

  // --- the handshake ---------------------------------------------------------------------------
  const init = await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "strict-client", version: "1" },
  });
  const result = init.result ?? {};

  if (!result.protocolVersion) note("initialize did not return a protocolVersion");
  if (!result.serverInfo?.name) note("initialize did not return serverInfo.name");
  if (!result.serverInfo?.version) note("initialize did not return serverInfo.version");
  if (!result.capabilities?.tools) note("initialize did not declare a tools capability");

  // The one that matters here: this server enables tools at runtime and sends
  // notifications/tools/list_changed. A client only re-reads the tool list if the server SAID it
  // would - so an undeclared listChanged means every lazily enabled tool stays invisible, which is
  // exactly the failure the benchmark harness had, for the same reason.
  if (result.capabilities?.tools && result.capabilities.tools.listChanged !== true) {
    note(
      "capabilities.tools.listChanged is not declared true, but this server enables tools at runtime " +
        "and sends notifications/tools/list_changed. A strict client will never re-read the list, so " +
        "unreal_enable_tools will appear to do nothing."
    );
  }

  server.notify("notifications/initialized");

  // --- the tool list ---------------------------------------------------------------------------
  const listed = await server.request("tools/list", {});
  const tools = listed.result?.tools ?? [];
  if (tools.length === 0) note("tools/list returned no tools");

  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) note(`two tools are both called "${tool.name}"`);
    seen.add(tool.name);

    // Anthropic's tool-name limit is 64 characters, and a name over it is rejected outright rather
    // than truncated.
    if (tool.name.length > 64) note(`tool name is ${tool.name.length} characters, over the 64 limit: ${tool.name}`);
    if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) note(`tool name has characters some clients reject: ${tool.name}`);
    if (!tool.description) note(`${tool.name} has no description`);

    const schema = tool.inputSchema;
    if (!schema) {
      note(`${tool.name} has no inputSchema`);
      continue;
    }
    if (schema.type !== "object") note(`${tool.name} inputSchema.type is "${schema.type}", not "object"`);
    if (schema.properties && typeof schema.properties !== "object") {
      note(`${tool.name} inputSchema.properties is not an object`);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (!property || typeof property !== "object") {
        note(`${tool.name}.${name} is not a schema object`);
        continue;
      }
      if (!property.type && !property.anyOf && !property.oneOf && !property.enum && !property.$ref) {
        note(`${tool.name}.${name} has no type, which some clients reject`);
      }
    }
    for (const required of schema.required ?? []) {
      if (!(schema.properties ?? {})[required]) {
        note(`${tool.name} requires "${required}" but does not describe it in properties`);
      }
    }
  }

  // --- how failures come back ------------------------------------------------------------------
  //
  // A tool that fails should answer with an error RESULT, not a JSON-RPC protocol error: a protocol
  // error means "this call was malformed", and a client is entitled to treat it as a bug in itself
  // rather than something to show the user.
  const failing = await server.request("tools/call", {
    name: "unreal_ping",
    arguments: {},
  });
  if (failing.error) {
    note(
      `a tool whose bridge is unreachable answered with a JSON-RPC error (${failing.error.message?.slice(0, 60)}) ` +
        `rather than an error result; a client cannot show that to a user as a tool failure`
    );
  } else if (failing.result && failing.result.isError !== true && !Array.isArray(failing.result.content)) {
    note("a failing tool call returned neither content nor isError");
  }

  // --- an unknown tool -------------------------------------------------------------------------
  const unknown = await server.request("tools/call", { name: "unreal_definitely_not_real", arguments: {} });
  if (!unknown.error && unknown.result?.isError !== true) {
    note("calling a tool that does not exist was not reported as an error at all");
  }

  // --- arguments that do not match the schema ---------------------------------------------------
  //
  // A client will eventually send a number where a string belongs, or omit something required. Both
  // must come back as an error RESULT the user can be shown, not as a JSON-RPC error (which says
  // "the client is broken") and certainly not as a crash.
  const wrongType = await server.request("tools/call", {
    name: "unreal_list_variables",
    arguments: { path: 12345 },
  });
  if (wrongType.error) {
    note("a wrongly-typed argument came back as a JSON-RPC error rather than an error result");
  } else if (wrongType.result?.isError !== true) {
    note("a wrongly-typed argument was not reported as an error at all");
  }

  const missingRequired = await server.request("tools/call", {
    name: "unreal_list_variables",
    arguments: {},
  });
  if (missingRequired.error) {
    note("a missing required argument came back as a JSON-RPC error rather than an error result");
  } else if (missingRequired.result?.isError !== true) {
    note("a missing required argument was not reported as an error at all");
  }

  // --- prompts, if declared --------------------------------------------------------------------
  //
  // The prompts surface ships the handbooks, and had never been exercised by anything.
  if (result.capabilities?.prompts) {
    const prompts = await server.request("prompts/list", {});
    const list = prompts.result?.prompts;
    if (!Array.isArray(list)) {
      note("prompts capability is declared but prompts/list did not return a prompts array");
    } else if (list.length === 0) {
      note("prompts capability is declared but no prompts are offered");
    } else {
      for (const prompt of list) {
        if (!prompt.name) note("a prompt has no name");
        if (!prompt.description) note(`prompt "${prompt.name}" has no description`);
      }
      const got = await server.request("prompts/get", { name: list[0].name, arguments: {} });
      const messages = got.result?.messages;
      if (got.error) {
        note(`prompts/get "${list[0].name}" failed: ${String(got.error.message).slice(0, 80)}`);
      } else if (!Array.isArray(messages) || messages.length === 0) {
        note(`prompts/get "${list[0].name}" returned no messages`);
      } else {
        for (const message of messages) {
          if (!message.role) note(`a message from "${list[0].name}" has no role`);
          if (typeof message.content?.text !== "string" || message.content.text.length === 0) {
            note(`a message from "${list[0].name}" has no text content`);
          }
        }
      }
    }
  }

  // --- a parameter that does not exist ----------------------------------------------------------
  //
  // zod strips unknown keys, so a plausible-but-wrong parameter name used to be accepted in silence
  // and the tool ran unfiltered. Measured on the real project: `match: "ServerList"` cost 75 tokens
  // and returned one Blueprint, while `nameContains: "ServerList"` cost 4,014 and returned all 339 -
  // 53x, with nothing to say the filter had done nothing. Every tool schema is strict now, and this
  // is here so it stays that way.
  const bogusParam = await server.request("tools/call", {
    name: "unreal_list_blueprints",
    arguments: { nameContains: "anything" },
  });
  const bogusText = bogusParam.result?.content?.[0]?.text ?? bogusParam.error?.message ?? "";
  if (!/not a parameter of/.test(bogusText)) {
    note("an unrecognised parameter was not refused - it is being silently ignored, and the caller pays for the unfiltered reply");
  } else if (!/pathPrefix|match/.test(bogusText)) {
    note("an unrecognised parameter was refused without naming the parameters that do exist, which leaves the caller guessing again");
  }

  // --- a parameter that was left out ------------------------------------------------------------
  //
  // The other half of the same question, and for a long time it got a much worse answer. `.strict()`
  // covers unknown keys only, so misspelling a name produced "not a parameter of unreal_map_system.
  // It accepts: query, maxAssets, depth, detail" while OMITTING a required one produced zod's bare
  // "Required at query". unreal_find_orphans with no arguments answered "Required at of / Required
  // at pairedWith" and nothing else: two names, no types, no list, no example - the caller told
  // least at the moment they know least.
  //
  // Two error paths describing the same problem differently is this project's commonest defect, and
  // the repair is always the same: make the two agree. Both messages are now built from one list.
  const missingParam = await server.request("tools/call", {
    name: "unreal_find_orphans",
    arguments: {},
  });
  const missingText = missingParam.result?.content?.[0]?.text ?? missingParam.error?.message ?? "";
  if (!/requires "of"/.test(missingText)) {
    note("a required parameter left out was not named back to the caller");
  } else if (!/It accepts: /.test(missingText)) {
    note(
      "a missing required parameter was reported without listing what the tool accepts, " +
        "while a MISSPELLED one gets that list - the same problem answered two different ways"
    );
  } else if (!/Nothing ran/.test(missingText)) {
    note("a missing required parameter was reported without saying whether anything ran");
  }

  // A tool that takes no parameters at all must still accept an empty object. Making schemas strict
  // is exactly the kind of change that breaks this without anyone noticing.
  const noArgs = await server.request("tools/call", { name: "unreal_pie_status", arguments: {} });
  if (noArgs.error) {
    note(`a zero-parameter tool rejected an empty argument object: ${String(noArgs.error.message).slice(0, 80)}`);
  }

  // --- a truncated list must say how to see the rest ---------------------------------------------
  //
  // list_blueprints and list_actors answer a cap with `truncated: true`, the real total, and a
  // `next` sentence naming the parameters that narrow the search. list_assets answered
  // `{count: 3, truncated: true}` - no total, so the caller could not tell whether four assets were
  // hidden or four thousand, and no route forward. Three tools describing one situation, one of them
  // differently, which is the defect this project keeps finding.
  //
  // A caller who cannot continue a truncated list does one of two things, and both are expensive:
  // raises maxResults blindly and pays for everything, or treats the partial list as the whole
  // project and reasons from it. The second is worse and looks like success.
  for (const [tool, args] of [
    ["unreal_list_blueprints", { maxResults: 2 }],
    ["unreal_list_actors", { maxResults: 2 }],
    ["unreal_list_assets", { className: "DataTable", maxResults: 2 }],
  ]) {
    const capped = await server.request("tools/call", { name: tool, arguments: args });
    const text = capped.result?.content?.[0]?.text ?? "";
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      continue; // an error reply is a different check's problem
    }
    if (body.truncated !== true) continue; // the project is smaller than the cap; nothing to assert
    if (typeof body.next !== "string" || body.next.length === 0) {
      note(
        `${tool} truncated its list without saying how to see the rest - the caller either raises ` +
          `maxResults blindly and pays for everything, or reasons from a partial list believing it is whole`
      );
    }
  }

  // --- one convention, described the same way by every tool that applies it ----------------------
  //
  // list_variables, read_class_defaults and read_asset_properties all drop a value that is the
  // type's zero. That is only safe if the caller is told, and for a long time only two of the three
  // told them - read_asset_properties returned everything verbatim, so a caller who learned "absent
  // means zero" from one tool met a different shape in another.
  //
  // Checked on the RENDERED description rather than the source: the sentence is assembled from
  // concatenated string literals and wraps across lines, so a source-text check matches or misses
  // depending on where the author happened to break the line.
  const zeroContract = ["unreal_list_variables", "unreal_read_class_defaults", "unreal_read_asset_properties"];
  for (const name of zeroContract) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) continue;
    if (!/appears only when it is not the type's zero/.test(tool.description ?? "")) {
      note(
        `${name} drops a value that is the type's zero without saying so in the same words as the ` +
          `other tools that do it - a caller who learned the convention elsewhere cannot tell whether ` +
          `an absent value here means zero or means unknown`
      );
    }
  }

  // --- no tool schema carries a dialect declaration ----------------------------------------------
  //
  // "$schema":"http://json-schema.org/draft-07/schema#" is 50 characters emitted once per tool by
  // zod-to-json-schema, about 1,338 tokens on every request, declaring a dialect that changes
  // nothing about what these schemas accept. It is stripped at the transport, and this is here so a
  // dependency bump that changes the message shape shows up as a failure rather than as a quiet
  // 1,300-token regression nobody would look for.
  const declaring = tools.filter((t) => t.inputSchema && "$schema" in t.inputSchema).map((t) => t.name);
  if (declaring.length > 0) {
    note(
      `${declaring.length} tool schema(s) still carry a $schema declaration (${declaring.slice(0, 3).join(", ")}...), ` +
        `which is ~${Math.round((declaring.length * 50) / 4)} tokens on every request for a label no client needs`
    );
  }

  // --- a value being written accepts the shape a caller would naturally send ---------------------
  //
  // Everything Unreal writes goes through ImportText, which takes a string, so every write parameter
  // was declared `z.string()`. Faithful to the engine and wrong for the caller: the natural way to
  // say "make it cost 500" is `{ Cost: 500 }`, and it was answered with
  //
  //   Expected string, received number at values.Cost
  //
  // on the single commonest change request there is. The read/write round trip was never broken - a
  // read returns "300" and a write takes "300" - so this was not two tools disagreeing, it was the
  // tool disagreeing with the person using it, which is harder to notice from inside.
  //
  // Asserted on the schema rather than by writing to an asset: this guard runs against a real
  // project and must not change it.
  const writeValueParams = [
    ["unreal_set_class_default", "value"],
    ["unreal_set_component_property", "value"],
    ["unreal_set_asset_property", "value"],
    ["unreal_set_pin_default_value", "value"],
    ["unreal_add_data_table_row", "values"],
    ["unreal_set_data_table_row", "values"],
  ];
  for (const [toolName, param] of writeValueParams) {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) continue; // a renamed tool is check:parity's problem, not this one's
    const schema = tool.inputSchema?.properties?.[param];
    if (!schema) {
      note(`${toolName} has no "${param}" parameter any more - this check has drifted from the tool`);
      continue;
    }
    // Either the parameter itself is the union, or it is a record whose values are.
    const valueSchema = schema.type === "object" ? schema.additionalProperties : schema;
    const types = Array.isArray(valueSchema?.type) ? valueSchema.type : [valueSchema?.type];
    if (!types.includes("number")) {
      note(
        `${toolName}.${param} refuses a number, so { Cost: 500 } is rejected with a zod type error - ` +
          `the commonest change request there is, answered by the schema rather than by the engine`
      );
    }
  }

  // --- several calls in flight at once -----------------------------------------------------------
  //
  // Real clients pipeline. Nothing in this project had ever sent a second request before the first
  // came back, so nothing had ever checked that responses are matched to their own ids rather than
  // to arrival order. This uses tools/list rather than a tool call so it needs no editor.
  const concurrent = await Promise.all([
    server.request("tools/list", {}),
    server.request("tools/list", {}),
    server.request("tools/list", {}),
    server.request("tools/list", {}),
  ]);
  if (concurrent.some((response) => !Array.isArray(response.result?.tools))) {
    note("one of four concurrent requests did not come back with its own result");
  }

  server.child.kill();

  if (problems.length > 0) {
    console.error(`\nprotocol check failed (${problems.length} problem(s)):\n`);
    for (const problem of problems) console.error(`  - ${problem}\n`);
    process.exit(1);
  }
  console.log(`protocol ok: handshake, ${tools.length} tool schemas, error shapes, and capability declarations`);
}

main().catch((err) => {
  console.error(`protocol check could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
