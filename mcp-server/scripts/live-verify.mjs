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
