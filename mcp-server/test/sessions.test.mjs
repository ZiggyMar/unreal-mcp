import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewSessions } from "../dist/sessions.js";

/**
 * The shape that produced this check: a host button and a server list, each building their own
 * params, with the LAN checkbox set differently. Both compile, both "work", the list stays empty.
 */
function graph(blueprint, nodes, live) {
  return {
    blueprint,
    path: `/Game/${blueprint}.${blueprint}`,
    graphName: "EventGraph",
    nodes,
    liveNodeIds: new Set(live ?? nodes.map((n) => n.id)),
  };
}
function call(id, title, paramsId) {
  return {
    id,
    type: "K2Node_CallFunction",
    title,
    connectedPins: paramsId ? [{ pin: "Params", direction: "in", linkedTo: [{ node: paramsId, pin: "ReturnValue" }] }] : [],
  };
}
function params(id, title) {
  return { id, type: "K2Node_CallFunction", title, connectedPins: [] };
}
const pins = (map) => async (_path, _graph, nodeId) => map[nodeId] ?? [];

test("hosting on LAN while searching online is reported", async () => {
  const review = await reviewSessions(
    [
      graph("WB_HostButton", [call("h", "Create Kronos Match", "hp"), params("hp", "Make Kronos Host Params")]),
      graph("WB_ServerList", [call("s", "Find Kronos Matches", "sp"), params("sp", "Make Kronos Search Params")]),
    ],
    pins({ hp: [{ name: "bIsLanMatch", defaultValue: "true" }], sp: [{ name: "bIsLanQuery", defaultValue: "False" }] })
  );
  const found = review.findings.find((f) => f.check === "session-lan-mismatch");
  assert.ok(found, `expected a mismatch, got ${review.findings.map((f) => f.check).join(", ") || "nothing"}`);
  assert.match(found.message, /WB_HostButton/);
  assert.match(found.message, /WB_ServerList/);
});

test("a project that agrees is left alone", async () => {
  // The expensive failure for this check is not missing one - it is sending somebody to rewrite a
  // working menu.
  const review = await reviewSessions(
    [
      graph("WB_HostButton", [call("h", "Create Session", "hp"), params("hp", "Make Host Params")]),
      graph("WB_ServerList", [call("s", "Find Sessions", "sp"), params("sp", "Make Search Params")]),
    ],
    pins({ hp: [{ name: "bUseLAN", defaultValue: "true" }], sp: [{ name: "bUseLAN", defaultValue: "true" }] })
  );
  assert.deepEqual(review.findings.map((f) => f.check), []);
});

test("abandoned menu code does not raise an alarm", async () => {
  // A shipping project's lobby is full of dead session nodes from earlier attempts. One button in
  // the project this came from had 46 dead nodes, including a whole earlier generation.
  const nodes = [
    call("live", "Create Kronos Match", "lp"),
    params("lp", "Make Kronos Host Params"),
    call("dead", "Create Session", "dp"),
    params("dp", "Make Host Params"),
    call("find", "Find Kronos Matches", "fp"),
    params("fp", "Make Kronos Search Params"),
  ];
  const review = await reviewSessions(
    [graph("WB_HostButton", nodes, ["live", "find"])],
    pins({
      lp: [{ name: "bIsLanMatch", defaultValue: "true" }],
      dp: [{ name: "bUseLAN", defaultValue: "False" }],
      fp: [{ name: "bIsLanQuery", defaultValue: "true" }],
    })
  );
  assert.deepEqual(review.findings.map((f) => f.check), [], "the dead node's flag must not count");
});

test("two live host buttons configured differently are reported", async () => {
  const review = await reviewSessions(
    [
      graph("WB_MainMenu", [call("a", "Create Kronos Match", "ap"), params("ap", "Make Kronos Host Params")]),
      graph("WB_ServerList", [call("b", "Create Kronos Match", "bp"), params("bp", "Make Kronos Host Params")]),
    ],
    pins({ ap: [{ name: "bIsLanMatch", defaultValue: "False" }], bp: [{ name: "bIsLanMatch", defaultValue: "true" }] })
  );
  const found = review.findings.find((f) => f.check === "session-host-paths-disagree");
  assert.ok(found);
  assert.match(found.fix, /one shared function/i);
});

test("params that come from a variable are not guessed at", async () => {
  // Reporting "LAN=undefined" as a mismatch would be inventing a finding.
  const review = await reviewSessions(
    [
      graph("WB_HostButton", [call("h", "Create Kronos Match")]),
      graph("WB_ServerList", [call("s", "Find Kronos Matches")]),
    ],
    pins({})
  );
  assert.equal(review.findings.filter((f) => f.check === "session-lan-mismatch").length, 0);
});

test("hosting with nothing that ever searches is worth saying once", async () => {
  const review = await reviewSessions(
    [graph("WB_HostButton", [call("h", "Create Kronos Match", "hp"), params("hp", "Make Kronos Host Params")])],
    pins({ hp: [{ name: "bIsLanMatch", defaultValue: "true" }] })
  );
  assert.ok(review.findings.some((f) => f.check === "session-host-without-search"));
});
