import test from "node:test";
import assert from "node:assert/strict";

import { toolsNamedInAdvice, disabledToolNote, withDisabledToolNote } from "../dist/disabledTools.js";

/** Everything on except the ones named. */
// Everything on except the named ones - AND the dispatcher off, which is what "everything on"
// actually means in this server. `full` disables unreal_call_tool on purpose, because every tool is
// already listed and dispatching would add a hop and a schema. A fixture that left it on would model
// a profile that does not exist, and the note reads differently when the dispatcher is standing:
// there, enabling is the expensive route and there is a cheaper one to name.
const allOnExcept = (...off) => (name) =>
  name === "unreal_call_tool" ? false : off.includes(name) ? false : true;

/** Everything on INCLUDING the dispatcher, which is `search` and `lazy`. */
const withDispatcher = (...off) => (name) => (off.includes(name) ? false : true);

test("only the advice fields are scanned, not the whole reply", () => {
  // Scanning everything would be simpler and wrong. unreal_list_tools names dozens of deliberately
  // disabled tools - that is its job - and a note listing all of them would be noise attached to the
  // one reply whose entire purpose is to describe what is off.
  const reply = {
    // Descriptions, summaries and catalogues are not instructions to act.
    summary: "unreal_build_graph places whole graphs",
    tools: [{ name: "unreal_add_node", what: "adds one node" }],
    next: "Fix it with unreal_remove_node.",
  };
  assert.deepEqual(toolsNamedInAdvice(reply), ["unreal_remove_node"]);
});

test("everything under an advice field counts, however deep", () => {
  // `blockers` is an array of sentences and `groups[].fix` is one level below a field that is not
  // advice itself, so the walk has to carry the flag down rather than test the top level only.
  const reply = {
    groups: [{ check: "dead-node", fix: "Remove them with unreal_remove_node." }],
    blockers: ["BP_X: run unreal_compile_blueprint to read them"],
  };
  assert.deepEqual(toolsNamedInAdvice(reply), ["unreal_compile_blueprint", "unreal_remove_node"]);
});

test("a tool this server does not have is not reported as switched off", () => {
  // undefined is deliberately different from false. Telling a caller that a tool which does not
  // exist is "switched off" sends them to enable something they can never get - a renamed tool, or
  // one quoted in prose that was never real.
  const note = disabledToolNote(
    { next: "Try unreal_does_not_exist and unreal_remove_node." },
    (name) => (name === "unreal_remove_node" ? false : undefined)
  );
  assert.deepEqual(note.toolsNotEnabled, ["unreal_remove_node"]);
});

test("a reply whose named tools are all callable carries nothing", () => {
  // The whole design: a complete answer pays nothing for this. A field reading "0 tools not enabled"
  // on every good reply is a token cost for a fact already visible.
  const reply = { next: "Fix it with unreal_remove_node." };
  assert.equal(disabledToolNote(reply, allOnExcept()), undefined);
  assert.equal(withDisabledToolNote(reply, allOnExcept()), reply, "and the reply is returned untouched");
});

test("the note names the exact call that fixes it", () => {
  // Naming the group would be the expensive answer - measured at 870 standing tokens for three
  // tools. The tools array is the cheap one, so the note spells that call out rather than leaving
  // the reader to work out the cheaper form.
  const note = disabledToolNote(
    { next: "unreal_set_data_table_row repairs it, then unreal_save_asset." },
    allOnExcept("unreal_set_data_table_row", "unreal_save_asset")
  );
  assert.match(note.toolsNotEnabledNote, /enable_tools\(\{ tools: \["unreal_save_asset", "unreal_set_data_table_row"\] \}\)/);
  assert.match(note.toolsNotEnabledNote, /less than a whole group/);
});

test("a tool named twice is named once", () => {
  const note = disabledToolNote(
    { next: "unreal_remove_node here and unreal_remove_node there.", fix: "unreal_remove_node again." },
    allOnExcept("unreal_remove_node")
  );
  assert.deepEqual(note.toolsNotEnabled, ["unreal_remove_node"]);
});

test("an empty or absent reply is not an error", () => {
  assert.deepEqual(toolsNamedInAdvice({}), []);
  assert.deepEqual(toolsNamedInAdvice(null), []);
  assert.deepEqual(toolsNamedInAdvice("unreal_remove_node"), [], "a bare string is not an advice field");
});

test("with the dispatcher standing, the note points at it rather than at enabling", () => {
  // On `search` and `lazy`, unreal_call_tool is listed and runs any registered tool without touching
  // the tool list. unreal_enable_tools changes the list, and changing the list re-charges the whole
  // cached prefix - so the old note recommended the expensive route on exactly the profiles that
  // have the cheap one.
  const enabled = withDispatcher("unreal_auto_layout_graph");
  const note = disabledToolNote({ fix: "Run unreal_auto_layout_graph." }, enabled);

  assert.deepEqual(note.toolsNotEnabled, ["unreal_auto_layout_graph"]);
  assert.match(note.toolsNotEnabledNote, /unreal_call_tool/);
  assert.doesNotMatch(
    note.toolsNotEnabledNote,
    /unreal_enable_tools\(/,
    "must not steer to the call that invalidates the cache when a wrapper would do"
  );
  assert.doesNotMatch(note.toolsNotEnabledNote, /switched off/, "they are unlisted, not unreachable");
});

test("without it, the advice is still to enable, because that is the only route", () => {
  // `full` disables the dispatcher on purpose - everything is already listed - and `core` never had
  // it. There, enabling really is what a caller has to do.
  const enabled = allOnExcept("unreal_auto_layout_graph");
  const note = disabledToolNote({ fix: "Run unreal_auto_layout_graph." }, enabled);

  assert.match(note.toolsNotEnabledNote, /unreal_enable_tools\(/);
  assert.doesNotMatch(note.toolsNotEnabledNote, /unreal_call_tool\(/);
});
