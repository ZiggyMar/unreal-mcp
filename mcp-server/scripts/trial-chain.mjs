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
  for (const p of cleanup.reverse()) {
    await call("unreal_delete_asset", { path: p, force: true }).catch(() => {});
  }
  server.child.kill();
  console.log("");
  console.log(
    failures.length === 0
      ? "chain trial ok: every value passed from one tool to the next without editing"
      : `CHAIN TRIAL FAILED: ${failures.length} join(s) need a translation step - ${failures.join("; ")}`
  );
  if (failures.length > 0) process.exitCode = 1;
}
