import { test } from "node:test";
import assert from "node:assert/strict";

import { auditDataTables } from "../dist/dataTableAudit.js";

/** A bridge serving canned Data Tables. */
function fakeBridge(tables, opts = {}) {
  return {
    async send(cmd, params = {}) {
      if (cmd === "list_assets") return { assets: Object.keys(tables) };
      if (cmd === "list_data_table_rows") {
        const t = tables[params.path];
        if (t === undefined) throw new Error(`asset_not_found: ${params.path}`);
        if (t.error) throw new Error(t.error);
        return { path: params.path, rows: t };
      }
      throw new Error(`unknown_cmd: ${cmd}`);
    },
    ...opts,
  };
}

/** The exact shape of the bug this check was written for. */
const ENEMY_TABLE = [
  {
    rowName: "ILY",
    values: {
      EnemyName: "ILYEnemy",
      EnemyType: "/Game/Chars/Enemies/BP_BasicEnemy.BP_BasicEnemy_C",
      Ratio: "6",
      MinimumWave: "0",
    },
  },
  {
    rowName: "Fly",
    values: { EnemyName: "FlyingEnemy", EnemyType: "None", Ratio: "1", MinimumWave: "3" },
  },
];

test("the real bug is caught: one row's class reference cleared to None", async () => {
  const result = await auditDataTables(fakeBridge({ "/Game/Data/DT_Enemies.DT_Enemies": ENEMY_TABLE }));

  assert.equal(result.verdict, "problems");
  assert.equal(result.nullReferences.length, 1);
  const hit = result.nullReferences[0];
  assert.equal(hit.rowName, "Fly");
  assert.equal(hit.field, "EnemyType");
  assert.equal(hit.exampleFromRow, "ILY", "it should show which row proves this field holds a reference");
  assert.match(hit.exampleValue, /BP_BasicEnemy/);
});

test("a healthy table is clean", async () => {
  const healthy = [
    { rowName: "A", values: { Cls: "/Game/X/BP_A.BP_A_C", N: "1" } },
    { rowName: "B", values: { Cls: "/Game/X/BP_B.BP_B_C", N: "2" } },
  ];
  const result = await auditDataTables(fakeBridge({ "/Game/D.D": healthy }));
  assert.equal(result.verdict, "clean");
  assert.deepEqual(result.nullReferences, []);
});

test("ordinary text fields are never mistaken for broken references", async () => {
  // "None" is a perfectly normal string value. Without a filled asset path in the SAME field, it
  // must not be reported - otherwise the check cries wolf on every table with prose in it.
  const rows = [
    { rowName: "A", values: { Label: "None", Count: "3" } },
    { rowName: "B", values: { Label: "Fire", Count: "4" } },
  ];
  const result = await auditDataTables(fakeBridge({ "/Game/D.D": rows }));
  assert.equal(result.verdict, "clean", JSON.stringify(result.nullReferences));
});

test("several broken rows in one table are all reported", async () => {
  const rows = [
    { rowName: "Good", values: { Cls: "/Game/X/BP_A.BP_A_C" } },
    { rowName: "Bad1", values: { Cls: "None" } },
    { rowName: "Bad2", values: { Cls: "" } },
  ];
  const result = await auditDataTables(fakeBridge({ "/Game/D.D": rows }));
  assert.equal(result.nullReferences.length, 2);
  assert.deepEqual(result.nullReferences.map((r) => r.rowName).sort(), ["Bad1", "Bad2"]);
});

test("a field empty in every row is reported as undecidable, not silently passed", async () => {
  // No filled row means no evidence the field is a reference at all. Saying so is honest; calling
  // it clean would be a claim the data does not support.
  const rows = [
    { rowName: "A", values: { Cls: "None", N: "1" } },
    { rowName: "B", values: { Cls: "None", N: "2" } },
  ];
  const result = await auditDataTables(fakeBridge({ "/Game/D.D": rows }));
  assert.equal(result.nullReferences.length, 0);
  assert.equal(result.undecidable.length, 1);
  assert.equal(result.undecidable[0].field, "Cls");
});

test("a table that cannot be read is reported, not skipped", async () => {
  const result = await auditDataTables(
    fakeBridge({
      "/Game/Good.Good": [{ rowName: "A", values: { Cls: "/Game/X/BP_A.BP_A_C" } }],
      "/Game/Bad.Bad": { error: "unknown_cmd: list_data_table_rows" },
    })
  );
  assert.equal(result.unreadable.length, 1);
  assert.match(result.unreadable[0].table, /Bad/);
  assert.equal(result.tablesScanned, 2, "an unreadable table still counts as attempted");
});

test("explicit paths skip the asset listing", async () => {
  let listed = false;
  const inner = fakeBridge({ "/Game/D.D": ENEMY_TABLE });
  const bridge = {
    async send(cmd, params) {
      if (cmd === "list_assets") listed = true;
      return inner.send(cmd, params);
    },
  };
  const result = await auditDataTables(bridge, { paths: ["/Game/D.D"] });
  assert.equal(listed, false);
  assert.equal(result.nullReferences.length, 1);
});

test("the next step names the tool that repairs it", async () => {
  const result = await auditDataTables(fakeBridge({ "/Game/D.D": ENEMY_TABLE }));
  assert.match(result.next, /unreal_set_data_table_row/);
  assert.match(result.next, /unreal_save_asset/);
});

test("list_assets is called with the parameters the bridge actually takes", async () => {
  // This test exists because the first version sent `classNames: ["DataTable"]`. The fake bridge
  // accepted it without complaint and a real editor answered "missing_param: className is required"
  // on the very first call. A mock that takes anything verifies nothing about the contract, so the
  // contract is pinned here explicitly.
  let seen = null;
  const bridge = {
    async send(cmd, params = {}) {
      if (cmd === "list_assets") {
        seen = params;
        if (typeof params.className !== "string") throw new Error("missing_param: className is required");
        return { assets: [] };
      }
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };

  await auditDataTables(bridge, { pathPrefix: "/Game/Data" });
  assert.equal(seen.className, "DataTable", "singular className, not classNames");
  assert.equal(seen.pathPrefix, "/Game/Data");
  assert.equal("classNames" in seen, false, "the plural form is not a parameter the bridge knows");
});
