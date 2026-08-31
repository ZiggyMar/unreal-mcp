// Take what one tool returns and hand it, unmodified, to the tool that consumes it.
//
// Every defect this trial exists for has the same shape: two tools that each work, describing the
// same thing differently. find_source returned `AAVSGameState` and describe_class refused it.
// list_variables printed `object:SkeletalMesh[]` and its own `match` could not find it. A read said
// `type: "Object", subType: "..."` and the write wanted `object:...`. None of those is visible in a
// single call, in a token measurement, or in a unit test with a fixture - only in the join.
//
// It goes through the MCP TOOLS, not the bridge. That distinction is the trial's whole premise and
// the first version got it wrong: calling the bridge directly bypasses the tool layer, which is
// where the compaction lives, where the descriptors are built, and where a shim covers a plugin
// older than this server. A model never sees the bridge, so a trial that tests it is measuring
// something nobody experiences.
import { startAndInitialize } from "./lib/mcpStdio.mjs";
import { sweepScratch, cleanUpScratch, SCRATCH_ROOT } from "./lib/scratch.mjs";

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "trial-chain");
const stamp = String(Date.now()).slice(-6);
const SCRATCH = `/Game/MCPTrial/BP_Chain${stamp}`;
const cleanup = [];
const failures = [];

const call = async (name, args) => {
  const reply = await server.request("tools/call", { name, arguments: args });
  const body = (reply.result ?? reply).content[0].text;
  if ((reply.result ?? reply).isError) throw new Error(body.slice(0, 160));
  return JSON.parse(body);
};

const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// Anything already in the scratch namespace is from a run that was killed before it could clean up.
await sweepScratch({
  list: async () => {
    const listed = await call("unreal_list_blueprints", { pathPrefix: SCRATCH_ROOT, maxResults: 200 });
    return (listed.blueprints ?? []).map((b) => b.path);
  },
  remove: (path) => call("unreal_delete_asset", { path, force: true }),
});

