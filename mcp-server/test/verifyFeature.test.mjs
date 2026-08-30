import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyFeature } from "../dist/verifyFeature.js";

/**
 * A bridge that answers per (command, path), so a test can make one asset healthy and another
 * broken - which is the entire case this tool exists for.
 */
function fakeBridge(perPath) {
  return {
    async send(cmd, params = {}) {
      const path = params.path;
      const state = perPath[path];
      if (state === undefined) throw new Error(`no such asset: ${path}`);
      if (state.unreachable && cmd === "compile_blueprint") throw new Error(state.unreachable);

      switch (cmd) {
        case "compile_blueprint":
          return {
            success: state.compiles,
            errorCount: state.compiles ? 0 : (state.errors ?? 1),
            warningCount: 0,
            status: state.compiles ? "UpToDate" : "Error",
            messages: [],
          };
        case "list_blueprint_graphs":
          return { graphs: [{ name: "EventGraph", type: "Event" }] };
        case "read_blueprint_graph_summary":
          return { path, graphName: "EventGraph", nodes: state.nodes ?? [] };
        case "list_variables":
          return { variables: state.variables ?? [] };
        default:
          throw new Error(`unknown_cmd: ${cmd}`);
      }
    },
  };
}

/** A node with an event that is wired to nothing: a finding every review reports. */
const danglingEvent = [
  { id: "1", type: "K2Node_Event", title: "Event ActorBeginOverlap", connectedPins: [] },
];

test("a clean set of assets passes, and says so without a list of things to do", async () => {
  const bridge = fakeBridge({
    "/Game/A.A": { compiles: true, nodes: [] },
    "/Game/B.B": { compiles: true, nodes: [] },
  });

  const result = await verifyFeature(bridge, { touched: ["/Game/A.A", "/Game/B.B"] });

  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checked.length, 2);
  assert.match(result.next, /report the work as done/);
});

test("an asset touched twenty calls ago is still checked, not just the last one", async () => {
  // The failure this tool exists for: the model compiles what it touched last, sees success, and
  // reports done, while an earlier asset in the same feature no longer builds.
  const bridge = fakeBridge({
    "/Game/Broken.Broken": { compiles: false, errors: 3 },
    "/Game/Latest.Latest": { compiles: true, nodes: [] },
  });

  const result = await verifyFeature(bridge, {
    touched: ["/Game/Broken.Broken", "/Game/Latest.Latest"],
  });

  assert.equal(result.verdict, "fail");
  assert.equal(result.blockers.length, 1);
  assert.match(result.blockers[0], /Broken/);
  assert.match(result.blockers[0], /does not compile \(3 error\(s\)\)/);
});

test("compile failures are listed before review findings", async () => {
  const bridge = fakeBridge({
    "/Game/Messy.Messy": { compiles: true, nodes: danglingEvent },
    "/Game/Broken.Broken": { compiles: false },
  });

  const result = await verifyFeature(bridge, {
    // Deliberately the messy one first, so ordering cannot pass by accident.
    touched: ["/Game/Messy.Messy", "/Game/Broken.Broken"],
  });

  assert.equal(result.verdict, "fail");
  assert.match(result.blockers[0], /Broken/, `compile failure should lead, got: ${result.blockers[0]}`);
  assert.ok(
    result.blockers.some((b) => b.includes("Messy")),
    "the review finding should still be reported, just after"
  );
});

test("a Blueprint that does not compile is not reviewed, because its graph was rejected", async () => {
  const seen = [];
  const inner = fakeBridge({ "/Game/Broken.Broken": { compiles: false } });
  const bridge = {
    async send(cmd, params) {
      seen.push(cmd);
      return inner.send(cmd, params);
    },
  };

  await verifyFeature(bridge, { touched: ["/Game/Broken.Broken"] });
  assert.ok(seen.includes("compile_blueprint"));
  assert.ok(
    !seen.includes("read_blueprint_graph_summary"),
    "reviewing a rejected graph reports on something that does not exist"
  );
});

test("one unreachable asset does not lose the verdict on the others", async () => {
  const bridge = fakeBridge({
    "/Game/Gone.Gone": { unreachable: "asset_not_found: /Game/Gone.Gone" },
    "/Game/Fine.Fine": { compiles: true, nodes: [] },
  });

  const result = await verifyFeature(bridge, { touched: ["/Game/Gone.Gone", "/Game/Fine.Fine"] });

  assert.equal(result.verdict, "fail");
  assert.equal(result.assets.length, 2, "both assets should appear in the report");
  assert.ok(result.assets.find((a) => a.path === "/Game/Fine.Fine").compiled, "the healthy one is still checked");
  assert.match(result.blockers[0], /could not be checked/);
});

