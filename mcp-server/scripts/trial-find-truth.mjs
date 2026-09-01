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

// --- the Level Blueprint, which was in no list at all ---
//
// Where a great deal of ordinary Unreal work lives: a trigger opening a door, a sequence starting,
// anything specific to one map. It is not in the asset registry as a Blueprint, so list_blueprints
// never showed it and searching for it found nothing - an entire category of a project, invisible.
// A level path resolves to it now, which means every graph tool reaches it without a new tool.
const levels = await call("unreal_list_assets", { className: "World", pathPrefix: "/Game" });
const level = (levels.assets ?? [])
  .map((a) => (typeof a === "string" ? a : a.path))
  .find(Boolean);
if (level) {
  const graphs = await call("unreal_list_blueprint_graphs", { path: level });
  check(
    "a level path reaches its Level Blueprint",
    Array.isArray(graphs.graphs) && graphs.graphs.length > 0,
    `${level.split("/").pop()} -> ${(graphs.graphs ?? []).map((g) => g.name).join(", ").slice(0, 80)}`
  );
  const explained = await call("unreal_explain_graph", { path: level, graphName: "EventGraph" });
  check(
    "and the ordinary graph readers work on it",
    typeof explained.text === "string" && explained.text.length > 0,
    (explained.text ?? explained.raw ?? "").slice(0, 90).replace(/\s+/g, " ")
  );
} else {
  check("a level path reaches its Level Blueprint", false, "no levels found to test against");
}

// --- a struct's fields and an enum's entries ---
//
// Reading a User Defined Struct returned `"properties": []`. A struct IS its fields, so that reply
// contained none of the asset. An enum returned one entry called EnumDescription and not a single
// enumerator. Between them that blocks the most ordinary data work there is: a Data Table is TYPED
// by a struct, so writing a row without its columns is guesswork.
const structs = await call("unreal_list_assets", { className: "UserDefinedStruct", pathPrefix: "/Game" });
const structPath = (structs.assets ?? []).map((a) => (typeof a === "string" ? a : a.path)).find(Boolean);
if (structPath) {
  // `match` filters the ordinary property walk down to nothing, so this asserts the struct fields
  // specifically rather than passing on unrelated properties.
  // Two halves, because the answer arrives in two calls on purpose.
  //
  // read_asset_properties used to inline a struct's fields, and this trial asserted that. The reply
  // now returns an empty `properties` and a `next` pointer naming unreal_list_struct_fields instead,
  // which is the better design - a struct's fields are not properties, and duplicating them in two
  // tools is how the two drift apart. The trial was not updated with it, so it sat at 11/13 asserting
  // a shape nothing produces any more. A stale check fails exactly like a broken tool, which is why
  // it went unread.
  //
  // So: the pointer has to NAME the tool that has the answer, and that tool has to have it.
  const st = await call("unreal_read_asset_properties", { path: structPath, match: "zzz-no-such-property" });
  check(
    "reading a struct points at the tool that has its fields",
    typeof st.next === "string" && /unreal_list_struct_fields/.test(st.next),
    `${structPath.split("/").pop()} -> ${String(st.next ?? "(no pointer)").slice(0, 90)}`
  );

  const fields = await call("unreal_list_struct_fields", { path: structPath });
  check(
    "and that tool reports them",
    Array.isArray(fields.fields) && fields.fields.length > 0,
    `${structPath.split("/").pop()} -> ${(fields.fields ?? []).map((f) => `${f.name}:${f.type}`).join(", ").slice(0, 90)}`
  );
  check(
    "by the name a person writes, not the GUID-suffixed internal one",
    (fields.fields ?? []).every((f) => !/_\d+_[0-9A-F]{16,}/i.test(f.name ?? "")),
    (fields.fields ?? []).map((f) => f.name).join(", ").slice(0, 80)
  );
}

const enums = await call("unreal_list_assets", { className: "UserDefinedEnum", pathPrefix: "/Game" });
const enumPath = (enums.assets ?? []).map((a) => (typeof a === "string" ? a : a.path)).find(Boolean);
if (enumPath) {
  const en = await call("unreal_read_asset_properties", { path: enumPath, match: "zzz-no-such-property" });
  check(
    "reading an enum points at the tool that has its entries",
    typeof en.next === "string" && /unreal_list_enum_entries/.test(en.next),
    `${enumPath.split("/").pop()} -> ${String(en.next ?? "(no pointer)").slice(0, 90)}`
  );

  const entries = await call("unreal_list_enum_entries", { path: enumPath });
  // displayName, not name. Unreal stores a User Defined Enum's entries as NewEnumerator0,
  // NewEnumerator1, ... and keeps what the author typed separately. Reporting only the internal name
  // is true and useless - "NewEnumerator2" tells a reader nothing, and this trial printed exactly
  // that for three entries while claiming the tool "reports them". The tool had the display names all
  // along; the check was reading past them.
  check(
    "and that tool reports them, by the name the author typed",
    Array.isArray(entries.entries) &&
      entries.entries.length > 0 &&
      entries.entries.every((e) => typeof e.displayName === "string" && e.displayName.length > 0),
    `${enumPath.split("/").pop()} -> ${(entries.entries ?? []).map((e) => `${e.displayName}=${e.value}`).join(", ").slice(0, 90)}`
  );
  check(
    "without the _MAX sentinel, which is bookkeeping nobody selects",
    (entries.entries ?? []).every((e) => !/_MAX$/i.test(e.name ?? "")),
    (entries.entries ?? []).map((e) => e.name).join(", ").slice(0, 80)
  );
}

server.child.kill();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
