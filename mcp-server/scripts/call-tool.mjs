/**
 * Call one tool through the real MCP server over stdio.
 *
 * Everything this session measured went through the bridge or through explainGraph() as a library.
 * Neither proves the TOOL returns the improved text - the server shapes replies on the way out, and
 * the server has been broken by an edit before (a temporal dead zone that compiled fine and died at
 * startup). So: start it the way a client does, and read what a client would read.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [toolName, argsJson] = process.argv.slice(2);
const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MCP_PROFILE: "full" },
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      /* not a JSON-RPC line */
    }
  }
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

const send = (msg) =>
  new Promise((resolve) => {
    if (msg.id) pending.set(msg.id, resolve);
    child.stdin.write(JSON.stringify(msg) + "\n");
    if (!msg.id) resolve();
  });

const init = await send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
});
if (!init.result) {
  console.log("initialize failed:", JSON.stringify(init).slice(0, 300), stderr.slice(0, 300));
  process.exit(1);
}
await send({ jsonrpc: "2.0", method: "notifications/initialized" });

const res = await send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: toolName, arguments: JSON.parse(argsJson) },
});

const text = (res.result?.content ?? []).map((c) => c.text ?? "").join("\n");
console.log("reply ~" + Math.round(text.length / 4) + " tokens");
console.log("---");
console.log(text.slice(0, 1200));
child.kill();
