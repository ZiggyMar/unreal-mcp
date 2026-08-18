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
import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);
const TRACE = process.argv.includes("--trace");

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
// Context size decides which models fit on a given GPU, so it has to be a knob rather than a
// constant: a 14B loads on a 12 GB card at 8k and fails at 16k.
const NUM_CTX = Number(valueOf("--ctx", "16384"));
const PROFILE = valueOf("--profile", "lazy");
const RUNS = Number(valueOf("--runs", "1"));
// Runs are isolated by clearing /Game/Bench first rather than by renaming. Without isolation, run
// two trips over run one's leftovers and the benchmark measures its own debris instead of the
// model - which is exactly what happened the first time this was run twice.

/**
 * Tasks are chosen to be ordinary, not clever. If a cheap model cannot do these, the tooling has
 * not solved the problem it claims to solve.
 */
// A fresh name per run. Deleting an asset frees it from disk, but the editor's undo buffer keeps a
// reference to the object, so garbage collection cannot reclaim the NAME until the editor restarts.
// That is correct engine behaviour and the bridge reports it clearly - but across many benchmark
// runs it accumulates, and a model then spends every step colliding with its own history instead of
// doing the task. Unique names remove a confound that is not what is being measured.
const RUN_ID = () => Math.floor(Date.now() / 1000) % 1000000;
let currentRunId = RUN_ID();

