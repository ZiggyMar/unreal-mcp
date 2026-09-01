// The three things this project promises, run from the sentence a person would actually type.
//
//   "upgrades aren't showing up in the shop"           -> find the bug
//   "add a new shop upgrade that increases fire rate"  -> plan against what exists
//   "the machine gun should cost 500 instead of 300"   -> find the value and change it
//
// Each of these was verified by hand, once, in the session that built it. None of them was
// repeatable, which means the headline claims of this repo were resting on a measurement nobody
// could re-run - and the routing they depend on is a keyword table, the single most fragile thing
// here. A rename, a reordered entry, or a word dropped from a `says` list breaks a journey without
// breaking a unit test.
//
// It reports CALLS and TOKENS per journey as well as pass/fail, because "did it still work" and
// "did it get more expensive" are different regressions and only the first one throws.
//
// Journeys 1 and 2 are read-only against the real project. Journey 3 has to write, so it builds its
// own table in the scratch namespace and deletes it, rather than touching anything a person made.
import { startAndInitialize } from "./lib/mcpStdio.mjs";
import { sweepScratch, cleanUpScratch, SCRATCH_ROOT } from "./lib/scratch.mjs";

const stamp = String(Date.now()).slice(-6);
const failures = [];
const cleanup = [];

// The search profile, because that is what a session starting from a sentence actually holds.
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "trial-workflows");

let calls = 0;
let tokens = 0;

// Tool-list changes are counted separately from reply tokens, because they are a different KIND of
// cost and much the larger one.
//
// The advertised tool list sits ahead of the system prompt and every message, so switching a tool on
// invalidates the prompt cache for the whole conversation: the next request re-reads the entire
// history at full price instead of the cached rate. Reporting only reply tokens made
// unreal_enable_tools look free, and it is not - which is why unreal_call_tool exists.
//
// A journey with three enables pays that three times. This is the number to keep down.
let listChanges = 0;
let standingAfterEnables = 0;

const measureStanding = async () => {
  const listed = await server.request("tools/list", {});
  return Math.round(JSON.stringify(listed?.result?.tools ?? []).length / 4);
};

const call = async (name, args) => {
  const reply = await server.request("tools/call", { name, arguments: args });
  const body = (reply.result ?? reply).content[0].text;
  calls += 1;
  tokens += Math.round(body.length / 4);
  if ((reply.result ?? reply).isError) throw new Error(body.slice(0, 200));
  const parsed = JSON.parse(body);
  // Only an enable that actually switched something on moves the list. Re-enabling what is already
  // on is a no-op, and counting it would overstate the cost.
  if (name === "unreal_enable_tools" && (parsed.newlyEnabled ?? []).length > 0) {
    listChanges += 1;
    standingAfterEnables = await measureStanding();
  }
  return parsed;
};

const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/** Standing cost of the profile, which is paid before any of this and on every request after it. */
const listed = await server.request("tools/list", {});
const standing = Math.round(JSON.stringify((listed.result ?? listed).tools).length / 4);

/** Only the journeys count toward the headline. The sweep and the teardown are this trial's own. */
const journeyTotals = { calls: 0, tokens: 0 };

const journey = async (title, sentence, run) => {
  const before = { calls, tokens };
  console.log("");
  console.log(`${title}: "${sentence}"`);
  try {
    await run();
  } catch (err) {
    check(title, false, String(err.message).slice(0, 140));
  }
  const used = { calls: calls - before.calls, tokens: tokens - before.tokens };
  journeyTotals.calls += used.calls;
  journeyTotals.tokens += used.tokens;
  console.log(`        ${used.calls} calls, ~${used.tokens} tokens`);
  return used;
};

