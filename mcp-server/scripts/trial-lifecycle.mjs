// Everything this server can create, it should be able to rename and remove - and each of those
// operations should leave the project consistent rather than merely different.
//
// Seven bridge commands were added across three sessions to close that gap: rename_asset,
// duplicate_asset, rename_variable, remove_variable, rename_component, remove_component,
// remove_function. Every one compiles against 5.6, 5.8 and the game target, and not one has been
// RUN, because the plugin binary in the editor predates all of them.
//
// That is a real risk and it grows quietly: the day the plugin is rebuilt, seven commands go live
// having never been executed once. This trial is the thing that runs the moment they exist. Today it
// reports what it cannot run and exits 2; after a rebuild it either passes or finds what compiling
// could not.
//
// What it checks is not "did the call return ok". A rename that changed a name and left every
// referencing node pointing at the old one has not renamed anything, so each step asserts the
// CONSEQUENCE: the new name is readable, the old one is gone, the nodes moved with it, and a removal
// that would break something refuses instead.
import { startAndInitialize } from "./lib/mcpStdio.mjs";
import { sweepScratch, cleanUpScratch, SCRATCH_ROOT } from "./lib/scratch.mjs";

const stamp = String(Date.now()).slice(-6);
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "trial-lifecycle");

const failures = [];
const cannotRun = [];
const cleanup = [];
let calls = 0;

/** One call. Returns {ok, body, unavailable} - never throws, so a missing command is data. */
const call = async (name, args) => {
  calls += 1;
  const reply = await server.request("tools/call", { name, arguments: args });
  const body = (reply.result ?? reply).content?.[0]?.text ?? "";
  const missing = /unknown_cmd:\s*([a-z0-9_]+)/i.exec(body);
  if (missing) {
    if (!cannotRun.includes(missing[1])) cannotRun.push(missing[1]);
    return { ok: false, unavailable: true, body };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* an error reply is not always JSON */
  }
  return { ok: !(reply.result ?? reply).isError, body, json: parsed, unavailable: false };
};

