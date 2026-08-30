import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "build");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;

const r = await call("unreal_build_graph", {
  path: GS,
  graphName: "ClaimSkin",
  nodes: [
    { ref: "ensure", nodeType: "CallFunction", functionName: "EnsureDeckExists" },
    { ref: "deck", nodeType: "VariableGet", variableName: "SkinDeck" },
    { ref: "remove", nodeType: "CallFunction", functionName: "Array_RemoveItem", className: "KismetArrayLibrary" },
  ],
  connections: [
    { from: "98787276.then", to: "ensure.execute" },
    { from: "ensure.then", to: "remove.execute" },
    { from: "deck.SkinDeck", to: "remove.TargetArray" },
    { from: "98787276.SkinId", to: "remove.Item" },
    { from: "remove.then", to: "EA265CF2.execute" },
    { from: "remove.ReturnValue", to: "EA265CF2.bClaimed" },
  ],
  compile: true,
});
console.log(r.slice(0, 700));
server.child.kill();
