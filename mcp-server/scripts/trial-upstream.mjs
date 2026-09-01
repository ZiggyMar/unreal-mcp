/** Walk backwards along exec links from a node to its entry point, listing the gates on the way. */
import { call } from "./trial-bridge.mjs";

const [path, graphName, targetId] = process.argv.slice(2);
const r = await call("read_blueprint_graph_summary", { path, graphName }, 180000);
if (!r?.ok) {
  console.log(JSON.stringify(r).slice(0, 300));
  process.exit(1);
}
const nodes = r.result.nodes;
const byId = new Map(nodes.map((n) => [n.id, n]));
console.log(`${graphName}: ${nodes.length} nodes`);

const label = (n) => `${n.id} ${(n.type || "").replace("K2Node_", "")} "${(n.title || "").slice(0, 46)}"`;

// Which node feeds a given node's exec input?
const execFeeders = (id) => {
  const out = [];
  for (const n of nodes) {
    for (const p of n.connectedPins || []) {
      if (p.direction !== "out") continue;
      // exec-ish output pins: then / execute / branch outputs
      for (const l of p.linkedTo || []) {
        if (l.node === id && (l.pin === "execute" || l.pin === "exec" || /^then/i.test(l.pin))) {
          out.push({ node: n, viaPin: p.pin });
        }
      }
    }
  }
  return out;
};

const dataInputs = (n) =>
  (n.connectedPins || [])
    .filter((p) => p.direction === "in" && p.pin !== "execute" && p.pin !== "exec")
    .map((p) => `${p.pin} <- ${(p.linkedTo || []).map((l) => byId.get(l.node)?.title || l.node).join(", ")}`);

let cur = byId.get(targetId);
if (!cur) {
  console.log(`node ${targetId} not in this graph`);
  process.exit(1);
}
const seen = new Set();
const chain = [];
while (cur && !seen.has(cur.id)) {
  seen.add(cur.id);
  chain.push(cur);
  const feeders = execFeeders(cur.id);
  if (feeders.length === 0) break;
  if (feeders.length > 1) {
    chain.push({ id: "*", type: "", title: `(${feeders.length} exec feeders: ${feeders.map((f) => f.node.title).join(" / ")})` });
  }
  cur = feeders[0].node;
}

console.log("\nchain from entry down to the call (reversed):");
for (const n of chain.reverse()) {
  const gates = n.id === "*" ? "" : dataInputs(n).join(" | ");
  console.log("  " + (n.id === "*" ? n.title : label(n)).padEnd(64) + (gates ? "   " + gates.slice(0, 100) : ""));
}
