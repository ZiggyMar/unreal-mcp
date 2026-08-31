#!/usr/bin/env node
// Plant a replication bug, WATCH it fail on the client, fix it, and watch it stop failing.
//
// trial-diagnose walks the static loop: plant a defect in a graph and check the tools find it.
// This walks the loop nothing here could walk at all - the one where the answer is "run it and see".
//
// It exists because of a specific class of bug this project prices at the top of its scale and could
// only ever ARGUE about. A server writes a value that is not replicated; on the host everything
// works, and on every client the value never arrives. One person cannot reproduce it. Static
// analysis can say "that variable is not marked Replicated", which is true and is not the same as
// watching the client sit at zero while the server counts.
//
// So the trial does both halves:
//
//   1. Build an actor whose server copy increments a NON-replicated counter every tick.
//   2. Play with two players, and assert the Authority world's value moves while the Client's
//      does not. That is the bug, observed.
//   3. Fix it with set_variable_replication - the tool that exists so the audit can act on its own
//      most expensive finding - and play again.
//   4. Assert the Client's value now moves too. That is the fix, observed.
//
// Step 4 is the point. Every other check in this repository can tell you a change was WRITTEN.
// This is the only one that can tell you it WORKED.
//
// Needs a running editor. Deliberately not part of `npm test`, which runs in CI with no engine.
//
// Usage: node scripts/trial-runtime.mjs

import { startAndInitialize } from "./lib/mcpStdio.mjs";

const NL = String.fromCharCode(10);
const PKG = "/Game/__MCPRuntimeTrial/BP_RuntimeTrial";
const PATH = `${PKG}.BP_RuntimeTrial`;
const WATCH = "BP_RuntimeTrial.Ticks";

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "trial-runtime");

let calls = 0;
const stalls = [];

async function step(label, name, args, check) {
  calls++;
  const r = await server.request("tools/call", { name, arguments: args });
  const text = ((r.result && r.result.content) || []).map((c) => c.text || "").join("") || JSON.stringify(r.error || {});
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not every reply is JSON */
  }
  const problem = r.error ? `JSON-RPC error: ${JSON.stringify(r.error).slice(0, 160)}` : check ? check(text, parsed) : null;
  if (problem) stalls.push({ label, problem, reply: text.slice(0, 300).split(NL).join(" ") });
  console.log(`  ${label.padEnd(42)} ${String(Math.round(text.length / 4)).padStart(5)} tok${problem ? "   <-- STALL" : ""}`);
  return { text, parsed };
}

/**
 * Let real time pass.
 *
 * Not a politeness. Sampling happens on the editor's tick, and the bridge runs on that same thread,
 * so the only way a sample differs from the one before it is for this process to stop asking and let
 * the editor run.
 */
const letItRun = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull one role's row out of a watch_runtime reply. */
function roleRow(parsed, roleStartsWith) {
  const rows = (parsed && parsed.watched) || [];
  return rows.find((r) => String(r.role || "").startsWith(roleStartsWith)) || null;
}

async function playAndWatch(phase) {
  await step(`${phase}: stop anything already running`, "unreal_stop_pie", {});
  await letItRun(1500);

  await step(`${phase}: play, two players, listen server`, "unreal_start_pie", { numPlayers: 2, listenServer: true },
    (t, j) => (j && j.requested ? null : "PIE was not requested"));

  // PIE starts on a later tick, and starting two worlds is not instant.
  let worlds = 0;
  for (let attempt = 0; attempt < 20 && worlds < 2; attempt++) {
    await letItRun(1000);
    const r = await server.request("tools/call", { name: "unreal_pie_status", arguments: {} });
    const text = ((r.result && r.result.content) || []).map((c) => c.text || "").join("");
    try {
      worlds = (JSON.parse(text).worlds || []).length;
    } catch {
      worlds = 0;
    }
  }
  console.log(`  ${`${phase}: worlds up`.padEnd(42)} ${String(worlds).padStart(5)}`);
  if (worlds < 2) {
    stalls.push({
      label: `${phase}: two worlds`,
      problem: `only ${worlds} PIE world(s) came up, so a client-versus-server difference cannot be seen at all`,
      reply: "",
    });
  }

  await step(`${phase}: start watching`, "unreal_watch_runtime", { action: "start", watch: [WATCH], intervalMs: 150 },
    (t, j) => (j && j.watching ? null : "watching did not start"));

  await letItRun(4000);

  const read = await step(`${phase}: read what changed`, "unreal_watch_runtime", { action: "read" }, (t, j) => {
    if (!j || !Array.isArray(j.watched)) return "no watched array came back";
    if (j.notFound) return `nothing matched ${WATCH}: ${String(j.notFound).slice(0, 120)}`;
    if (j.watched.length === 0) return "nothing was sampled";
    return null;
  });

  await step(`${phase}: stop watching`, "unreal_watch_runtime", { action: "stop" });
  await step(`${phase}: stop playing`, "unreal_stop_pie", {});
  await letItRun(1500);
  return read.parsed;
}

