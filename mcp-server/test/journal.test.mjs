import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionJournal, isWrite, targetOf } from "../dist/journal.js";

test("reads are not recorded, writes are", () => {
  const j = new SessionJournal();
  j.record("read_blueprint_graph_summary", { path: "/Game/BP_A.BP_A" }, true);
  j.record("search_project", { query: "health" }, true);
  j.record("find_node", { query: "print" }, true);
  j.record("add_variable", { path: "/Game/BP_A.BP_A", variableName: "Health" }, true);

  const s = j.summary();
  assert.equal(s.totalWrites, 1, "only the write should be logged");
  assert.equal(s.byAsset[0].asset, "/Game/BP_A.BP_A");
});

test("an unknown command is treated as a write, because that is the safe default", () => {
  // A command added later must not silently escape the log just because this file has not
  // heard of it. Under-reporting a change is the dangerous direction.
  assert.equal(isWrite("some_future_command"), true);
  assert.equal(isWrite("list_widgets"), false);
});

test("the target is found whatever the command calls it", () => {
  assert.equal(targetOf({ path: "/Game/A.A" }), "/Game/A.A");
  assert.equal(targetOf({ packagePath: "/Game/New" }), "/Game/New");
  assert.equal(targetOf({ paths: ["/Game/A.A", "/Game/B.B"] }), "/Game/A.A, /Game/B.B");
  assert.equal(targetOf({ query: "health" }), undefined);
  assert.equal(targetOf(undefined), undefined);
});

test("changes are grouped by asset, with repeats collapsed but still counted", () => {
  const j = new SessionJournal();
  for (let i = 0; i < 12; i++) j.record("add_node", { path: "/Game/BP_A.BP_A" }, true);
  j.record("compile_blueprint", { path: "/Game/BP_A.BP_A" }, true);
  j.record("add_widget", { path: "/Game/W_HUD.W_HUD" }, true);

  const s = j.summary();
  assert.equal(s.assetsTouched, 2);
  const bpA = s.byAsset.find((a) => a.asset === "/Game/BP_A.BP_A");
  assert.equal(bpA.writeCount, 13, "every write counts");
  assert.equal(bpA.changes.length, 2, "twelve identical lines would be unreadable");
  assert.ok(bpA.changes.includes("added a node to a graph"));
  // Busiest asset first: that is the one the user most needs to look at.
  assert.equal(s.byAsset[0].asset, "/Game/BP_A.BP_A");
});

test("command names are translated out of jargon", () => {
  const j = new SessionJournal();
  j.record("set_class_default", { path: "/Game/BP_A.BP_A" }, true);
  const changes = j.summary().byAsset[0].changes;
  assert.ok(!changes.some((c) => c.includes("_")), `still jargon: ${changes.join(", ")}`);
  assert.ok(changes.includes("changed a class default"));
});

test("deletions are surfaced separately, because they are what a user most wants to know", () => {
  const j = new SessionJournal();
  j.record("delete_asset", { paths: ["/Game/Old.Old"] }, true);
  j.record("add_variable", { path: "/Game/BP_A.BP_A" }, true);

  const s = j.summary();
  assert.equal(s.destructive.length, 1);
  assert.equal(s.destructive[0].command, "delete_asset");
  assert.equal(s.destructive[0].target, "/Game/Old.Old");
});

test("failed writes are counted and listed, not quietly dropped", () => {
  const j = new SessionJournal();
  j.record("add_node", { path: "/Game/BP_A.BP_A" }, false, "function_not_found: Nope");
  j.record("add_node", { path: "/Game/BP_A.BP_A" }, true);

  const s = j.summary();
  assert.equal(s.totalWrites, 2);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 1);
  assert.match(s.failures[0].error, /function_not_found/);
  // A failed write must not appear as a change that happened.
  assert.equal(s.byAsset[0].writeCount, 1);
});

test("project-wide changes are kept but not counted as an asset", () => {
  const j = new SessionJournal();
  j.record("set_game_settings", { defaultGameMode: "/Game/BP_GM.BP_GM" }, true);

  const s = j.summary();
  assert.equal(s.assetsTouched, 0);
  assert.equal(s.byAsset[0].asset, "(project-wide)");
});

