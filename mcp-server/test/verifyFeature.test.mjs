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

/** A bridge that compiles clean, reviews perfectly, and answers a scripted trace. */
function tracingBridge(trace) {
  return {
    async send(cmd, params) {
      if (cmd === "compile_blueprint") return { success: true, errorCount: 0, warningCount: 0 };
      if (cmd === "trace_function_calls") {
        if (trace instanceof Error) throw trace;
        return trace;
      }
      if (cmd === "review_blueprint") return { score: 100, nextAction: undefined, graphNodes: [], variables: [] };
      if (cmd === "list_assets") return { assets: [] };
      return {};
    },
  };
}

const ASSET = "/Game/X/BP_Thing.BP_Thing";

test("a function nothing calls does not pass verification silently", async () => {
  // The gap this closes. Everything else here asks "does it compile and is it well made" - and a
  // function can pass all of that, score 100, and be called by nothing at all. Saying "pass" for that
  // is agreeing the feature is done when it does nothing.
  const result = await verifyFeature(tracingBridge({ reachable: [], unreachable: [] }), {
    paths: [ASSET],
    touchedGraphs: [{ asset: ASSET, graph: "ShowCountdown" }],
  });
  assert.equal(result.notReached.length, 1);
  assert.equal(result.notReached[0].why, "no Blueprint calls it at all");
  assert.ok(result.blockers.some((b) => /ShowCountdown/.test(b)), "and it leads the blockers");
});

test("the weak case says it is weak, and names why", async () => {
  // "No Blueprint call site" is not proof: a delegate binding, an interface dispatch, an override,
  // or a call from C++ all look identical from here. A first draft treated this as conclusive and
  // would have raised an alarm on every interface implementation in the project.
  const result = await verifyFeature(tracingBridge({ reachable: [], unreachable: [] }), {
    paths: [ASSET],
    touchedGraphs: [{ asset: ASSET, graph: "OnSomethingHappened" }],
  });
  const blocker = result.blockers.find((b) => /OnSomethingHappened/.test(b));
  assert.match(blocker, /not conclusive/i);
  assert.match(blocker, /delegate|interface|C\+\+/);
});

test("the strong case says it is strong", async () => {
  // Call sites exist and nothing runs them. There is no blind spot that explains this away.
  const result = await verifyFeature(
    tracingBridge({
      reachable: [],
      unreachable: [{ blueprint: "BP_Other", graph: "Unused", calls: "DoTheThing" }],
    }),
    { paths: [ASSET], touchedGraphs: [{ asset: ASSET, graph: "DoTheThing" }] }
  );
  assert.match(result.notReached[0].why, /every call site is itself unreachable/);
  assert.match(result.blockers.find((b) => /DoTheThing/.test(b)), /conclusive/);
});

test("a function something calls is not reported", async () => {
  const result = await verifyFeature(
    tracingBridge({ reachable: [{ blueprint: "BP_Caller", graph: "EventGraph", calls: "DoTheThing" }], unreachable: [] }),
    { paths: [ASSET], touchedGraphs: [{ asset: ASSET, graph: "DoTheThing" }] }
  );
  assert.deepEqual(result.notReached, []);
});

test("call sites for a DIFFERENT function do not count as callers", async () => {
  // trace_function_calls matches on substring, so asking about "Show" returns "ShowCountdown" and
  // "ShowHUD" alike. Counting those as callers of the function actually asked about would report a
  // dead function as alive - which is the failure this whole check exists to prevent.
  const result = await verifyFeature(
    tracingBridge({ reachable: [{ blueprint: "BP_Caller", graph: "EventGraph", calls: "ShowHUD" }], unreachable: [] }),
    { paths: [ASSET], touchedGraphs: [{ asset: ASSET, graph: "ShowCountdown" }] }
  );
  assert.equal(result.notReached.length, 1, "a call to a different function is not a call to this one");
});

test("a trace that could not run says so instead of passing quietly", async () => {
  // The first version swallowed every error here, and it swallowed a wrong parameter name for a
  // whole debugging session: the check reported nothing and looked exactly like it was working.
  const result = await verifyFeature(tracingBridge(new Error("missing_param: function")), {
    paths: [ASSET],
    touchedGraphs: [{ asset: ASSET, graph: "DoTheThing" }],
  });
  assert.match(result.notReached[0].why, /could not be traced/);
  assert.match(result.notReached[0].why, /missing_param/);
});

