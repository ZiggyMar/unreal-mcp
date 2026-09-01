/** Minimal raw bridge caller: node bridge.mjs <cmd> '<json params>' */
import net from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.MCP_PORT || 8765);
let authToken;
try {
  authToken = JSON.parse(
    readFileSync(join(homedir(), "AppData", "Local", "UnrealMCPBridge", `session-${PORT}.json`), "utf8")
  ).token;
} catch {}

let nextId = 1;
export function call(cmd, params = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(PORT, "127.0.0.1");
    let buf = "";
    const done = (fn, v) => {
      s.destroy();
      fn(v);
    };
    s.setTimeout(timeoutMs, () => done(reject, new Error(`timeout after ${timeoutMs}ms`)));
    s.on("connect", () => {
      const env = { id: String(nextId++), cmd, params };
      if (authToken) env.auth_token = authToken;
      s.write(JSON.stringify(env) + "\n");
    });
    s.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) done(resolve, JSON.parse(buf.slice(0, nl)));
    });
    s.on("error", (e) => done(reject, e));
  });
}

if (process.argv[1] && process.argv[1].endsWith("bridge.mjs")) {
  const cmd = process.argv[2];
  const params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const r = await call(cmd, params);
  console.log(JSON.stringify(r, null, 2));
}