try {
  console.log("find_node -> add_node");
  await call("unreal_create_blueprint", { packagePath: SCRATCH, parentClass: "Actor" });
  cleanup.push(SCRATCH);
  await call("unreal_build_graph", {
    path: SCRATCH,
    graphName: "EventGraph",
    nodes: [{ ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" }],
    connections: [],
  });

  for (const intent of ["line trace", "get player character", "print string", "set timer"]) {
    const found = await call("unreal_find_node", { query: intent });
    const hit = (found.hits ?? [])[0];
    if (!hit) {
      check(intent, false, "find_node returned nothing");
      continue;
    }
    // Verbatim. The whole point is that no translation should be needed between the two.
    try {
      await call("unreal_add_node", {
        path: SCRATCH,
        graphName: "EventGraph",
        nodeType: "CallFunction",
        functionName: hit.functionName,
        className: hit.className,
      });
      check(intent, true, `${hit.className}::${hit.functionName}`);
    } catch (err) {
      check(intent, false, `add_node refused what find_node returned: ${String(err.message).slice(0, 110)}`);
    }
  }

  console.log("");
  console.log("list_blueprint_graphs -> read_blueprint_summary -> read_node_detail");
  const graphs = await call("unreal_list_blueprint_graphs", { path: SCRATCH });
  const graphName = (graphs.graphs ?? []).map((g) => g.name ?? g)[0];
  check("a graph name comes back", Boolean(graphName), String(graphName));

  const summary = await call("unreal_read_blueprint_summary", { path: SCRATCH, graphName });
  const nodeId = (summary.nodes ?? [])[0]?.id;
  check("a node id comes back", Boolean(nodeId), String(nodeId).slice(0, 12));
  try {
    const detail = await call("unreal_read_node_detail", { path: SCRATCH, graphName, nodeId });
    check("read_node_detail takes that id verbatim", Boolean(detail.pins), `${(detail.pins ?? []).length} pins`);
  } catch (err) {
    check("read_node_detail takes that id verbatim", false, String(err.message).slice(0, 110));
  }

  console.log("");
  console.log("list_variables -> add_variable");
  await call("unreal_add_variable", { path: SCRATCH, variableName: "TrialMesh", type: "object:StaticMesh[]" });
  const vars = await call("unreal_list_variables", { path: SCRATCH, match: "TrialMesh" });
  const printed = (vars.variables ?? []).find((v) => v.name === "TrialMesh")?.type;
  check("the type a read prints round-trips", printed === "object:StaticMesh[]", String(printed));
  try {
    await call("unreal_add_variable", { path: SCRATCH, variableName: "TrialMesh2", type: printed });
    check("add_variable accepts it verbatim", true);
  } catch (err) {
    check("add_variable accepts it verbatim", false, String(err.message).slice(0, 110));
  }

  console.log("");
  console.log("list_components -> set_component_property");
  await call("unreal_add_component", { path: SCRATCH, componentClass: "SphereComponent", name: "TrialSphere" });
  const comps = await call("unreal_list_components", { path: SCRATCH });
  const comp = (comps.components ?? []).find((c) => c.name === "TrialSphere");
  check("the component comes back under the name it was given", Boolean(comp), JSON.stringify(comp));
  if (comp) {
    try {
      // `comp.name` into `component:`. The parameter is named differently from the field, which is
      // normal and not what this trial is about - it checks that the VALUE passes through unedited.
      // A first version wrote componentName/propertyName here and the trial reported a failure that
      // was its own: worth remembering that a red result needs reading before it is believed.
      await call("unreal_set_component_property", {
        path: SCRATCH,
        component: comp.name,
        property: "SphereRadius",
        value: "120",
      });
      check("set_component_property takes that name verbatim", true);
    } catch (err) {
      check("set_component_property takes that name verbatim", false, String(err.message).slice(0, 110));
    }
  }

  console.log("");
  console.log("list_struct_fields -> add_struct_field");
  const STRUCT = `/Game/MCPTrial/S_Chain${stamp}`;
  await call("unreal_create_struct", { packagePath: STRUCT, fields: [{ name: "Icon", type: "object:Texture2D" }] });
  cleanup.push(STRUCT);
  const fields = await call("unreal_list_struct_fields", { path: STRUCT });
  const printedField = (fields.fields ?? []).find((f) => String(f.name).startsWith("Icon"))?.type;
  check("the field type a read prints round-trips", printedField === "object:Texture2D", String(printedField));
  try {
    await call("unreal_add_struct_field", { path: STRUCT, name: "Icon2", type: printedField });
    check("add_struct_field accepts it verbatim", true);
  } catch (err) {
    check("add_struct_field accepts it verbatim", false, String(err.message).slice(0, 110));
  }

  console.log("");
  console.log("list_assets -> read_asset_properties -> set_asset_property");
  const assets = await call("unreal_list_assets", { className: "DataTable", maxResults: 3 });
  const asset = (assets.assets ?? [])[0];
  if (asset) {
    try {
      const props = await call("unreal_read_asset_properties", { path: asset.path });
      check("read_asset_properties takes the listed path verbatim", Array.isArray(props.properties), `${(props.properties ?? []).length} properties`);
    } catch (err) {
      check("read_asset_properties takes the listed path verbatim", false, String(err.message).slice(0, 110));
    }
  }

  console.log("");
  console.log("audit_project -> the tool its own fix names");
  // The audit reports node ids truncated to what a person would copy out of a report. Whatever it
  // hands back has to be enough for the tool it tells you to use.
  const audit = await call("unreal_audit_project", { check: "dead-node", limit: 40 });
  const deadGroup = (audit.groups ?? []).find((g) => g.check === "dead-node");
  if (deadGroup && (deadGroup.examples ?? []).length > 0) {
    check("the audit names a fix tool for its findings", /unreal_[a-z_]+/.test(String(deadGroup.fix)), String(deadGroup.fix).slice(0, 80));
  } else {
    console.log("  --    no dead-node findings on this project to chain from");
  }

  console.log("");
  console.log("find_in_data_tables -> set_data_table_row (the change request, end to end)");
  // "The machine gun should cost 500 instead of 300" is the shape of most change requests, and until
  // recently none of it worked: search_project could not see inside a table at all, and the write
  // refused `{ Cost: 500 }` because every write parameter was declared as a string.
  const STRUCT2 = `/Game/MCPTrial/S_Chg${stamp}`;
  const TABLE = `/Game/MCPTrial/DT_Chg${stamp}`;
  await call("unreal_create_struct", {
    packagePath: STRUCT2,
    fields: [{ name: "Cost", type: "int" }, { name: "Label", type: "string" }],
  });
  cleanup.push(STRUCT2);
  await call("unreal_create_data_table", { packagePath: TABLE, rowStruct: STRUCT2 });
  cleanup.push(TABLE);
  try {
    // A number, not "300". This is the call that used to fail.
    await call("unreal_add_data_table_row", { path: TABLE, rowName: "Weapon_MachineGun", values: { Cost: 300, Label: "Machine Gun" } });
    check("a write takes a number for a numeric field", true);
  } catch (err) {
    check("a write takes a number for a numeric field", false, String(err.message).slice(0, 110));
  }

  const searched = await call("unreal_find_in_data_tables", { query: "MachineGun", pathPrefix: "/Game/MCPTrial" });
  const hit = (searched.hits ?? [])[0];
  check("find_in_data_tables locates the row", Boolean(hit), hit ? `${hit.rowName} in ${hit.field}` : "no hit");
  if (hit) {
    try {
      // hit.table and hit.rowName verbatim into the writer, which is the whole point of this trial.
      await call("unreal_set_data_table_row", { path: hit.table, rowName: hit.rowName, values: { Cost: 500 } });
      const after = await call("unreal_list_data_table_rows", { path: TABLE });
      const cost = (after.rows ?? [])[0]?.values?.Cost;
      check("the change lands and reads back", String(cost) === "500", `Cost is now ${JSON.stringify(cost)}`);
    } catch (err) {
      check("set_data_table_row takes what find_in_data_tables returned", false, String(err.message).slice(0, 110));
    }
  }

  console.log("");
  console.log("find_source -> describe_class (the join that was actually broken)");
  // A model reads a Blueprint, sees a native parentClass, asks where it is declared, then asks what
  // it offers. find_source answers with the C++ spelling - AAVSGameState - and describe_class
  // refused it, because UClass::GetName() carries no prefix. Both tools were right on their own.
  const listed = await call("unreal_list_blueprints", { maxResults: 400 });
  const nativeParents = [...new Set((listed.blueprints ?? []).map((x) => x.parentClass).filter((n) => n && !/_C$/.test(n)))];
  let checked = 0;
  for (const name of nativeParents) {
    const source = await call("unreal_find_source", { symbol: name });
    if (!source.foundAs) continue; // only the ones whose C++ name differs are interesting here
    checked += 1;
    try {
      const described = await call("unreal_describe_class", { className: source.foundAs });
      check(`find_source said "${source.foundAs}", describe_class takes it`, Boolean(described.name), described.name);
    } catch (err) {
      check(`find_source said "${source.foundAs}", describe_class takes it`, false, String(err.message).slice(0, 110));
    }
    if (checked >= 3) break;
  }
  if (checked === 0) console.log("  --    no parent class in this project has a differing C++ name");
} finally {
  await cleanUpScratch(cleanup, (path) => call("unreal_delete_asset", { path, force: true }));
  server.child.kill();
  console.log("");
  console.log(
    failures.length === 0
      ? "chain trial ok: every value passed from one tool to the next without editing"
      : `CHAIN TRIAL FAILED: ${failures.length} join(s) need a translation step - ${failures.join("; ")}`
  );
  if (failures.length > 0) process.exitCode = 1;
}