// -------------------------------------------------------------------------------------------------
// Check the editor can answer at all, before spending twenty-three calls finding out.
//
// The first run of this took eleven minutes to fail and printed nothing while it did, because every
// call sat on its own 60-second timeout and the whole run was buffered. The editor was up, the
// bridge was listening and the game thread was blocked - the project's startup map was an Open World
// template, which does enough work on load to stop answering.
//
// One ping first turns eleven silent minutes into one sentence.
// -------------------------------------------------------------------------------------------------
{
  const r = await server.request("tools/call", { name: "unreal_ping", arguments: {} });
  const text = ((r.result && r.result.content) || []).map((c) => c.text || "").join("");
  let ok = false;
  try {
    ok = Boolean(JSON.parse(text).project || JSON.parse(text).ok);
  } catch {
    ok = false;
  }
  if (!ok) {
    console.error("the editor is not answering, so there is nothing to trial:" + NL);
    console.error("  " + text.slice(0, 400).split(NL).join(NL + "  "));
    console.error(
      NL +
        "A bridge that accepts a connection and never replies means the game thread is blocked." + NL +
        "An Open World startup map will do it. Open a simple level and run this again."
    );
    process.exit(1);
  }
  console.log(`editor answering: ${text.slice(0, 120).split(NL).join(" ")}`);
}

// -------------------------------------------------------------------------------------------------
// Build the thing. An actor that counts, but only where it has authority.
//
// The authority branch is what makes this a replication demonstration rather than two machines
// counting independently. Without it both worlds increment their own copy and the numbers match for
// entirely the wrong reason - which would be a trial that passes while proving nothing.
// -------------------------------------------------------------------------------------------------
console.log("building an actor that counts on the server only");

await step("create the Blueprint", "unreal_create_blueprint", { packagePath: PKG, parentClass: "Actor", save: false },
  (t, j) => (j && j.path ? null : "no asset path came back"));

await step("add the counter variable", "unreal_add_variable", { path: PATH, variableName: "Ticks", type: "int" },
  (t, j) => (j && j.added ? null : "the variable was not added"));

// The actor itself has to replicate before a variable on it can. Setting this now means the only
// thing that changes between the two runs below is the variable's own replication, which is what the
// trial claims to be measuring.
await step("make the actor replicate", "unreal_set_class_default", { path: PATH, propertyName: "bReplicates", value: "true" });

await step("count, but only with authority", "unreal_build_graph", {
  path: PATH,
  graphName: "EventGraph",
  nodes: [
    { ref: "tick", nodeType: "Event", eventName: "ReceiveTick" },
    // NOT pure. Actor.h declares HasAuthority as UFUNCTION(BlueprintCallable) with no BlueprintPure,
    // so it is an impure node with exec pins and has to sit IN the chain rather than feed it from
    // the side. Checked against the engine header rather than assumed - a pure node here would have
    // failed to wire and the trial would have blamed the wrong thing.
    { ref: "auth", nodeType: "CallFunction", functionName: "HasAuthority" },
    { ref: "br", nodeType: "Branch" },
    { ref: "get", nodeType: "VariableGet", variableName: "Ticks" },
    { ref: "add", nodeType: "CallFunction", functionName: "Add_IntInt", className: "KismetMathLibrary", pure: true },
    { ref: "set", nodeType: "VariableSet", variableName: "Ticks" },
  ],
  connections: [
    { from: "tick.then", to: "auth.execute" },
    { from: "auth.then", to: "br.execute" },
    { from: "auth.ReturnValue", to: "br.Condition" },
    { from: "br.then", to: "set.execute" },
    { from: "get.Ticks", to: "add.A" },
    { from: "add.ReturnValue", to: "set.Ticks" },
  ],
  pinDefaults: [{ node: "add", pin: "B", value: "1" }],
  compile: true,
}, (t, j) => (j && j.nodes ? null : "the graph did not come back built"));

