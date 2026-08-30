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
