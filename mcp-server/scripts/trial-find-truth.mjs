/**
 * Do the read-only tools tell the truth about a real project?
 *
 * These two lies cost a whole investigation each, and both are the same shape: the tool answered
 * "there is nothing there" about something that was plainly there, and the answer was confident
 * enough to act on.
 *
 *   trace_variable   said PlayerWhoPlacedName was read but NEVER WRITTEN, and its verdict said the
 *                    reading side "silently takes the fallback forever". The name was being set on
 *                    the SpawnActor node, one pin away from where the tracer looked.
 *
 *   search_project   returned zero hits for CE_Server_TryPing - the name of an entire subsystem -
 *                    because the index walked FunctionGraphs and Custom Events are not in it.
 *
 * A tool that under-reports is worse than one that fails: a failure gets retried, a confident "no"
 * gets believed. So these are asserted against the real Blueprints they were wrong about.
 *
 * Requires the AntiVirusSquad project open.
 *   node scripts/trial-find-truth.mjs
 */
import { startAndInitialize } from "./lib/mcpStdio.mjs";

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "find-truth");
const call = async (tool, args) => {
  const res = await server.request("tools/call", { name: "unreal_call_tool", arguments: { tool, args } });
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const results = [];
const check = (label, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

// --- a variable written only by a spawn pin ---
const ping = await call("unreal_trace_variable", {
  variableName: "PlayerWhoPlacedName",
  pathPrefix: "/Game/AntiVirusSquad",
});
check(
  "a spawn-pin assignment counts as a write",
  (ping.writes ?? []).length > 0,
  `${(ping.writes ?? []).length} write(s): ${JSON.stringify(ping.writes ?? []).slice(0, 120)}`
);
check(
  "and the verdict no longer calls it never written",
  !/never written/i.test(ping.verdict ?? ""),
  (ping.verdict ?? "(no verdict, which is right when it is simply used)").slice(0, 110)
);
check(
  "the write says which node did it, so a writer in another Blueprint reads as deliberate",
  (ping.writes ?? []).some((w) => /spawn/i.test(w.via ?? "")),
  JSON.stringify((ping.writes ?? []).map((w) => w.via)).slice(0, 140)
);

// A variable that genuinely is never written must STILL be reported as such, or this fix has just
// replaced one wrong answer with the opposite one.
const nonsense = await call("unreal_trace_variable", {
  variableName: "ThisVariableDoesNotExistAnywhere",
  pathPrefix: "/Game/AntiVirusSquad",
});
check(
  "a name that exists nowhere is still reported as nowhere",
  (nonsense.declaredIn ?? []).length === 0 && (nonsense.writes ?? []).length === 0,
  (nonsense.verdict ?? "").slice(0, 100)
);

// --- a Custom Event, which is not in FunctionGraphs ---
const found = await call("unreal_search_project", { query: "CE_Server_TryPing" });
check(
  "a Custom Event can be found by name",
  (found.hits ?? []).length > 0,
  `${(found.hits ?? []).length} hit(s)`
);
check(
  "and is labelled an event rather than a function",
  (found.hits ?? []).some((h) => h.kind === "customEvent"),
  JSON.stringify((found.hits ?? []).map((h) => `${h.kind}:${h.name}`)).slice(0, 160)
);

// Real function graphs must keep being called functions.
const fn = await call("unreal_search_project", { query: "DraggedByVacuum" });
check(
  "a real function is still a function",
  (fn.hits ?? []).some((h) => h.kind === "function"),
  JSON.stringify((fn.hits ?? []).map((h) => `${h.kind}:${h.name}`)).slice(0, 140)
);

server.child.kill();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