try {
  // Same reason, at the other end: the sweep runs before any journey has enabled anything.
  await server
    .request("tools/call", {
      name: "unreal_enable_tools",
      arguments: { tools: ["unreal_list_assets", "unreal_delete_asset"] },
    })
    .catch(() => {});

  await sweepScratch({
    list: async () => {
      // className is REQUIRED, and "Object" is how you ask for everything - this trial leaves a Data
      // Table and a struct behind when it fails, so a sweep that only knew about Blueprints would
      // miss them.
      //
      // The first version omitted className entirely and wrapped the whole sweep in `.catch(() => {})`.
      // list_assets rejected the call, the catch ate it, the sweep silently did nothing, and journey
      // 3 then found a leftover table from the previous run, wrote the new value into THAT, and
      // verified the table it had just created - two different tables, reported as a failure whose
      // cause was nowhere in the output. A bare catch over a setup step, in a file written to catch
      // exactly this kind of thing.
      const assets = await call("unreal_list_assets", { className: "Object", pathPrefix: SCRATCH_ROOT, maxResults: 300 });
      return (assets.assets ?? []).map((a) => (typeof a === "string" ? a : a.path));
    },
    remove: (path) => call("unreal_delete_asset", { path, force: true }),
  });

  // ---------------------------------------------------------------------------------------------
  await journey("1 a bug in plain language", "upgrades aren't showing up in the shop", async () => {
    // The entry point a session on `search` actually has. `match` is a substring search over tool
    // NAMES, so every word of this sentence returns nothing and the symptom index is what answers.
    const found = await call("unreal_list_tools", { match: "upgrades aren't showing up in the shop" });
    const suggested = (found.suggested ?? []).map((t) => t.name);
    check("the sentence reaches a tool", suggested.length > 0, suggested.join(", ") || "nothing");
    check("it is read as a bug, not a build", found.intent === "broken", `intent: ${found.intent}`);
    check(
      "the data table check leads",
      suggested[0] === "unreal_check_data_tables",
      `led with ${suggested[0] ?? "nothing"}`
    );

    const groups = [...new Set((found.suggested ?? []).map((t) => t.group))];
    await call("unreal_enable_tools", { groups });

    const tables = await call("unreal_check_data_tables", {});
    // The real bug in this project: two rows of DT_Upgrades have a null UpgradeClass, so those
    // upgrades cannot appear. If someone fixes them the count goes to zero, which is not a failure
    // of the journey - so this asserts the tool answered, not what the answer was.
    check("it returns a verdict on the project's tables", typeof tables.verdict === "string", `verdict: ${tables.verdict}`);
    check(
      "and the advice does not tell you to copy the example",
      tables.nullReferences?.length > 0 ? /not the answer for this row/.test(tables.next ?? "") : true,
      tables.nullReferences?.length > 0 ? `${tables.nullReferences.length} null reference(s)` : "no nulls to advise on"
    );
  });

  // ---------------------------------------------------------------------------------------------
  await journey("2 a feature request", "add a new shop upgrade that increases fire rate", async () => {
    const found = await call("unreal_list_tools", { match: "add a new shop upgrade that increases fire rate" });
    check("it is read as something to build", found.intent === "building", `intent: ${found.intent}`);
    const suggested = (found.suggested ?? []).map((t) => t.name);
    check("planning leads", suggested[0] === "unreal_plan_feature", `led with ${suggested[0] ?? "nothing"}`);

    await call("unreal_enable_tools", { groups: [...new Set((found.suggested ?? []).map((t) => t.group))] });

    const plan = await call("unreal_plan_feature", { request: "add a new shop upgrade that increases fire rate" });
    check(
      "the concepts are nouns, not verbs",
      !(plan.conceptsExamined ?? []).some((c) => /^increas/.test(c)),
      (plan.conceptsExamined ?? []).join(", ")
    );
    check(
      "it found the shop system that already exists",
      (plan.existingSystems ?? []).some((sys) => sys.concept === "shop" || sys.concept === "upgrade"),
      (plan.existingSystems ?? []).map((sys) => sys.concept).join(", ")
    );
    check(
      "and says to extend rather than duplicate",
      (plan.raiseWithUser ?? []).some((line) => /already exists/.test(line)),
      `${(plan.raiseWithUser ?? []).length} thing(s) to raise`
    );
  });

  // ---------------------------------------------------------------------------------------------
  await journey("3 a change request", "the machine gun should cost 500 instead of 300", async () => {
    const found = await call("unreal_list_tools", { match: "the machine gun should cost 500 instead of 300" });
    check("it is read as a change, not a build", found.intent === "changing", `intent: ${found.intent}`);
    const suggested = (found.suggested ?? []).map((t) => t.name);
    check(
      "the Data Table search is offered",
      suggested.includes("unreal_find_in_data_tables"),
      suggested.join(", ") || "nothing"
    );
    check(
      "and so is the C++ search, because the value could be there",
      suggested.includes("unreal_find_source"),
      suggested.join(", ")
    );

    await call("unreal_enable_tools", { groups: ["data", "core"] });

    // Its own table, so the journey is real without editing anything a person made.
    const struct = `${SCRATCH_ROOT}/S_Flow${stamp}`;
    const table = `${SCRATCH_ROOT}/DT_Flow${stamp}`;
    await call("unreal_create_struct", { packagePath: struct, fields: [{ name: "Cost", type: "int" }] });
    cleanup.push(struct);
    await call("unreal_create_data_table", { packagePath: table, rowStruct: struct });
    cleanup.push(table);
    // A number, not "300" - the shape a caller naturally sends.
    await call("unreal_add_data_table_row", { path: table, rowName: "Weapon_MachineGun", values: { Cost: 300 } });

    const hits = await call("unreal_find_in_data_tables", { query: "MachineGun", pathPrefix: SCRATCH_ROOT });
    const hit = (hits.hits ?? [])[0];
    check("the value is found without knowing which table holds it", Boolean(hit), hit ? `${hit.rowName} in ${hit.table.split("/").pop()}` : "no hit");

    if (hit) {
      // hit.table and hit.rowName verbatim into the writer. The join is the point.
      await call("unreal_set_data_table_row", { path: hit.table, rowName: hit.rowName, values: { Cost: 500 } });
      // Read back the table the SEARCH named, not the one this trial happened to create. They are
      // the same table when the scratch namespace is clean and different when it is not, and
      // verifying the wrong one is how the first version of this reported a pass it had not earned.
      const after = await call("unreal_list_data_table_rows", { path: hit.table });
      const cost = (after.rows ?? [])[0]?.values?.Cost;
      check("the change lands and reads back", String(cost) === "500", `Cost is now ${JSON.stringify(cost)}`);
    }
  });
} finally {
  // Teardown needs tools the journeys deliberately did not enable.
  //
  // The first run of this trial left two assets behind and said so - "Tool unreal_delete_asset
  // disabled" - because the journeys start on `search` and only turn on what they actually need. The
  // fix is not to enable everything up front, which would quietly make journey 1 and 2 dishonest
  // about what a bare session can reach; it is to enable the teardown tools at teardown, which is
  // not part of any journey.
  await server
    .request("tools/call", {
      name: "unreal_enable_tools",
      arguments: { tools: ["unreal_delete_asset", "unreal_list_assets"] },
    })
    .catch(() => {});

  if (cleanup.length > 0) {
    await cleanUpScratch(
      cleanup,
      (path) => call("unreal_delete_asset", { path, force: true }),
      console.log,
      (paths) => call("unreal_delete_asset", { paths, force: true })
    ).catch(() => {});
  }
  server.child.kill();

  console.log("");
  console.log(`standing context on the \`search\` profile: ~${standing} tokens, paid on every request`);
  // Journeys only. The first version reported `calls` and `tokens`, which also counted the scratch
  // sweep and the teardown - so the headline moved with how much residue happened to be lying around,
  // which is the opposite of a number you can compare between runs.
  console.log(`all three journeys: ${journeyTotals.calls} calls, ~${journeyTotals.tokens} tokens of replies`);
  console.log(
    `tool-list changes: ${listChanges}` +
      (listChanges > 0
        ? ` (standing ended at ~${standingAfterEnables} tokens; each change re-reads the whole ` +
          `conversation at full price, so this is the cost that dwarfs the replies above)`
        : " (nothing switched on - every call went through unreal_call_tool or was already enabled)")
  );
  console.log(`(setup and teardown, not part of any journey: ${calls - journeyTotals.calls} calls)`);
  console.log("");
  console.log(
    failures.length === 0
      ? "workflow trial ok: a bug, a feature and a change each got from a sentence to the right tool"
      : `WORKFLOW TRIAL FAILED: ${failures.length} step(s) - ${failures.join("; ")}`
  );
  if (failures.length > 0) process.exitCode = 1;
}
