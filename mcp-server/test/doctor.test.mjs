import { test } from "node:test";
import assert from "node:assert/strict";

import { runDoctor, formatDoctorReport } from "../dist/doctor.js";

const CONN = { host: "127.0.0.1", port: 8765 };

const HEALTHY = {
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
  const replies = { ...HEALTHY, ...overrides };
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
