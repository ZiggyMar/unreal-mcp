/**
 * Which other reads carry repeated struct literals worth collapsing?
 *
 * list_data_table_rows lost 67% to a single empty FSlateBrush written 28 times. The compaction that
 * did it is general, but wiring it into a read that has nothing to repeat costs a legend and buys
 * nothing. So: measure the prize per read before touching any of them.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = "F:/MCP/unreal-mcp/mcp-server/dist/index.js";

function client() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_PROFILE: "full" } });
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
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      } catch { /* not ours */ }
    }
  });
  let id = 0;
  const send = (msg) => new Promise((res) => { if (msg.id) pending.set(msg.id, res); child.stdin.write(JSON.stringify(msg) + "\n"); if (!msg.id) res(); });
  return {
    child,
    init: () => send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scan", version: "1" } } })
      .then(() => send({ jsonrpc: "2.0", method: "notifications/initialized" })),
    call: (name, args) => send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } })
      .then((r) => (r.result?.content ?? []).map((c) => c.text ?? "").join("\n")),
  };
}

/** Upper-bound saving from writing each repeated balanced group once. */
function prize(text) {
  const counts = new Map();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "(") continue;
    let d = 0, j = i;
    for (; j < text.length; j++) { if (text[j] === "(") d++; else if (text[j] === ")") { d--; if (!d) break; } }
    if (d) continue;
    const g = text.slice(i, j + 1);
    if (g.length < 120) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best = { saving: 0, count: 0, len: 0, sample: "" };
  for (const [g, c] of counts) {
    if (c < 3) continue;
    const saving = (g.length - 4) * (c - 1);
    if (saving > best.saving) best = { saving, count: c, len: g.length, sample: g.slice(0, 50) };
  }
  return best;
}

const BP = "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player";
const CASES = [
  ["read_class_defaults", "unreal_read_class_defaults", { path: BP }],
  ["read_asset_properties", "unreal_read_asset_properties", { path: BP }],
  ["list_actors", "unreal_list_actors", {}],
  ["review_blueprint", "unreal_review_blueprint", { path: BP }],
  ["list_variables", "unreal_list_variables", { path: BP }],
  ["read_blueprint_summary", "unreal_read_blueprint_summary", { path: BP, graphName: "EventGraph" }],
  ["find_references", "unreal_find_references", { name: "BP_Player" }],
  ["list_blueprints", "unreal_list_blueprints", {}],
];

const c = client();
await c.init();
console.log(`  ${"read".padEnd(26)}${"tokens".padStart(8)}${"prize".padStart(9)}${"  %".padStart(6)}  repeated value`);
console.log(`  ${"-".repeat(26)}${"-".repeat(8)}${"-".repeat(9)}${"-".repeat(6)}  ${"-".repeat(40)}`);
for (const [label, tool, args] of CASES) {
  let text = "";
  try { text = await c.call(tool, args); } catch { text = ""; }
  if (!text) { console.log(`  ${label.padEnd(26)}${"(failed)".padStart(8)}`); continue; }
  const p = prize(text);
  const pct = text.length ? Math.round((p.saving / text.length) * 100) : 0;
  console.log(
    `  ${label.padEnd(26)}${String(Math.round(text.length / 4)).padStart(8)}${String(Math.round(p.saving / 4)).padStart(9)}${(pct + "%").padStart(6)}  ` +
      (p.count ? `x${p.count} of ${p.len}ch: ${p.sample}` : "-")
  );
}
c.child.kill();
