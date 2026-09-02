import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

import { FINDING_COST } from "../dist/findingCost.js";
import { auditProject,
} from "../dist/audit.js";

/**
 * A project of two Blueprints: one with a stray node and a leftover print, one clean.
 *
 * Built from the same shapes the bridge returns, so the test exercises the real path rather than a
 * convenient one.
 */
function fakeBridge(overrides = {}) {
  const graphs = {
    "/Game/BP_Messy.BP_Messy": {
      EventGraph: [
        {
          id: "e",
          type: "K2Node_Event",
          title: "Event BeginPlay",
          connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "p", pin: "execute" }] }],
        },
        {
          id: "p",
          type: "K2Node_CallFunction",
          title: "Print String",
          connectedPins: [{ pin: "execute", direction: "in", linkedTo: [{ node: "e", pin: "then" }] }],
        },
        { id: "orphan", type: "K2Node_CallFunction", title: "Get Actor Location", connectedPins: [] },
      ],
    },
    "/Game/BP_Clean.BP_Clean": {
      EventGraph: [
        {
          id: "e",
          type: "K2Node_Event",
          title: "Event BeginPlay",
          connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "s", pin: "execute" }] }],
        },
        {
          id: "s",
          type: "K2Node_VariableSet",
          title: "SET Health",
          connectedPins: [{ pin: "execute", direction: "in", linkedTo: [{ node: "e", pin: "then" }] }],
        },
      ],
    },
  };

  return {
    calls: [],
    async send(cmd, params) {
      this.calls.push(cmd);
      if (overrides[cmd]) return overrides[cmd](params);
      switch (cmd) {
        case "list_blueprints":
          return {
            blueprints: [
              { name: "BP_Messy", path: "/Game/BP_Messy.BP_Messy" },
              { name: "BP_Clean", path: "/Game/BP_Clean.BP_Clean" },
            ],
          };
        case "list_blueprint_graphs":
          return { graphs: Object.keys(graphs[params.path] ?? {}).map((name) => ({ name })) };
        case "read_blueprint_graph_summary":
          return { graphName: params.graphName, nodes: graphs[params.path]?.[params.graphName] ?? [] };
        case "list_variables":
          return { parentClass: "Actor", variables: [] };
        case "describe_class":
          return { serverOnly: false, ancestry: ["Actor"] };
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
  };
}

test("findings are grouped and ranked by cost, not by count", () => {
  // A dead event is cosmetic until somebody wires it; a cast that fails on every client but the
  // host is a bug nobody can reproduce alone. Sorting by how many there are would bury the second.
  assert.ok(FINDING_COST["cast-to-server-only-class"] > FINDING_COST["unlabelled-sections"]);
  assert.ok(FINDING_COST["server-writes-unreplicated"] > FINDING_COST["dead-node"]);
});

test("a project audit reports the messy Blueprint and not the clean one", async () => {
  const result = await auditProject(fakeBridge());
  assert.equal(result.blueprintsScanned, 2);
  assert.ok(result.findingCount > 0);
  const worst = result.worstBlueprints.map((b) => b.name);
  assert.ok(worst.includes("BP_Messy"), `expected BP_Messy in ${worst.join(", ")}`);
});

test("groups come back sorted by cost, most expensive first", async () => {
  const result = await auditProject(fakeBridge());
  for (let i = 1; i < result.groups.length; i += 1) {
    assert.ok(
      result.groups[i - 1].cost >= result.groups[i].cost,
      `group ${i} (${result.groups[i].check}) outranks the one before it`
    );
  }
});

test("the reply is a summary, not every finding", async () => {
  // The whole point of running this against a real project is that the answer stays small. A
  // ranked list of eight hundred findings is the same as no list.
  const result = await auditProject(fakeBridge(), { examplesPerGroup: 2 });
  for (const group of result.groups) {
    assert.ok(group.examples.length <= 2, `${group.check} returned ${group.examples.length} examples`);
  }
});

test("one unreadable Blueprint does not cost the caller the audit", async () => {
  const bridge = fakeBridge({
    list_blueprint_graphs: (params) => {
      if (params.path.includes("BP_Messy")) throw new Error("asset_locked");
      return { graphs: [{ name: "EventGraph" }] };
    },
  });
  const result = await auditProject(bridge);
  assert.equal(result.unreadable.length, 1);
  assert.equal(result.unreadable[0].name, "BP_Messy");
  // ...and the other one was still audited.
  assert.equal(result.blueprintsScanned, 2);
});

test("the limit is honoured and truncation is reported", async () => {
  const result = await auditProject(fakeBridge(), { limit: 1 });
  assert.equal(result.blueprintsScanned, 1);
  assert.equal(result.truncated, true, "a caller must be told the sweep did not cover everything");
});

test("nextAction names the highest-cost group and how to fix it", async () => {
  const result = await auditProject(fakeBridge());
  assert.ok(result.nextAction.length > 0);
  if (result.groups.length > 0) {
    assert.match(result.nextAction, new RegExp(result.groups[0].check));
  }
});

test("an empty project says so rather than inventing work", async () => {
  const bridge = fakeBridge({ list_blueprints: () => ({ blueprints: [] }) });
  const result = await auditProject(bridge);
  assert.equal(result.findingCount, 0);
  assert.equal(result.truncated, false);
  assert.match(result.nextAction, /Nothing found|matched nothing/i);
});

test("the audit looks at Data Tables too, and leads with a null reference", async () => {
  // "My game has bugs, where do I look" is the question this tool answers, and the most expensive
  // bug it has seen was not in a graph: a row's class reference cleared to None. An audit that reads
  // only Blueprints looks straight past it, which is exactly what happened.
  const bridge = {
    async send(cmd, params = {}) {
      if (cmd === "list_blueprints") return { blueprints: [] };
      if (cmd === "list_assets") return { assets: ["/Game/Data/DT_Enemies.DT_Enemies"] };
      if (cmd === "list_data_table_rows") {
        return {
          rows: [
            { rowName: "ILY", values: { EnemyType: "/Game/E/BP_Basic.BP_Basic_C", Ratio: "6" } },
            { rowName: "Fly", values: { EnemyType: "None", Ratio: "1" } },
          ],
        };
      }
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTableNulls.length, 1);
  assert.equal(r.dataTableNulls[0].rowName, "Fly");
  assert.equal(r.dataTableNulls[0].field, "EnemyType");
  assert.match(r.nextAction, /Data Table reference/);
  assert.match(r.nextAction, /unreal_set_data_table_row/);
});

test("a bridge that cannot read Data Tables still returns the Blueprint half", async () => {
  // An older plugin has no list_data_table_rows. Losing the whole audit over the half it cannot do
  // would make upgrading the server before the plugin actively worse than not upgrading.
  const bridge = {
    async send(cmd) {
      if (cmd === "list_blueprints") return { blueprints: [] };
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };
  const r = await auditProject(bridge, {});
  assert.deepEqual(r.dataTableNulls, []);
  assert.equal(typeof r.nextAction, "string");
});

test("an empty asset pin carries its node id into the finding", async () => {
  // "PlaySoundAtLocation runs with its Sound pin empty" is a search across the graph; the same
  // sentence with a node id is an edit. The bridge sends one, so the audit must not drop it.
  const bridge = fakeBridge({
    find_broken_names: () => ({
      namesChecked: 4,
      namesFromVariables: 0,
      broken: [
        {
          blueprint: "BP_Messy",
          graph: "EventGraph",
          check: "asset-pin-empty",
          nodeId: "a1b2c3d4",
          message: "PlaySoundAtLocation runs with its Sound pin empty, so no sound plays.",
          fix: "Set the Sound pin, or wire it.",
        },
      ],
    }),
  });
  const result = await auditProject(bridge);
  const group = result.groups.find((g) => g.check === "asset-pin-empty");
  assert.ok(group, `expected an asset-pin-empty group in ${result.groups.map((g) => g.check).join(", ")}`);
  assert.match(group.examples[0].message, /node a1b2c3d4/);
});

test("a check with no node id still reads as a sentence", async () => {
  const bridge = fakeBridge({
    find_broken_names: () => ({
      namesChecked: 1,
      namesFromVariables: 0,
      broken: [
        {
          blueprint: "BP_Messy",
          graph: "EventGraph",
          check: "timer-target-missing",
          message: "starts a timer on \"Tik\", which BP_Messy has no function by.",
          fix: "Check the spelling.",
        },
      ],
    }),
  });
  const result = await auditProject(bridge);
  const group = result.groups.find((g) => g.check === "timer-target-missing");
  assert.ok(group);
  assert.doesNotMatch(group.examples[0].message, /node undefined/);
});

test("an empty asset pin outranks cosmetic findings", () => {
  // It compiles, it runs, it reports success, and the effect never happens. That belongs above a
  // stray node every time.
  assert.ok(FINDING_COST["asset-pin-empty"] > FINDING_COST["dead-node"]);
});

test("check: returns one finding kind in full, wherever it ranks", async () => {
  // The natural next move after an audit is "tell me more about that one", and the only lever was
  // detailedGroups, which is positional: to see the 13th kind you asked for the first thirteen.
  // Measured on the real project, that was 2,350 tokens to 4,352. Naming the check is 2,137 -
  // cheaper than the plain audit, because everything else drops to a count.
  const bridge = fakeBridge({
    find_broken_names: () => ({
      namesChecked: 2,
      namesFromVariables: 0,
      broken: [
        { blueprint: "BP_Messy", graph: "EventGraph", check: "timer-target-missing", message: "a", fix: "f" },
        { blueprint: "BP_Clean", graph: "EventGraph", check: "timer-target-missing", message: "b", fix: "f" },
      ],
    }),
  });
  const result = await auditProject(bridge, { check: "timer-target-missing" });

  const named = result.groups.find((g) => g.check === "timer-target-missing");
  assert.ok(named, "the named check must come back");
  assert.ok(!named.detailElided, "and it must be detailed, whatever its rank");
  assert.equal(named.examples.length, 2);

  for (const group of result.groups) {
    if (group.check === "timer-target-missing") continue;
    assert.equal(group.examples.length, 0, `${group.check} should be counted only`);
  }
});

test("check: names the kinds that exist when it matches none", async () => {
  // A check name is exactly as unguessable as a pin name or a parameter name, and this is the same
  // answer given for both: refuse, and say what does exist. Silently returning a summary with every
  // group elided looks identical to "your check is real and found nothing", which is a different
  // answer entirely.
  const result = await auditProject(fakeBridge(), { check: "repnotify" });
  assert.match(result.checkNotFound, /No finding kind called "repnotify"/);
  assert.match(result.checkNotFound, /This run found: /);
  for (const group of result.groups) {
    assert.equal(group.examples.length, 0, "nothing is detailed when the name matched nothing");
  }
});

test("no check named means the old positional behaviour, unchanged", async () => {
  const result = await auditProject(fakeBridge(), { detailedGroups: 2 });
  assert.equal(result.checkNotFound, undefined);
  const detailed = result.groups.filter((g) => !g.detailElided);
  assert.ok(detailed.length <= 2, `expected at most 2 detailed groups, got ${detailed.length}`);
});

test("every check a module emits has a price, because the fallback is silent", () => {
  // FINDING_COST[check] ?? 1 is the whole failure mode. A check name that is never added here, or
  // that drifts from the one a module emits, scores 1 and sinks under every cosmetic finding in the
  // audit - and nothing anywhere says so. The ranking is the entire product of this tool.
  //
  // Found by mutation testing rather than by reading: renaming "repnotify-does-nothing" broke no
  // test, which meant nothing tied that name to its price. Checking the class instead of the
  // instance then turned up "level-sweep-repeated", emitted by quality.ts and priced nowhere.
  const src = readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"));
  const emitted = new Set();
  for (const file of src) {
    const text = readFileSync(join(SRC_DIR, file), "utf8");
    for (const m of text.matchAll(/check:\s*"([a-z0-9-]+)"/g)) emitted.add(m[1]);
  }
  assert.ok(emitted.size > 20, `expected to find the check names; found ${emitted.size}`);
  const unpriced = [...emitted].filter((name) => FINDING_COST[name] === undefined);
  assert.deepEqual(unpriced, [], `emitted but unpriced, so they score 1 and sink: ${unpriced.join(", ")}`);
});

test("a check that could not run is reported, not silently dropped", async () => {
  // Three whole checks sit behind bridge commands an older plugin may not have - animation, Niagara,
  // and the broken-name sweep - and each catch said so in a code comment and nothing else. The reply
  // then read as a complete audit that happened to find no animation bugs, which is the same
  // sentence as "I could not look at animation".
  //
  // It matters most exactly when it is most likely: the plugin inside a running editor is routinely
  // older than this server.
  const bridge = {
    async send(cmd) {
      if (cmd === "list_blueprints") return { blueprints: [] };
      if (cmd === "read_anim_blueprint" || cmd === "read_niagara_system" || cmd === "find_broken_names") {
        throw new Error(`unknown_cmd: ${cmd}`);
      }
      return {};
    },
  };
  const result = await auditProject(bridge, {});
  const skipped = result.checksSkipped.map((c) => c.name);
  assert.ok(skipped.length > 0, `something should have been recorded as skipped, got ${JSON.stringify(result.checksSkipped)}`);
  assert.match(result.checksSkippedNote ?? "", /not a complete audit/);
  // The reason has to say what to do about it, not just what failed.
  for (const entry of result.checksSkipped) {
    assert.match(entry.why, /older than this server|unknown_cmd/, entry.name);
  }
});

test("a complete audit pays nothing for the skipped-check machinery", async () => {
  // The note is absent when nothing was skipped. A field that says "0 checks skipped" on every
  // successful run is a token cost for a fact the reader can already see.
  const bridge = { async send(cmd) { return cmd === "list_blueprints" ? { blueprints: [] } : {}; } };
  const result = await auditProject(bridge, {});
  assert.deepEqual(result.checksSkipped, []);
  assert.equal(result.checksSkippedNote, undefined);
});

test("a missing command is one skipped check, not one unreadable asset per file", async () => {
  // Both the animation and Niagara sweeps read one asset at a time inside a per-asset try, so a
  // plugin without the command produced an "unreadable: unknown_cmd" row for EVERY asset - sixty-two
  // of them on the real project. That reads as sixty-two corrupt assets rather than one command this
  // editor does not have, and it kept asking, sixty-two times, for an answer that could not change.
  let attempts = 0;
  const bridge = {
    async send(cmd, params) {
      if (cmd === "list_blueprints") return { blueprints: [] };
      if (cmd === "list_assets") {
        return params.className === "Niagara" || params.className === "NiagaraSystem"
          ? { assets: [1, 2, 3, 4, 5].map((n) => ({ name: `NS_${n}`, path: `/Game/NS_${n}.NS_${n}` })) }
          : { assets: [] };
      }
      if (cmd === "read_niagara_system") {
        attempts++;
        throw new Error("unknown_cmd: read_niagara_system");
      }
      return {};
    },
  };
  const result = await auditProject(bridge, {});
  assert.equal(attempts, 1, "it must stop after the first unknown_cmd, not retry per asset");
  assert.deepEqual(result.checksSkipped.map((c) => c.name), ["niagara"]);
  assert.equal(result.unreadable.length, 0, "a missing command is not an unreadable asset");
});


test("a class the engine could not resolve is reported, not counted as clean", () => {
  // The bare `catch {}` recorded serverOnly=false and widgetClass=false for a class that failed to
  // resolve, then said nothing. "Checked, not server-only" and "could not look" produced identical
  // output. cast-to-server-only-class is the most expensive check in the table and can never fire
  // for a class nothing is known about.
  //
  // The values still default to false - reporting a finding about an unknown class would be a guess
  // dressed as a result. What changed is that the audit now says which classes those were, in the
  // same spirit as checksSkipped: a check that could not look must not read as one that found
  // nothing.
  const source = readFileSync(join(SRC_DIR, "audit.ts"), "utf8");
  assert.match(source, /unresolvedClasses\.add\(className\)/, "the failure is recorded rather than swallowed");
  assert.match(source, /classesNotResolvedNote/, "and surfaced in the reply");
  assert.match(
    source,
    /not because they are clean/,
    "and the note says what the absence of findings about them actually means"
  );
});

test("the project audit reports Blueprint-level findings, not only graph ones", async () => {
  // These were computed for every Blueprint and thrown away, because the audit loop only read
  // `graphs`. So review_blueprint on ONE asset reported replication bugs and audit_project across
  // all of them reported none - and replication is the most expensive class of bug in the set.
  // A whole-project audit that silently omits a whole family is worse than one that omits nothing,
  // because the silence reads as "clean".
  const bridge = fakeBridge({
    list_variables: (params) =>
      params.path === "/Game/BP_Messy.BP_Messy"
        ? {
            parentClass: "Actor",
            variables: [
              { name: "PlayerName", type: "Text", replicated: true, repNotify: "OnRep_PlayerName" },
            ],
          }
        : { parentClass: "Actor", variables: [] },
    // The handler exists as a graph and holds only its entry node: on the canvas, wired to nothing.
    list_blueprint_graphs: (params) =>
      params.path === "/Game/BP_Messy.BP_Messy"
        ? { graphs: [{ name: "EventGraph" }, { name: "OnRep_PlayerName" }] }
        : { graphs: [{ name: "EventGraph" }] },
  });

  const result = await auditProject(bridge, {});
  const group = (result.groups ?? []).find((g) => g.check === "repnotify-does-nothing");
  assert.ok(
    group,
    `expected the RepNotify finding in the project audit, got: ${(result.groups ?? []).map((g) => g.check).join(", ") || "(nothing)"}`
  );
  assert.equal(group.examples[0].blueprint, "BP_Messy");
  // Filed under "(whole asset)" rather than an arbitrary graph, because it is not about a graph.
  // It read "variables" until the two loops producing these findings were found to be duplicates of
  // each other; the surviving one uses this label and also carries `observed`.
  assert.equal(group.examples[0].graph, "(whole asset)");

  // Once, not twice - the property the duplicate loops broke and nothing asserted.
  //
  // Two loops walked review.blueprint a few hundred lines apart, filing the same finding under two
  // different labels, so every Blueprint-level finding was double-counted: the group totals, the
  // per-Blueprint costs, and the worstBlueprints ranking built from them. On a real project
  // BP_Player reported eight server-writes-unreplicated findings where the check itself produces
  // four. Nothing here noticed, because both copies were present and the assertion only read [0].
  console.log("DEBUG group:", JSON.stringify(group).slice(0, 700));
  assert.equal(group.count, 1, "a Blueprint-level finding must be counted once");
  assert.equal(group.examples.length, 1, "and appear once in the examples");
});

test("a duplicate class reference reaches nextAction, not just the payload", async () => {
  // It was found and never ranked. The check exists and had already caught the real one on this
  // project - Survival_MobileAgent and Stat_BulletSize both pointing at BP_BulletSize, so buying
  // the movement upgrade applies the bullet-size one - and the result sat in
  // dataTableDuplicateClasses where nothing pointed at it. nextAction named only the nulls.
  //
  // Six filled rows so the check's own gates pass: it needs 4+ filled and 70% distinct values
  // before it will call a repeat suspicious, because two rows sharing an icon is what icons are for.
  const rows = [
    { rowName: "Move", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_Size.BP_Size_C'" } },
    { rowName: "Size", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_Size.BP_Size_C'" } },
    { rowName: "Dmg", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_Dmg.BP_Dmg_C'" } },
    { rowName: "Speed", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_Speed.BP_Speed_C'" } },
    { rowName: "Heal", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_Heal.BP_Heal_C'" } },
    { rowName: "Health", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_HP.BP_HP_C'" } },
  ];
  const bridge = {
    async send(cmd) {
      if (cmd === "list_blueprints") return { blueprints: [] };
      if (cmd === "list_assets") return { assets: ["/Game/Data/DT_Upgrades.DT_Upgrades"] };
      if (cmd === "list_data_table_rows") return { rows };
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTableDuplicateClasses.length, 1, "the check must still find it");
  assert.deepEqual(r.dataTableDuplicateClasses[0].rows, ["Move", "Size"]);
  // The point of the fix: it has to be in the field a model is told to act on.
  assert.match(r.nextAction, /sharing a class reference/);
  assert.match(r.nextAction, /Move and Size/);
});

test("a struct or enum variable is not reported as an unresolvable class", async () => {
  // describe_class cannot resolve Vector, and no class check could ever apply to it - but a struct
  // variable carries its own name in subType, so every one of them was landing in "class name(s)
  // could not be resolved". Measured: 52 names on a real project, ~38 of them structs and enums.
  // That teaches a reader to discount the note, which costs the names that genuinely matter.
  const bridge = fakeBridge({
    list_variables: () => ({
      parentClass: "Actor",
      variables: [
        { name: "Loc", type: "Struct", subType: "Vector" },
        { name: "Tint", type: "Struct", subType: "LinearColor" },
        { name: "Align", type: "Byte", subType: "EHorizontalAlignment" },
        { name: "Thing", type: "Object", subType: "BP_MissingThing_C" },
      ],
    }),
    describe_class: (params) => {
      throw new Error(`class_not_found: ${params?.className}`);
    },
  });

  const r = await auditProject(bridge, {});
  const unresolved = r.classesNotResolved ?? [];
  // The one real class reference is still reported: recall must not be traded for quiet.
  assert.ok(unresolved.includes("BP_MissingThing_C"), "an unresolvable OBJECT class is still worth saying");
  for (const notAClass of ["Vector", "LinearColor", "EHorizontalAlignment"]) {
    assert.ok(!unresolved.includes(notAClass), `${notAClass} is not a class and must not be listed as one`);
  }
});

test("a C++ row struct is named, so the consequence can be looked up rather than guessed", async () => {
  // The generic wording says an empty reference means "whatever consumes it silently does nothing".
  // On the real table that was wrong in the worse direction: FShopUpgradeDef.UpgradeClass is read by
  // AC_ShopComponent.cpp to count ownership by class equality, so an empty one means the upgrade
  // never registers as owned, never reaches MaxTiers, and can be bought forever.
  //
  // The audit cannot know that, and should not pretend to. What it can do is name the struct, which
  // turns a guess into one find_source call.
  const bridge = fakeBridge({
    list_assets: () => ({ assets: ["/Game/Data/DT_Upgrades.DT_Upgrades"] }),
    list_data_table_rows: () => ({
      rowStruct: "/Script/MyGame.ShopUpgradeDef",
      rows: [
        { rowName: "A", values: { UpgradeClass: "/Script/Engine.BlueprintGeneratedClass'/G/BP_A.BP_A_C'" } },
        { rowName: "B", values: { UpgradeClass: "" } },
      ],
    }),
  });

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTableNulls.length, 1);
  assert.equal(r.dataTableNulls[0].rowStruct, "/Script/MyGame.ShopUpgradeDef", "the thread to the code");
  assert.match(r.nextAction, /ShopUpgradeDef/);
  assert.match(r.nextAction, /unreal_find_source/);
});

test("a Blueprint row struct gets no C++ pointer, because there is no C++ to point at", async () => {
  const bridge = fakeBridge({
    list_assets: () => ({ assets: ["/Game/Data/DT_Things.DT_Things"] }),
    list_data_table_rows: () => ({
      rowStruct: "/Game/Data/S_Thing.S_Thing",
      rows: [
        { rowName: "A", values: { Ref: "/Script/Engine.BlueprintGeneratedClass'/G/BP_A.BP_A_C'" } },
        { rowName: "B", values: { Ref: "" } },
      ],
    }),
  });

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTableNulls.length, 1);
  assert.doesNotMatch(r.nextAction, /unreal_find_source/, "a Blueprint struct is not found with find_source");
});

test("a native parent is reported as uncovered, not as a finding", async () => {
  // parent-event-not-called compares a child against its parent's graph, so a parent that is not a
  // Blueprint is skipped - and was skipped in silence. Measured: 296 of 339 Blueprints inherit from
  // a native class, so a cost-95 check was running on 13% of the project and the report said so
  // nowhere.
  //
  // Firing anyway would be worse. This check's own rule is that the signal is overriding a parent
  // implementation that DOES work; without the parent there is no signal, only a shape, and it would
  // fire on hundreds of ordinary widgets. So it reports coverage, like classesNotResolved does.
  // BP_Messy and BP_Clean are the fixture's own Blueprints and already have event graphs, so they
  // reach the parent-call stage; giving them a native parent is the whole scenario.
  const bridge = fakeBridge({
    list_variables: () => ({ parentClass: "AVSActivatableWidget", variables: [] }),
  });

  const r = await auditProject(bridge, {});
  const groups = (r.groups ?? []).map((g) => g.check);
  assert.ok(!groups.includes("parent-event-not-called"), "no parent graph means no finding, only a gap");
  assert.match(r.parentCallNotChecked ?? "", /AVSActivatableWidget/);
  assert.match(r.parentCallNotChecked ?? "", /unreal_find_source/);
});

test("the Data Table half says how much it read", async () => {
  // Without this, a project with no Data Tables and a project with fifty clean ones produce an
  // identical reply and neither says which it is. The absence of findings is not evidence until you
  // know what was read - the same reason parent-event-not-called now reports its coverage.
  const bridge = fakeBridge({
    list_assets: () => ({ assets: ["/Game/Data/DT_A.DT_A", "/Game/Data/DT_B.DT_B"] }),
    list_data_table_rows: () => ({
      rows: [
        { rowName: "one", values: { Ref: "/Script/Engine.BlueprintGeneratedClass'/G/BP_A.BP_A_C'" } },
        { rowName: "two", values: { Ref: "/Script/Engine.BlueprintGeneratedClass'/G/BP_B.BP_B_C'" } },
      ],
    }),
  });

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTablesScanned, 2);
  assert.equal(r.dataTableRowsScanned, 4, "two tables of two rows");
  assert.deepEqual(r.dataTableNulls, [], "nothing wrong with these, which is the point");
});

test("a project with no Data Tables reports zero rather than staying silent", async () => {
  const r = await auditProject(fakeBridge({ list_assets: () => ({ assets: [] }) }), {});
  assert.equal(r.dataTablesScanned, 0);
  assert.equal(r.dataTableRowsScanned, 0);
});

test("a Data Table finding says how many assets read the table", async () => {
  // A broken row in a table nothing reads and a broken row in a table six things read are different
  // facts. Found the hard way: the audit reported two empty UpgradeClass references and a shared one
  // in DT_Upgrades, and that was acted on as though DT_Upgrades were THE upgrade table. This project
  // has three - DT_Upgrades, DT_UpgradesBP, DT_UpgradesOld - referenced by 1, 6 and 3 assets, with
  // overlapping rows. The findings are in the one almost nothing reads; the one six assets read is
  // clean.
  const bridge = fakeBridge({
    list_assets: () => ({ assets: ["/Game/Data/DT_Thing.DT_Thing"] }),
    list_data_table_rows: () => ({
      rows: [
        { rowName: "A", values: { Ref: "/Script/Engine.BlueprintGeneratedClass'/G/BP_A.BP_A_C'" } },
        { rowName: "B", values: { Ref: "" } },
      ],
    }),
    find_references: () => ({ referencedBy: [{ package: "/Game/X" }, { package: "/Game/Y" }] }),
  });

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTableNulls.length, 1);
  assert.equal(r.dataTableNulls[0].referencedBy, 2);
  // It has to reach nextAction, not just the payload - the ordering bug that shipped this the first
  // time attached the count AFTER the sentence that reads it, so the field was right and the
  // sentence never mentioned it.
  assert.match(r.nextAction, /2 asset\(s\) reference/);
});

test("a reference lookup that fails does not cost the finding", async () => {
  const bridge = fakeBridge({
    list_assets: () => ({ assets: ["/Game/Data/DT_Thing.DT_Thing"] }),
    list_data_table_rows: () => ({
      rows: [
        { rowName: "A", values: { Ref: "/Script/Engine.BlueprintGeneratedClass'/G/BP_A.BP_A_C'" } },
        { rowName: "B", values: { Ref: "" } },
      ],
    }),
    find_references: () => {
      throw new Error("unknown_cmd: find_references");
    },
  });

  const r = await auditProject(bridge, {});
  assert.equal(r.dataTableNulls.length, 1, "the finding survives");
  assert.equal(r.dataTableNulls[0].referencedBy, undefined, "and says nothing rather than guessing");
});

test("the worst-Blueprint ranking says how much each is used", async () => {
  // Measured on this project: PC_TutGameplay is third in the ranking at cost 890 with 20 findings,
  // GS_TutGameplay eighth at 515 with 13, and nothing references either. That is 1,405 cost aimed at
  // assets no other asset mentions, and the ranking said nothing about it.
  //
  // Reported, not re-ranked. Zero referencers is strong evidence and not proof - a class set in a
  // level's World Settings can be real and show nothing here - and deciding that for the caller
  // would be the same overreach as the "read by nobody" wording this project already walked back.
  const bridge = fakeBridge({
    find_references: (params) =>
      /BP_Messy/.test(params.path) ? { referencedBy: [{ package: "/Game/A" }] } : { referencedBy: [] },
  });

  const r = await auditProject(bridge, {});
  const messy = (r.worstBlueprints ?? []).find((w) => w.name === "BP_Messy");
  assert.ok(messy, "BP_Messy has the findings in this fixture");
  assert.equal(messy.referencedBy, 1);
});

test("a failed reference lookup leaves the ranking intact", async () => {
  const bridge = fakeBridge({
    find_references: () => {
      throw new Error("unknown_cmd: find_references");
    },
  });
  const r = await auditProject(bridge, {});
  assert.ok((r.worstBlueprints ?? []).length > 0, "the ranking survives");
  assert.equal((r.worstBlueprints ?? [])[0].referencedBy, undefined, "and says nothing rather than guessing");
});