await step("save it", "unreal_save_blueprint", { path: PATH });

await step("put one in the level", "unreal_spawn_actor",
  { actorClass: PATH, label: "MCPRuntimeTrial", locX: 0, locY: 0, locZ: 200 },
  (t, j) => (j && (j.spawned || j.name || j.label) ? null : "nothing was spawned"));

// Deliberately NOT saving the level.
//
// PIE runs the world that is in memory, so a spawned actor is there whether or not the map has been
// written to disk - and saving it is actively harmful. The first run of this trial saved a level
// that happened to be an ENGINE template map, which cannot be written in place, so the editor opened
// InternalPromptForCheckoutAndSave and sat on it. Every call after that timed out.
//
// Worth recording because the window title did NOT change: the editor still read
// "UnrealMCPTest56 - Unreal Editor" while blocked, so the dialog-naming diagnostic in
// bridgeClient.ts would not have caught this one. It catches the dialogs that own the main window,
// like Restore Packages, and not the ones that do not.

// -------------------------------------------------------------------------------------------------
// The bug, observed.
// -------------------------------------------------------------------------------------------------
console.log(NL + "the bug: Ticks is not replicated");

const broken = await playAndWatch("unreplicated");

const brokenAuth = roleRow(broken, "Authority");
const brokenClient = roleRow(broken, "Client");
if (brokenAuth) console.log(`      Authority  ${brokenAuth.first} -> ${brokenAuth.last}   changed=${brokenAuth.changed}`);
if (brokenClient) console.log(`      Client     ${brokenClient.first} -> ${brokenClient.last}   changed=${brokenClient.changed}`);

if (!brokenAuth || !brokenAuth.changed) {
  stalls.push({
    label: "the server counts",
    problem: "the Authority world's Ticks never changed, so the actor is not doing its job and nothing below means anything",
    reply: JSON.stringify(brokenAuth || null).slice(0, 200),
  });
}
if (brokenClient && brokenClient.changed) {
  stalls.push({
    label: "the client does NOT receive it",
    problem: "the Client world's Ticks changed even though the variable is not replicated - the trial is not demonstrating what it claims",
    reply: JSON.stringify(brokenClient).slice(0, 200),
  });
}

// -------------------------------------------------------------------------------------------------
// The fix, and the same observation again.
// -------------------------------------------------------------------------------------------------
console.log(NL + "the fix: mark it replicated, with the tool the audit points at");

await step("set_variable_replication -> replicated", "unreal_set_variable_replication",
  { path: PATH, variableName: "Ticks", mode: "replicated" },
  (t, j) => (j && j.changed ? null : "replication was not changed"));

await step("compile", "unreal_compile_blueprint", { path: PATH },
  (t, j) => (j && j.success ? null : "the Blueprint did not compile after the change"));

await step("save", "unreal_save_blueprint", { path: PATH });

const fixed = await playAndWatch("replicated");

const fixedAuth = roleRow(fixed, "Authority");
const fixedClient = roleRow(fixed, "Client");
if (fixedAuth) console.log(`      Authority  ${fixedAuth.first} -> ${fixedAuth.last}   changed=${fixedAuth.changed}`);
if (fixedClient) console.log(`      Client     ${fixedClient.first} -> ${fixedClient.last}   changed=${fixedClient.changed}`);

if (!fixedClient) {
  stalls.push({ label: "the client is sampled at all", problem: "no Client row came back after the fix", reply: "" });
} else if (!fixedClient.changed) {
  stalls.push({
    label: "the client NOW receives it",
    problem: "the Client world's Ticks still never changed after marking the variable Replicated - the fix did not take, or replication is not reaching the client",
    reply: JSON.stringify(fixedClient).slice(0, 200),
  });
}

// -------------------------------------------------------------------------------------------------
console.log(NL + "cleaning up");
await step("delete the trial asset", "unreal_delete_asset", { path: PATH, force: true });

console.log(NL + `${calls} calls`);
if (stalls.length > 0) {
  console.error(NL + `runtime trial FAILED (${stalls.length}):`);
  for (const s of stalls) {
    console.error(`  - ${s.label}: ${s.problem}`);
    if (s.reply) console.error(`      ${s.reply}`);
  }
  process.exit(1);
}
console.log(NL + "runtime trial ok: the bug was seen on a running client, fixed, and seen to stop");
process.exit(0);
