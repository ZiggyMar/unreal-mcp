import { startAndInitialize } from "./scripts/lib/mcpStdio.mjs";
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "comp");
const call = async (n, a) => ((await server.request("tools/call", { name: n, arguments: a }))?.result?.content ?? []).map((c) => c.text ?? "").join("");
const GS = (JSON.parse(await call("unreal_list_blueprints", { match: "GS_Gameplay" })).blueprints ?? []).find((b) => b.path.includes("/GS_Gameplay."))?.path;
console.log("refresh:", (await call("unreal_refresh_blueprint", { path: GS })).replace(/\s+/g, " ").slice(0, 160));
console.log("compile:", (await call("unreal_compile_blueprint", { path: GS })).replace(/\s+/g, " ").slice(0, 300));
server.child.kill();
