import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "deck");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;
for (const g of ["EnsureDeckExists", "GetNextTicket", "BurnTicket"]) {
  const s = JSON.parse(await call("unreal_read_blueprint_summary", { path: GS, graphName: g }));
  console.log("===", g, "|", (s.nodes ?? []).length, "nodes");
  for (const n of s.nodes ?? []) console.log("   ", n.type, "|", n.title, "|", JSON.stringify(n.pins ?? []).slice(0, 130));
}
server.child.kill();
