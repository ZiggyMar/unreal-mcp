import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, from this test file, so the bridge source can be read.*/
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Bridge commands deliberately NOT probed, each with the reason.
 *
 * A probe sends the command with no parameters and reads `unknown_cmd` off the reply, so anything
 * that could act without parameters, or that costs real time, stays out.
 */
const NOT_PROBED = new Set([
  // Everything that already existed when this guard was written. They are covered generically by the
  // "plugin freshness" check, which compares the plugin's build time against the C++ source and so
  // catches a plugin missing ANY command at once. The probe list exists to name WHICH feature is
  // dark, which is only worth spending a round trip on for the newest few.
  //
  // The point of this set is not its contents. It is that adding a bridge command from now on fails
  // this test until somebody decides which side it belongs on - because the alternative, twice
  // already, was a doctor confidently reporting "missing 2" when it was missing eight.
  // The montage notify pair: both WRITE. A probe sends no parameters, and a probe that succeeded
  // would have put a notify on somebody's montage to find out whether the command exists. The
  // freshness check covers them - it compares the plugin binary's build time against the C++ source,
  // so a plugin missing either is caught, just without naming which.
  "add_montage_notify", "remove_montage_notify",
  "add_component", "add_data_table_row", "add_enum_entry", "add_input_mapping", "add_node", "add_struct_field",
  "add_variable", "add_widget", "asset_status", "build_graph", "compile_blueprint",
  "connect_pins", "create_blueprint", "create_enum", "create_function", "create_level",
  "create_material", "create_material_instance", "create_struct", "create_widget_blueprint", "delete_actor",
  "delete_asset", "describe_class", "find_broken_names", "find_node", "find_references",
  "get_game_settings", "get_node_signature", "get_project_overview", "list_actors", "list_assets",
  "list_blueprint_graphs", "list_blueprints", "list_components", "list_data_table_rows", "list_enum_entries",
  "list_input_mappings", "list_material_parameters", "list_struct_fields", "list_widgets", "open_level",
  "organize_graph", "pie_status", "ping", "project_health", "read_anim_blueprint",
  "read_asset_properties", "read_behavior_tree", "read_blueprint_graph_summary", "read_blueprint_node_detail", "read_class_defaults",
  "read_niagara_system", "refresh_blueprint", "remove_data_table_row", "remove_node", "save_blueprint",
  "save_level", "search_project", "set_actor_property", "set_asset_property", "set_class_default",
  "set_component_property", "set_data_table_row", "set_game_settings", "set_material_parameter", "set_pin_default_value",
  "set_widget_property", "spawn_actor", "start_pie", "stop_pie", "take_screenshot",
  "trace_function_calls", "trace_variable", "undo_history",
]);


import { runDoctor, formatDoctorReport, FEATURE_PROBE_LIST } from "../dist/doctor.js";

const CONN = { host: "127.0.0.1", port: 8765 };

// The feature probes doctor uses to detect a plugin older than this server. The real bridge
// rejects each of these with missing_param before doing any work; what matters is that it does NOT
// answer unknown_cmd. A fixture missing them models an old plugin, which is a different test.
const PROBE_REPLIES = {
  list_variables: new Error("missing_param: path"),
  create_data_table: new Error("missing_param: packagePath and rowStruct are required"),
  save_asset: new Error("missing_param: path"),
  set_variable_replication: new Error("missing_param: path, variableName and mode are required"),
  watch_runtime: new Error("missing_param: watch is required"),
};

const HEALTHY = {
  ...PROBE_REPLIES,
  ping: {
    status: "ok",
    plugin: "UnrealMCPBridge",
    protocolVersion: 1,
    project: "MyGame",
    projectFile: "A:/Projects/MyGame/MyGame.uproject",
    engineVersion: "5.6.0",
  },
  get_project_overview: {
    blueprintCount: 21,
    totalFunctions: 84,
    totalVariables: 130,
    totalGraphs: 40,
    totalNodes: 900,
    folders: [],
    byParentClass: [],
    assetRegistryStillScanning: false,
  },
  find_node: { query: "Print String", hits: [], hitCount: 1, catalogSize: 15775 },
  pie_status: { running: false },
};