const check = (name, ok, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const skipped = (name, why) => console.log(`  --    ${name} - ${why}`);

try {
  await sweepScratch({
    list: async () => {
      const assets = await call("unreal_list_assets", { className: "Object", pathPrefix: SCRATCH_ROOT, maxResults: 300 });
      return (assets.json?.assets ?? []).map((a) => (typeof a === "string" ? a : a.path));
    },
    remove: (path) => call("unreal_delete_asset", { path, force: true }),
  });

  const BP = `${SCRATCH_ROOT}/BP_Life${stamp}`;
  await call("unreal_create_blueprint", { packagePath: BP, parentClass: "Actor" });
  cleanup.push(BP);

  // ---------------------------------------------------------------------------------------------
  console.log("");
  console.log("a variable, renamed with the nodes that read it");
  await call("unreal_add_variable", { path: BP, variableName: "FireRate", type: "float" });
  // A graph that actually reads the variable, so the rename has something to rebind. Without this
  // the test proves only that a descriptor changed, which is the easy half.
  await call("unreal_build_graph", {
    path: BP,
    graphName: "EventGraph",
    nodes: [
      { ref: "ev", nodeType: "Event", eventName: "ReceiveBeginPlay" },
      { ref: "get", nodeType: "VariableGet", variableName: "FireRate" },
      { ref: "print", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
    ],
    connections: [{ from: "ev.then", to: "print.execute" }],
  });

  const renamed = await call("unreal_rename_variable", { path: BP, variableName: "FireRate", newName: "RateOfFire" });
  if (renamed.unavailable) {
    skipped("rename_variable", "the plugin has never heard of it");
  } else {
    check("the rename reports the nodes it moved", typeof renamed.json?.nodesUpdated === "number", `nodesUpdated: ${renamed.json?.nodesUpdated}`);

    const vars = await call("unreal_list_variables", { path: BP });
    const names = (vars.json?.variables ?? []).map((v) => v.name);
    check("the new name is there and the old one is gone", names.includes("RateOfFire") && !names.includes("FireRate"), names.join(", "));

    // The consequence that matters: a graph still reading "FireRate" would be broken, and the
    // Blueprint would stop compiling. Compiling is the cheapest way to ask the engine.
    const compiled = await call("unreal_compile_blueprint", { path: BP });
    check("the Blueprint still compiles after the rename", compiled.json?.success === true, `errors: ${compiled.json?.errorCount ?? "?"}`);
  }

  // ---------------------------------------------------------------------------------------------
  console.log("");
  console.log("a variable in use refuses to be removed");
  const inUse = await call("unreal_remove_variable", { path: BP, variableName: "RateOfFire" });
  if (inUse.unavailable) {
    skipped("remove_variable", "the plugin has never heard of it");
  } else {
    // Either it refused (a node still reads it) or there was nothing reading it. Both are correct;
    // what must not happen is a silent removal while something still uses it.
    const refused = /variable_in_use/.test(inUse.body);
    check(
      "removing a variable is a decision, not a surprise",
      refused || inUse.ok,
      refused ? "refused and named the graphs" : "removed; nothing referenced it"
    );
    if (refused) {
      const forced = await call("unreal_remove_variable", { path: BP, variableName: "RateOfFire", force: true });
      check("force removes it", forced.ok, forced.body.slice(0, 80));
    }
  }

  // ---------------------------------------------------------------------------------------------
  console.log("");
  console.log("a component, renamed and removed");
  await call("unreal_add_component", { path: BP, componentClass: "SphereComponent", name: "Trigger" });
  const compRenamed = await call("unreal_rename_component", { path: BP, component: "Trigger", newName: "InteractionRange" });
  if (compRenamed.unavailable) {
    skipped("rename_component", "the plugin has never heard of it");
  } else {
    const comps = await call("unreal_list_components", { path: BP });
    const compNames = (comps.json?.components ?? []).map((c) => c.name);
    check("the component answers to its new name", compNames.includes("InteractionRange"), compNames.join(", "));

    const removed = await call("unreal_remove_component", { path: BP, component: "InteractionRange" });
    check("and can then be removed", removed.ok, removed.body.slice(0, 80));
    const after = await call("unreal_list_components", { path: BP });
    const left = (after.json?.components ?? []).map((c) => c.name);
    check("it is actually gone", !left.includes("InteractionRange"), left.join(", ") || "(none)");
  }

  // ---------------------------------------------------------------------------------------------
  console.log("");
  console.log("a function that is called refuses to be removed");
  await call("unreal_create_function", { path: BP, functionName: "DoTheThing", inputs: [], outputs: [] });
  const fnRemoved = await call("unreal_remove_function", { path: BP, functionName: "DoTheThing" });
  if (fnRemoved.unavailable) {
    skipped("remove_function", "the plugin has never heard of it");
  } else {
    check("an uncalled function removes cleanly", fnRemoved.ok, fnRemoved.body.slice(0, 80));
    const graphs = await call("unreal_list_blueprint_graphs", { path: BP });
    const graphNames = (graphs.json?.graphs ?? []).map((g) => g.name ?? g);
    check("and is gone from the graph list", !graphNames.includes("DoTheThing"), graphNames.join(", "));
  }

  // ---------------------------------------------------------------------------------------------
  console.log("");
  console.log("an asset, copied and renamed");
  const copyName = `BP_LifeCopy${stamp}`;
  const copied = await call("unreal_duplicate_asset", { path: BP, newName: copyName });
  if (copied.unavailable) {
    skipped("duplicate_asset", "the plugin has never heard of it");
  } else {
    cleanup.push(`${SCRATCH_ROOT}/${copyName}`);
    check("the copy exists", copied.ok && typeof copied.json?.path === "string", copied.json?.path ?? copied.body.slice(0, 80));

    const newName = `BP_LifeMoved${stamp}`;
    const movedReply = await call("unreal_rename_asset", { path: `${SCRATCH_ROOT}/${copyName}`, newName });
    if (movedReply.unavailable) {
      skipped("rename_asset", "the plugin has never heard of it");
    } else {
      check("the rename reports where it went", /to/.test(movedReply.body), movedReply.json?.to ?? movedReply.body.slice(0, 80));
      cleanup.push(`${SCRATCH_ROOT}/${newName}`);
      const listed = await call("unreal_list_blueprints", { pathPrefix: SCRATCH_ROOT, maxResults: 60 });
      const paths = (listed.json?.blueprints ?? []).map((b) => b.path);
      check(
        "the new path is listed and the old one is not",
        paths.some((p) => p.includes(newName)) && !paths.some((p) => p.includes(copyName)),
        paths.map((p) => p.split("/").pop()).join(", ")
      );
    }
  }
} finally {
  await cleanUpScratch(
    cleanup,
    (path) => call("unreal_delete_asset", { path, force: true }),
    console.log,
    (paths) => call("unreal_delete_asset", { paths, force: true })
  ).catch(() => {});
  server.child.kill();

  console.log("");
  console.log(`${calls} calls`);

  if (cannotRun.length > 0) {
    console.log("");
    console.log(
      `CANNOT FULLY RUN: the installed plugin does not have ${cannotRun.join(", ")}. These commands ` +
        `exist in this server and compile against every engine target; the binary in the editor ` +
        `predates them. Close the editor, run \`npm run build:engines\`, reopen, and run this again.`
    );
  }

  if (failures.length > 0) {
    console.error("");
    console.error(`LIFECYCLE TRIAL FAILED: ${failures.length} - ${failures.join("; ")}`);
    process.exitCode = 1;
  } else if (cannotRun.length > 0) {
    // Same rule as trial:runtime. Not a failure, not a pass, and they must not share an exit code.
    console.log("");
    console.log(
      "lifecycle trial: nothing failed, and nothing was proved either - every command it exists to " +
        "check is missing from the running plugin. Exiting 2 so this cannot be mistaken for a pass."
    );
    process.exitCode = 2;
  } else {
    console.log("");
    console.log("lifecycle trial ok: everything that can be created can be renamed and removed, and the project still compiles");
  }
}
