import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actionsForKey,
  chainsForAction,
  describeTrace,
  keyOfMapping,
  traceInput,
} from "../dist/traceInput.js";

const ctx = (context, actions) => ({ context, reply: { context, actions } });

test("keyOfMapping keeps the key and drops the modifiers", () => {
  assert.equal(keyOfMapping("Escape"), "Escape");
  assert.equal(keyOfMapping("S (Negate)"), "S");
  assert.equal(keyOfMapping("Gamepad_LeftStick_Y (SwizzleAxis, Negate)"), "Gamepad_LeftStick_Y");
});

test("a key matches its whole name, never a substring of another key", () => {
  // The reason this rule exists: "E" is the most common interact key in Unreal, and it is a
  // substring of Escape, End, Enter and Equals. A substring rule reports that pressing E opens the
  // pause menu, which is confidently wrong rather than merely unhelpful.
  const contexts = [
    ctx("IMC_Default", { IA_Interact: ["E"], IA_OpenPause: ["Escape"], IA_Back: ["End"] }),
  ];

  const forE = actionsForKey(contexts, "E");
  assert.deepEqual(
    forE.map((a) => a.action),
    ["IA_Interact"]
  );

  const forEscape = actionsForKey(contexts, "Escape");
  assert.deepEqual(
    forEscape.map((a) => a.action),
    ["IA_OpenPause"]
  );
});

test("a key bound in several contexts reports every one of them", () => {
  // Two contexts binding the same key is normal - a gameplay context and a menu context - and which
  // one is active decides what actually happens. Reporting only the first hides that.
  const contexts = [
    ctx("IMC_Default", { IA_OpenPause: ["Escape"] }),
    ctx("IMC_Menu", { IA_OpenPause: ["Escape"] }),
  ];
  const hits = actionsForKey(contexts, "Escape");
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].contexts, ["IMC_Default", "IMC_Menu"]);
});

test("key matching ignores case, because engine key names are typed by hand", () => {
  const contexts = [ctx("IMC_Default", { IA_OpenPause: ["Escape"] })];
  assert.equal(actionsForKey(contexts, "escape").length, 1);
});

test("chainsForAction will not let IA_Open claim IA_OpenPause's chains", () => {
  const explanation = {
    chains: [
      { entry: "EnhancedInputAction IA_OpenPause", entryId: "1", steps: ["Create WB_PauseScreen"] },
      { entry: "EnhancedInputAction IA_Open", entryId: "2", steps: ["Open Door"] },
    ],
  };
  const pause = chainsForAction(explanation, "IA_OpenPause");
  assert.deepEqual(
    pause.map((c) => c.entryId),
    ["1"]
  );

  const open = chainsForAction(explanation, "IA_Open");
  assert.deepEqual(
    open.map((c) => c.entryId),
    ["2"],
    "IA_Open must not also claim the IA_OpenPause chain"
  );
});

test("an action at the very start of the entry still matches", () => {
  // Found by mutation testing: flipping `at === 0` to `at !== 0` on the boundary check survived the
  // whole suite, because every fixture happened to put the action mid-title ("EnhancedInputAction
  // IA_Jump"). A chain titled with the bare action name has `at === 0`, and the mutant then reads
  // entry[-1] -> undefined, which /[a-z0-9_]/ happily matches once it is coerced to "undefined" -
  // so the chain is dropped and the handler vanishes from the answer.
  const explanation = { chains: [{ entry: "IA_OpenPause", entryId: "1", steps: ["Create WB_Pause"] }] };
  assert.deepEqual(
    chainsForAction(explanation, "IA_OpenPause").map((c) => c.entryId),
    ["1"]
  );
});

test("an action at the very end of the entry still matches", () => {
  // The other boundary, for the same reason: entry[at + len] is undefined past the end.
  const explanation = { chains: [{ entry: "Event IA_OpenPause", entryId: "1", steps: [] }] };
  assert.deepEqual(
    chainsForAction(explanation, "IA_OpenPause").map((c) => c.entryId),
    ["1"]
  );
});

test("an empty action matches nothing rather than everything", () => {
  const explanation = { chains: [{ entry: "EnhancedInputAction IA_Jump", entryId: "1", steps: [] }] };
  assert.deepEqual(chainsForAction(explanation, ""), []);
  assert.deepEqual(chainsForAction(explanation, "   "), []);
});

