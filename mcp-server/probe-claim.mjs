import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "claim");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;
console.log("GS_Gameplay:", GS);

console.log("1. create ClaimSkin(SkinId:int) -> bool");
console.log("  ", (await call("unreal_create_function", {
  path: GS, functionName: "ClaimSkin",
  inputs: [{ name: "SkinId", type: "int" }],
  outputs: [{ name: "bClaimed", type: "bool" }],
})).slice(0, 220));

console.log("2. what nodes exist in it now");
const s = JSON.parse(await call("unreal_read_blueprint_summary", { path: GS, graphName: "ClaimSkin" }));
for (const n of s.nodes ?? []) console.log("   ", n.id, n.type, "|", n.title, "|", JSON.stringify(n.pins ?? []).slice(0, 120));
server.child.kill();
