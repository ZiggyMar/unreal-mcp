import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "fn");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
for (const q of ["RemoveItem", "Array_RemoveItem"]) {
  const r = JSON.parse(await call("unreal_find_node", { query: q, maxResults: 4 }));
  console.log("===", q);
  console.log(JSON.stringify(r).slice(0, 600));
}
server.child.kill();
