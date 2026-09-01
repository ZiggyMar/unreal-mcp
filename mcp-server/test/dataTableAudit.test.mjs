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

test("rows that could not be judged make the verdict partial, not clean", async () => {
  // "clean" reads as a guarantee. A column empty in every row of a table gives nothing to compare
  // against - there is no filled row to show whether it should hold an asset reference - so those
  // rows were not checked, they were skipped. The undecidable list was always in the reply; the word
  // on the front of it did not admit them.
  const result = await auditDataTables(
    fakeBridge({
      "/Game/DT_Thing.DT_Thing": [
        { rowName: "A", values: { Icon: "None" } },
        { rowName: "B", values: { Icon: "None" } },
      ],
    })
  );
  assert.equal(result.nullReferences.length, 0, "nothing is provably wrong");
  assert.ok(result.undecidable.length > 0, "but nothing was provably right either");
  assert.equal(result.verdict, "partial");
});

test("the audit never asks for the shortened rows, because empty IS the default", async () => {
  // The regression this guards is subtle and total. list_data_table_rows now defaults to omitting
  // fields still at the row struct's default, which is most of a real reply. An EMPTY asset
  // reference is exactly that default - so under the shortened form it vanishes, and the one finding
  // this whole module exists to produce vanishes with it.
  //
  // The read tool asks for the short form. The audit must not, and must not start to by accident.
  const asked = [];
  const inner = fakeBridge({ "/Game/D.D": ENEMY_TABLE });
  const bridge = {
    async send(cmd, params) {
      if (cmd === "list_data_table_rows") asked.push(params);
      return inner.send(cmd, params);
    },
  };
  const result = await auditDataTables(bridge, { paths: ["/Game/D.D"] });
  assert.ok(asked.length > 0, "the audit does read rows");
  for (const params of asked) {
    assert.notEqual(params.omitDefaults, true, "asking for the delta would hide every empty reference");
  }
  assert.equal(result.nullReferences.length, 1, "and the finding still comes out");
});

test("the advice warns against the obvious wrong fix, not just the missing value", async () => {
  // exampleValue is carried so a caller can see the SHAPE a correct value takes, taken from a filled
  // sibling row. Copying it is a different thing entirely, and it is the obvious next move.
  //
  // On the real project the example offered for row "Weapon_MachineGun" is BP_BulletSize, taken from
  // "Survival_MobileAgent". Paste that in and the machine gun grants a bullet-size upgrade: the
  // table then passes every check in this file and the game is quietly wrong - a worse outcome than
  // the null it replaced, because nothing will ever flag it again.
  //
  // The two rows flagged on the real project name upgrades that exist as no Blueprint anywhere, so
  // "this was never built" is a real answer and the advice has to leave room for it.
  const result = await auditDataTables(
    fakeBridge({
      "/Game/DT_Upgrades.DT_Upgrades": [
        { rowName: "Weapon_MachineGun", values: { UpgradeClass: "None" } },
        { rowName: "Stat_BulletSize", values: { UpgradeClass: "/Game/BP_BulletSize.BP_BulletSize_C" } },
      ],
    })
  );
  assert.equal(result.nullReferences.length, 1, "the fixture has to produce a finding or this proves nothing");
  assert.match(result.next, /not the answer for this row/, "the example is named as a shape, not an answer");
  assert.match(result.next, /never built/, "and 'no such asset exists yet' is offered as a real finding");
});

test("a clean table pays nothing for that warning", async () => {
  // Advice attached to a good result is a standing token cost for a situation that is not happening.
  const result = await auditDataTables(
    fakeBridge({
      "/Game/DT_Fine.DT_Fine": [
        { rowName: "A", values: { UpgradeClass: "/Game/BP_One.BP_One_C" } },
        { rowName: "B", values: { UpgradeClass: "/Game/BP_Two.BP_Two_C" } },
      ],
    })
  );
  assert.equal(result.nullReferences.length, 0);
  assert.ok(!/not the answer for this row/.test(result.next), "the clean reply does not carry the warning");
});

test("two rows sharing a class reference are reported; two sharing an icon are not", async () => {
  // Found on a real project: DT_Upgrades has nine rows whose UpgradeClass is a distinct Blueprint
  // each, except "Survival_MobileAgent", which points at BP_BulletSize_C - the same class as
  // "Stat_BulletSize". Nothing was null and nothing was broken; one row simply did another's job,
  // so every existing check walked past it.
  //
  // The same run also flagged two health upgrades sharing a heart icon, which is what icons are for.
  // A shared CLASS means two rows behave identically while claiming to differ; a shared texture
  // means they look alike. Only the first is a defect.
  const rows = [
    { rowName: "Stat_BulletSize", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/Game/U/BP_BulletSize.BP_BulletSize_C'", Icon: "/Script/Engine.Texture2D'/Game/T/heart.heart'" } },
    { rowName: "Survival_MobileAgent", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/Game/U/BP_BulletSize.BP_BulletSize_C'", Icon: "/Script/Engine.Texture2D'/Game/T/heart.heart'" } },
    { rowName: "Stat_HealthNum", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/Game/U/BP_Health.BP_Health_C'", Icon: "/Script/Engine.Texture2D'/Game/T/a.a'" } },
    { rowName: "Stat_HealSpeed", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/Game/U/BP_Heal.BP_Heal_C'", Icon: "/Script/Engine.Texture2D'/Game/T/b.b'" } },
    { rowName: "Stat_VacuumPush", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/Game/U/BP_Push.BP_Push_C'", Icon: "/Script/Engine.Texture2D'/Game/T/c.c'" } },
  ];

  const result = await auditDataTables(
    {
      send: async (cmd) =>
        cmd === "list_assets"
          ? { assets: [{ path: "/Game/DT_Upgrades.DT_Upgrades" }] }
          : { rows },
    },
    {}
  );

  assert.equal(result.duplicateReferences.length, 1, "the class duplicate, and only that");
  assert.equal(result.duplicateReferences[0].field, "UpgradeClass");
  assert.deepEqual(result.duplicateReferences[0].rows.sort(), ["Stat_BulletSize", "Survival_MobileAgent"]);
});

test("a column where sharing is the norm is left alone", async () => {
  // Twenty rows pointing at three classes is a design - a tier system, a category - not twenty
  // mistakes. The check only speaks where one-asset-per-row is plainly the intent.
  const rows = Array.from({ length: 12 }, (_, i) => ({
    rowName: `Row${i}`,
    values: { UpgradeClass: `/Script/Engine.BlueprintGeneratedClass'/Game/U/BP_${i % 3}.BP_${i % 3}_C'` },
  }));

  const result = await auditDataTables(
    {
      send: async (cmd) =>
        cmd === "list_assets" ? { assets: [{ path: "/Game/DT.DT" }] } : { rows },
    },
    {}
  );

  assert.deepEqual(result.duplicateReferences, []);
});