/** A bridge whose per-command replies can be overridden, or replaced with a thrown error. */
function fakeBridge(overrides = {}) {
  // A healthy plugin answers every command the doctor probes for, derived from the probe list rather
  // than listed again here. Adding a probe used to leave this fixture behind, and the test then
  // failed for the fixture's reason rather than the code's.
  const probesAnswered = Object.fromEntries(FEATURE_PROBE_LIST.map((probe) => [probe.cmd, {}]));
  const replies = { ...probesAnswered, ...HEALTHY, ...overrides };
  return {
    async send(cmd) {
      const reply = replies[cmd];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`unknown_cmd: ${cmd}`);
      return reply;
    },
  };
}

const check = (report, name) => report.checks.find((c) => c.name === name);
/** Deterministic clock: each call advances by the given step. */
const clock = (stepMs = 5) => {
  let t = 0;
  return () => (t += stepMs);
};

/** runDoctor with a fake bridge and an injected source-mtime, since the real tree is not a fixture. */
function doctorWith(overrides, newestSource) {
  return runDoctor(fakeBridge(overrides), CONN, clock(), newestSource);
}

test("a healthy editor reports ready, with every check ok and no remedies", async () => {
  const report = await runDoctor(fakeBridge(), CONN, clock());

  assert.equal(report.verdict, "ready");
  assert.equal(report.checks.filter((c) => c.status !== "ok").length, 0);
  for (const c of report.checks) assert.equal(c.remedy, undefined);
  assert.match(report.nextAction, /Everything checks out/);
});

test("an unreachable bridge reports not_connected and stops, keeping the client's own checklist", async () => {
  const detailed = new Error("Could not reach the UnrealMCPBridge plugin at 127.0.0.1:8765. Check, in this order: ...");
  const report = await runDoctor(fakeBridge({ ping: detailed }), CONN, clock());

  assert.equal(report.verdict, "not_connected");
  assert.equal(report.checks.length, 1, "no further check is meaningful until the editor answers");
  assert.equal(check(report, "bridge reachable").status, "fail");
  assert.equal(
    check(report, "bridge reachable").remedy,
    detailed.message,
    "the transport's checklist must be passed through verbatim, not paraphrased"
  );
});

test("an older plugin is diagnosed as older, and told what will break", async () => {
  const report = await runDoctor(
    fakeBridge({ ping: { ...HEALTHY.ping, protocolVersion: 0 } }),
    CONN,
    clock()
  );
  const version = check(report, "protocol version");
  assert.equal(version.status, "warn");
  assert.match(version.remedy, /older than this MCP server/);
  assert.match(version.remedy, /unknown_cmd/);
  assert.equal(report.verdict, "degraded");
});

test("a newer plugin is diagnosed the other way round", async () => {
  const report = await runDoctor(
    fakeBridge({ ping: { ...HEALTHY.ping, protocolVersion: 9 } }),
    CONN,
    clock()
  );
  assert.match(check(report, "protocol version").remedy, /Update the server/);
});

test("a slow ping is reported as a busy editor, not a misconfiguration", async () => {
  const report = await runDoctor(fakeBridge(), CONN, clock(4000));
  const responsive = check(report, "editor responsive");
  assert.equal(responsive.status, "warn");
  assert.match(responsive.remedy, /Nothing is misconfigured/);
});

test("a still-scanning AssetRegistry warns that searches can report false absences", async () => {
  const report = await runDoctor(
    fakeBridge({ get_project_overview: { ...HEALTHY.get_project_overview, assetRegistryStillScanning: true } }),
    CONN,
    clock()
  );
  const index = check(report, "project index");
  assert.equal(index.status, "warn");
  assert.match(index.remedy, /does not exist when it does/);
});

test("an empty index suggests the wrong project may be open", async () => {
  const report = await runDoctor(
    fakeBridge({ get_project_overview: { ...HEALTHY.get_project_overview, blueprintCount: 0 } }),
    CONN,
    clock()
  );
  assert.match(check(report, "project index").remedy, /title bar/);
});

test("a failed overview does not abort the remaining checks", async () => {
  const report = await runDoctor(
    fakeBridge({ get_project_overview: new Error("index_locked") }),
    CONN,
    clock()
  );
  assert.equal(check(report, "project index").status, "fail");
  assert.ok(check(report, "node catalog"), "later checks must still run");
  assert.ok(check(report, "play-in-editor"));
  assert.equal(report.verdict, "degraded");
});

