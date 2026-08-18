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
