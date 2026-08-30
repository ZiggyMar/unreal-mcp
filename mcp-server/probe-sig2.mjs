import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "sig2");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
const j = JSON.parse(await call("unreal_get_node_signature", { functionName: "Array_RemoveItem", className: "KismetArrayLibrary" }));
console.log("Array_RemoveItem params:");
for (const p of j.params ?? []) console.log("   ", p.direction ?? (p.isReturn ? "out" : "in"), p.name, ":", p.type);
server.child.kill();