test("a running PIE session is surfaced, because edits during PIE look like no-ops", async () => {
  const report = await runDoctor(fakeBridge({ pie_status: { running: true } }), CONN, clock());
  const pie = check(report, "play-in-editor");
  assert.equal(pie.status, "warn");
  assert.match(pie.remedy, /unreal_stop_pie/);
});

test("a plugin too old to know pie_status is not reported as a problem", async () => {
  const report = await runDoctor(fakeBridge({ pie_status: undefined }), CONN, clock());
  assert.equal(check(report, "play-in-editor").status, "ok");
});

test("an empty node catalog warns that the model has no ground truth", async () => {
  const report = await runDoctor(
    fakeBridge({ find_node: { query: "Print String", hits: [], hitCount: 0, catalogSize: 0 } }),
    CONN,
    clock()
  );
  assert.match(check(report, "node catalog").remedy, /no ground truth|ground truth/);
});

test("nextAction names the worst problem, preferring a failure over a warning", async () => {
  const report = await runDoctor(
    fakeBridge({
      get_project_overview: new Error("index_locked"),
      pie_status: { running: true },
    }),
    CONN,
    clock()
  );
  assert.match(report.nextAction, /^project index:/, `got: ${report.nextAction}`);
});

test("the plain-text rendering marks each check and ends with the next action", () => {
  const text = formatDoctorReport({
    verdict: "degraded",
    host: "127.0.0.1",
    port: 8765,
    checks: [
      { name: "bridge reachable", status: "ok", detail: "answered in 3ms" },
      { name: "play-in-editor", status: "warn", detail: "running", remedy: "Stop it.\nThen retry." },
    ],
    nextAction: "play-in-editor: Stop it.",
  });

  assert.match(text, /DEGRADED/);
  assert.match(text, /\[ok\]\s+bridge reachable/);
  assert.match(text, /\[warn\]\s*play-in-editor/);
  assert.match(text, /^\s+Then retry\.$/m, "multi-line remedies stay indented under their check");
  assert.match(text, /Next: play-in-editor/);
});

test("the connected project is named, because only one editor can hold the port", async () => {
  const report = await runDoctor(fakeBridge(), CONN, clock());
  const which = check(report, "which project");
  assert.equal(which.status, "ok");
  assert.match(which.detail, /MyGame/);
});

test("a project mismatch FAILS loudly rather than warning", async () => {
  // This is the "agent silently edited the wrong project" case. A warning would be read past.
  const report = await runDoctor(fakeBridge(), { ...CONN, expectedProject: "OtherGame" }, clock());
  const which = check(report, "which project");
  assert.equal(which.status, "fail");
  assert.match(which.remedy, /WRONG PROJECT/);
  assert.match(which.remedy, /second editor/i);
  assert.match(which.remedy, /Do not make any edits/);
  assert.equal(report.verdict, "degraded");
  assert.match(report.nextAction, /^which project:/);
});

test("a matching project passes, case-insensitively", async () => {
  const report = await runDoctor(fakeBridge(), { ...CONN, expectedProject: "mygame" }, clock());
  assert.equal(check(report, "which project").status, "ok");
});

test("a plugin too old to report its project is called out", async () => {
  const report = await runDoctor(
    fakeBridge({ ping: { status: "ok", plugin: "UnrealMCPBridge", protocolVersion: 1 } }),
    CONN,
    clock()
  );
  const which = check(report, "which project");
  assert.equal(which.status, "warn");
  assert.match(which.remedy, /Update the plugin/);
});

test("a plugin older than the server is caught, even though the protocol number matches", async () => {
  // The trap this exists for: the protocol number has been 1 since the beginning while the bridge
  // gained more than twenty commands, so an old plugin passes every other check and then fails on
  // the first tool that needs one of them, with unknown_cmd and no explanation.
  const old = fakeBridge({
    list_variables: undefined,
    create_data_table: undefined,
    save_asset: undefined,
  });
  // `undefined` in the overrides does not delete the key, so build the old plugin explicitly.
  const oldPlugin = {
    async send(cmd) {
      if (["list_variables", "create_data_table", "save_asset"].includes(cmd)) {
        throw new Error(`unknown_cmd: ${cmd}`);
      }
      return old.send(cmd);
    },
  };

  const report = await runDoctor(oldPlugin, CONN, clock());
  const features = check(report, "plugin features");
  assert.ok(features, "no plugin features check was reported");
  assert.equal(features.status, "fail");
  assert.match(features.detail, /list_variables/);
  assert.match(features.remedy, /older than this MCP server/i);
  assert.equal(report.verdict, "degraded");
});

