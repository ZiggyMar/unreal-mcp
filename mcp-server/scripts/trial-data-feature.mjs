#!/usr/bin/env node
// "Add a new upgrade type." Can this thing actually do that, from the sentence?
//
// The Blueprint half of that promise has a trial. The DATA half did not, and it is the half a
// designer lives in: a new option is an enum entry, a row in the table typed by a struct, and the
// two have to agree. Every piece existed and nothing checked that they compose.
//
// That mattered more than it sounds. Enums could be CREATED and never extended - add_struct_field
// could grow a struct, and the only way to add one enum entry was to recreate the enum and break
// every asset referring to it. The gap sat there through several sessions of work on the read side,
// because reading an enum worked perfectly and nothing ever tried to change one.
//
// So this walks the whole path on scratch assets: define the type, define the row shape, make the
// table, add the option, add a row that uses it, read it back, and check the value that comes out is
// the one that went in. Each step asserts what that step is FOR - a reply that merely arrives is not
// a working step.
//
// Usage: node scripts/trial-data-feature.mjs   (needs an editor open)
import { startAndInitialize } from "./lib/mcpStdio.mjs";
import { SCRATCH_ROOT } from "./lib/scratch.mjs";

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "data-feature");
const call = async (tool, args) => {
  const res = await server.request("tools/call", { name: "unreal_call_tool", arguments: { tool, args } });
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    return { ...JSON.parse(text), _isError: res?.result?.isError === true, _raw: text };
  } catch {
    return { _isError: true, _raw: text };
  }
};

const results = [];
const check = (label, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

// Unique per run: a trial that collides with its own leftovers reports a failure that is really
// yesterday's success.
const stamp = String(Date.now()).slice(-6);
const ENUM = `${SCRATCH_ROOT}/E_TrialUpgrade${stamp}`;
const STRUCT = `${SCRATCH_ROOT}/S_TrialUpgrade${stamp}`;
const TABLE = `${SCRATCH_ROOT}/DT_TrialUpgrade${stamp}`;
const created = [];

try {
  // 1. The type the designer is adding options to.
  const madeEnum = await call("unreal_create_enum", { packagePath: ENUM, entries: ["Damage", "Speed"] });
  check("an enum of upgrade types is created", madeEnum.entryCount === 2, madeEnum._raw.slice(0, 90));
  if (!madeEnum._isError) created.push(`${ENUM}.${ENUM.split("/").pop()}`);

  // 2. The row shape. The struct's field type has to NAME the enum, which is the join that makes
  //    this a composition test rather than three unrelated calls.
  const madeStruct = await call("unreal_create_struct", {
    packagePath: STRUCT,
    fields: [{ name: "Label", type: "text" }],
  });
  check("a row struct is created", !madeStruct._isError, madeStruct._raw.slice(0, 90));
  if (!madeStruct._isError) created.push(`${STRUCT}.${STRUCT.split("/").pop()}`);

  const enumName = ENUM.split("/").pop();
  const addedField = await call("unreal_add_struct_field", {
    path: STRUCT,
    name: "Kind",
    // The vocabulary the reader hands back and this tool accepts have to be the same one. They were
    // not, briefly, and that is why this asserts the join rather than the field count.
    type: `enum:${enumName}`,
  });
  check("the struct takes a field typed by that enum", !addedField._isError, addedField._raw.slice(0, 110));

  // 3. What a caller reads before writing a row. This is the step that was impossible to answer
  //    from the generic property reader, which returned an empty list.
  const fields = await call("unreal_list_struct_fields", { path: STRUCT });
  const fieldNames = (fields.fields ?? []).map((f) => f.name);
  check("the struct reports its columns", fieldNames.includes("Label") && fieldNames.includes("Kind"), fieldNames.join(", "));

  // 4. The new option. THIS is the call that did not exist.
  const added = await call("unreal_add_enum_entry", { path: ENUM, name: "Shield" });
  check("a new option is added to the existing enum", added.added === "Shield" && added.entryCount === 3, added._raw.slice(0, 110));

  const entries = await call("unreal_list_enum_entries", { path: ENUM });
  check(
    "and it reads back among the others",
    (entries.entries ?? []).map((e) => e.displayName ?? e.name).includes("Shield"),
    (entries.entries ?? []).map((e) => e.displayName ?? e.name).join(", ")
  );

  // 5. The table, and a row that uses the option added in step 4.
  const madeTable = await call("unreal_create_data_table", { packagePath: TABLE, rowStruct: STRUCT });
  check("a data table is created on that struct", !madeTable._isError, madeTable._raw.slice(0, 110));
  if (!madeTable._isError) created.push(`${TABLE}.${TABLE.split("/").pop()}`);

  const addedRow = await call("unreal_add_data_table_row", {
    path: TABLE,
    rowName: "ShieldUpgrade",
    values: { Label: "Shield Booster", Kind: "Shield" },
  });
  check("a row is added using the new option", !addedRow._isError, addedRow._raw.slice(0, 130));

  // 6. The only assertion that matters: what comes out is what went in. Every step above can
  //    "succeed" and still leave a row whose enum cell silently fell back to the first entry.
  const rows = await call("unreal_list_data_table_rows", { path: TABLE });
  const written = (rows.rows ?? []).find((r) => r.rowName === "ShieldUpgrade")?.values ?? {};
  check("the row reads back with the text that was written", written.Label === "Shield Booster", JSON.stringify(written));
  // The enum CELL specifically, by exact value. The first version of this asserted /Shield/ against
  // the whole row and passed on "Shield Booster" in the neighbouring field while the enum cell read
  // "NewEnumerator2" - a test that agreed with a bug because it matched the wrong string.
  check(
    "and the enum cell holds the name that was written, not its internal one",
    written.Kind === "Shield",
    `Kind = ${JSON.stringify(written.Kind)}`
  );
} finally {
  for (const path of created.reverse()) {
    await call("unreal_delete_asset", { path, force: true });
  }
  console.log(`cleaned up ${created.length} scratch asset(s)`);
  server.child.kill();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
