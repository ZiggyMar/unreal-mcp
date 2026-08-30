/**
 * A minimal MCP stdio client for the measurement scripts.
 *
 * Extracted rather than copied. Two scripts needed to speak JSON-RPC to this server over stdio, and
 * copying the twenty lines that do it is how a repo ends up with two clients that drift - one gets a
 * timeout, the other does not, and the difference only shows up as a hanging script months later.
 * The same lesson the engine-build scripts learned by having two of themselves.
 *
 * This is deliberately not the SDK client: these scripts measure what a client actually receives on
 * the wire, so they should do exactly what a client does and nothing more.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_PATH = join(here, "..", "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);

/** Tokens are estimated from characters; see measure-profiles.mjs for why that is honest enough. */
export const estimateTokens = (chars) => Math.round(chars / 4);

/**
 * Start the server over stdio.
 *
 * `env` is merged over the current environment, so a caller sets UNREAL_MCP_PROFILE and nothing else.
 */
export function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, UNREAL_MCP_MODE: "standard", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  const waiters = new Map();
  let nextId = 1;

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

/** Start a server and complete the MCP handshake, which every caller here needs first. */
export async function startAndInitialize(env = {}, clientName = "measure") {
  const server = startServer(env);
  await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: clientName, version: "1" },
  });
  server.notify("notifications/initialized");
  return server;
}

/** The serialized tool definitions a client would send to the model, and what they cost. */
export async function listTools(server) {
  const listed = await server.request("tools/list", {});
  const tools = listed?.result?.tools ?? [];
  const chars = JSON.stringify(tools).length;
  return { tools, chars, tokens: estimateTokens(chars) };
}
