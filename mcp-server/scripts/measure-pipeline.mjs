#!/usr/bin/env node
// Does the whole layout pipeline still work, against a real editor?
//
// Unit tests cover each piece. Running them as a pipeline has twice found something no unit test
// did, because both faults lived in how the pieces meet:
//
//   - a batch of two events went into one box named after the FIRST of them, because the naming fix
//     lived in a code path a small batch never reaches
//   - the fallback for a refused resize dropped the wrong moves, because the caller re-derived
//     which move needed the growth from geometry instead of being told
//
// Neither is visible without an editor. So this builds a throwaway Blueprint, drives the real tools
// through it, checks the outcome, and deletes it. Not part of `npm test` for the same reason
// measure:reads is not: it needs an editor open, and a check that cannot run gets switched off.
//
// Usage: node scripts/measure-pipeline.mjs   (needs an editor open on a project)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const BP = "/Game/AntiVirusSquad/_TEMP_PipelineCheck";
const KISMET = "/Script/Engine.KismetSystemLibrary";

const call = (tool, args) => {
  const out = execFileSync("node", [join(here, "call-tool.mjs"), tool, JSON.stringify(args), "--full"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  });
  const last = out.trim().split("\n").pop();
  try { return JSON.parse(last); } catch { return { _raw: last.slice(0, 300) }; }
};

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`  ${pass ? "ok    " : "FAIL  "} ${label}${detail ? `  (${detail})` : ""}`);
};

/** A chain of `count` nodes hanging off one custom event. */
function system(evName, tag, count) {
  const nodes = [{ ref: evName, nodeType: "CustomEvent", eventName: evName }];
  const connections = [{ from: `${evName}.then`, to: `${tag}0.execute` }];
  for (let i = 0; i < count; i++) nodes.push({ ref: `${tag}${i}`, nodeType: "CallFunction", functionName: "PrintString", className: KISMET });
  for (let i = 0; i < count - 1; i++) connections.push({ from: `${tag}${i}.then`, to: `${tag}${i + 1}.execute` });
  return { nodes, connections };
}

console.log("\nDriving the layout pipeline through a throwaway Blueprint\n");
call("unreal_delete_asset", { path: BP });                       // in case a previous run died
call("unreal_create_blueprint", { packagePath: BP, parentClass: "Actor" });

try {
  // A graph that already uses boxes, which is what boxForBatch asks before adding one.
  call("unreal_organize_graph", { path: BP, graphName: "EventGraph", action: "add_comment_box", x: -6000, y: -6000, width: 300, height: 200, text: "Existing" });

  // First batch: small graph, so build_graph lays the whole thing out itself.
  const a = system("CE_Warmup", "w", 5);
  const first = call("unreal_build_graph", { path: BP, graphName: "EventGraph", nodes: a.nodes, connections: a.connections, compile: true });
  check("a fresh graph is laid out in full", first.layout?.skipped !== true, `columns=${first.layout?.columns ?? "?"}`);

  // Second batch: the graph is populated now, so the layout is SKIPPED and placement runs instead.
  const b = system("CE_RepairStart", "r", 3), c = system("CE_RepairEnd", "q", 3);
  const second = call("unreal_build_graph", {
    path: BP, graphName: "EventGraph",
    nodes: [...b.nodes, ...c.nodes], connections: [...b.connections, ...c.connections], compile: true,
  });
  const layout = second.layout ?? {};
  const boxNote = String(layout.commentBox ?? "");
  check("a populated graph is NOT relaid out", layout.skipped === true);
  check("only the new nodes moved", layout.nodesMoved === 8, `moved=${layout.nodesMoved}`);
  check("the new system got a comment box", /Grouped as/.test(boxNote));
  // The bug an end-to-end run found: two events sharing a word must name the box for the word, not
  // for whichever event came first.
  check("named for the shared word, not the first event", boxNote.includes("Repair") && !boxNote.includes("Repair Start"), boxNote.slice(11, 40));

  const rev = call("unreal_review_layout", { path: BP });
  check("no backward execution wires", rev.backwardWires === 0, `back=${rev.backwardWires}`);
  check("nothing stacked", !(rev.findings ?? []).some((f) => f.kind === "stacked"));
  check("no box half-overlaps another", !(rev.findings ?? []).some((f) => f.kind === "overlappingBoxes"));

  // A Branch's `else` running leftward: invisible until the exec-pin names were fixed.
  const sum = call("unreal_read_blueprint_summary", { path: BP, graphName: "EventGraph", maxNodes: 300, withPositions: true });
  const last = (sum.nodes ?? []).filter((n) => /Print/.test(n.title ?? "")).sort((x, y) => y.x - x.x)[0];
  call("unreal_organize_graph", { path: BP, graphName: "EventGraph", action: "move_node", nodeId: last.id, x: last.x - 3000, y: last.y });
  check("a leftward chain is detected", (call("unreal_review_layout", { path: BP }).backwardWires ?? 0) >= 1);

  // Tidy either fixes it or says why, and both are correct outcomes.
  //
  // The first version of this check asserted "backwardWires === 0" afterwards and failed - because
  // the node had been dragged OUT of the box that owns its chain, and straightening it would carry
  // it back across a box edge. Tidy refuses to adopt a loose node into a box it is not currently in,
  // which is the guard doing its job. Asserting the mechanism made a correct refusal look like a
  // bug; the invariant is that the wire is either straightened or accounted for.
  const tidied = call("unreal_tidy_layout", { path: BP, graphName: "EventGraph", minY: -20000, maxY: 20000 });
  const after = call("unreal_review_layout", { path: BP });
  const explained = Boolean(tidied.heldByBox || tidied.resizeUnavailable);
  check(
    "tidy straightens it, or says why it cannot",
    after.backwardWires === 0 || explained,
    after.backwardWires === 0 ? "straightened" : "held, and reported"
  );
  check("tidy stacks nothing doing so", !(after.findings ?? []).some((f) => f.kind === "stacked"));
  check("no node was carried out of its comment box", !explained || after.backwardWires >= 1);
} finally {
  const gone = call("unreal_delete_asset", { path: BP });
  check("the throwaway Blueprint is deleted", gone.deleted === 1);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n  ${results.length - failed.length}/${results.length} checks passed.\n`);
process.exit(failed.length > 0 ? 1 : 0);