test("a current plugin reports no missing features", async () => {
  const report = await runDoctor(fakeBridge(), CONN, clock());
  const features = check(report, "plugin features");
  assert.equal(features.status, "ok");
});

test("a plugin older than the C++ source is reported, with what to do", async () => {
  // The check that would have made two days shorter. A hand-maintained probe list catches the
  // commands somebody remembered to add to it; this catches every command at once, because a plugin
  // older than the source is missing all of them by definition. Measured against a real editor: it
  // was running a build from Aug 30 19:42 while the source had moved on, and `plugin features`
  // reported everything implemented.
  const built = "Aug 30 2026 19:42:16";
  const sourceNewer = Date.parse(built) + 60 * 60 * 1000;
  const report = await doctorWith({ ping: { ...HEALTHY.ping, pluginBuiltAt: built } }, () => sourceNewer);
  const check = report.checks.find((c) => c.name === "plugin freshness");
  assert.ok(check, `expected a freshness check; got ${report.checks.map((c) => c.name).join(", ")}`);
  assert.equal(check.status, "warn");
  assert.match(check.remedy, /build:engines/);
  assert.match(check.remedy, /build-targets\.json/, "a project that is not a target never receives anything");
});

test("a plugin built from the current source is not nagged about", async () => {
  const built = "Aug 31 2026 09:00:00";
  const report = await doctorWith({ ping: { ...HEALTHY.ping, pluginBuiltAt: built } }, () => Date.parse(built) - 1000);
  const check = report.checks.find((c) => c.name === "plugin freshness");
  assert.equal(check.status, "ok");
});

test("no sources on disk means no verdict, not a clean bill of health", async () => {
  // An installed copy of this server has no UnrealMCPBridge sources beside it. Reporting freshness
  // from their absence would be inventing an answer.
  const report = await doctorWith({ ping: { ...HEALTHY.ping, pluginBuiltAt: "Aug 30 2026 19:42:16" } }, () => 0);
  assert.ok(!report.checks.some((c) => c.name === "plugin freshness"), "silent when it cannot tell");
});

test("the feature probe says how many it probed, not that everything is fine", async () => {
  // "The plugin implements every command this server probes for" was true and useless: it reported
  // an all-clear on an editor that was missing two commands, because they were not in the list.
  const report = await doctorWith({}, () => 0);
  const check = report.checks.find((c) => c.name === "plugin features");
  assert.equal(check.status, "ok");
  assert.match(check.detail, /\d+ probed commands/);
  assert.match(check.detail, /sample, not the whole surface/);
});

test("every bridge command is either probed or deliberately not, with a reason", () => {
  // The doctor's probe list is hand-maintained and it has gone stale TWICE - once missing
  // set_variable_replication and watch_runtime while reporting everything implemented, and again
  // missing six more after a session that added the console, Enhanced Input and live coding. Both
  // times it was confidently wrong in the one place somebody looks when nothing works.
  //
  // This does not demand that everything be probed - most commands cannot be, because a probe sends
  // no parameters and `delete_asset` is a poor way to ask whether a command exists. It demands a
  // DECISION, recorded here, whenever a command is added. The next stale probe list is a failing
  // test rather than a wrong diagnosis.
  const handler = readFileSync(
    join(REPO_ROOT, "UnrealMCPBridge/Source/UnrealMCPBridge/Private/MCPCommandHandler.cpp"),
    "utf8"
  );
  const commands = new Set([...handler.matchAll(/Cmd\s*==\s*TEXT\("([a-z0-9_]+)"\)/g)].map((m) => m[1]));
  assert.ok(commands.size > 50, `expected to find the bridge's command list, found ${commands.size}`);

  const probed = new Set(FEATURE_PROBE_LIST.map((p) => p.cmd));
  const unaccounted = [...commands].filter((c) => !probed.has(c) && !NOT_PROBED.has(c)).sort();
  assert.deepEqual(
    unaccounted,
    [],
    `these bridge commands are neither probed nor listed as deliberately unprobed, so a plugin ` +
      `missing them would be reported as healthy: ${unaccounted.join(", ")}`
  );

  // And nothing probed should have been retired from the bridge.
  const gone = [...probed].filter((c) => !commands.has(c));
  assert.deepEqual(gone, [], `probing commands the bridge no longer has: ${gone.join(", ")}`);
});
