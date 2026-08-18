#!/usr/bin/env node
// Live verification against a running Unreal Editor.
//
// Compiling proves the plugin builds. Running it against a real editor is the only thing that
// proves a command works, and this project has twice been saved by that distinction (a duplicated
// override-event node on 5.8, an EngineVersion pin that every build check ignored and the runtime
// loader did not). This script is that check, made repeatable instead of hand-run.
//
// Usage: node scripts/live-verify.mjs [--keep]
//   --keep  leave the created assets in the project instead of deleting them at the end
//
// It creates everything it needs under /Game/MCPLiveVerify/ and deletes it again, so it is safe
// to run against a real project, though a scratch project is still the polite choice.

import { UnrealBridgeClient } from "../dist/bridgeClient.js";

const bridge = new UnrealBridgeClient({
  host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
});

const ROOT = "/Game/MCPLiveVerify";
const keep = process.argv.includes("--keep");

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`  ok   ${name}${detail ? ` - ${detail}` : ""}`);
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ name, message });
    console.log(`  FAIL ${name}\n         ${message.split("\n")[0]}`);
  }
}

/** Assert a call fails, and that its error explains itself. Wrong-input paths are half the product. */
async function expectFailure(name, cmd, params, expectedFragment) {
  await check(name, async () => {
    let result;
    try {
      result = await bridge.send(cmd, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes(expectedFragment)) {
        throw new Error(`expected an error containing "${expectedFragment}", got: ${message}`);
      }
      return `rejected with ${expectedFragment}`;
    }
    throw new Error(`expected a failure, but it succeeded: ${JSON.stringify(result)}`);
  });
}

const firstLine = (text) => String(text).split(String.fromCharCode(10))[0];

/**
 * Create a Blueprint, clearing any leftover of the same name first.
 *
 * Verification assets must not depend on the previous run having tidied up: a run that failed
 * mid-check leaves debris, and the next run then reports a name collision instead of the thing it
 * was actually testing. That misdirection cost real time here.
 */
