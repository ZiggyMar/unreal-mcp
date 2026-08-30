import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "v3");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
for (let i = 1; i <= 40; i++) {
  const p = await call("unreal_ping", {});
  if (!/error/i.test(p)) { console.log("pluginBuiltAt:", JSON.parse(p).pluginBuiltAt); break; }
  await sleep(15000);
}
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;

// The earlier ClaimSkin was saved with a plain CallFunction node. Throw its body away and rebuild
// with the corrected node class.
const s = JSON.parse(await call("unreal_read_blueprint_summary", { path: GS, graphName: "ClaimSkin" }));
const entry = (s.nodes ?? []).find((n) => n.type === "FunctionEntry");
const result = (s.nodes ?? []).find((n) => n.type === "FunctionResult");
for (const n of (s.nodes ?? []).filter((n) => !["FunctionEntry", "FunctionResult"].includes(n.type))) {
  await call("unreal_remove_node", { path: GS, graphName: "ClaimSkin", nodeId: n.id });
}
const built = JSON.parse(await call("unreal_build_graph", {
  path: GS, graphName: "ClaimSkin",
  nodes: [
    { ref: "ensure", nodeType: "CallFunction", functionName: "EnsureDeckExists" },
    { ref: "deck", nodeType: "VariableGet", variableName: "SkinDeck" },
    { ref: "remove", nodeType: "CallFunction", functionName: "Array_RemoveItem", className: "KismetArrayLibrary" },
  ],
  connections: [
    { from: `${entry.id}.then`, to: "ensure.execute" },
    { from: "deck.SkinDeck", to: "remove.TargetArray" },
    { from: "ensure.then", to: "remove.execute" },
    { from: `${entry.id}.SkinId`, to: "remove.Item" },
    { from: "remove.then", to: `${result.id}.execute` },
    { from: "remove.ReturnValue", to: `${result.id}.bClaimed` },
  ],
  compile: true,
}));
console.log("compile:", JSON.stringify(built.compile ?? {}).slice(0, 220));
const after = JSON.parse(await call("unreal_read_blueprint_summary", { path: GS, graphName: "ClaimSkin" }));
console.log("node classes:", (after.nodes ?? []).map((n) => n.type).join(", "));
console.log("save:", (await call("unreal_save_blueprint", { path: GS })).replace(/\s+/g, " ").slice(0, 110));
server.child.kill();
