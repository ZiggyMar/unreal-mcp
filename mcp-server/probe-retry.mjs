import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "retry");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
for (let i = 1; i <= 40; i++) {
  const p = await call("unreal_ping", {});
  if (!/error/i.test(p)) { console.log("pluginBuiltAt:", JSON.parse(p).pluginBuiltAt); break; }
  await sleep(15000);
}
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;

// The wildcard link is already in the graph from the earlier attempt; re-make it so the new
// notification path runs, then compile.
console.log("reconnect TargetArray:", (await call("unreal_connect_pins", {
  path: GS, graphName: "ClaimSkin",
  sourceNodeId: "162C3BCE", sourcePin: "SkinDeck",
  targetNodeId: "0C502F11", targetPin: "TargetArray",
})).replace(/\s+/g, " ").slice(0, 160));
console.log("compile:", (await call("unreal_compile_blueprint", { path: GS })).replace(/\s+/g, " ").slice(0, 260));
server.child.kill();
