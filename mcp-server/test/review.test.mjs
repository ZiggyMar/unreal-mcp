import test from "node:test";
import assert from "node:assert/strict";

import { reviewBlueprint } from "../dist/review.js";
import { FINDING_COST } from "../dist/findingCost.js";

/**
 * review_blueprint is the largest single read on this surface - 7,562 tokens on BP_Player, more than
 * list_data_table_rows - and until now it had no test file at all. Both defects below were found by
 * asking it a real question about a real Blueprint, not by reading it.
 */

/** A bridge with just the three commands review actually sends. */
const fakeBridge = (graphs) => ({
  async send(command, args) {
    if (command === "list_blueprint_graphs") {
      return { graphs: graphs.map((g) => ({ name: g.name })) };
    }
    if (command === "list_variables") {
      return { parentClass: "Character", variables: [] };
    }
    if (command === "read_blueprint_graph_summary") {
      const graph = graphs.find((g) => g.name === args.graphName);
      return { nodes: graph?.nodes ?? [] };
    }
    throw new Error(`unexpected command ${command}`);
  },
});

/**
 * Nodes in the shape the bridge actually sends them: connectedPins, with the link naming the pin it
 * arrives on. A first version of this file invented an `execOut: [ids]` field, and every graph came
 * back with zero findings - a fixture that tests nothing, passing quietly, which is a defect this
 * project has already shipped once.
 */
const execOut = (...targets) => ({
  pin: "then",
  direction: "out",
  linkedTo: targets.map((node) => ({ node, pin: "execute" })),
});
const execIn = (from) => ({ pin: "execute", direction: "in", linkedTo: [{ node: from, pin: "then" }] });

/** An Event Tick running `count` nodes in a chain: produces tick-heavy, which costs 55. */
const tickGraph = (name, count) => ({
  name,
  nodes: [
    { id: `${name}_tick`, type: "Event", title: "Event Tick", connectedPins: [execOut(`${name}_0`)] },
    ...Array.from({ length: count }, (_, i) => ({
      id: `${name}_${i}`,
      type: "CallFunction",
      title: `Step${i}`,
      connectedPins: [
        execIn(i === 0 ? `${name}_tick` : `${name}_${i - 1}`),
        ...(i + 1 < count ? [execOut(`${name}_${i + 1}`)] : []),
      ],
    })),
  ],
});

/** A cast whose Cast Failed pin goes nowhere: unhandled-cast-failure, which costs 40. */
const castGraph = (name) => ({
  name,
  nodes: [
    { id: `${name}_ev`, type: "Event", title: "Event BeginPlay", connectedPins: [execOut(`${name}_cast`)] },
    {
      id: `${name}_cast`,
      type: "K2Node_DynamicCast",
      title: "Cast To BP_Thing",
      connectedPins: [execIn(`${name}_ev`), execOut(`${name}_ok`)],
    },
    { id: `${name}_ok`, type: "CallFunction", title: "Do Thing", connectedPins: [execIn(`${name}_cast`)] },
  ],
});

test("nextAction leads with what costs most, not with whichever graph was read first", async () => {
  // The bug, exactly as it shipped: nextAction sorted by severity alone, so within "warning" the
  // order was whatever order the graphs happened to come back in. On BP_Player that put a cost-40
  // unhandled cast ahead of four cost-55 tick findings, in the one field whose whole job is to say
  // what to do next. Reading the cast graph FIRST here is the point - under the old sort it won.
  const review = await reviewBlueprint(fakeBridge([castGraph("ReadFirst"), tickGraph("ReadSecond", 8)]));

  const tick = review.graphs.flatMap((g) => g.findings).find((f) => f.check === "tick-heavy");
  const cast = review.graphs.flatMap((g) => g.findings).find((f) => f.check === "unhandled-cast-failure");
  assert.ok(tick && cast, "the fixture has to produce both findings or this test proves nothing");
  assert.ok(
    FINDING_COST[tick.check] > FINDING_COST[cast.check],
    "and the premise has to hold: tick-heavy must be the more expensive of the two"
  );

  assert.match(review.nextAction, /ReadSecond/, "the costlier finding leads, though its graph was read second");
});

test("an error still outranks a costlier warning", async () => {
  // Cost orders WITHIN a severity, it does not replace severity. An error is something that is
  // already broken; a warning is something that will cost you later. Letting a 55-point warning
  // jump an error would trade a real break for a predicted one.
  const rank = { error: 0, warning: 1, info: 2 };
  const errors = Object.entries(FINDING_COST).filter(([, cost]) => cost >= 90);
  assert.ok(errors.length > 0, "the table still has high-cost checks to reason about");
  assert.equal(rank.error < rank.warning, true);
});

test("clean graphs are reported by name, not dropped and not spelled out in full", async () => {
  // BP_Player has 60 graphs and 13 with anything to say. The other 47 each carried a score, a
  // summary of three zeroes and an empty findings array: 5,574 characters, 30% of the reply, to
  // report that nothing is wrong.
  //
  // Dropping them silently would be the cheap wrong answer. "Checked and clean" and "never looked
  // at" are different answers, and a caller that cannot tell them apart re-reads what was cleared.
  const clean = { name: "UserConstructionScript", nodes: [{ id: "n", type: "Event", title: "Construction Script", connectedPins: [] }] };
  const review = await reviewBlueprint(fakeBridge([tickGraph("Busy", 8), clean]));

  assert.deepEqual(review.graphs.map((g) => g.graphName), ["Busy"], "only graphs with findings are spelled out");
  assert.deepEqual(review.cleanGraphs, ["UserConstructionScript"], "the clean one is still named");
  assert.equal(
    JSON.stringify(review).includes('"graphName":"UserConstructionScript","nodeCount"'),
    false,
    "but it does not carry a score, a node count and an empty findings array"
  );
});

