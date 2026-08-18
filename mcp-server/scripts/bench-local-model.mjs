#!/usr/bin/env node
// Drive this MCP server with a LOCAL model, and measure how well it copes.
//
// The project's headline claim is that it works "no matter how dumb or smart the model is". That
// claim has been argued for, designed for, and never tested. A frontier model succeeding proves
// nothing about it; the interesting question is whether a 7B running on a consumer GPU can take a
// plain-English request and produce a working Blueprint.
//
// This is a real agent loop, not a mock: it hands the model the actual tool schemas from the
// running MCP server, parses its tool calls, executes them, feeds the results back, and repeats.
// What it measures is what matters for a cheap model:
//
//   - tokens per second, so "cheap" can be stated in seconds rather than adjectives
//   - how many tool calls were malformed (bad JSON, missing required params, invented tool names)
//   - how many failed against the bridge, and whether the model recovered from the error text
//   - whether the task actually got done, checked against the project rather than the transcript
//
// Usage:
//   node scripts/bench-local-model.mjs --model qwen2.5-coder:7b [--task health] [--steps 20]
//
// Requires: Ollama running, and an Unreal Editor open with the plugin.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const MODEL = valueOf("--model", "qwen2.5-coder:7b");
const MAX_STEPS = Number(valueOf("--steps", "20"));
// OLLAMA_HOST is commonly set as "0.0.0.0:11434" with no scheme, which fetch rejects outright.
const rawHost = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const withScheme = /^https?:\/\//.test(rawHost) ? rawHost : `http://${rawHost}`;
// 0.0.0.0 means "listen everywhere"; as a destination it is not routable, so talk to loopback.
const OLLAMA = withScheme.replace("//0.0.0.0", "//127.0.0.1");
const TASK_NAME = valueOf("--task", "health");

/**
 * Tasks are chosen to be ordinary, not clever. If a cheap model cannot do these, the tooling has
 * not solved the problem it claims to solve.
 */
const TASKS = {
  health: {
    request:
      "In the Unreal project, create a Blueprint called BP_BenchTarget in /Game/Bench, based on Actor. " +
      "Give it a float variable called Health with a default of 100. Then compile it and save it.",
    // Checked against the project, not against what the model said it did.
    async verify(callTool) {
      const listed = await callTool("unreal_list_blueprints", { pathPrefix: "/Game/Bench" });
      const text = JSON.stringify(listed);
      if (!text.includes("BP_BenchTarget")) return { done: false, why: "BP_BenchTarget does not exist" };
      const graphs = await callTool("unreal_list_blueprint_graphs", {
        path: "/Game/Bench/BP_BenchTarget.BP_BenchTarget",
      });
      if (JSON.stringify(graphs).includes("error")) return { done: false, why: "the Blueprint cannot be read" };
      // The index updates asynchronously, so a search issued the instant a variable is added can
      // miss it. This project documents that caveat; the first version of this check ignored it
      // and reported the model had failed when it had not.
      for (const delay of [0, 500, 1000, 2000]) {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const search = await callTool("unreal_search_project", { query: "Health" });
        if (JSON.stringify(search).includes("BP_BenchTarget")) {
          return { done: true, why: "Blueprint exists with a Health variable" };
        }
      }
      return { done: false, why: "Blueprint exists but the Health variable was never added" };
    },
    async cleanup(callTool) {
      // Models rename around a collision, so clean up the variants too rather than leaving debris
      // that makes the next run start from a different state.
      for (const suffix of ["", "_1", "_2"]) {
        const name = `BP_BenchTarget${suffix}`;
        await callTool("unreal_delete_asset", { paths: [`/Game/Bench/${name}.${name}`], force: true });
      }
    },
  },

  /**
   * Harder: this needs the model to find a real function name, wire exec pins, and use the
   * batch builder. It is where a small model is expected to struggle, which is the point.
   */
  graph: {
    request:
      "In the Unreal project, create a Blueprint called BP_BenchGraph in /Game/Bench based on Actor. " +
      "Then add graph logic to its EventGraph so that when the game starts it prints the message " +
      '"hello" to the screen. Compile it when done.',
    async verify(callTool) {
      // Models rename around a collision, so check whichever variant they actually made rather
      // than the name the task suggested. Judging the model on my own leftover debris would be
      // measuring the harness.
      const listed = await callTool("unreal_list_blueprints", { pathPrefix: "/Game/Bench" });
      const made = [...listed.matchAll(/"(BP_BenchGraph[0-9_]*)"/g)].map((m) => m[1]);
      if (made.length === 0) return { done: false, why: "no BP_BenchGraph was created" };
      const name = made[made.length - 1];
      const summary = await callTool("unreal_read_blueprint_summary", {
        path: `/Game/Bench/${name}.${name}`,
        graphName: "EventGraph",
      });
      const hasEvent = /BeginPlay/i.test(summary);
      const hasPrint = /Print String/i.test(summary);
      if (!hasEvent) return { done: false, why: "no BeginPlay event in the graph" };
      if (!hasPrint) return { done: false, why: "BeginPlay exists but nothing prints" };
      // Wired, not merely present: two unconnected nodes are not a working graph.
      const wired = /linkedTo"\s*:\s*\[\s*\{/.test(summary);
      return wired
        ? { done: true, why: "BeginPlay wired to Print String" }
        : { done: false, why: "both nodes exist but nothing is connected" };
    },
    async cleanup(callTool) {
      const listed = await callTool("unreal_list_blueprints", { pathPrefix: "/Game/Bench" });
      for (const name of [...listed.matchAll(/"(BP_BenchGraph[0-9_]*)"/g)].map((m) => m[1])) {
        await callTool("unreal_delete_asset", { paths: [`/Game/Bench/${name}.${name}`], force: true });
      }
    },
  },
};

