import test from "node:test";
import assert from "node:assert/strict";

import { findInDataTables } from "../dist/findInDataTables.js";

/**
 * This tool exists because a whole substrate of the project was unsearchable.
 *
 *   unreal_search_project "Weapon_MachineGun"  ->  {hits: [], hitCount: 0}
 *
 * Weapon_MachineGun is a real row in this project's DT_Upgrades. search_project indexes Blueprint
 * names, parent classes, function names and variable names; row names and cell values are not in
 * that index, and it said so nowhere in the reply. check_data_tables walks every table but reports
 * PROBLEMS, not values.
 *
 * So "whether it's C++ or Blueprints or a Data Table" was untrue for the third of those, and it only
 * came out by trying to answer a change request - "the machine gun should cost 500 instead of 300" -
 * and finding nothing could locate the number.
 */

function fakeBridge(tables, opts = {}) {
  return {
    async send(cmd, params = {}) {
      if (cmd === "list_assets") return { assets: Object.keys(tables) };
      if (cmd === "list_data_table_rows") {
        const rows = tables[params.path];
        if (rows === undefined) throw new Error(`asset_not_found: ${params.path}`);
        if (rows.error) throw new Error(rows.error);
        return { path: params.path, rows };
      }
      throw new Error(`unknown_cmd: ${cmd}`);
    },
    ...opts,
  };
}

const UPGRADES = {
  "/Game/DT_Upgrades.DT_Upgrades": [
    { rowName: "Weapon_MachineGun", values: { Cost: 300, UpgradeClass: "None" } },
    { rowName: "Stat_BulletDamage", values: { Cost: 150, UpgradeClass: "/Game/BP_DamageUpgrade.BP_DamageUpgrade_C" } },
  ],
  "/Game/DT_Enemies.DT_Enemies": [{ rowName: "Grunt", values: { Health: 50 } }],
};

test("a row name that search_project cannot see is found here", async () => {
  const result = await findInDataTables(fakeBridge(UPGRADES), "MachineGun");
  assert.equal(result.hitCount, 1);
  assert.deepEqual(result.hits[0], {
    table: "/Game/DT_Upgrades.DT_Upgrades",
    rowName: "Weapon_MachineGun",
    field: "rowName",
  });
  assert.equal(result.tablesSearched, 2);
  assert.equal(result.rowsSearched, 3);
});

test("a cell value matches too, and says which field it was in", async () => {
  // "Where is BP_DamageUpgrade used?" is a Data Table question, and find_references answers it for
  // assets rather than for rows.
  const result = await findInDataTables(fakeBridge(UPGRADES), "BP_DamageUpgrade");
  assert.equal(result.hitCount, 1);
  assert.equal(result.hits[0].field, "UpgradeClass");
  assert.match(result.hits[0].value, /BP_DamageUpgrade/);
});

test("a number in a cell is searchable", async () => {
  // The motivating request was "the machine gun should cost 500 instead of 300", so the old value
  // is often the only thing the caller knows. Non-string cells are stringified for the match.
  const result = await findInDataTables(fakeBridge(UPGRADES), "300");
  assert.equal(result.hitCount, 1);
  assert.equal(result.hits[0].rowName, "Weapon_MachineGun");
  assert.equal(result.hits[0].field, "Cost");
});

test("matching is case-insensitive", async () => {
  assert.equal((await findInDataTables(fakeBridge(UPGRADES), "machinegun")).hitCount, 1);
  assert.equal((await findInDataTables(fakeBridge(UPGRADES), "MACHINEGUN")).hitCount, 1);
});

test("no match says what was searched, not just that there was nothing", async () => {
  // `{hits: [], hitCount: 0}` is what search_project answered, and it is the reply that sent this
  // whole investigation the wrong way: a caller cannot tell "not in this project" from "this tool
  // does not look there".
  const result = await findInDataTables(fakeBridge(UPGRADES), "zzz_nothing");
  assert.equal(result.hitCount, 0);
  assert.match(result.next, /every row name and every cell value/);
  assert.match(result.next, /unreal_search_project/, "and names where else to look");
  assert.match(result.next, /unreal_find_source/, "including C\\+\\+");
});

test("a table that could not be read is reported, not counted as clean", async () => {
  // "No hits" and "could not look" must be different answers. Every other check in this repo makes
  // that distinction and a new one must not quietly drop it.
  const bridge = fakeBridge({
    "/Game/DT_Upgrades.DT_Upgrades": UPGRADES["/Game/DT_Upgrades.DT_Upgrades"],
    "/Game/DT_Broken.DT_Broken": { error: "row_struct_missing" },
  });
  const result = await findInDataTables(bridge, "zzz_nothing");
  assert.equal(result.hitCount, 0);
  assert.equal(result.unreadable.length, 1);
  assert.match(result.next, /not a clean "not found"/);
});

test("a clean search carries no unreadable field at all", async () => {
  const result = await findInDataTables(fakeBridge(UPGRADES), "Grunt");
  assert.equal("unreadable" in result, false);
  assert.equal("truncated" in result, false);
});

test("one row yields one hit, however many of its fields match", async () => {
  // A row whose name and three cells all contain the query is still one place to go and look. Four
  // near-identical hits would be four lines saying the same thing.
  const bridge = fakeBridge({
    "/Game/DT_X.DT_X": [{ rowName: "Vacuum", values: { A: "Vacuum", B: "Vacuum", C: "Vacuum" } }],
  });
  const result = await findInDataTables(bridge, "Vacuum");
  assert.equal(result.hitCount, 1);
});

test("the cap is reported rather than silently applied", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ rowName: `Item_${i}`, values: {} }));
  const result = await findInDataTables(fakeBridge({ "/Game/DT_Many.DT_Many": many }), "Item", { maxResults: 5 });
  assert.equal(result.hitCount, 5);
  assert.equal(result.truncated, true);
  assert.match(result.next, /Stopped at 5 hits/);
  assert.equal(result.rowsSearched, 30, "the count of what was examined stays honest past the cap");
});

test("the rows themselves never come back", async () => {
  // Reading every table on the real project is 128 rows; the answer is WHERE the match is. A tool
  // that returned the rows would cost more than the read it saves.
  const result = await findInDataTables(fakeBridge(UPGRADES), "MachineGun");
  const text = JSON.stringify(result);
  assert.ok(!text.includes('"values"'), "no row payload rides along");
  assert.ok(text.length < 700, `the reply stays small: ${text.length} chars`);
});