// A graph big enough for the style note to be a fair observation: several chains, no labelling at
// all. It used to take four nodes, because the check fired on almost anything - which was 41% of a
// real project's entire audit and is why the threshold moved. The point these tests make is
// unchanged: an info finding is not a reason to call a finished feature unfinished.
const unlabelledGraph = (chains = 4, perChain = 12) => {
  const out = [];
  for (let c = 0; c < chains; c += 1) {
    out.push({
      id: `ev${c}`,
      type: "CustomEvent",
      title: `Event${c}`,
      connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: `n${c}_0`, pin: "execute" }] }],
    });
    for (let i = 0; i < perChain; i += 1) {
      const pins = [
        { pin: "execute", direction: "in", linkedTo: [{ node: i === 0 ? `ev${c}` : `n${c}_${i - 1}`, pin: "then" }] },
      ];
      if (i < perChain - 1) pins.push({ pin: "then", direction: "out", linkedTo: [{ node: `n${c}_${i + 1}`, pin: "execute" }] });
      out.push({ id: `n${c}_${i}`, type: "CallFunction", title: `Do${c}_${i}`, connectedPins: pins });
    }
  }
  return out;
};

test("a style note does not mean the feature is unfinished", async () => {
  // Measured on the flow this tool exists for: create a Blueprint, add one variable, ask whether
  // the feature is done -> verdict "fail", score 99, blocked on "3 execution chains but only 0
  // comment box(es)". The rule was `score < 100`, which treats a style note exactly like a bug.
  //
  // A model that trusts the verdict then adds comment boxes to a feature that was already finished.
  // A model that learns not to trust it stops reading the tool - worse, because this is the last
  // call before telling the user the work is done, and it is only worth having if "fail" means
  // something is actually wrong.
  //
  // The fixture has to be two real chains, each event wired to something. A first version used three
  // events with no connections at all, which are DEAD NODES - a warning - so the test failed and was
  // right to: it was asserting the wrong thing, not catching a bug. Isolated nodes and unlabelled
  // chains are different findings at different severities, which is the whole distinction here.
  const chain = (event, step) => [
    {
      id: event,
      type: "Event",
      title: event,
      connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: step, pin: "execute" }] }],
    },
    {
      id: step,
      type: "CallFunction",
      title: `Do${step}`,
      connectedPins: [{ pin: "execute", direction: "in", linkedTo: [{ node: event, pin: "then" }] }],
    },
  ];
  const twoChains = unlabelledGraph();
  const result = await verifyFeature(fakeBridge({ "/Game/BP_New.BP_New": { compiles: true, nodes: twoChains } }), {
    paths: ["/Game/BP_New.BP_New"],
  });

  assert.equal(result.assets[0].problems.errors, 0);
  assert.equal(result.assets[0].problems.warnings, 0);
  assert.ok(result.assets[0].problems.infos > 0, "the fixture has to produce an info finding or this proves nothing");
  assert.equal(result.verdict, "pass", "info alone must not fail the verdict");
  assert.deepEqual(result.blockers, []);
});

test("the info finding is still reported, just not as a blocker", async () => {
  // Dropping it would trade a false alarm for a blind spot. It is worth knowing and it is not
  // "not finished".
  const wired = (event, step) => [
    {
      id: event,
      type: "Event",
      title: event,
      connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: step, pin: "execute" }] }],
    },
    {
      id: step,
      type: "CallFunction",
      title: `Do${step}`,
      connectedPins: [{ pin: "execute", direction: "in", linkedTo: [{ node: event, pin: "then" }] }],
    },
  ];
  const twoChains = unlabelledGraph();
  const result = await verifyFeature(fakeBridge({ "/Game/BP_New.BP_New": { compiles: true, nodes: twoChains } }), {
    paths: ["/Game/BP_New.BP_New"],
  });
  assert.ok(result.assets[0].nextAction, "the finding still reaches the caller");
  assert.ok(result.assets[0].score < 100, "and the score still reflects it");
});

test("a warning still fails the verdict", async () => {
  // The change narrows what blocks; it must not stop anything from blocking. An Event Tick running
  // a long chain is tick-heavy, which is a warning.
  const tick = [
    { id: "t", type: "Event", title: "Event Tick", connectedPins: [{ pin: "then", direction: "out", linkedTo: [{ node: "n0", pin: "execute" }] }] },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `n${i}`,
      type: "CallFunction",
      title: `Step${i}`,
      connectedPins: [
        { pin: "execute", direction: "in", linkedTo: [{ node: i === 0 ? "t" : `n${i - 1}`, pin: "then" }] },
        ...(i < 8 ? [{ pin: "then", direction: "out", linkedTo: [{ node: `n${i + 1}`, pin: "execute" }] }] : []),
      ],
    })),
  ];
  const result = await verifyFeature(fakeBridge({ "/Game/BP_Busy.BP_Busy": { compiles: true, nodes: tick } }), {
    paths: ["/Game/BP_Busy.BP_Busy"],
  });
  assert.ok(result.assets[0].problems.warnings > 0, "the fixture has to produce a warning");
  assert.equal(result.verdict, "fail");
  assert.equal(result.blockers.length, 1);
});

test("a Blueprint that does not compile still fails whatever its findings say", async () => {
  const result = await verifyFeature(fakeBridge({ "/Game/BP_Bad.BP_Bad": { compiles: false, errors: 2 } }), {
    paths: ["/Game/BP_Bad.BP_Bad"],
  });
  assert.equal(result.verdict, "fail");
  assert.match(result.blockers[0], /does not compile/);
});