const TASKS = {
  health: {
    name: () => `BP_BenchTarget${currentRunId}`,
    request: () =>
      `In the Unreal project, create a Blueprint called BP_BenchTarget${currentRunId} in /Game/Bench, based on ` +
      "Actor. Give it a float variable called Health with a default of 100. Then compile it and save it.",
    // Checked against the project, not against what the model said it did.
    async verify() {
      const listed = await probeCall("list_blueprints", { pathPrefix: "/Game/Bench" });
      const target = `BP_BenchTarget${currentRunId}`;
      if (!listed.includes(target)) return { done: false, why: `${target} does not exist` };
      // Read the variables directly. This used to search the project index, which updates
      // asynchronously, so a query issued right after a write could report "no" about a variable
      // that was plainly there - the benchmark spent several runs blaming the model for that. A
      // benchmark that reports false failures is worse than no benchmark, since it sends you off
      // fixing something that was never broken.
      const variables = await probeCall("list_variables", { path: `/Game/Bench/${target}.${target}` });
      if (!/"name":"Health"/.test(variables)) {
        return { done: false, why: "Blueprint exists but the Health variable was never added" };
      }
      return { done: true, why: "Blueprint exists with a Health variable" };
    },
    async cleanup() {
      await clearBench();
    },
  },

  /**
   * Harder: this needs the model to find a real function name, wire exec pins, and use the
   * batch builder. It is where a small model is expected to struggle, which is the point.
   */
  graph: {
    name: () => `BP_BenchGraph${currentRunId}`,
    request: () =>
      `In the Unreal project, create a Blueprint called BP_BenchGraph${currentRunId} in /Game/Bench based on Actor. ` +
      'Then add graph logic to its EventGraph so that when the game starts it prints the message "hello" to the ' +
      "screen. Compile it when done.",
    async verify() {
      // Models rename around a collision, so check whichever variant they actually made rather
      // than the name the task suggested. Judging the model on my own leftover debris would be
      // measuring the harness.
      const listed = await probeCall("list_blueprints", { pathPrefix: "/Game/Bench" });
      const made = [...listed.matchAll(new RegExp(`"(BP_BenchGraph${currentRunId}[0-9_]*)"`, "g"))].map((m) => m[1]);
      if (made.length === 0) return { done: false, why: "no BP_BenchGraph was created" };
      const name = made[made.length - 1];
      const summary = await probeCall("read_blueprint_graph_summary", {
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
    async cleanup() {
      await clearBench();
    },
  },

  /**
   * Harder: a component with a property, plus TWO handlers. This is the shape of a real small
   * feature, and it is where scaffold_blueprint either earns its keep or does not.
   */
  /**
   * The brownfield case, and the one that matters most.
   *
   * Every other task here creates something from nothing, which is the easy half of the job and
   * not the half people actually have. The real situation is an existing project full of
   * Blueprints someone else built, where the request is "add X to the thing that already works"
   * and the failure that costs you a day is not a missing feature - it is the agent quietly
   * removing something that was already there.
   *
   * So this one is scored on what SURVIVES as much as on what gets added.
   */
  brownfield: {
    name: () => `BP_BenchExisting${currentRunId}`,
    /**
     * Build the "existing" Blueprint the model is asked to extend.
     *
     * Deliberately assembled from bridge primitives rather than scaffold_blueprint: scaffold is a
     * server-side composite, and probeCall talks to the bridge directly so the setup cannot depend
     * on the tool surface the model is being tested on.
     */
    async setup() {
      const name = `BP_BenchExisting${currentRunId}`;
      const path = `/Game/Bench/${name}.${name}`;
      await probeCall("create_blueprint", { packagePath: `/Game/Bench/${name}`, parentClass: "Actor", save: false });
      await probeCall("add_variable", { path, variableName: "Health", type: "float", defaultValue: "100" });
      await probeCall("add_component", { path, componentClass: "StaticMeshComponent", name: "Body" });
      await probeCall("build_graph", {
        path,
        graphName: "EventGraph",
        nodes: [
          { ref: "evt", nodeType: "Event", eventName: "ReceiveBeginPlay" },
          { ref: "a0", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
        ],
        connections: [{ from: "evt.then", to: "a0.execute" }],
        pinDefaults: [{ node: "a0", pin: "In String", value: "existing" }],
      });
      await probeCall("compile_blueprint", { path });
      await probeCall("save_blueprint", { path });
    },
    request: () =>
      `The Blueprint /Game/Bench/BP_BenchExisting${currentRunId} already exists and is in use. Add a float ` +
      "variable called Stamina with a default of 50, and add an ActorBeginOverlap handler that prints " +
      '"touched". Everything already in this Blueprint must keep working - do not remove or replace what is ' +
      "there.",
    async verify() {
      const name = `BP_BenchExisting${currentRunId}`;
      const path = `/Game/Bench/${name}.${name}`;

      const variables = await probeCall("list_variables", { path });
      if (!/"name":"Stamina"/.test(variables)) return { done: false, why: "Stamina was not added" };
      // The whole point: the new thing arrived AND the old thing is still there.
      if (!/"name":"Health"/.test(variables)) {
        return { done: false, why: "DESTRUCTIVE: the existing Health variable is gone" };
      }

      const components = await probeCall("list_components", { path });
      if (!components.includes("Body")) {
        return { done: false, why: "DESTRUCTIVE: the existing Body component is gone" };
      }

      // Check the printed strings, not just that nodes exist.
      //
      // The first version of this searched the graph SUMMARY for the text "existing". The summary
      // carries node types, titles and connections and deliberately not pin values - that is the
      // whole point of the tiered read - so it could never match, and this task reported
      // "DESTRUCTIVE: the existing BeginPlay logic is gone" on three runs where the model had done
      // exactly the right thing in two calls. A false destructive alarm is a particularly bad bug
      // to ship in a benchmark: it is the single claim here most likely to be believed without
      // checking.
      let summary;
      try {
        summary = JSON.parse(await probeCall("read_blueprint_graph_summary", { path, graphName: "EventGraph" }));
      } catch {
        return { done: false, why: "the event graph could not be read" };
      }
      const nodes = summary.nodes ?? [];

      /** Follow an event's exec output to the Print String it drives, and read what it prints. */
      const printedBy = async (eventTitle) => {
        const event = nodes.find((n) => (n.title ?? "").includes(eventTitle));
        if (!event) return null;
        const target = (event.connectedPins ?? []).flatMap((pin) => pin.linkedTo ?? [])[0];
        if (!target) return null;
        const detail = JSON.parse(
          await probeCall("read_blueprint_node_detail", { path, graphName: "EventGraph", nodeId: target.node })
        );
        // Match the pin name the way the bridge itself does: spaces and case are not significant.
        // Writes accept "In String" because pin resolution is forgiving; reads report the canonical
        // "InString". Assuming those two spellings are the same string is what made this check
        // report a destroyed Blueprint three times over a Blueprint that was perfectly intact.
        const normalise = (text) => text.replace(/[^a-z0-9]/gi, "").toLowerCase();
        const pin = (detail.pins ?? []).find((candidate) => normalise(candidate.name) === "instring");
        return pin ? pin.defaultValue : null;
      };

      if ((await printedBy("BeginPlay")) !== "existing") {
        return { done: false, why: "DESTRUCTIVE: the existing BeginPlay logic no longer prints 'existing'" };
      }
      if ((await printedBy("ActorBeginOverlap")) !== "touched") {
        return { done: false, why: "no overlap handler printing 'touched' was added and wired" };
      }

      return { done: true, why: "Stamina and the overlap handler added, everything existing intact" };
    },
    async cleanup() {
      await clearBench();
    },
  },

  feature: {
    name: () => `BP_BenchFeature${currentRunId}`,
    request: () =>
      `In the Unreal project, create a Blueprint called BP_BenchFeature${currentRunId} in /Game/Bench based on ` +
      "Actor. Give it a SphereComponent named Trigger with SphereRadius 150, a float variable called Health with " +
      'default 100, and two event handlers: on BeginPlay print "ready", and on ActorBeginOverlap print "touched". ' +
      "Compile and save it.",
    async verify() {
      const name = `BP_BenchFeature${currentRunId}`;
      const listed = await probeCall("list_blueprints", { pathPrefix: "/Game/Bench" });
      if (!listed.includes(name)) return { done: false, why: `${name} does not exist` };

      const components = await probeCall("list_components", { path: `/Game/Bench/${name}.${name}` });
      if (!components.includes("Trigger")) return { done: false, why: "no Trigger component" };

      const summary = await probeCall("read_blueprint_graph_summary", {
        path: `/Game/Bench/${name}.${name}`,
        graphName: "EventGraph",
      });
      if (!/BeginPlay/i.test(summary)) return { done: false, why: "no BeginPlay handler" };
      if (!/Overlap/i.test(summary)) return { done: false, why: "BeginPlay exists but no overlap handler" };
      const prints = (summary.match(/Print String/g) ?? []).length;
      if (prints < 2) return { done: false, why: `only ${prints} Print String node(s); both handlers should print` };
      if (!/linkedTo":\[\{/.test(summary)) return { done: false, why: "nodes exist but nothing is wired" };

      // A variable too, since the whole point is doing several kinds of thing in one go. Read it
      // directly rather than through the project index, which lags a write and produced false
      // failures here before list_variables existed.
      const variables = await probeCall("list_variables", { path: `/Game/Bench/${name}.${name}` });
      if (!/"name":"Health"/.test(variables)) return { done: false, why: "everything but the Health variable" };
      return { done: true, why: "component, variable and both handlers present and wired" };
    },
    async cleanup() {
      await clearBench();
    },
  },
};

/**
 * The harness talks to the bridge directly for its own housekeeping and checking.
 *
 * Going through the model's tool surface was a mistake that produced a FALSE PASS: delete_asset
 * lives in the "maintenance" group, which the lazy profile does not enable, so every cleanup call
 * silently did nothing, stale assets from earlier runs satisfied the verification, and five runs
 * reported PASS having made zero tool calls. A benchmark that can report success for work nobody
 * did is worse than no benchmark.
 *
 * Separating them also removes a confound: what the harness checks with is no longer part of what
 * the model is being offered.
 */
const probe = new UnrealBridgeClient({});
const probeCall = async (cmd, params) => {
  try {
    return JSON.stringify(await probe.send(cmd, params));
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
};

/** Delete everything under /Game/Bench, so a run starts from a known state. */
async function clearBench() {
  const listed = await probeCall("list_blueprints", { pathPrefix: "/Game/Bench" });
  const names = [...listed.matchAll(/"(BP_Bench[A-Za-z0-9_]*)"/g)].map((m) => m[1]);
  for (const name of [...new Set(names)]) {
    await probeCall("delete_asset", { paths: [`/Game/Bench/${name}.${name}`], force: true });
  }
}

// --- MCP plumbing -------------------------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    // "lazy" is the profile a small-context model should use, so benchmark what we recommend.
    env: { ...process.env, UNREAL_MCP_PROFILE: PROFILE, UNREAL_MCP_MODE: "standard" },
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

/**
 * Whether this model accepts the tool-calling API at all.
 *
 * Plenty of local models have no tool template and reject the request outright - the user's own 27B
 * does. That is not a reason to give up on them: the harness already recovers tool calls from
 * message text, so the tools can simply be described in the prompt instead. Falling back rather
 * than failing is also what a real user of such a model has to do.
 */
let toolApiSupported = true;

/** A compact prompt-side description of the tools, for models with no tool template. */
function describeToolsForPrompt(tools) {
  const lines = tools.map((t) => {
    const required = t.function.parameters?.required ?? [];
    const props = Object.keys(t.function.parameters?.properties ?? {});
    const shown = [...new Set([...required, ...props])].slice(0, 6);
    // First sentence only: the full descriptions would swamp a small context.
    const summary = (t.function.description ?? "").split(". ")[0].slice(0, 130);
    return `- ${t.function.name}(${shown.join(", ")}): ${summary}`;
  });
  return (
    "You have these tools. To call one, reply with ONLY a JSON object of the form " +
    '{"name": "<tool>", "arguments": {...}} and nothing else.' +
    String.fromCharCode(10) +
    lines.join(String.fromCharCode(10))
  );
}

async function askModel(messages, tools) {
  const started = Date.now();
  const body = {
    model: MODEL,
    messages,
    stream: false,
    options: { temperature: 0.1, num_ctx: NUM_CTX },
  };
  if (toolApiSupported) body.tools = tools;

  let response = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (/does not support tools/i.test(errorText) && toolApiSupported) {
      // Retry with the tools described in the prompt instead of passed as an API field.
      console.log("  (this model has no tool template; describing tools in the prompt instead)");
      toolApiSupported = false;
      delete body.tools;
      body.messages = [
        { role: "system", content: describeToolsForPrompt(tools) },
        ...messages.filter((m) => m.role !== "system" || !String(m.content).startsWith("You have these tools")),
      ];
      response = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (!response.ok) {
      throw new Error(`ollama returned ${response.status}: ${errorText.slice(0, 200)}`);
    }
  }
  const reply = await response.json();
  const elapsedMs = Date.now() - started;
  return {
    message: reply.message ?? {},
    elapsedMs,
    // Ollama reports these in nanoseconds when available.
    evalCount: reply.eval_count ?? 0,
    evalDurationMs: reply.eval_duration ? reply.eval_duration / 1e6 : elapsedMs,
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

  // Walk the text and pull out every BALANCED {...} object.
  //
  // The previous version sliced from the first "{" to the last "}", which works only when the
  // message is exactly one JSON object. Small models routinely emit an object followed by prose,
  // or two objects in a row, and that span is then invalid JSON - so a perfectly good tool call
  // was being discarded and the benchmark reported the model doing nothing. Measuring the harness
  // instead of the model is the one thing a benchmark must never do.
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === String.fromCharCode(92)) {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }

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

  console.log(`model: ${MODEL} (profile ${PROFILE}, context ${NUM_CTX})`);
  console.log(`task:  ${task.request()}`);
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

  const runResults = [];

  for (let run = 1; run <= RUNS; run++) {
    if (RUNS > 1) {
      console.log(`--- run ${run} of ${RUNS} ---`);
    }
    // A fresh name per run, then a sweep of anything left from earlier runs.
    currentRunId = RUN_ID() + run;
    await clearBench();

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

    // A task may need the project put into a particular state first - the brownfield task has to
    // have something to be brown about.
    if (task.setup) await task.setup();

    const messages = [
      {
        role: "system",
        content:
          "You control an Unreal Engine editor through the given tools. Use them; do not describe what you would " +
          "do. Call one tool at a time and read its result before the next. Asset paths look like " +
          '"/Game/Folder/BP_Name" and the object path adds the name again: "/Game/Folder/BP_Name.BP_Name". ' +
          "When the task is complete, reply with the single word DONE.",
      },
      { role: "user", content: task.request() },
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
        const recovered = parseToolCallFromText(reply.message.content ?? "", toolNames);
        if (recovered) {
          stats.textEmbeddedCalls++;
          calls = [recovered];
        }
      }

      if (calls.length === 0) {
        const text = (reply.message.content ?? "").trim();
        if (RUNS === 1) console.log(`  [${step}] model says: ${text.slice(0, 120)}`);
        messages.push({ role: "assistant", content: text });

        // Do not take "DONE" on trust. Check the project and, if the task is not finished, say
        // exactly what is missing.
        //
        // The previous nudge just said "use the tools or reply DONE", and the model responded by
        // repeating the call it had already made. A vague prod invites a repeat; a specific fact
        // gives it somewhere to go. This is also what a real client does, and what this project
        // ships unreal_review_blueprint for - a benchmark whose client blindly believes the model
        // is measuring optimism.
        // The word boundary here is load-bearing, and was once a literal backspace byte: an
        // editing slip turned \b into 0x08, so this regex could never match. Every DONE the model
        // sent was therefore ignored, and the harness prodded it to keep calling tools. The
        // resulting churn got read as a model that could not tell it had finished; it was being
        // told not to stop. A benchmark bug that looks exactly like a model failure is the worst
        // kind, because the fix goes into the wrong codebase.
        if (/\bDONE/i.test(text)) {
          const check = await task.verify();
          if (check.done) break;
          // A rejected DONE is the most interesting event in a run: either the model quit early or
          // the verifier is wrong. Printing the reason is what separates those two, and guessing
          // between them has already sent this project after the wrong bug once.
          if (TRACE) console.log(`    !! DONE rejected: ${check.why}`);
          messages.push({
            role: "user",
            content: `Not finished: ${check.why}. Do that now with the tools, then reply DONE.`,
          });
          continue;
        }
        messages.push({
          role: "user",
          content: "Call a tool to do the next step. Do not repeat a call that already succeeded.",
        });
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
            continue;
          }
        }

        if (!toolNames.has(name)) {
          stats.unknownTool++;
          messages.push({
            role: "tool",
            content: `There is no tool called "${name}". Available: ${[...toolNames].join(", ")}`,
          });
          continue;
        }

        // --trace prints what the model actually called. A benchmark that only reports PASS/FAIL
        // tells you a regression happened; it does not tell you which call went missing, and that
        // was the first question asked the first time this suite went red.
        if (TRACE) {
          const shown = JSON.stringify(argumentsObject);
          console.log(`    -> ${name} ${shown.length > 300 ? shown.slice(0, 300) + "..." : shown}`);
        }

        const result = await callTool(name, argumentsObject);
        const failed = isFailure(result);
        if (failed) stats.bridgeErrors++;
        if (RUNS === 1) {
          console.log(
            `  [${step}] ${name}(${JSON.stringify(argumentsObject).slice(0, 90)}) -> ${failed ? "ERR " : "ok  "}${result.slice(0, 100).replace(/\s+/g, " ")}`
          );
        }
        messages.push({ role: "tool", content: result.slice(0, 2000) });
      }
    }

    const verdict = await task.verify();
    const tokensPerSecond = stats.evalMs > 0 ? (stats.evalTokens / stats.evalMs) * 1000 : 0;
    runResults.push({ ...stats, done: verdict.done, why: verdict.why, tokensPerSecond });
    console.log(
      `  ${verdict.done ? "PASS" : "FAIL"} - ${verdict.why} ` +
        `(${stats.toolCalls} calls, ${stats.bridgeErrors} errored, ${tokensPerSecond.toFixed(1)} tok/s)`
    );
    await task.cleanup();
  }

  // --- aggregate --------------------------------------------------------------------------------
  const passes = runResults.filter((r) => r.done).length;
  const mean = (pick) => runResults.reduce((total, r) => total + pick(r), 0) / (runResults.length || 1);

  console.log("");
  console.log(`RESULT over ${runResults.length} run(s)`);
  console.log(`  passed             ${passes}/${runResults.length}`);
  console.log(`  generation speed   ${mean((r) => r.tokensPerSecond).toFixed(1)} tok/s mean`);
  console.log(`  tool calls         ${mean((r) => r.toolCalls).toFixed(1)} mean`);
  console.log(`    via tool API     ${mean((r) => r.structuredCalls).toFixed(1)}`);
  console.log(`    from message text ${mean((r) => r.textEmbeddedCalls).toFixed(1)}`);
  console.log(`  malformed args     ${mean((r) => r.malformed).toFixed(1)}`);
  console.log(`  invented tools     ${mean((r) => r.unknownTool).toFixed(1)}`);
  console.log(`  calls that errored ${mean((r) => r.bridgeErrors).toFixed(1)}`);
  if (runResults.length > 1) {
    // Variance matters more than the mean for a small model: a tool that works half the time is a
    // different product from one that works reliably, and the mean hides which you have.
    const spread = runResults.map((r) => (r.done ? "P" : "F")).join("");
    console.log(`  run by run         ${spread}`);
  }

  server.child.kill();
  process.exit(passes === runResults.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`bench could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
