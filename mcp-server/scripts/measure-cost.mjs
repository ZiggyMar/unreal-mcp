#!/usr/bin/env node
// Measure what a real build actually costs, per mode.
//
// The claim "cheap" is worthless unmeasured, and the number people care about is not the tool
// definitions (paid once) but the response payloads (paid on every single call, and they are the
// part nobody looks at). This builds the same graph in each mode against a running editor and
// reports the bytes that would land in a model's context.
//
// Usage: node scripts/measure-cost.mjs        (with an editor open)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);

const ROOT = "/Game/MCPCost";

/** A representative small feature: an event chain with a branch and two calls. */
const GRAPH = {
  graphName: "EventGraph",
  nodes: [
    { ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" },
    { ref: "br", nodeType: "Branch" },
    { ref: "p1", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
    { ref: "p2", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
    { ref: "seq", nodeType: "Sequence" },
  ],
  connections: [
    { from: "ev.then", to: "seq.execute" },
    { from: "seq.then_0", to: "br.execute" },
    { from: "br.then", to: "p1.execute" },
    { from: "br.else", to: "p2.execute" },
  ],
};

function runSession(mode, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, UNREAL_MCP_MODE: mode },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const messages = [];
    const waiters = new Map();

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
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cost", version: "1" } },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      for (const req of requests) await send(req);
      child.stdin.end();
    })().catch(reject);
  });
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const textOf = (messages, id) => messages.find((m) => m.id === id)?.result?.content?.[0]?.text ?? "";

async function measure(mode, index) {
  const path = `${ROOT}/BP_Cost${index}`;
  const messages = await runSession(mode, [
    call(2, "unreal_create_blueprint", { packagePath: path, parentClass: "Actor", save: false }),
    call(3, "unreal_build_graph", { path: `${path}.BP_Cost${index}`, ...GRAPH }),
  ]);

  const create = textOf(messages, 2);
  const build = textOf(messages, 3);
  if (!build) throw new Error(`no build response in ${mode} mode; is an editor running?`);
  // Look for an actual failure, not the substring "error": a clean compile reports
  // "errorCount": 0, which a naive check reads as a failure and then reports confidently.
  let failed = false;
  try {
    const parsed = JSON.parse(build);
    failed = parsed.compile ? parsed.compile.success === false : false;
  } catch {
    failed = build.includes("UnrealMCPBridge error");
  }
  if (failed) {
    console.log(`  (${mode}: the build did not compile; sizes still shown)`);
  }
  return { mode, path: `${path}.BP_Cost${index}`, createBytes: create.length, buildBytes: build.length };
}

async function main() {
  console.log("measuring response payloads for one 5-node build, per mode");
  console.log("");

  const results = [];
  let i = 0;
  for (const mode of ["fast", "standard", "max"]) {
    results.push(await measure(mode, i++));
  }

  const baseline = results.find((r) => r.mode === "max").buildBytes;
  console.log("  mode      build response      vs max");
  for (const r of results) {
    const pct = Math.round((r.buildBytes / baseline) * 100);
    console.log(
      `  ${r.mode.padEnd(9)} ${String(r.buildBytes).padStart(6)} chars (~${String(Math.round(r.buildBytes / 4)).padStart(4)} tok)   ${String(pct).padStart(3)}%`
    );
  }

  console.log("");
  console.log("cleaning up");
  const cleanup = await runSession("fast", [
    call(2, "unreal_enable_tools", { groups: ["maintenance"] }),
    call(3, "unreal_delete_asset", { paths: results.map((r) => r.path), force: true }),
  ]);
  console.log(`  ${textOf(cleanup, 3).split(NEWLINE)[0] || "(no cleanup response)"}`);
}

main().catch((err) => {
  console.error(`could not measure: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