/** A bridge whose replies are fixtures, so the orchestration is what is under test. */
function stubBridge(overrides = {}) {
  const calls = [];
  const bridge = {
    async send(cmd, params) {
      calls.push({ cmd, params });
      if (overrides[cmd]) return overrides[cmd](params);
      switch (cmd) {
        case "list_assets":
          return params.className === "InputMappingContext"
            ? { assets: [{ name: "IMC_Default", path: "/Game/Input/IMC_Default" }] }
            : { assets: [{ name: "IA_OpenPause", path: "/Game/Input/IA_OpenPause" }] };
        case "read_input_context":
          return { context: "IMC_Default", actions: { IA_OpenPause: ["Escape"] } };
        case "find_references":
          return {
            referencedBy: [
              { assetName: "PC_Base", package: "/Game/GameMode/PC_Base", assetClass: "Blueprint" },
              { assetName: "IMC_Menu", package: "/Game/Input/IMC_Menu", assetClass: "InputMappingContext" },
            ],
          };
        case "read_blueprint_graph_summary":
          return { path: params.path };
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
  };
  return { bridge, calls };
}

const explainStub = () => ({
  chains: [
    {
      entry: "EnhancedInputAction IA_OpenPause",
      entryId: "n1",
      steps: ["Create WB_PauseScreen", "Add to Viewport"],
      truncated: false,
    },
  ],
});

test("tracing a key reaches the handler and reports what it actually does", async () => {
  const { bridge } = stubBridge();
  const trace = await traceInput(bridge, { key: "Escape" }, explainStub);

  assert.equal(trace.actions.length, 1);
  const action = trace.actions[0];
  assert.equal(action.action, "IA_OpenPause");
  assert.deepEqual(action.contexts, ["IMC_Default"]);
  assert.equal(action.handlers.length, 1);
  assert.equal(action.handlers[0].name, "PC_Base");
  // The point of the whole tool: the answer names the widget, so nobody has to guess it from a
  // filename that merely contains "pause".
  assert.ok(action.handlers[0].steps.join(" ").includes("WB_PauseScreen"));
});

test("the mapping context that binds the action is not reported as a handler", () => {
  // IMC_Menu references IA_OpenPause because it binds it. That is the binding, not a handler, and
  // listing it invites a reader to go looking for logic that is not there.
  const { bridge, calls } = stubBridge();
  return traceInput(bridge, { key: "Escape" }, explainStub).then((trace) => {
    const names = trace.actions[0].handlers.map((h) => h.name);
    assert.ok(!names.includes("IMC_Menu"));
    const read = calls.filter((c) => c.cmd === "read_blueprint_graph_summary");
    assert.equal(read.length, 1, "should not have opened the mapping context's graph");
  });
});

test("a referrer with no chain for the action is reported, not silently dropped", async () => {
  const { bridge } = stubBridge();
  const trace = await traceInput(bridge, { key: "Escape" }, () => ({ chains: [] }));
  assert.deepEqual(trace.actions[0].handlers, []);
  assert.deepEqual(trace.actions[0].referencedByWithoutHandler, ["PC_Base"]);
});

test("a referrer whose graph cannot be read is named rather than throwing", async () => {
  const { bridge } = stubBridge({
    read_blueprint_graph_summary: () => {
      throw new Error("no EventGraph");
    },
  });
  const trace = await traceInput(bridge, { key: "Escape" }, explainStub);
  assert.deepEqual(trace.actions[0].referencedByWithoutHandler, ["PC_Base"]);
});

test("the handler cap is reported, never a quiet truncation", async () => {
  // A capped audit that reads as complete is the failure this repo keeps finding in itself.
  const many = Array.from({ length: 5 }, (_, i) => ({
    assetName: `BP_${i}`,
    package: `/Game/BP_${i}`,
    assetClass: "Blueprint",
  }));
  const { bridge } = stubBridge({ find_references: () => ({ referencedBy: many }) });
  const trace = await traceInput(bridge, { key: "Escape", maxHandlers: 2 }, explainStub);

  assert.equal(trace.actions[0].handlers.length, 2);
  assert.ok(
    trace.notes.some((n) => n.includes("Stopped after reading 2 of 5")),
    `expected a truncation note, got ${JSON.stringify(trace.notes)}`
  );
});

test("an unbound key says so instead of returning an empty object", async () => {
  const { bridge } = stubBridge();
  const trace = await traceInput(bridge, { key: "F13" }, explainStub);
  assert.deepEqual(trace.actions, []);
  assert.match(describeTrace(trace), /not bound to any Input Action/);
});

test("the prose names the key, the action, the context and the steps", () => {
  const text = describeTrace({
    key: "Escape",
    actions: [
      {
        action: "IA_OpenPause",
        contexts: ["IMC_Default"],
        mappings: ["Escape"],
        handlers: [
          {
            path: "/Game/GameMode/PC_Base",
            name: "PC_Base",
            entry: "EnhancedInputAction IA_OpenPause",
            entryId: "n1",
            steps: ["Create WB_PauseScreen", "Add to Viewport"],
            truncated: false,
          },
        ],
        referencedByWithoutHandler: [],
      },
    ],
    notes: [],
  });

  assert.match(text, /Pressing Escape fires IA_OpenPause \(bound in IMC_Default\)/);
  assert.match(text, /PC_Base/);
  assert.match(text, /Create WB_PauseScreen -> Add to Viewport/);
});

test("an action that nothing handles reads as a finding, not as success", async () => {
  const { bridge } = stubBridge({ find_references: () => ({ referencedBy: [] }) });
  const trace = await traceInput(bridge, { key: "Escape" }, explainStub);
  assert.match(describeTrace(trace), /Nothing handles it/);
});
