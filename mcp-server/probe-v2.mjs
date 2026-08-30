import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "v2");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
for (let i = 1; i <= 40; i++) {
  const p = await call("unreal_ping", {});
  if (!/error/i.test(p)) { console.log("pluginBuiltAt:", JSON.parse(p).pluginBuiltAt); break; }
  await sleep(15000);
}
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;
const s = JSON.parse(await call("unreal_read_blueprint_summary", { path: GS, graphName: "ClaimSkin" }));
const rm = (s.nodes ?? []).find((n) => /Remove Item/.test(n.title || ""));
const deck = (s.nodes ?? []).find((n) => /SkinDeck/.test(n.title || ""));
console.log("re-make the wildcard link with the new notify path:");
console.log(" ", (await call("unreal_connect_pins", {
  path: GS, graphName: "ClaimSkin",
  sourceNodeId: deck.id, sourcePin: "SkinDeck", targetNodeId: rm.id, targetPin: "TargetArray",
})).replace(/\s+/g, " ").slice(0, 150));
console.log("compile:", (await call("unreal_compile_blueprint", { path: GS })).replace(/\s+/g, " ").slice(0, 240));
server.child.kill();