test("an untouched session reports nothing rather than looking broken", () => {
  const s = new SessionJournal().summary();
  assert.equal(s.totalWrites, 0);
  assert.deepEqual(s.byAsset, []);
  assert.deepEqual(s.destructive, []);
});

test("the report states its own limits and how to undo", () => {
  const s = new SessionJournal().summary();
  assert.match(s.scope, /this session only/i);
  assert.match(s.scope, /by hand in the editor/i);
  assert.match(s.undo, /Ctrl\+Z/);
});

test("the full log preserves order and outcome", () => {
  const j = new SessionJournal();
  j.record("create_blueprint", { packagePath: "/Game/BP_A" }, true);
  j.record("add_variable", { path: "/Game/BP_A.BP_A" }, false, "boom");

  const log = j.all();
  assert.deepEqual(
    log.map((r) => r.seq),
    [1, 2]
  );
  assert.equal(log[0].ok, true);
  assert.equal(log[1].ok, false);
});

test("the reads that a whole-project audit issues are not logged as changes", () => {
  // The regression, exactly as it was found. audit_project, map_system, find_orphans and
  // plan_feature loop over the project and issue hundreds of reads. Fifteen of those read commands
  // were missing from READ_ONLY_COMMANDS, so unreal_session_changes - the tool whose entire job is
  // answering "what did I change this session" - reported 359 writes across 190 assets after a
  // session that changed nothing, at 9,871 tokens. It is now 130.
  //
  // The token cost is the smaller half. A model that calls session_changes to check its own work
  // and is told it modified 190 assets it never touched has been actively misled by the one tool
  // that has to be right about this.
  const j = new SessionJournal();
  for (const command of [
    "describe_class",
    "find_broken_names",
    "get_game_settings",
    "list_actors",
    "list_data_table_rows",
    "list_input_mappings",
    "list_material_parameters",
    "list_variables",
    "read_anim_blueprint",
    "read_asset_properties",
    "read_behavior_tree",
    "read_class_defaults",
    "read_input_context",
    "read_level_sequence",
    "read_niagara_system",
  ]) {
    assert.equal(isWrite(command), false, `${command} only looks at things`);
    j.record(command, { path: "/Game/BP_A.BP_A" }, true);
  }
  assert.equal(j.summary().totalWrites, 0, "a session that only read changed nothing");
  assert.equal(j.summary().byAsset.length, 0, "and touched no assets");
});

test("a read next to a write does not hide the write", () => {
  // The fix has an obvious failure mode: classify everything as a read and the false positives
  // vanish along with the true ones. Reads going quiet is only correct if writes still land.
  const j = new SessionJournal();
  j.record("create_blueprint", { packagePath: "/Game/BP_New" }, true);
  j.record("list_variables", { path: "/Game/BP_New" }, true);
  j.record("add_variable", { path: "/Game/BP_New", variableName: "Health" }, true);
  j.record("read_class_defaults", { path: "/Game/BP_New" }, true);

  const s = j.summary();
  assert.equal(s.totalWrites, 2, "both writes recorded");
  assert.deepEqual(s.byAsset.map((a) => a.writeCount), [2]);
});

test("status reads are reads, including the ones whose names do not say so", () => {
  // These are the half the naming guard cannot check. project_health, pie_status and the traces
  // inspect and report; they were read out of the C++ handler one at a time rather than assumed,
  // which is the slow half of keeping this list honest.
  for (const command of ["ping", "pie_status", "asset_status", "project_health", "undo_history", "trace_function_calls", "trace_variable", "watch_runtime"]) {
    assert.equal(isWrite(command), false, `${command} changes nothing in the project`);
  }
});

test("take_screenshot is still logged, because it leaves a file behind", () => {
  // It touches no asset, so the mutation scan calls it a read. It is kept as a write deliberately:
  // a side effect that leaves something on disk is worth one line in the log.
  assert.equal(isWrite("take_screenshot"), true);
});

test("a command that writes is still a write even if it is called after a read", () => {
  assert.equal(isWrite("run_console_command"), true, "a console command can do anything");
  assert.equal(isWrite("live_coding_compile"), true, "compiling changes the running editor");
  assert.equal(isWrite("live_coding_status"), false, "asking whether it compiled does not");
});