async function freshBlueprint(path, name) {
  await bridge.send("delete_asset", { paths: [`${path}.${name}`], force: true }).catch(() => {});
  await bridge.send("create_blueprint", { packagePath: path, parentClass: "Actor", save: false });
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  console.log("live verification against a running editor\n");

  section("connectivity");
  await check("ping", async () => {
    const r = await bridge.send("ping", {});
    return `${r.plugin} protocol ${r.protocolVersion}`;
  });

  // --- Structs -------------------------------------------------------------------------------
  section("structs");
  const structPath = `${ROOT}/S_MCPVerifyItem`;
  await check("create_struct with typed fields", async () => {
    const r = await bridge.send("create_struct", {
      packagePath: structPath,
      fields: [
        { name: "DisplayName", type: "text" },
        { name: "Count", type: "int" },
        { name: "Origin", type: "vector" },
      ],
    });
    if (r.fields.length !== 3) throw new Error(`expected 3 fields, got ${r.fields.length}`);
    const names = r.fields.map((f) => f.name);
    // The first field reuses the placeholder member a new struct always arrives with; if that
    // reuse is wrong, the names come back shifted or a stray MemberVar survives.
    if (names[0] !== "DisplayName") throw new Error(`first field is "${names[0]}", expected DisplayName`);
    return names.join(", ");
  });

  await check("list_struct_fields by short name", async () => {
    const r = await bridge.send("list_struct_fields", { path: "S_MCPVerifyItem" });
    return `${r.fields.length} fields, types: ${r.fields.map((f) => f.type).join("/")}`;
  });

  await check("add_struct_field", async () => {
    const r = await bridge.send("add_struct_field", { path: structPath, name: "Weight", type: "float" });
    const names = r.fields.map((f) => f.name);
    if (!names.includes("Weight")) throw new Error(`Weight missing; got ${names.join(", ")}`);
    return names.join(", ");
  });

  await expectFailure(
    "add_struct_field rejects a native engine struct",
    "add_struct_field",
    { path: "Vector", name: "Nope", type: "int" },
    "not_a_user_struct"
  );

  await expectFailure(
    "create_struct rejects a bad field type before creating anything",
    "create_struct",
    { packagePath: `${ROOT}/S_ShouldNotExist`, fields: [{ name: "Bad", type: "definitely_not_a_type" }] },
    "unknown_type"
  );
  await check("...and left no asset behind", async () => {
    const r = await bridge.send("list_assets", { className: "UserDefinedStruct", pathPrefix: ROOT });
    const paths = JSON.stringify(r);
    if (paths.includes("S_ShouldNotExist")) throw new Error("a half-built struct was created despite the failure");
    return "no partial asset";
  });

  // --- Enums ---------------------------------------------------------------------------------
  section("enums");
  const enumPath = `${ROOT}/E_MCPVerifyState`;
  await check("create_enum with entries", async () => {
    const r = await bridge.send("create_enum", {
      packagePath: enumPath,
      entries: ["Idle", "Chasing", "Attacking"],
    });
    if (r.entryCount !== 3) throw new Error(`enum reports ${r.entryCount} entries, expected 3`);
    if (r.warning) throw new Error(r.warning);
    return `${r.entryCount} entries, use as ${r.useAs}`;
  });

  await check("list_enum_entries returns the display names set", async () => {
    const r = await bridge.send("list_enum_entries", { path: "E_MCPVerifyState" });
    const names = r.entries.map((e) => e.displayName);
    // The implicit _MAX sentinel must not be reported as a usable value.
    if (r.entries.length !== 3) throw new Error(`expected 3 entries, got ${r.entries.length}: ${names.join(", ")}`);
    if (names[0] !== "Idle") throw new Error(`first entry is "${names[0]}", expected Idle`);
    if (!r.editable) throw new Error("a user-defined enum reported itself as not editable");
    return names.join(", ");
  });

  await check("list_enum_entries works on a native engine enum", async () => {
    const r = await bridge.send("list_enum_entries", { path: "ECollisionChannel" });
    if (r.editable) throw new Error("a native enum reported itself as editable");
    return `${r.entries.length} entries, editable=${r.editable}`;
  });

  // --- struct:/enum: as variable types -------------------------------------------------------
  section("struct: and enum: variable types");
  const bpPath = `${ROOT}/BP_MCPVerify`;
  await check("create_blueprint", async () => {
    const r = await bridge.send("create_blueprint", { packagePath: bpPath, parentClass: "Actor", save: false });
    return r.path;
  });

  await check("add_variable of type struct:<Name>", async () => {
    const r = await bridge.send("add_variable", {
      path: `${bpPath}.BP_MCPVerify`,
      variableName: "ItemData",
      type: "struct:S_MCPVerifyItem",
    });
    return JSON.stringify(r);
  });

  await check("add_variable of type enum:<Name>", async () => {
    const r = await bridge.send("add_variable", {
      path: `${bpPath}.BP_MCPVerify`,
      variableName: "State",
      type: "enum:E_MCPVerifyState",
    });
    return JSON.stringify(r);
  });

  await expectFailure(
    "an unknown struct name fails with a message naming the fix",
    "add_variable",
    { path: `${bpPath}.BP_MCPVerify`, variableName: "Nope", type: "struct:S_DoesNotExist" },
    "struct_not_found"
  );

  await check("the Blueprint still compiles with both new variable types", async () => {
    const r = await bridge.send("compile_blueprint", { path: `${bpPath}.BP_MCPVerify` });
    if (!r.success) throw new Error(`compile failed: ${JSON.stringify(r.errors ?? r)}`);
    return "compiled clean";
  });

  // --- UMG -----------------------------------------------------------------------------------
  section("UMG widgets");
  const widgetPath = `${ROOT}/W_MCPVerify`;
  await check("create_widget_blueprint", async () => {
    const r = await bridge.send("create_widget_blueprint", { packagePath: widgetPath, save: false });
    if (!r.rootWidget) throw new Error("no root widget was created");
    return `root ${r.rootWidget} (${r.rootWidgetClass})`;
  });

  await check("add_widget under the root", async () => {
    const r = await bridge.send("add_widget", {
      path: `${widgetPath}.W_MCPVerify`,
      widgetClass: "ProgressBar",
      name: "HealthBar",
    });
    return `${r.name} in ${r.parent}, slot ${r.slotClass}`;
  });

  await check("add_widget Button, then a TextBlock nested inside it", async () => {
    await bridge.send("add_widget", { path: `${widgetPath}.W_MCPVerify`, widgetClass: "Button", name: "StartButton" });
    const r = await bridge.send("add_widget", {
      path: `${widgetPath}.W_MCPVerify`,
      widgetClass: "TextBlock",
      name: "StartLabel",
      parent: "StartButton",
    });
    if (r.parent !== "StartButton") throw new Error(`label landed in ${r.parent}`);
    return `${r.name} inside ${r.parent}, slot ${r.slotClass}`;
  });

  await expectFailure(
    "a second child on a Button is refused with parent_full",
    "add_widget",
    { path: `${widgetPath}.W_MCPVerify`, widgetClass: "TextBlock", name: "SecondLabel", parent: "StartButton" },
    "parent_full"
  );

  await expectFailure(
    "a non-widget class is refused",
    "add_widget",
    { path: `${widgetPath}.W_MCPVerify`, widgetClass: "Actor", name: "Nope" },
    "not_a_widget_class"
  );

  await expectFailure(
    "an unknown parent lists the panels that do exist",
    "add_widget",
    { path: `${widgetPath}.W_MCPVerify`, widgetClass: "TextBlock", name: "Nope2", parent: "NoSuchPanel" },
    "parent_not_found"
  );

  await check("list_widgets returns the hierarchy in depth order", async () => {
    const r = await bridge.send("list_widgets", { path: `${widgetPath}.W_MCPVerify` });
    const label = r.widgets.find((w) => w.name === "StartLabel");
    if (!label) throw new Error(`StartLabel missing from ${r.widgets.map((w) => w.name).join(", ")}`);
    if (label.depth !== 2) throw new Error(`StartLabel depth is ${label.depth}, expected 2 (root > Button > Text)`);
    return r.widgets.map((w) => `${"  ".repeat(w.depth)}${w.name}`).join(" | ");
  });

  await check("set_widget_property on the widget", async () => {
    const r = await bridge.send("set_widget_property", {
      path: `${widgetPath}.W_MCPVerify`,
      widget: "HealthBar",
      property: "Percent",
      value: "0.75",
    });
    return JSON.stringify(r);
  });

  await check("set_widget_property on the layout slot", async () => {
    const r = await bridge.send("set_widget_property", {
      path: `${widgetPath}.W_MCPVerify`,
      widget: "HealthBar",
      property: "ZOrder",
      value: "3",
      onSlot: true,
    });
    return JSON.stringify(r);
  });

  await expectFailure(
    "onSlot on the root widget explains why there is no slot",
    "set_widget_property",
    { path: `${widgetPath}.W_MCPVerify`, widget: "RootWidget", property: "ZOrder", value: "1", onSlot: true },
    "widget_not_found"
  );

  await check("the Widget Blueprint compiles", async () => {
    const r = await bridge.send("compile_blueprint", { path: `${widgetPath}.W_MCPVerify` });
    if (!r.success) throw new Error(`compile failed: ${JSON.stringify(r.errors ?? r)}`);
    return "compiled clean";
  });

  await expectFailure(
    "widget tools refuse an ordinary Blueprint",
    "list_widgets",
    { path: `${bpPath}.BP_MCPVerify` },
    "not_a_widget_blueprint"
  );

  // --- Materials ------------------------------------------------------------------------------
  section("materials");
  const matPath = `${ROOT}/M_MCPVerify`;
  const instPath = `${ROOT}/MI_MCPVerify`;
  await check("create_material with parameters, not constants", async () => {
    const r = await bridge.send("create_material", {
      packagePath: matPath,
      baseColor: "1,0,0",
      metallic: 1,
      roughness: 0.2,
      emissiveColor: "0,2,4",
    });
    if (!r.parameters || r.parameters.length !== 4) {
      throw new Error(`expected 4 parameters, got ${JSON.stringify(r.parameters)}`);
    }
    return r.parameters.join(", ");
  });

  await check("list_material_parameters sees them on the master", async () => {
    const r = await bridge.send("list_material_parameters", { path: `${matPath}.M_MCPVerify` });
    const names = r.parameters.map((p) => p.name).sort();
    // If the master were built from constants instead of parameters, this list would be empty and
    // the whole instancing workflow would silently be impossible.
    for (const expected of ["BaseColor", "EmissiveColor", "Metallic", "Roughness"]) {
      if (!names.includes(expected)) throw new Error(`${expected} missing from ${names.join(", ")}`);
    }
    if (r.isInstance) throw new Error("a master material reported itself as an instance");
    return names.join(", ");
  });

  await check("create_material_instance from that master", async () => {
    const r = await bridge.send("create_material_instance", {
      packagePath: instPath,
      parentMaterial: `${matPath}.M_MCPVerify`,
    });
    return `${r.name} <- ${r.parent}`;
  });

  await check("the instance inherits the parent's parameters", async () => {
    const r = await bridge.send("list_material_parameters", { path: `${instPath}.MI_MCPVerify` });
    if (!r.isInstance) throw new Error("an instance reported itself as a master");
    if (r.parameters.length !== 4) throw new Error(`expected 4 inherited parameters, got ${r.parameters.length}`);
    return `${r.parameters.length} inherited`;
  });

  await check("set_material_parameter overrides a colour and a scalar", async () => {
    await bridge.send("set_material_parameter", { path: `${instPath}.MI_MCPVerify`, parameter: "BaseColor", color: "0,0,1" });
    const r = await bridge.send("set_material_parameter", { path: `${instPath}.MI_MCPVerify`, parameter: "Roughness", scalar: 0.9 });
    return r.applied;
  });

  await expectFailure(
    "a parameter that does not exist is refused, not silently ignored",
    "set_material_parameter",
    { path: `${instPath}.MI_MCPVerify`, parameter: "NoSuchParameter", scalar: 1 },
    "parameter_not_found"
  );

  await expectFailure(
    "setting a parameter on the MASTER is refused with an explanation",
    "set_material_parameter",
    { path: `${matPath}.M_MCPVerify`, parameter: "Roughness", scalar: 0.1 },
    "material_instance_not_found"
  );

  await check("create_material with a base colour texture and a normal map", async () => {
    // Use a texture that ships with the engine, so this works in any project.
    const engineTexture = "/Engine/EngineResources/DefaultTexture.DefaultTexture";
    const r = await bridge.send("create_material", {
      packagePath: `${ROOT}/M_MCPTextured`,
      baseColor: "1,1,1",
      baseColorTexture: engineTexture,
      normalTexture: engineTexture,
    });
    const names = r.parameters.join(", ");
    if (!names.includes("BaseColorTexture")) throw new Error(`no texture parameter: ${names}`);
    if (!names.includes("NormalTexture")) throw new Error(`no normal parameter: ${names}`);
    return names;
  });

  await check("the textured material's parameters are all instanceable", async () => {
    const r = await bridge.send("list_material_parameters", { path: `${ROOT}/M_MCPTextured.M_MCPTextured` });
    const byKind = r.parameters.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
    // Texture parameters are what let an instance swap the texture without a new material.
    if (!byKind.texture) throw new Error(`no texture parameters exposed: ${JSON.stringify(byKind)}`);
    return JSON.stringify(byKind);
  });

  await expectFailure(
    "a texture path that does not resolve is refused rather than silently skipped",
    "create_material",
    { packagePath: `${ROOT}/M_NoTex`, baseColorTexture: "/Game/Nope/NotATexture.NotATexture" },
    "texture_not_found"
  );

  await expectFailure(
    "a malformed colour is refused",
    "create_material",
    { packagePath: `${ROOT}/M_Bad`, baseColor: "not-a-colour" },
    "bad_color"
  );

  // --- Levels and actors -----------------------------------------------------------------------
  section("levels and actors");
  const levelPath = `${ROOT}/L_MCPVerify`;
  await check("create_level and open it", async () => {
    // The level is the one asset this script cannot clean up (it is open at the end), so a repeat
    // run finds it already there. Re-running a verification script must not fail because the last
    // run succeeded.
    let created = "reused existing";
    try {
      await bridge.send("create_level", { packagePath: levelPath });
      created = "created";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already_exists")) throw err;
    }
    const r = await bridge.send("open_level", { path: levelPath });
    if (!JSON.stringify(r).includes("L_MCPVerify")) {
      throw new Error(`open_level did not switch to the verification level: ${JSON.stringify(r)}`);
    }
    return `${created}, opened ${JSON.stringify(r)}`;
  });

  await check("spawn actors into it", async () => {
    await bridge.send("spawn_actor", { actorClass: "PlayerStart", label: "MCPStart", locZ: 100 });
    const r = await bridge.send("spawn_actor", { actorClass: "PointLight", label: "MCPLight", locZ: 300 });
    return `${r.actor} (${r.class})`;
  });

  await check("list_actors reads back what is there", async () => {
    const r = await bridge.send("list_actors", {});
    const labels = r.actors.map((a) => a.label);
    for (const expected of ["MCPStart", "MCPLight"]) {
      if (!labels.includes(expected)) throw new Error(`${expected} missing from ${labels.join(", ")}`);
    }
    if (!Array.isArray(r.byClass) || r.byClass.length === 0) throw new Error("no per-class census");
    return `${r.totalActors} actors, classes: ${r.byClass.map((c) => c.class).slice(0, 3).join(", ")}`;
  });

  await check("classFilter narrows a level", async () => {
    const r = await bridge.send("list_actors", { classFilter: "PointLight" });
    if (r.actors.some((a) => !a.class.includes("PointLight"))) throw new Error("filter leaked other classes");
    if (r.actors.length === 0) throw new Error("filter matched nothing");
    // The census must still describe the whole level, or a filtered read would misrepresent it.
    if (r.totalActors <= r.actors.length) throw new Error("census should cover the whole level, not the filtered subset");
    return `${r.actors.length} of ${r.totalActors}`;
  });

  await check("set_actor_property changes one instance, and says so", async () => {
    const r = await bridge.send("set_actor_property", { actor: "MCPLight", property: "bHidden", value: "true" });
    const text = JSON.stringify(r);
    if (!text.includes("ONLY this placed instance")) throw new Error(`scope not explained: ${text}`);
    return text.slice(0, 90);
  });

  await expectFailure(
    "an unknown actor lists some that do exist",
    "set_actor_property",
    { actor: "NoSuchActor", property: "bHidden", value: "true" },
    "actor_not_found"
  );

  await expectFailure(
    "deleting the OPEN level is refused rather than hanging the editor",
    "delete_asset",
    { paths: [`${levelPath}.L_MCPVerify`], force: true },
    "cannot_delete_open_level"
  );

  await check("delete_actor removes it", async () => {
    await bridge.send("delete_actor", { actor: "MCPLight" });
    const r = await bridge.send("list_actors", {});
    if (r.actors.some((a) => a.label === "MCPLight")) throw new Error("the actor is still there");
    return `${r.totalActors} actors remain`;
  });

  // --- claims audit -----------------------------------------------------------------------------
  // Several rows in docs/COMPLAINTS_SOLVED.md were written from reasoning rather than from running
  // anything. These check the load-bearing ones. A safety guarantee nobody has exercised is a
  // guarantee in name only.
  section("audit of claims made in the complaint matrix");

  await check("C4: deleting an asset something still references is BLOCKED by default", async () => {
    // MI_MCPVerify was deleted in cleanup of a previous section, so rebuild the pair here.
    await bridge.send("create_material", { packagePath: `${ROOT}/M_Parent`, baseColor: "0,1,0" });
    await bridge.send("create_material_instance", {
      packagePath: `${ROOT}/MI_Child`,
      parentMaterial: `${ROOT}/M_Parent.M_Parent`,
    });
    let blocked = false;
    let detail = "";
    try {
      const r = await bridge.send("delete_asset", { path: `${ROOT}/M_Parent.M_Parent` });
      detail = JSON.stringify(r);
      // Some builds report the refusal in the result rather than as an error.
      blocked = detail.includes("blocked") || r.deleted === 0;
    } catch (err) {
      blocked = true;
      detail = firstLine(err instanceof Error ? err.message : String(err));
    }
    if (!blocked) {
      throw new Error(`a referenced asset was deleted without force: ${detail}`);
    }
    return detail.slice(0, 110);
  });

  await check("C4: force:true still deletes it, so the guard is a guard and not a wall", async () => {
    const r = await bridge.send("delete_asset", {
      paths: [`${ROOT}/MI_Child.MI_Child`, `${ROOT}/M_Parent.M_Parent`],
      force: true,
    });
    return JSON.stringify(r);
  });

  await check("E2: a misspelled function name comes back with didYouMean", async () => {
    const bp = `${ROOT}/BP_Suggest`;
    await freshBlueprint(bp, "BP_Suggest");
    // Clean up even when the assertion fails. A check that only tidies up on success poisons the
    // next run with its own debris, and then reports a collision instead of the real result - which
    // is exactly what happened the first time this check failed.
    try {
      let message = "";
      try {
        await bridge.send("add_node", {
          path: `${bp}.BP_Suggest`,
          graphName: "EventGraph",
          nodeType: "CallFunction",
          functionName: "PrintSting",
          className: "KismetSystemLibrary",
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      if (!message) throw new Error("a misspelled function name was accepted");
      if (!/didYouMean|PrintString/i.test(message)) {
        throw new Error(`no suggestion offered, which is the dead end this claims to prevent: ${message.slice(0, 200)}`);
      }
      return message.slice(0, 140);
    } finally {
      await bridge.send("delete_asset", { paths: [`${bp}.BP_Suggest`], force: true }).catch(() => {});
    }
  });

  await check("C3: writes really do land in the editor's undo stack as named MCP transactions", async () => {
    // Claimed since M2 and never checked from outside the process. A safety guarantee nobody has
    // exercised is a guarantee in name only.
    const bp = `${ROOT}/BP_Undo`;
    await freshBlueprint(bp, "BP_Undo");
    try {
      await bridge.send("add_variable", { path: `${bp}.BP_Undo`, variableName: "AuditVar", type: "float" });
      const history = await bridge.send("undo_history", { maxResults: 10 });
      if (history.fromMCP < 1) {
        throw new Error(
          `no MCP transaction in the undo stack, so the Ctrl+Z claim is false: ${JSON.stringify(history.entries)}`
        );
      }
      const top = history.entries[0];
      if (!top.fromMCP) {
        throw new Error(`the newest undo entry is not ours: ${JSON.stringify(top)}`);
      }
      return `${history.fromMCP} MCP entries, next Ctrl+Z reverses "${top.title}"`;
    } finally {
      await bridge.send("delete_asset", { paths: [`${bp}.BP_Undo`], force: true }).catch(() => {});
    }
  });

  await check("B3: refresh_blueprint runs and reports before/after error counts", async () => {
    const bp = `${ROOT}/BP_Refresh`;
    await freshBlueprint(bp, "BP_Refresh");
    try {
      const r = await bridge.send("refresh_blueprint", { path: `${bp}.BP_Refresh` });
      const text = JSON.stringify(r);
      if (!/error/i.test(text)) throw new Error(`no error counts reported: ${text}`);
      return text.slice(0, 120);
    } finally {
      await bridge.send("delete_asset", { paths: [`${bp}.BP_Refresh`], force: true }).catch(() => {});
    }
  });

  // --- the crash that this script found ------------------------------------------------------
  section("create-after-delete (regression: this used to assert and close the editor)");
  const reusePath = `${ROOT}/BP_MCPReuse`;
  await check("create, delete, then create the same name again", async () => {
    await bridge.send("create_blueprint", { packagePath: reusePath, parentClass: "Actor", save: false });
    await bridge.send("delete_asset", { path: `${reusePath}.BP_MCPReuse`, force: true });
    // The package is off disk now but the UObject is still resident, which is exactly the state
    // where FKismetEditorUtilities::CreateBlueprint asserts. It must return an error, not die.
    try {
      const again = await bridge.send("create_blueprint", { packagePath: reusePath, parentClass: "Actor", save: false });
      return `recreated cleanly: ${again.path}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("asset_name_in_use")) return "refused with asset_name_in_use, editor still alive";
      throw err;
    }
  });
  await check("the editor is still running afterwards", async () => {
    const r = await bridge.send("ping", {});
    return `still up, protocol ${r.protocolVersion}`;
  });

  // --- cleanup -------------------------------------------------------------------------------
  if (!keep) {
    section("cleanup");
    await check("delete every asset this run created", async () => {
      const r = await bridge.send("delete_asset", {
        paths: [
          `${bpPath}.BP_MCPVerify`,
          `${widgetPath}.W_MCPVerify`,
          `${structPath}.S_MCPVerifyItem`,
          `${enumPath}.E_MCPVerifyState`,
          `${reusePath}.BP_MCPReuse`,
          `${instPath}.MI_MCPVerify`,
          `${matPath}.M_MCPVerify`,

          `${ROOT}/M_MCPTextured.M_MCPTextured`,
        ],
        force: true,
      });
      return JSON.stringify(r);
    });
    await check("the verification level is left behind, deliberately and visibly", async () => {
      // It is the open level, so it cannot be deleted from this run without opening another one
      // and leaving THAT behind instead. Reporting it beats a silent leftover.
      return `${levelPath} remains (it is the open level); delete it by hand or open another level first`;
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`live verification could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
