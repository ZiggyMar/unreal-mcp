#!/usr/bin/env node
// Build a deliberately overloaded player Blueprint, then measure what reading it costs.
//
// Every other measurement here is taken on something small enough to be comfortable. The situation
// people describe is the opposite: one Blueprint that grew for eight months and now holds a dozen
// systems, where the question is not "can the tool build this" but "can a model still find its way
// around it afterwards".
//
// So this builds that Blueprint on purpose - many independent systems, each an event chain with
// branches and state - and reports what the reading tools cost against it. It scales with
// --systems so the numbers can be plotted rather than asserted once.
//
// Usage: node scripts/stress-build.mjs [--systems 24] [--keep]
//
// Creates /Game/MCPStress/BP_StressPlayer and deletes it afterwards unless --keep is passed.

import { UnrealBridgeClient } from "../dist/bridgeClient.js";
import { explainGraph } from "../dist/explainGraph.js";

const bridge = new UnrealBridgeClient({
  host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
});

const valueOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SYSTEMS = Number(valueOf("--systems", "24"));
const keep = process.argv.includes("--keep");

const ROOT = "/Game/MCPStress";
// The size is in the name so runs at different scales can coexist, and so a run never has to
// recreate a name it just deleted: a deleted UObject lingers until garbage collection, and creating
// over it would assert inside the engine. The bridge refuses that rather than crashing, which is
// how this was noticed.
const NAME = `BP_StressPlayer${SYSTEMS}`;
const PATH = `${ROOT}/${NAME}.${NAME}`;

/** The systems a real player Blueprint accumulates, in roughly the order they get added. */
const SYSTEM_NAMES = [
  "Movement", "Sprint", "Crouch", "Jump", "Health", "Damage", "Death", "Respawn",
  "Inventory", "Pickup", "Drop", "Interact", "Weapon", "Fire", "Reload", "Aim",
  "Ability", "Cooldown", "Stamina", "Footsteps", "Camera", "Save", "Score", "Team",
  "Vault", "Slide", "Ping", "Emote", "Chat", "Voice", "Loadout", "Perk",
];

const est = (value) => Math.round(JSON.stringify(value).length / 4);

async function main() {
  console.log(`building ${NAME} with ${SYSTEMS} systems\n`);

  await bridge.send("delete_asset", { paths: [PATH], force: true }).catch(() => {});
  await bridge.send("create_blueprint", { packagePath: `${ROOT}/${NAME}`, parentClass: "Character", save: false });

  const names = Array.from({ length: SYSTEMS }, (_, i) => SYSTEM_NAMES[i % SYSTEM_NAMES.length] + (i >= SYSTEM_NAMES.length ? String(i) : ""));

  // State first, so the graph nodes that set it have something to point at.
  for (const name of names) {
    await bridge.send("add_variable", { path: PATH, variableName: `b${name}Active`, type: "bool" });
    await bridge.send("add_variable", { path: PATH, variableName: `${name}Value`, type: "float", defaultValue: "1" });
  }
  console.log(`  ${names.length * 2} variables`);

  // Each system: an event, a branch, and work down both arms. No data pins are wired - this is
  // measuring the cost of reading structure, and an unwired condition costs exactly as much to
  // read as a wired one.
  let built = 0;
  for (const name of names) {
    try {
      await bridge.send("build_graph", {
        path: PATH,
        graphName: "EventGraph",
        nodes: [
          { ref: "evt", nodeType: "CustomEvent", eventName: `Sys_${name}` },
          { ref: "br", nodeType: "Branch" },
          { ref: "set1", nodeType: "VariableSet", variableName: `b${name}Active` },
          { ref: "call1", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
          { ref: "set2", nodeType: "VariableSet", variableName: `${name}Value` },
          { ref: "call2", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
          { ref: "call3", nodeType: "CallFunction", functionName: "PrintString", className: "KismetSystemLibrary" },
        ],
        connections: [
          { from: "evt.then", to: "br.execute" },
          { from: "br.then", to: "set1.execute" },
          { from: "set1.then", to: "call1.execute" },
          { from: "call1.then", to: "set2.execute" },
          { from: "set2.then", to: "call2.execute" },
          { from: "br.else", to: "call3.execute" },
        ],
        pinDefaults: [
          { node: "call1", pin: "In String", value: `${name} on` },
          { node: "call2", pin: "In String", value: `${name} done` },
          { node: "call3", pin: "In String", value: `${name} skipped` },
        ],
      });
      built += 1;
    } catch (err) {
      console.log(`  ! ${name}: ${err instanceof Error ? err.message.slice(0, 90) : err}`);
    }
  }
  console.log(`  ${built}/${names.length} systems wired`);

  await bridge.send("compile_blueprint", { path: PATH });

  // --- the measurement ---------------------------------------------------------------------
  const timed = async (label, fn) => {
    const start = Date.now();
    const value = await fn();
    return { label, ms: Date.now() - start, value };
  };

  const graphs = await timed("list_blueprint_graphs", () => bridge.send("list_blueprint_graphs", { path: PATH }));
  const summary = await timed("read_blueprint_graph_summary", () =>
    bridge.send("read_blueprint_graph_summary", { path: PATH, graphName: "EventGraph" })
  );
  const nodeCount = summary.value.nodes.length;
  const explained = explainGraph(summary.value);

  console.log(`\n${nodeCount} nodes in the EventGraph\n`);
  console.log("  what it costs to read this Blueprint");
  console.log("  ---------------------------------------------------------------");
  for (const step of [graphs, summary]) {
    console.log(`  ${step.label.padEnd(30)} ${String(step.ms).padStart(5)}ms  ${String(est(step.value)).padStart(6)} tok`);
  }
  console.log(`  ${"explain_graph".padEnd(30)} ${"".padStart(5)}     ${String(est(explained)).padStart(6)} tok`);
  console.log(`  ${"explain_graph (text only)".padEnd(30)} ${"".padStart(5)}     ${String(Math.round(explained.text.length / 4)).padStart(6)} tok`);
  const ratio = est(summary.value) / Math.round(explained.text.length / 4);
  console.log(`\n  reading the structure costs ${ratio.toFixed(1)}x the explanation`);
  console.log(`  per node: ${(est(summary.value) / nodeCount).toFixed(0)} tok structure, ${(Math.round(explained.text.length / 4) / nodeCount).toFixed(1)} tok explained`);

  console.log(`\n  first lines of the explanation:`);
  for (const line of explained.text.split("\n").slice(0, 4)) console.log(`    ${line.slice(0, 110)}`);

  if (!keep) {
    await bridge.send("delete_asset", { paths: [PATH], force: true }).catch(() => {});
    console.log("\ncleaned up");
  } else {
    console.log(`\nleft in place: ${PATH}`);
  }
}

main().catch((err) => {
  console.error(`stress build failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
