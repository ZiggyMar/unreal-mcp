import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "redo");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;

const made = JSON.parse(await call("unreal_create_function", {
  path: GS, functionName: "ClaimSkin",
  inputs: [{ name: "SkinId", type: "int" }],
  outputs: [{ name: "bClaimed", type: "bool" }],
}));
const entry = made.entryNodeId.slice(0, 8);
const result = made.resultNodeId.slice(0, 8);
console.log("created ClaimSkin | entry", entry, "| result", result);

const built = await call("unreal_build_graph", {
  path: GS, graphName: "ClaimSkin",
  nodes: [
    { ref: "ensure", nodeType: "CallFunction", functionName: "EnsureDeckExists" },
    { ref: "deck", nodeType: "VariableGet", variableName: "SkinDeck" },
    { ref: "remove", nodeType: "CallFunction", functionName: "Array_RemoveItem", className: "KismetArrayLibrary" },
  ],
  connections: [
    { from: `${entry}.then`, to: "ensure.execute" },
    { from: "deck.SkinDeck", to: "remove.TargetArray" },
    { from: "ensure.then", to: "remove.execute" },
    { from: `${entry}.SkinId`, to: "remove.Item" },
    { from: "remove.then", to: `${result}.execute` },
    { from: "remove.ReturnValue", to: `${result}.bClaimed` },
  ],
  compile: true,
});
const j = JSON.parse(built);
console.log("build compile:", JSON.stringify(j.compile ?? {}).slice(0, 200));
console.log("save:", (await call("unreal_save_blueprint", { path: GS })).replace(/\s+/g, " ").slice(0, 120));
server.child.kill();