test("explicit paths override the journal, and repeats are checked once", async () => {
  let compiles = 0;
  const inner = fakeBridge({ "/Game/A.A": { compiles: true, nodes: [] } });
  const bridge = {
    async send(cmd, params) {
      if (cmd === "compile_blueprint") compiles++;
      return inner.send(cmd, params);
    },
  };

  const result = await verifyFeature(bridge, {
    paths: ["/Game/A.A", "/Game/A.A", "/Game/A.A"],
    touched: ["/Game/Ignored.Ignored"],
  });

  assert.deepEqual(result.checked, ["/Game/A.A"], "a feature touches one asset many times");
  assert.equal(compiles, 1, "checking the same asset four times costs four times and says the same thing");
  assert.match(result.scope, /paths you named/);
});

test("nothing written and nothing named says so rather than passing vacuously", async () => {
  const result = await verifyFeature(fakeBridge({}), { touched: [] });
  assert.equal(result.verdict, "fail", "an empty check must never read as a pass");
  assert.match(result.next, /Nothing to verify/);
});

test("project-wide journal entries are not mistaken for asset paths", async () => {
  // SessionJournal files commands with no target under "(project-wide)".
  const result = await verifyFeature(fakeBridge({}), { touched: ["(project-wide)"] });
  assert.deepEqual(result.checked, []);
  assert.equal(result.verdict, "fail");
});

test("a null Data Table reference fails verification, not just a broken Blueprint", async () => {
  // The bug that motivated this whole session was not in a graph. A row's class reference was
  // cleared to None; the engine resolved it to null and the spawner silently did nothing. A
  // verification step that only compiled Blueprints would have passed that build with a straight
  // face, which is exactly what happened.
  const bridge = {
    async send(cmd, params = {}) {
      if (cmd === "compile_blueprint") {
        return { success: true, errorCount: 0, warningCount: 0, status: "UpToDate", messages: [] };
      }
      if (cmd === "list_blueprint_graphs") return { graphs: [{ name: "EventGraph", type: "Event" }] };
      if (cmd === "read_blueprint_graph_summary") return { path: params.path, graphName: "EventGraph", nodes: [] };
      if (cmd === "list_variables") return { variables: [] };
      if (cmd === "list_data_table_rows") {
        if (!/DT_/.test(params.path)) throw new Error(`data_table_not_found: ${params.path}`);
        return {
          rows: [
            { rowName: "Good", values: { Cls: "/Game/X/BP_A.BP_A_C" } },
            { rowName: "Bad", values: { Cls: "None" } },
          ],
        };
      }
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };

  const r = await verifyFeature(bridge, { touched: ["/Game/BP_Fine.BP_Fine", "/Game/DT_Things.DT_Things"] });

  assert.equal(r.verdict, "fail", "a clean compile is not the same as a finished feature");
  assert.equal(r.dataTableNulls.length, 1);
  assert.equal(r.dataTableNulls[0].rowName, "Bad");
  assert.ok(r.blockers.some((b) => b.includes("DT_Things") && b.includes("Bad")));
});

test("Blueprints in scope are not reported as unreadable Data Tables", async () => {
  // verify_feature hands the whole touched set to the table sweep, and most of it is Blueprints.
  // "That is not a Data Table" is not a failure to read one, and reporting each as a problem would
  // bury the single real finding under one line per asset.
  const bridge = {
    async send(cmd, params = {}) {
      if (cmd === "compile_blueprint") return { success: true, errorCount: 0, warningCount: 0, status: "ok", messages: [] };
      if (cmd === "list_blueprint_graphs") return { graphs: [] };
      if (cmd === "list_variables") return { variables: [] };
      if (cmd === "list_data_table_rows") throw new Error(`data_table_not_found: ${params.path}`);
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };
  const r = await verifyFeature(bridge, { touched: ["/Game/BP_A.BP_A", "/Game/BP_B.BP_B"] });
  assert.equal(r.verdict, "pass");
  assert.deepEqual(r.dataTableNulls, []);
  assert.deepEqual(r.blockers, []);
});

test("one asset under two spellings is checked once, not twice", async () => {
  // The journal records the same Blueprint two ways: create_blueprint logs the package path and
  // build_graph logs the object path. Measured on a real two-asset trial, a Set of raw strings made
  // that four assets, and every blocker appeared twice - which reads as two separate problems.
  let compiles = 0;
  const bridge = {
    async send(cmd, params = {}) {
      if (cmd === "compile_blueprint") {
        compiles++;
        return { success: true, errorCount: 0, warningCount: 0, status: "ok", messages: [] };
      }
      if (cmd === "list_blueprint_graphs") return { graphs: [] };
      if (cmd === "list_variables") return { variables: [] };
      if (cmd === "list_data_table_rows") throw new Error("data_table_not_found");
      throw new Error(`unknown_cmd: ${cmd}`);
    },
  };

  const r = await verifyFeature(bridge, {
    touched: ["/Game/X/BP_Alpha", "/Game/X/BP_Alpha.BP_Alpha", "/Game/X/BP_Beta.BP_Beta", "/Game/X/BP_Beta"],
  });

  assert.deepEqual(r.checked, ["/Game/X/BP_Alpha.BP_Alpha", "/Game/X/BP_Beta.BP_Beta"]);
  assert.equal(compiles, 2, "two assets, two compiles - not four");
});