// --- MCP plumbing -------------------------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    // "lazy" is the profile a small-context model should use, so benchmark what we recommend.
    env: { ...process.env, UNREAL_MCP_PROFILE: "lazy", UNREAL_MCP_MODE: "standard" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const waiters = new Map();
  let nextId = 100;

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf(NEWLINE)) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + NEWLINE);
    });

  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + NEWLINE);

  return { child, request, notify };
}

// --- the model ----------------------------------------------------------------------------------

async function askModel(messages, tools) {
  const started = Date.now();
  const response = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      stream: false,
      options: { temperature: 0.1, num_ctx: 16384 },
    }),
  });
  if (!response.ok) {
    throw new Error(`ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const body = await response.json();
  const elapsedMs = Date.now() - started;
  return {
    message: body.message ?? {},
    elapsedMs,
    // Ollama reports these in nanoseconds when available.
    evalCount: body.eval_count ?? 0,
    evalDurationMs: body.eval_duration ? body.eval_duration / 1e6 : elapsedMs,
  };
}

/** Did this tool result actually fail? */
function isFailure(resultText) {
  if (resultText.startsWith("UnrealMCPBridge error")) return true;
  try {
    const parsed = JSON.parse(resultText);
    if (parsed.compile && parsed.compile.success === false) return true;
    if (parsed.success === false) return true;
    return false;
  } catch {
    // Not JSON: fall back to looking for an error prefix rather than the word anywhere.
    return /^\s*\{?\s*"?error/i.test(resultText);
  }
}

/**
 * Pull a tool call out of plain message text.
 *
 * Accepts the shapes small models actually produce: a bare {"name":...,"arguments":{...}} object,
 * the same wrapped in a fenced code block, or an OpenAI-style {"function":{...}} envelope.
 */
function parseToolCallFromText(text, toolNames) {
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const fn = parsed.function ?? parsed;
    const name = fn.name;
    if (typeof name !== "string" || !toolNames.has(name)) continue;
    let argumentsObject = fn.arguments ?? fn.parameters ?? {};
    if (typeof argumentsObject === "string") {
      try {
        argumentsObject = JSON.parse(argumentsObject);
      } catch {
        argumentsObject = {};
      }
    }
    return { function: { name, arguments: argumentsObject } };
  }
  return null;
}

// --- run ------------------------------------------------------------------------------------------

async function main() {
  const task = TASKS[TASK_NAME];
  if (!task) {
    console.error(`unknown task "${TASK_NAME}". Available: ${Object.keys(TASKS).join(", ")}`);
    process.exit(2);
  }

  console.log(`model: ${MODEL}`);
  console.log(`task:  ${task.request}`);
  console.log("");

  const server = startServer();
  await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bench", version: "1" },
  });
  server.notify("notifications/initialized");

  const listed = await server.request("tools/list", {});
  const mcpTools = listed.result?.tools ?? [];
  // Ollama's tool format is OpenAI-shaped.
  const tools = mcpTools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const toolNames = new Set(mcpTools.map((t) => t.name));
  const toolDefinitionChars = JSON.stringify(tools).length;
  console.log(`tools offered: ${tools.length} (~${Math.round(toolDefinitionChars / 4)} tokens of definitions)`);
  console.log("");

  const callTool = async (name, argumentsObject) => {
    const res = await server.request("tools/call", { name, arguments: argumentsObject });
    return res.result?.content?.[0]?.text ?? JSON.stringify(res.error ?? {});
  };

  const stats = {
    steps: 0,
    toolCalls: 0,
    structuredCalls: 0,
    textEmbeddedCalls: 0,
    malformed: 0,
    unknownTool: 0,
    bridgeErrors: 0,
    modelMs: 0,
    evalTokens: 0,
    evalMs: 0,
  };

  const messages = [
    {
      role: "system",
      content:
        "You control an Unreal Engine editor through the given tools. Use them; do not describe what you would " +
        "do. Call one tool at a time and read its result before the next. Asset paths look like " +
        '"/Game/Folder/BP_Name" and the object path adds the name again: "/Game/Folder/BP_Name.BP_Name". ' +
        "When the task is complete, reply with the single word DONE.",
    },
    { role: "user", content: task.request },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    stats.steps++;
    let reply;
    try {
      reply = await askModel(messages, tools);
    } catch (err) {
      console.log(`  model error: ${err instanceof Error ? err.message : err}`);
      break;
    }
    stats.modelMs += reply.elapsedMs;
    stats.evalTokens += reply.evalCount;
    stats.evalMs += reply.evalDurationMs;

    let calls = reply.message.tool_calls ?? [];
    if (calls.length > 0) {
      stats.structuredCalls += calls.length;
    } else {
      // Small models very often emit a tool call as plain JSON in the message text instead of
      // using the structured tool-calling API. Real clients cope with this, so the benchmark must
      // too - otherwise it measures the model's output formatting rather than whether the tooling
      // works. Counted separately, because "which models need this crutch" is useful to know.
      const recovered = parseToolCallFromText(reply.message.content ?? "", toolNames);
      if (recovered) {
        stats.textEmbeddedCalls++;
        calls = [recovered];
      }
    }

    if (calls.length === 0) {
      const text = (reply.message.content ?? "").trim();
      console.log(`  [${step}] model says: ${text.slice(0, 120)}`);
      messages.push({ role: "assistant", content: text });
      if (/\bDONE\b/i.test(text)) break;
      // Nudge once rather than looping on chat.
      messages.push({ role: "user", content: "Use the tools to actually do it, or reply DONE if finished." });
      continue;
    }

    messages.push(reply.message);
    for (const call of calls) {
      stats.toolCalls++;
      const name = call.function?.name ?? "";
      let argumentsObject = call.function?.arguments ?? {};
      if (typeof argumentsObject === "string") {
        try {
          argumentsObject = JSON.parse(argumentsObject);
        } catch {
          stats.malformed++;
          messages.push({ role: "tool", content: "Your arguments were not valid JSON. Send a JSON object." });
          console.log(`  [${step}] ${name} <- malformed arguments`);
          continue;
        }
      }

      if (!toolNames.has(name)) {
        stats.unknownTool++;
        console.log(`  [${step}] ${name} <- no such tool`);
        messages.push({
          role: "tool",
          content: `There is no tool called "${name}". Available: ${[...toolNames].join(", ")}`,
        });
        continue;
      }

      const result = await callTool(name, argumentsObject);
      // Detect a real failure, not the substring "error". A clean compile reports "errorCount": 0,
      // which a naive check reads as a failure - the same mistake this project already made once
      // in measure-cost.mjs, repeated here because the check was written from memory.
      const failed = isFailure(result);
      if (failed) stats.bridgeErrors++;
      console.log(`  [${step}] ${name}(${JSON.stringify(argumentsObject).slice(0, 90)}) -> ${failed ? "ERR " : "ok  "}${result.slice(0, 100).replace(/\s+/g, " ")}`);
      messages.push({ role: "tool", content: result.slice(0, 2000) });
    }
  }

  console.log("");
  console.log("verifying against the project, not the transcript");
  const verdict = await task.verify(callTool);
  console.log(`  ${verdict.done ? "TASK COMPLETED" : "TASK NOT COMPLETED"}: ${verdict.why}`);

  const tokensPerSecond = stats.evalMs > 0 ? (stats.evalTokens / stats.evalMs) * 1000 : 0;
  console.log("");
  console.log("measurements");
  console.log(`  generation speed   ${tokensPerSecond.toFixed(1)} tok/s`);
  console.log(`  model time         ${(stats.modelMs / 1000).toFixed(1)}s over ${stats.steps} steps`);
  console.log(`  tool calls         ${stats.toolCalls}`);
  console.log(`    via tool API     ${stats.structuredCalls}`);
  console.log(`    recovered from text ${stats.textEmbeddedCalls}`);
  console.log(`  malformed args     ${stats.malformed}`);
  console.log(`  invented tools     ${stats.unknownTool}`);
  console.log(`  calls that errored ${stats.bridgeErrors}`);

  try {
    await task.cleanup(callTool);
    console.log("");
    console.log("cleaned up");
  } catch {
    console.log("");
    console.log("cleanup failed; remove /Game/Bench by hand");
  }

  server.child.kill();
  process.exit(verdict.done ? 0 : 1);
}

main().catch((err) => {
  console.error(`bench could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