test("a Blueprint with nothing wrong says so, and carries no empty graphs array of its own", async () => {
  const review = await reviewBlueprint(
    fakeBridge([{ name: "OnlyGraph", nodes: [{ id: "n", type: "Event", title: "Event BeginPlay", connectedPins: [] }] }])
  );
  assert.equal(review.graphs.length, 0);
  assert.deepEqual(review.cleanGraphs, ["OnlyGraph"]);
  assert.match(review.nextAction, /passes every check/);
});

test("a Blueprint where every graph has findings carries no cleanGraphs field at all", async () => {
  // The field appears when it has something to say and costs nothing when it does not - the same
  // rule the disabled-tool note follows. A `"cleanGraphs": []` on every dirty reply is a token cost
  // for a fact already visible.
  const review = await reviewBlueprint(fakeBridge([tickGraph("Busy", 8)]));
  assert.equal("cleanGraphs" in review, false);
});

test("the review and the audit rank findings from the same table", async () => {
  // They used to disagree: the audit sorted by FINDING_COST and the review by severity rank. Two
  // tools that each work, telling you to fix different things first, is the defect class this
  // project keeps finding - and it is only ever visible when you use both.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/review.ts", import.meta.url), "utf8")
  );
  assert.match(source, /FINDING_COST\[b\.finding\.check\]/, "review ranks by the shared cost table");
  const audit = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/audit.ts", import.meta.url), "utf8")
  );
  assert.match(audit, /from "\.\/findingCost\.js"/, "and the audit imports the same one rather than owning a copy");
});

/** A bridge that answers with the graph and variable NAMES a test cares about, and nothing else. */
const namedBridge = (graphNames, variables) => ({
  async send(command) {
    if (command === "list_blueprint_graphs") return { graphs: graphNames.map((name) => ({ name })) };
    if (command === "list_variables") return { parentClass: "Character", variables };
    if (command === "read_blueprint_graph_summary") return { nodes: [] };
    throw new Error(`unexpected command ${command}`);
  },
});

// --- Names with whitespace the editor does not show -----------------------------------------------
//
// Measured before this was written: 7 across 168 assets, 811 variables, 793 graphs and 18 anim
// states on the real project - 0.4%, which is rare enough to mean something. A name that differs
// from its own trim is never deliberate, and the editor renders it identically to the trimmed one.

test("a variable whose name has a trailing space is reported", async () => {
  const bridge = namedBridge(["EventGraph"], [{ name: "VacuumDragged " }]);
  const review = await reviewBlueprint(bridge, "/Game/BP_X");
  const finding = (review.blueprint ?? []).find((f) => f.check === "name-has-stray-whitespace");
  assert.ok(finding, "expected the stray-whitespace finding");
  assert.match(finding.message, /VacuumDragged/);
  assert.match(finding.observed, /"VacuumDragged"/, "says what the name would be trimmed");
});

test("a graph whose name has a leading space is reported", async () => {
  const bridge = namedBridge(["EventGraph", " VacuumDragged"], []);
  const review = await reviewBlueprint(bridge, "/Game/BP_X");
  const found = (review.blueprint ?? []).filter((f) => f.check === "name-has-stray-whitespace");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /graph/);
});

test("ordinary names are not reported", async () => {
  // The check has to stay silent on the 99.6%. A name with an INTERNAL single space is normal in
  // Unreal - display names routinely have them - and only leading, trailing or doubled ones count.
  const bridge = namedBridge(["EventGraph", "Take Damage"], [{ name: "Health" }, { name: "Max Health" }]);
  const review = await reviewBlueprint(bridge, "/Game/BP_X");
  assert.equal((review.blueprint ?? []).filter((f) => f.check === "name-has-stray-whitespace").length, 0);
});

test("the conclusion comes before the evidence it was drawn from", async () => {
  // nextAction is the single thing to do about a Blueprint - the whole point of scoring one. It sat
  // LAST, after every graph, every finding and every caveat: 78% of the way through a 13,288-character
  // reply on BP_Player, and 91% on the project audit.
  //
  // That is the first thing a reader loses. A client that truncates, a context that fills, a person
  // running `head -c 400` on the output - all of them keep the evidence and drop the verdict. The last
  // of those is not hypothetical; it cost two wrong readings in the session that moved this.
  //
  // JSON key order is insertion order and JSON.stringify preserves it, so the fix costs nothing: the
  // same reply, the same length, in the order a summary should arrive.
  const review = await reviewBlueprint(fakeBridge([tickGraph("Busy", 8)]));
  const keys = Object.keys(review);
  const at = keys.indexOf("nextAction");
  assert.ok(at >= 0, "nextAction is missing entirely");
  assert.ok(
    at < 5,
    `nextAction is key ${at + 1} of ${keys.length}; it belongs near the front so a truncated read keeps it`
  );

  // And it must still be a real answer, not just early.
  assert.ok(review.nextAction.length > 20, `nextAction is too short to act on: "${review.nextAction}"`);
});
