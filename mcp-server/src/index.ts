#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { UnrealBridgeClient } from "./bridgeClient.js";
import { enrichSearchHits, isEnrichmentEnabled } from "./enrichment.js";
import { autoLayoutGraph } from "./autoLayout.js";
import { reviewBlueprint } from "./review.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { SessionJournal, isWrite } from "./journal.js";
import { mapSystem } from "./systemMap.js";
import { planFeature } from "./planFeature.js";
import { cleanupBlueprint } from "./cleanup.js";
import { addEventHandler } from "./eventHandler.js";
import { scaffoldBlueprint } from "./scaffold.js";
import { scaffoldWidget } from "./scaffoldWidget.js";
import { explainGraph } from "./explainGraph.js";
import { allPolicies, resolveMode } from "./mode.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AddNodeResult,
  AddVariableResult,
  BuildGraphResult,
  CompileBlueprintResult,
  ConnectPinsResult,
  CreateBlueprintResult,
  CreateFunctionResult,
  FindNodeResult,
  FindReferencesResult,
  GetProjectOverviewResult,
  NodeCatalogEntry,
  OrganizeGraphResult,
  ListBlueprintGraphsResult,
  ListBlueprintsResult,
  PingResult,
  ReadBlueprintGraphSummaryResult,
  ReadBlueprintNodeDetailResult,
  RemoveNodeResult,
  SaveBlueprintResult,
  SearchProjectResult,
  SetPinDefaultValueResult,
} from "./types.js";

const BRIDGE_HOST = process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765);

// Left unset, each command gets a timeout sized to what it actually costs on the game thread
// (see COMMAND_TIMEOUTS_MS in bridgeClient.ts). Set this only to force a single flat timeout.
const TIMEOUT_OVERRIDE_MS = process.env.UNREAL_MCP_TIMEOUT_MS ? Number(process.env.UNREAL_MCP_TIMEOUT_MS) : undefined;

// Which project this session is allowed to touch. Only one editor can hold the bridge port, so
// with two open, every call silently goes to whichever won. Setting this turns "silently edited the
// wrong project" into a refusal on the first call.
const EXPECT_PROJECT = process.env.UNREAL_MCP_EXPECT_PROJECT?.trim();

const rawBridge = new UnrealBridgeClient({ host: BRIDGE_HOST, port: BRIDGE_PORT, timeoutMs: TIMEOUT_OVERRIDE_MS });
const journal = new SessionJournal();

/**
 * Every command goes through here, so the change log cannot drift from what was actually sent.
 * Recording at each of the fifty call sites would be one forgotten line away from lying to the
 * user about what was touched, and a change log that is wrong is worse than none.
 */
/**
 * Confirm we are attached to the project the user meant, before the first write of the session.
 *
 * Checking only in unreal_doctor would not help: the failure is silent by nature, so it is found by
 * someone noticing damage rather than by anyone thinking to run a diagnosis. The check costs one
 * ping, once, and only when UNREAL_MCP_EXPECT_PROJECT is set.
 */
let projectChecked = false;
async function assertExpectedProject(cmd: string): Promise<void> {
  if (!EXPECT_PROJECT || projectChecked || !isWrite(cmd)) return;
  const ping = await rawBridge.send<{ project?: string; projectFile?: string }>("ping", {});
  if (ping.project && ping.project.toLowerCase() !== EXPECT_PROJECT.toLowerCase()) {
    throw new Error(
      `WRONG PROJECT: this bridge is attached to "${ping.project}"` +
        `${ping.projectFile ? ` (${ping.projectFile})` : ""}, but UNREAL_MCP_EXPECT_PROJECT is "${EXPECT_PROJECT}". ` +
        `Refusing to write. This normally means a second Unreal Editor is open: only one can hold port ` +
        `${BRIDGE_PORT}, so every call goes to that one. Close the other editor, or run each on its own port ` +
        `with -MCPBridgePort=<n> and UNREAL_MCP_BRIDGE_PORT. Nothing has been changed.`
    );
  }
  projectChecked = true;
}

const bridge = {
  async send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T> {
    try {
      await assertExpectedProject(cmd);
      const result = await rawBridge.send<T>(cmd, params);
      journal.record(cmd, params, true);
      return result;
    } catch (err) {
      journal.record(cmd, params, false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
};

const server = new McpServer({
  name: "unreal-mcp-server",
  version: "0.1.0",
});

/**
 * Tool profile: which tools this server exposes.
 *
 * Tool definitions are paid for on every single request, before the user's message is even read.
 * At 39 tools with descriptions written to actually teach a model the sequencing, that is roughly
 * 11k tokens of standing cost. On a 200k-context model that is noise. On an 8k or 32k local model
 * it is the difference between usable and unusable, and "works with any model" is the point.
 *
 * The instructive descriptions are NOT the thing to cut: they are why a weaker model succeeds at
 * all. So instead of making every user's tools worse, a user on a small-context model can opt into
 * a smaller set. "core" keeps a straight line through authoring a Blueprint feature and reviewing
 * it, and drops the single-node editing tools (unreal_build_graph does that job in one call), the
 * level/actor/component/PIE surface, and the maintenance tools.
 *
 * Set UNREAL_MCP_PROFILE=core to use it. The default is "full".
 */
const CORE_PROFILE_TOOLS = new Set([
  "unreal_ping",
  "unreal_doctor",
  "unreal_enable_tools",
  "unreal_session_changes",
  "unreal_undo_history",
  "unreal_get_project_overview",
  "unreal_search_project",
  "unreal_map_system",
  "unreal_plan_feature",
  "unreal_project_health",
  "unreal_list_blueprints",
  "unreal_list_blueprint_graphs",
  "unreal_read_blueprint_summary",
  "unreal_explain_graph",
  "unreal_find_node",
  "unreal_get_node_signature",
  // unreal_create_blueprint is deliberately ABSENT, exactly as it is from `minimal`.
  //
  // It makes an EMPTY Blueprint, and it is the familiar name, so a small model reaches for it and
  // then cannot finish: add_component is not in this set either, so a Blueprint created that way
  // has no route to a component at all. Measured, not theorised - the three-part feature task went
  // from 5/5 to 0/3, and the trace shows every failing run picking create_blueprint and then
  // looping compile/save/review without ever adding the component it was asked for.
  //
  // The principle was already written down when `minimal` was built and only applied there: a
  // profile for weak models should contain the best path for each job, not every path. Offering a
  // worse-but-familiar option is offering a way to fail. It is still reachable through
  // unreal_enable_tools, and `full` still has it.
  "unreal_scaffold_blueprint",
  "unreal_create_function",
  "unreal_add_variable",
  "unreal_build_graph",
  "unreal_add_event_handler",
  "unreal_compile_blueprint",
  "unreal_save_blueprint",
  "unreal_auto_layout_graph",
  "unreal_review_blueprint",
  "unreal_cleanup_blueprint",
]);

/**
 * Tool groups, for the "lazy" profile.
 *
 * Trimming descriptions was measured and rejected as the answer to context bloat: tool
 * descriptions are 41% of the payload and they are the teaching a weaker model relies on, and
 * parameter prose is only another 17%, so aggressive editing buys around a tenth of the total
 * while making every model worse at sequencing. The bytes are not the problem. Sending tools the
 * caller will never touch is the problem.
 *
 * So "lazy" registers everything, with full schemas, and leaves every non-core group DISABLED.
 * A session that never builds UI never pays for the UMG tools. When the model needs a group it
 * calls unreal_enable_tools, the group switches on, and the SDK notifies the client that the tool
 * list changed. Nothing is dumbed down; it just arrives when it is wanted.
 */
const TOOL_GROUPS: Record<string, string[]> = {
  edit: [
    // Reachable but not offered by default. It makes an EMPTY Blueprint, and a weak model reaches
    // for the familiar name over scaffold_blueprint and then cannot finish - measured, see
    // CORE_PROFILE_TOOLS. A caller that genuinely wants an empty Blueprint can enable it.
    "unreal_create_blueprint",
    "unreal_read_node_detail",
    "unreal_add_node",
    "unreal_connect_pins",
    "unreal_set_pin_default_value",
    "unreal_remove_node",
    "unreal_organize_graph",
  ],
  ui: ["unreal_scaffold_widget", "unreal_create_widget_blueprint", "unreal_add_widget", "unreal_list_widgets", "unreal_set_widget_property"],
  materials: [
    "unreal_create_material",
    "unreal_create_material_instance",
    "unreal_set_material_parameter",
    "unreal_list_material_parameters",
  ],
  data: [
    "unreal_save_asset",
    "unreal_create_data_table",
    "unreal_add_data_table_row",
    "unreal_list_data_table_rows",
    "unreal_create_struct",
    "unreal_add_struct_field",
    "unreal_list_struct_fields",
    "unreal_create_enum",
    "unreal_list_enum_entries",
    "unreal_list_assets",
  ],
  scene: [
    "unreal_create_level",
    "unreal_open_level",
    "unreal_spawn_actor",
    "unreal_list_actors",
    "unreal_set_actor_property",
    "unreal_delete_actor",
    "unreal_save_level",
    "unreal_add_component",
    "unreal_list_variables",
    "unreal_list_components",
    "unreal_set_component_property",
    "unreal_set_class_default",
    "unreal_set_game_settings",
    "unreal_add_input_mapping",
    "unreal_start_pie",
    "unreal_stop_pie",
    "unreal_pie_status",
  ],
  maintenance: ["unreal_asset_status", "unreal_find_references", "unreal_delete_asset", "unreal_refresh_blueprint"],
};

const GROUP_SUMMARY: Record<string, string> = {
  edit: "single-node graph editing: add/remove one node, wire one pin, set one default, move/comment nodes",
  ui: "UMG: create Widget Blueprints, build the widget tree, set widget and slot properties",
  materials: "Materials and Material Instances: create them, parameterise them, override them",
  data: "Structs, Enums, and asset lookup",
  scene: "Levels, actors, components, class defaults, project settings, input mappings, Play In Editor",
  maintenance: "reference lookup, asset deletion, Refresh Nodes repair",
};

/**
 * The smallest set that can still build something, for models running on a tight GPU.
 *
 * This exists because of a measurement, not a preference. On a 12 GB card, qwen2.5-coder:14b loads
 * at 8k context and fails to load at 16k. The "lazy" profile is ~8.2k tokens of tool definitions
 * BY ITSELF, so its tool list alone consumes the entire budget a 14B has available - the payload
 * does not merely cost tokens, it decides which models you can run at all.
 *
 * So this is the authoring spine and nothing else: find the right function, create, add state,
 * attach behaviour, compile, review, save. Everything else arrives through unreal_enable_tools.
 */
const MINIMAL_PROFILE_TOOLS = new Set([
  "unreal_doctor",
  "unreal_enable_tools",
  "unreal_list_blueprints",
  "unreal_find_node",
  // Deliberately NOT unreal_create_blueprint. It makes an EMPTY Blueprint, and the measured
  // failure of a small model is exactly that: it creates the empty asset, declares the task done,
  // and never adds anything. scaffold_blueprint does everything create does and more, so offering
  // both here only offers a way to fail. A profile built for weak models should contain the best
  // path for each job, not every path.
  "unreal_scaffold_blueprint",
  // Without this, the smallest and most reliable profile cannot build a user interface at all.
  "unreal_scaffold_widget",
  "unreal_add_variable",
  "unreal_add_event_handler",
  "unreal_compile_blueprint",
  "unreal_review_blueprint",
  "unreal_save_blueprint",
]);

const PROFILE = (process.env.UNREAL_MCP_PROFILE ?? "full").trim().toLowerCase();

// How much to spend per build. The floor never moves: every mode still builds atomically, lays the
// graph out, and compiles. Modes trade polish and paperwork, never correctness.
const { policy: MODE, warning: MODE_WARNING } = resolveMode(process.env.UNREAL_MCP_MODE);
const registeredToolNames: string[] = [];
const toolHandles = new Map<string, { enable(): void; disable(): void; enabled: boolean }>();

/**
 * registerTool, gated by the active profile.
 *
 * Typed as the SDK's own registerTool so every call site keeps full inference on its zod schema
 * and handler arguments; a skipped tool returns an inert handle rather than being special-cased
 * at each of the 39 call sites.
 */
const register: typeof server.registerTool = ((name: string, config: never, handler: never) => {
  if (PROFILE === "core" && !CORE_PROFILE_TOOLS.has(name)) {
    return { enable() {}, disable() {}, remove() {}, update() {}, enabled: false } as never;
  }
  if (PROFILE === "minimal" && !MINIMAL_PROFILE_TOOLS.has(name)) {
    return { enable() {}, disable() {}, remove() {}, update() {}, enabled: false } as never;
  }
  registeredToolNames.push(name);
  const handle = server.registerTool(name, config, handler);
  toolHandles.set(name, handle as unknown as { enable(): void; disable(): void; enabled: boolean });
  return handle;
}) as typeof server.registerTool;

/** Switch a group on. Returns the tool names that became available. */
function enableGroup(group: string): string[] {
  const names = TOOL_GROUPS[group] ?? [];
  const turnedOn: string[] = [];
  for (const name of names) {
    const handle = toolHandles.get(name);
    if (handle && !handle.enabled) {
      handle.enable();
      turnedOn.push(name);
    }
  }
  return turnedOn;
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `UnrealMCPBridge error: ${message}`,
      },
    ],
  };
}

register(
  "unreal_ping",
  {
    title: "Ping Unreal MCP Bridge",
    description:
      "Checks whether the UnrealMCPBridge plugin is running inside the Unreal Editor and reachable over TCP. " +
      "Use this first to confirm the editor bridge is up before calling other unreal_* tools.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send<PingResult>("ping");
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_blueprints",
  {
    title: "List Unreal Blueprints",
    description:
      "Lists Blueprint assets in the open Unreal project via the AssetRegistry (project-wide, or scoped to a path prefix). " +
      "Returns name, asset path, and parent class for each, not graph contents. Use this to find a Blueprint before " +
      "drilling into it with unreal_list_blueprint_graphs.",
    inputSchema: {
      pathPrefix: z
        .string()
        .optional()
        .describe('Optional content-path prefix to scope the search, e.g. "/Game/Blueprints". Defaults to "/Game".'),
    },
  },
  async ({ pathPrefix }) => {
    try {
      const result = await bridge.send<ListBlueprintsResult>("list_blueprints", { pathPrefix });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_blueprint_graphs",
  {
    title: "List a Blueprint's graphs",
    description:
      "Lists the graphs (event graphs, functions, macros) inside one Blueprint, with just names and node counts. " +
      "This is the first tier of the tiered-read strategy: call this before unreal_read_blueprint_summary to decide " +
      "which graph is worth reading in full.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send<ListBlueprintGraphsResult>("list_blueprint_graphs", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_explain_graph",
  {
    title: "What does this graph actually do?",
    description:
      "**Read this before reading a graph node by node.** Returns each entry point and the ordered chain of things " +
      "it does, in plain text. " +
      "A real 104-node EventGraph costs ~8,800 tokens as a node-and-pin structure and about a tenth of that as an " +
      "explanation, so this is usually the only read you need - and on a small model it is the difference between " +
      "the graph fitting in context and not. " +
      "Deliberately lossy: it names what happens, not exact pins or node ids. When you need those, call " +
      "unreal_read_blueprint_summary for the one chain you are changing.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      graphName: z.string().optional().describe('Graph to explain. Defaults to "EventGraph".'),
    },
  },
  async ({ path, graphName }) => {
    try {
      const summary = await bridge.send("read_blueprint_graph_summary", {
        path,
        graphName: graphName ?? "EventGraph",
      });
      return jsonResult(explainGraph(summary as never));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_blueprint_summary",
  {
    title: "Read a Blueprint graph summary",
    description:
      "Reads a compact summary of one graph in a Blueprint: every node's id, type, and title, plus which pins are " +
      "connected to which other nodes. Deliberately omits node position/cosmetic metadata and unconnected pins to stay " +
      "token-lean. Use unreal_read_node_detail afterward for full pin/property detail on a specific node id from this result.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe('Graph name as returned by unreal_list_blueprint_graphs, e.g. "EventGraph".'),
    },
  },
  async ({ path, graphName }) => {
    try {
      const result = await bridge.send<ReadBlueprintGraphSummaryResult>("read_blueprint_graph_summary", {
        path,
        graphName,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_read_node_detail",
  {
    title: "Read full detail for one Blueprint node",
    description:
      "Reads full pin and property detail (categories, default values, array-ness, links) for exactly one node, " +
      "identified by the node id returned from unreal_read_blueprint_summary. Use sparingly: this is the most " +
      "verbose tier of the tiered-read strategy and should follow a summary read, not replace it.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe("Graph name containing the node."),
      nodeId: z.string().describe('Node id as returned by unreal_read_blueprint_summary, e.g. "n12".'),
    },
  },
  async ({ path, graphName, nodeId }) => {
    try {
      const result = await bridge.send<ReadBlueprintNodeDetailResult>("read_blueprint_node_detail", {
        path,
        graphName,
        nodeId,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =============================== Milestone 2: write/edit tools ===============================
// Same thin-translator pattern as the M1 read tools above: each tool is just a param reshape
// plus a call to the bridge. All the actual Blueprint-editing logic lives in the C++ plugin
// (MCPCommandHandler.cpp). This file never touches engine state directly.

register(
  "unreal_create_blueprint",
  {
    title: "Create a new Blueprint asset",
    description:
      "**If you also need variables, components, or event logic, use unreal_scaffold_blueprint instead** - it does all " +
      "of that in one call, in the right order. " +
      "Creates a new EMPTY Blueprint asset at a given content path with a given parent class, and saves it to disk " +
      "by default. Use this before unreal_add_node/unreal_add_variable to start building a new Blueprint from scratch. " +
      "Fails if an asset already exists at packagePath.",
    inputSchema: {
      packagePath: z
        .string()
        .describe('Full content path for the new asset, e.g. "/Game/_MCPTest/BP_MyActor" (no extension, no _C suffix).'),
      parentClass: z
        .string()
        .describe(
          'Parent class: a short native name ("Actor", "Pawn", "ActorComponent"), or a full path ' +
            '("/Script/Engine.Actor", or another Blueprint\'s generated class "/Game/BP_Base.BP_Base_C").'
        ),
      save: z
        .boolean()
        .optional()
        .describe("Whether to save the new asset to disk immediately. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, save }) => {
    try {
      const result = await bridge.send<CreateBlueprintResult>("create_blueprint", { packagePath, parentClass, save });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_node",
  {
    title: "Add a node to a Blueprint graph",
    description:
      "Adds one node to a graph and returns its new node id immediately so you can reference it in the same " +
      "conversation (via unreal_connect_pins, unreal_set_pin_default_value, etc) without re-reading the whole graph. " +
      "Node ids are the node's persistent GUID: stable across editor restarts and unaffected by removing other nodes.\n\n" +
      "nodeType determines which other params are required:\n" +
      '  - "Event": eventName = a function on the Blueprint\'s parent class to override (e.g. "ReceiveBeginPlay", "ReceiveTick").\n' +
      '  - "CustomEvent": eventName = name for the new custom event (auto-uniquified if it collides).\n' +
      '  - "CallFunction": functionName required; className optional (short name or full path); defaults to searching ' +
      "the Blueprint's own generated class, then its parent class. If the name is close but wrong, the error includes " +
      "a didYouMean list of near-misses.\n" +
      '  - "VariableGet" / "VariableSet": variableName = an existing member variable on this Blueprint (added via ' +
      "unreal_add_variable). Inherited variables from a parent class are not yet supported.\n" +
      '  - "Branch": an if/else on a bool. Pins: execute, Condition, then, else. No other params.\n' +
      '  - "Sequence": executes its output pins in order (then_0, then_1). No other params.\n' +
      '  - "Cast": targetClass required (short name or full path); pure optional (default false = has exec pins). ' +
      "Pins: execute, Object, then, CastFailed, As<Class>.\n" +
      '  - "Macro": macroName required, from the engine\'s standard macro library: ForEachLoop, ForLoop, WhileLoop, ' +
      "DoOnce, DoN, Gate, FlipFlop, IsValid, etc. A wrong name returns the full list of available macros. NOTE: macro " +
      'nodes name their input exec pin "Exec" (capital E), unlike regular nodes\' "execute".\n\n' +
      "x/y are optional graph-editor position hints (cosmetic only, for the human opening the graph later). Set them " +
      "roughly left-to-right in execution order so the graph stays readable to a human. comment is an optional " +
      "annotation shown on the node; use it to explain WHY a node exists, as you place it.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe('Graph name to add the node to, e.g. "EventGraph".'),
      nodeType: z.enum(["Event", "CustomEvent", "CallFunction", "VariableGet", "VariableSet", "Branch", "Sequence", "Cast", "Macro"]),
      eventName: z.string().optional().describe("Required for nodeType Event or CustomEvent."),
      functionName: z.string().optional().describe("Required for nodeType CallFunction."),
      className: z.string().optional().describe("Optional owning class for nodeType CallFunction."),
      variableName: z.string().optional().describe("Required for nodeType VariableGet or VariableSet."),
      targetClass: z.string().optional().describe("Required for nodeType Cast: the class to cast to."),
      pure: z.boolean().optional().describe("Cast only: true for the pure (no exec pins) form. Defaults to false."),
      macroName: z.string().optional().describe('Required for nodeType Macro, e.g. "ForEachLoop", "WhileLoop", "DoOnce".'),
      x: z.number().optional().describe("Cosmetic graph-editor X position. Defaults to 0."),
      y: z.number().optional().describe("Cosmetic graph-editor Y position. Defaults to 0."),
      comment: z.string().optional().describe("Optional node comment explaining why this node exists."),
    },
  },
  async ({ path, graphName, nodeType, eventName, functionName, className, variableName, targetClass, pure, macroName, x, y, comment }) => {
    try {
      const result = await bridge.send<AddNodeResult>("add_node", {
        path,
        graphName,
        nodeType,
        eventName,
        functionName,
        className,
        variableName,
        targetClass,
        pure,
        macroName,
        x,
        y,
        comment,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_connect_pins",
  {
    title: "Connect two Blueprint node pins",
    description:
      "Connects an output pin on one node to an input pin on another (works for both exec and data pins). Source/target " +
      "node ids come from unreal_read_blueprint_summary or unreal_add_node. Fails with incompatible_pins if the schema " +
      "rejects the connection (e.g. mismatched data types). The error message explains why.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe("Graph name containing both nodes."),
      sourceNodeId: z.string().describe("Node id (GUID) owning the OUTPUT pin."),
      sourcePin: z.string().describe('Output pin name on the source node, e.g. "then" or "ReturnValue".'),
      targetNodeId: z.string().describe("Node id (GUID) owning the INPUT pin."),
      targetPin: z.string().describe('Input pin name on the target node, e.g. "execute" or "Target".'),
    },
  },
  async ({ path, graphName, sourceNodeId, sourcePin, targetNodeId, targetPin }) => {
    try {
      const result = await bridge.send<ConnectPinsResult>("connect_pins", {
        path,
        graphName,
        sourceNodeId,
        sourcePin,
        targetNodeId,
        targetPin,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_pin_default_value",
  {
    title: "Set a literal default value on an unconnected input pin",
    description:
      "Sets a literal (string-serialized) default value on an input pin, e.g. setting a float literal to \"1.5\" or a " +
      "bool literal to \"true\". Fails with pin_is_connected if the pin already has a link: disconnect it first.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe("Graph name containing the node."),
      nodeId: z.string().describe("Node id (GUID) of the node owning the pin."),
      pinName: z.string().describe("Input pin name."),
      value: z.string().describe("Literal value, serialized as a string the way Blueprint pin defaults are stored."),
    },
  },
  async ({ path, graphName, nodeId, pinName, value }) => {
    try {
      const result = await bridge.send<SetPinDefaultValueResult>("set_pin_default_value", {
        path,
        graphName,
        nodeId,
        pinName,
        value,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_remove_node",
  {
    title: "Remove a node from a Blueprint graph",
    description: "Removes a node by id and breaks all of its pin links first. Does not recompile. Call unreal_compile_blueprint afterward.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe("Graph name containing the node."),
      nodeId: z.string().describe('Node id, e.g. "n5".'),
    },
  },
  async ({ path, graphName, nodeId }) => {
    try {
      const result = await bridge.send<RemoveNodeResult>("remove_node", { path, graphName, nodeId });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_variable",
  {
    title: "Add a member variable to a Blueprint",
    description:
      "Adds a new member variable to a Blueprint. type is a compact type descriptor: bool, byte, int, int64, float, " +
      "double, string, name, text, vector, rotator, transform, or object:<ClassName> / class:<ClassName> for object " +
      "references. Fails if a variable with that name already exists on this Blueprint.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      variableName: z.string().describe("New variable name."),
      type: z
        .string()
        .describe('Compact type descriptor, e.g. "bool", "float", "string", "vector", "object:StaticMeshComponent".'),
      category: z.string().optional().describe("Optional category for grouping in the editor's My Blueprint panel."),
      defaultValue: z.string().optional().describe("Optional literal default value, string-serialized."),
    },
  },
  async ({ path, variableName, type, category, defaultValue }) => {
    try {
      const result = await bridge.send<AddVariableResult>("add_variable", {
        path,
        variableName,
        type,
        category,
        defaultValue,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_compile_blueprint",
  {
    title: "Compile a Blueprint and report errors/warnings",
    description:
      "Compiles the Blueprint and returns structured errors/warnings (severity + message text), plus an overall " +
      "success flag and status. This is the safety net for every unreal_add_node / unreal_connect_pins / " +
      "unreal_add_variable call: always run this after a batch of edits to confirm the graph is actually valid " +
      "before telling the user it's done, since a graph can look structurally fine (nodes added, pins connected) " +
      "and still fail to compile (type mismatches, missing pins, unresolved variables, etc).",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send<CompileBlueprintResult>("compile_blueprint", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_save_blueprint",
  {
    title: "Save a Blueprint's package to disk",
    description:
      "Saves the Blueprint's package to disk in place. Edits made via unreal_add_node/unreal_connect_pins/etc exist " +
      "only in the running editor's memory until this is called (or unreal_create_blueprint's default save=true ran).",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send<SaveBlueprintResult>("save_blueprint", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// =============================== Milestone 3: project-wide index tools ===============================
// These exist to solve the actual pain point that motivated this whole project: finding
// things across a large project without either re-enumerating everything every time, or
// the model losing track of what's connected to what. They're backed by a persistent,
// incrementally-updated index on the C++ side (FMCPProjectIndex), not a live re-scan per
// call. See ../ARCHITECTURE.md and docs/M3_STATUS.md.

register(
  "unreal_get_project_overview",
  {
    title: "Get a cheap project-wide overview",
    description:
      "Returns a cheap top-level summary of the whole project's Blueprint structure: total counts (blueprints, " +
      "functions, variables, graphs, nodes), a breakdown by top-level content folder, and a breakdown by parent " +
      "class. Call this FIRST (before unreal_search_project or unreal_list_blueprints) to orient yourself in an " +
      "unfamiliar project. It costs one cheap index lookup instead of enumerating everything, and on a fresh editor " +
      "session may trigger the one-time index build (subsequent calls are fast).",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send<GetProjectOverviewResult>("get_project_overview");
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_search_project",
  {
    title: "Search the project-wide Blueprint index",
    description:
      "Keyword/substring search (case-insensitive) across every indexed Blueprint's name, parent class, function " +
      "names, and variable names. Returns compact hits (kind, path, name, one-line context), capped at maxResults " +
      "and marked `truncated: true` if the cap was hit. Narrow your query rather than assuming you saw every match. " +
      "This is the main way to find something without enumerating the whole project, and is backed by a persistent " +
      "index kept fresh as the project changes, not a live rescan. If UNREAL_MCP_LOCAL_LLM_URL is configured server-" +
      "side, up to a handful of top hits are best-effort enriched with a one-line natural-language `summary` field " +
      "generated by a local model, at no cost to your own context. Check the response's `enrichment` field to see " +
      'whether that ran ("local-llm" or "none").',
    inputSchema: {
      query: z.string().describe('Case-insensitive substring to search for, e.g. "health" or "BP_Enemy".'),
      maxResults: z.number().optional().describe("Cap on returned hits. Defaults to 50, clamped to [1, 500]."),
    },
  },
  async ({ query, maxResults }) => {
    try {
      const result = await bridge.send<SearchProjectResult>("search_project", { query, maxResults });
      const enrichedHits = await enrichSearchHits(result.hits);
      return jsonResult({
        ...result,
        hits: enrichedHits,
        enrichment: isEnrichmentEnabled() ? "local-llm" : "none",
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_references",
  {
    title: "Find what references, and is referenced by, an asset",
    description:
      "Given an asset path (typically a Blueprint), returns what other assets reference it (referencedBy) and what " +
      "it depends on (dependsOn), via the AssetRegistry's dependency graph. Engine/script-internal references are " +
      'filtered out to keep this focused on project content. This is the direct answer to "what uses this Blueprint" ' +
      'or "what does this Blueprint depend on" without opening each candidate manually, which is usually the single ' +
      "most useful tool for understanding how a change might ripple across a large project.",
    inputSchema: {
      path: z
        .string()
        .describe('Asset path, e.g. "/Game/Blueprints/BP_Foo.BP_Foo" or just the package "/Game/Blueprints/BP_Foo".'),
      maxResults: z.number().optional().describe("Cap per list (referencedBy / dependsOn). Defaults to 200."),
    },
  },
  async ({ path, maxResults }) => {
    try {
      const result = await bridge.send<FindReferencesResult>("find_references", { path, maxResults });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_find_node",
  {
    title: "Find the exact Blueprint node/function for an intent",
    description:
      "Searches the running editor's real catalog of Blueprint-callable functions, built from live C++ reflection " +
      "on the exact engine version that is open, so the names and signatures it returns are correct by construction " +
      "rather than recalled. Search by intent or partial name (e.g. \"spawn actor\", \"line trace\", \"print\") and get " +
      "back exact functionName and className values that unreal_add_node will accept, ranked exact then prefix then " +
      "contains. **Call this before unreal_add_node whenever you are not certain a function name and its owning class " +
      "are exactly right**, which is most of the time: guessing Unreal's API surface from memory is the single most " +
      "common cause of a failed edit. Returns compact entries without full pin lists; follow up with " +
      "unreal_get_node_signature for exact pins.",
    inputSchema: {
      query: z
        .string()
        .describe('What you are looking for, e.g. "spawn actor", "PrintString", "get player controller".'),
      maxResults: z.number().optional().describe("Cap on hits returned. Defaults to 20, max 100."),
    },
  },
  async ({ query, maxResults }) => {
    try {
      const result = await bridge.send<FindNodeResult>("find_node", { query, maxResults });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_get_node_signature",
  {
    title: "Get a Blueprint function's exact pins and parameter types",
    description:
      "Given an exact function name (and optionally its owning class, to disambiguate), returns that function's real " +
      "parameter list from engine reflection: each parameter's name, C++ type, direction (in/out/return), and default " +
      "value where one exists. Use this to get pin names exactly right before calling unreal_connect_pins or " +
      "unreal_set_pin_default_value, instead of guessing what a pin is called. If the name does not resolve, the error " +
      "includes a didYouMean list of near-misses. Find the function name first with unreal_find_node if you do not " +
      "already know it.",
    inputSchema: {
      functionName: z.string().describe('Exact function name, e.g. "PrintString".'),
      className: z
        .string()
        .optional()
        .describe(
          'Optional owning class to disambiguate, short name or full path, e.g. "KismetSystemLibrary" or ' +
            '"/Script/Engine.KismetSystemLibrary". Omit to take the first exact name match.'
        ),
    },
  },
  async ({ functionName, className }) => {
    try {
      const result = await bridge.send<NodeCatalogEntry>("get_node_signature", { functionName, className });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_build_graph",
  {
    title: "Build a piece of graph in one atomic call",
    description:
      "For a plain \"when X happens, do these in order\" chain, use unreal_add_event_handler instead: it wires the " +
      "exec pins for you. Use this for branches, loops, and data wiring. " +
      "The general way to author Blueprint logic: many nodes, connections, and pin defaults in ONE call, inside one " +
      "editor transaction. If any step fails, the entire batch rolls back and the graph is exactly as it was, so you " +
      "retry the whole call with the fix instead of reasoning about partial state. The response maps each of your " +
      "refs to its created node id, and the Blueprint is compiled at the end by default (compile: false to skip).\n\n" +
      "nodes: same fields as unreal_add_node plus a required short 'ref' you choose (no dots). " +
      'connections: {from, to} strings as "ref.pinName", e.g. {"from":"ev.then","to":"branch.execute"}. You can also ' +
      "use an existing node's id in place of a ref to extend a graph you read earlier. " +
      "pinDefaults: {node, pin, value}.\n\n" +
      "Prefer this over individual unreal_add_node/unreal_connect_pins calls whenever placing more than one node: a " +
      "10-node graph costs 1 round trip instead of ~25, and a human can undo the whole feature with one Ctrl+Z. " +
      "Errors name the failing ref or index and include available pin names or didYouMean suggestions.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe('Graph to build in, e.g. "EventGraph" or a function graph name.'),
      nodes: z
        .array(
          z.object({
            ref: z.string().describe("Your short handle for this node, unique in the batch, no dots."),
            nodeType: z.enum(["Event", "CustomEvent", "CallFunction", "VariableGet", "VariableSet", "Branch", "Sequence", "Cast", "Macro"]),
            eventName: z.string().optional(),
            functionName: z.string().optional(),
            className: z.string().optional(),
            variableName: z.string().optional(),
            targetClass: z.string().optional(),
            pure: z.boolean().optional(),
            macroName: z.string().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            comment: z.string().optional(),
          })
        )
        .optional()
        .describe("Nodes to create, in order. Same per-type params as unreal_add_node."),
      connections: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .optional()
        .describe('Wires, each "ref.pinName" -> "ref.pinName". Existing node ids also work as the ref part.'),
      pinDefaults: z
        .array(z.object({ node: z.string(), pin: z.string(), value: z.string() }))
        .optional()
        .describe("Literal defaults to set on unconnected input pins."),
      compile: z.boolean().optional().describe("Compile the Blueprint after building. Defaults to true."),
      autoLayout: z
        .boolean()
        .optional()
        .describe(
          "Tidy the whole graph's node positions after building, so it reads left to right with straight exec " +
            "chains and no overlaps. Defaults to TRUE, and you should almost always leave it on: you do not need to " +
            "supply x/y at all. Pass false only if you set every x/y deliberately and want them preserved exactly."
        ),
    },
  },
  async ({ path, graphName, nodes, connections, pinDefaults, compile, autoLayout }) => {
    try {
      const result = await bridge.send<BuildGraphResult>("build_graph", {
        path,
        graphName,
        nodes,
        connections,
        pinDefaults,
        compile,
      });

      // Layout is cosmetic and must never turn a successful build into a failed tool call, so a
      // layout error is reported alongside the build result rather than thrown over it.
      if (autoLayout === false) {
        return jsonResult(result);
      }
      try {
        // Layout happens in every mode. A graph nobody can read is not a cheaper graph.
        const layout = await autoLayoutGraph(bridge, path, graphName, {
          addCommentBoxes: MODE.commentBoxes,
        });

        // Trim the per-node echo unless asked for: the caller already knows what it sent, and the
        // ref-to-id map is the only part it cannot reconstruct.
        const buildPart = MODE.verboseBuildResult
          ? result
          : {
              nodes: Object.fromEntries(Object.entries(result.nodes ?? {}).map(([ref, n]) => [ref, n.id])),
              connectionsMade: result.connectionsMade,
              pinDefaultsSet: result.pinDefaultsSet,
              compile: result.compile,
            };

        if (MODE.attachReview === "none") {
          return jsonResult({ ...buildPart, layout: { nodesMoved: layout.nodesMoved }, mode: MODE.mode });
        }

        // Review the graph we just built and hand the findings back unasked. A model that never
        // calls unreal_review_blueprint is exactly the model that most needs to hear this.
        const review = await reviewBlueprint(bridge, path, graphName);
        const reviewPart =
          MODE.attachReview === "summary"
            ? { score: review.score, nextAction: review.nextAction }
            : {
                score: review.score,
                summary: review.summary,
                nextAction: review.nextAction,
                findings: review.graphs.flatMap((graph) => graph.findings).slice(0, MODE.maxFindings),
              };

        return jsonResult({
          ...buildPart,
          layout: { nodesMoved: layout.nodesMoved, columns: layout.columns },
          review: reviewPart,
          mode: MODE.mode,
        });
      } catch (layoutErr) {
        return jsonResult({
          ...result,
          layoutError: layoutErr instanceof Error ? layoutErr.message : String(layoutErr),
        });
      }
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_delete_asset",
  {
    title: "Delete one or more assets, with reference safety",
    description:
      "Deletes assets by path. Pass a single path, or paths[] to delete a whole cluster at once (members that " +
      "reference each other delete cleanly together). By default, if any asset OUTSIDE the delete set still " +
      "references what you're deleting, the call is BLOCKED and returns the blocking referencers, so you never " +
      "silently orphan live content. Pass force:true to delete anyway (breaks those outside references to None). " +
      "Use this to remove dead template debris after confirming it is unreferenced by live content.",
    inputSchema: {
      path: z.string().optional().describe("Single asset object path to delete."),
      paths: z.array(z.string()).optional().describe("Multiple asset object paths to delete together."),
      force: z.boolean().optional().describe("Delete even if outside-set references exist. Defaults to false (blocks and reports)."),
    },
  },
  async ({ path, paths, force }) => {
    try {
      const result = await bridge.send("delete_asset", { path, paths, force });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_refresh_blueprint",
  {
    title: "Refresh a Blueprint's nodes after a C++ change",
    description:
      "The 'right-click > Refresh Nodes' repair. Every node re-reads its backing function/struct/pin signature, " +
      "dropping pins that no longer exist and picking up renamed ones. This is the fix for the whole family of errors " +
      "a C++ signature change leaves behind ('in use pin X no longer exists, please refresh node', 'break <unknown " +
      "struct>', missing-function-from-known-class). It does NOT fix genuinely-deleted classes (NULL parent class, " +
      "invalid cast target) which need a CoreRedirect or deletion instead. Recompiles by default and reports the " +
      "before/after error count so you can see what cleared.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/UI/W_Healthbar.W_Healthbar".'),
      compile: z.boolean().optional().describe("Recompile after refreshing. Defaults to true."),
    },
  },
  async ({ path, compile }) => {
    try {
      const result = await bridge.send("refresh_blueprint", { path, compile });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_function",
  {
    title: "Create a function in a Blueprint",
    description:
      "Creates a new function graph on a Blueprint with typed inputs and outputs, and returns the graph name plus " +
      "the entry (and result, if outputs exist) node ids so you can immediately add nodes inside it with " +
      "unreal_add_node targeting the new graphName. Wire logic from the entry node's output pins to the result " +
      "node's input pins. Call the function from other graphs via unreal_add_node CallFunction with functionName " +
      "set to this name and no className. Type strings are the same compact descriptors unreal_add_variable uses " +
      '("bool", "int", "float", "string", "vector", "object:<Class>", "struct:<Struct>", "enum:<Enum>", ...).',
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      functionName: z.string().describe('Name for the new function, e.g. "HandleDamage". Fails if a graph with this name exists.'),
      inputs: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe('Function input parameters, e.g. [{"name":"Amount","type":"float"}].'),
      outputs: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe('Function return values, e.g. [{"name":"bDied","type":"bool"}].'),
    },
  },
  async ({ path, functionName, inputs, outputs }) => {
    try {
      const result = await bridge.send<CreateFunctionResult>("create_function", { path, functionName, inputs, outputs });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_organize_graph",
  {
    title: "Organize a Blueprint graph: comments and layout",
    description:
      "Graph-organization actions, so generated graphs read like a careful human built them:\n" +
      '  - "set_node_comment": nodeId + comment. Sets/clears the comment bubble on one node.\n' +
      '  - "add_comment_box": text + x/y/width/height. Adds a comment box; place it so it visually groups related ' +
      "nodes (boxes render behind nodes covering their area).\n" +
      '  - "move_node": nodeId + x/y. Repositions a node.\n' +
      "Use comment boxes to group each logical section of a graph and node comments to explain non-obvious choices. " +
      "Positions are cosmetic to the compiler but matter to the human who opens the graph next.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe("Graph to organize."),
      action: z.enum(["set_node_comment", "add_comment_box", "move_node"]),
      nodeId: z.string().optional().describe("Required for set_node_comment and move_node."),
      comment: z.string().optional().describe("set_node_comment: the comment text (empty string clears it)."),
      text: z.string().optional().describe("add_comment_box: the box's title text."),
      x: z.number().optional().describe("Position X (add_comment_box, move_node)."),
      y: z.number().optional().describe("Position Y (add_comment_box, move_node)."),
      width: z.number().optional().describe("add_comment_box: box width. Defaults to 400."),
      height: z.number().optional().describe("add_comment_box: box height. Defaults to 300."),
    },
  },
  async ({ path, graphName, action, nodeId, comment, text, x, y, width, height }) => {
    try {
      const result = await bridge.send<OrganizeGraphResult>("organize_graph", {
        path,
        graphName,
        action,
        nodeId,
        comment,
        text,
        x,
        y,
        width,
        height,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_assets",
  {
    title: "List project assets of a class",
    description:
      "AssetRegistry query for real asset paths by class, so you never guess or invent a content path. " +
      "Pass the class name without its U/A prefix (StaticMesh, SkeletalMesh, Material, AnimBlueprint, " +
      "AnimSequence, Texture2D, SoundWave, NiagaraSystem, World, ...). " +
      "**Call this before any tool that takes an asset path** (unreal_spawn_actor's staticMesh, " +
      "unreal_set_component_property with an asset value, unreal_set_class_default): a path that does not " +
      "resolve is the single most common way an agent-authored Blueprint silently ends up broken.",
    inputSchema: {
      className: z.string().describe('Asset class name, e.g. "StaticMesh", "SkeletalMesh", "AnimBlueprint", "Material".'),
      pathPrefix: z.string().optional().describe('Restrict to a content path, e.g. "/Game/Meshes". Defaults to the whole project, including engine content.'),
      maxResults: z.number().optional().describe("Cap the number of results returned. Keep this small; the response is token-billed."),
    },
  },
  async ({ className, pathPrefix, maxResults }) => {
    try {
      const result = await bridge.send("list_assets", { className, pathPrefix, maxResults });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_level",
  {
    title: "Create a new Level (World) asset",
    description:
      "Creates and saves a new empty Level asset, optionally assigning its GameMode override. A brand new level is " +
      "unplayable until it has at least a PlayerStart and a floor, so the normal sequence is: unreal_create_level, " +
      "unreal_open_level, unreal_spawn_actor for a PlayerStart plus a StaticMeshActor floor plus a light, " +
      "unreal_save_level, then unreal_set_game_settings to make it the startup and default map.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Maps/L_Arena".'),
      gameModeClass: z.string().optional().describe("Optional GameMode class or Blueprint path to set as this level's GameMode override."),
    },
  },
  async ({ packagePath, gameModeClass }) => {
    try {
      const result = await bridge.send("create_level", { packagePath, gameModeClass });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_open_level",
  {
    title: "Open a Level in the editor",
    description:
      "Loads a Level asset into the editor world. Every actor tool (unreal_spawn_actor, unreal_save_level) operates " +
      "on the currently open level, so call this first to choose which level you are editing. Opening a level " +
      "discards unsaved changes in the current one, so call unreal_save_level before switching.",
    inputSchema: {
      path: z.string().describe('Level asset path, e.g. "/Game/Maps/L_Arena".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("open_level", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_spawn_actor",
  {
    title: "Spawn an actor into the open level",
    description:
      "Places an actor in the currently open level with a transform and an optional label. Accepts any actor class " +
      "by name (PlayerStart, DirectionalLight, SkyLight, PointLight, StaticMeshActor, ...) or a Blueprint asset " +
      "path for your own actors. For blocking out geometry, pass actorClass StaticMeshActor plus staticMesh to " +
      "spawn and assign a mesh in one call. Changes live in memory until unreal_save_level. Requires an open " +
      "level: call unreal_open_level first if this returns no_editor_world.",
    inputSchema: {
      actorClass: z.string().describe('Actor class name ("PlayerStart", "DirectionalLight", "StaticMeshActor") or a Blueprint asset path.'),
      label: z.string().optional().describe("Human-readable label shown in the World Outliner. Name things meaningfully; a human reads this list."),
      locX: z.number().optional().describe("World location X. Defaults to 0."),
      locY: z.number().optional().describe("World location Y. Defaults to 0."),
      locZ: z.number().optional().describe("World location Z. Defaults to 0."),
      pitch: z.number().optional().describe("Rotation pitch in degrees. Defaults to 0."),
      yaw: z.number().optional().describe("Rotation yaw in degrees. Defaults to 0."),
      roll: z.number().optional().describe("Rotation roll in degrees. Defaults to 0."),
      scaleX: z.number().optional().describe("Scale X. Defaults to 1."),
      scaleY: z.number().optional().describe("Scale Y. Defaults to 1."),
      scaleZ: z.number().optional().describe("Scale Z. Defaults to 1."),
      staticMesh: z.string().optional().describe('StaticMeshActor only: mesh asset path to assign, e.g. "/Engine/BasicShapes/Cube.Cube". Verify it with unreal_list_assets first.'),
    },
  },
  async (args) => {
    try {
      const result = await bridge.send("spawn_actor", args);
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_save_level",
  {
    title: "Save the open Level to disk",
    description:
      "Saves the currently open Level. Actors placed with unreal_spawn_actor exist only in the running editor's " +
      "memory until this is called, exactly like unreal_save_blueprint for Blueprint edits.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send("save_level", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_component",
  {
    title: "Add a component to a Blueprint",
    description:
      "Adds a component to a Blueprint's component hierarchy (the Components panel), which is how an actor gets a " +
      "mesh, collision, camera, movement, audio, or particle behavior. Pass parent to attach beneath an existing " +
      "component instead of at the root; call unreal_list_components first to see the current hierarchy and the " +
      "exact parent name. Configure the new component with unreal_set_component_property, then " +
      "unreal_compile_blueprint and unreal_save_blueprint.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      componentClass: z.string().describe('Component class, e.g. "StaticMeshComponent", "SphereComponent", "CameraComponent", "SpringArmComponent", "AudioComponent".'),
      name: z.string().describe('Name for the component as it appears in the Components panel, e.g. "PickupCollision".'),
      parent: z.string().optional().describe("Existing component name to attach under. Defaults to the Blueprint's root component."),
    },
  },
  async ({ path, componentClass, name, parent }) => {
    try {
      const result = await bridge.send("add_component", { path, componentClass, name, parent });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_variables",
  {
    title: "Read a Blueprint's variables",
    description:
      "Lists the variables a Blueprint declares, with type, default, category and whether a designer can set each " +
      "one per instance. **Use this to see what state a Blueprint holds** - it is usually the first question worth " +
      "asking about an unfamiliar one. " +
      "This is a direct read, so unlike unreal_search_project it cannot lag behind a write you just made.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("list_variables", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_components",
  {
    title: "List a Blueprint's components",
    description:
      "Reads a Blueprint's component hierarchy: each component's name, class, and parent, including components " +
      "inherited from a C++ or Blueprint parent class. Call this before unreal_add_component to pick a valid " +
      "parent, or before unreal_set_component_property to get the exact component name, rather than guessing " +
      'names like "Mesh" or "Root".',
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_components", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_component_property",
  {
    title: "Set a property on a Blueprint component",
    description:
      "Sets one property on a component's template (its defaults): a StaticMeshComponent's StaticMesh, a " +
      "SphereComponent's SphereRadius, a CameraComponent's FieldOfView, a collision setting, and so on. Values are " +
      "written as strings and coerced to the property's real type; struct values use UE's literal syntax such as " +
      '"(X=0,Y=0,Z=100)". If the value names an asset that does not resolve, the call FAILS rather than silently ' +
      "setting None, so a bad path is reported instead of shipping a broken Blueprint. Get exact component names " +
      "from unreal_list_components and verify asset paths with unreal_list_assets.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      component: z.string().describe("Component name, exactly as returned by unreal_list_components."),
      property: z.string().describe('Property name, e.g. "StaticMesh", "SphereRadius", "FieldOfView", "bGenerateOverlapEvents".'),
      value: z.string().describe('Value as a string: "true", "250.0", an asset path, or a struct literal like "(X=0,Y=0,Z=100)".'),
    },
  },
  async ({ path, component, property, value }) => {
    try {
      const result = await bridge.send("set_component_property", { path, component, property, value });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_class_default",
  {
    title: "Set a Blueprint class default (CDO property)",
    description:
      "Sets a property on the Blueprint's Class Default Object: the values shown in the Class Defaults panel. This " +
      "is how you configure inherited settings without touching a graph, and it is the correct way to turn on " +
      'replication for an actor ("bReplicates", "bAlwaysRelevant", "NetUpdateFrequency"), set a Character\'s ' +
      "movement defaults, or set the default value of any inherited variable. Same string coercion and same " +
      "fail-loudly-on-unresolved-asset behavior as unreal_set_component_property.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      property: z.string().describe('Property name on the class, e.g. "bReplicates", "NetUpdateFrequency", "InitialLifeSpan".'),
      value: z.string().describe('Value as a string, e.g. "true", "10.0", an asset path, or a struct literal.'),
    },
  },
  async ({ path, property, value }) => {
    try {
      const result = await bridge.send("set_class_default", { path, property, value });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_game_settings",
  {
    title: "Set project GameMode and startup maps",
    description:
      "Writes the project's UGameMapsSettings: the default GameMode, the map the editor opens on, and the map the " +
      "packaged game launches into, persisted to the project's config. Without this, a level you just built is " +
      "never actually the one that runs. Pass any combination of the three; at least one is required.",
    inputSchema: {
      defaultGameMode: z.string().optional().describe('GameMode class or Blueprint path, e.g. "/Game/BP/BP_MyGameMode.BP_MyGameMode".'),
      editorStartupMap: z.string().optional().describe('Level path the editor opens on startup, e.g. "/Game/Maps/L_Arena".'),
      gameDefaultMap: z.string().optional().describe('Level path the packaged game loads first, e.g. "/Game/Maps/L_Arena".'),
    },
  },
  async ({ defaultGameMode, editorStartupMap, gameDefaultMap }) => {
    try {
      const result = await bridge.send("set_game_settings", { defaultGameMode, editorStartupMap, gameDefaultMap });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_input_mapping",
  {
    title: "Add a project input mapping",
    description:
      "Adds an action or axis mapping to the project's input settings and saves them to config, so InputAction and " +
      'InputAxis event nodes have something real behind them. kind "action" is a press/release binding (Jump, ' +
      'Fire); kind "axis" is a continuous value (MoveForward) and takes scale, so a W/S pair is two calls with ' +
      "scale 1 and -1. Key names are UE's own: W, A, S, D, SpaceBar, LeftMouseButton, Gamepad_LeftX. Add the " +
      "mapping before adding the matching input event node to a graph.",
    inputSchema: {
      kind: z.enum(["action", "axis"]).describe('"action" for press/release, "axis" for a continuous value.'),
      name: z.string().describe('Mapping name the Blueprint event node will use, e.g. "Jump" or "MoveForward".'),
      key: z.string().describe('UE key name, e.g. "SpaceBar", "W", "LeftMouseButton", "Gamepad_LeftX".'),
      scale: z.number().optional().describe("Axis only: the value this key contributes, typically 1 or -1. Defaults to 1."),
    },
  },
  async ({ kind, name, key, scale }) => {
    try {
      const result = await bridge.send("add_input_mapping", { kind, name, key, scale });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_start_pie",
  {
    title: "Start Play In Editor",
    description:
      "Starts a PIE session so runtime behavior can actually be verified instead of assumed, including multiplayer: " +
      "pass numPlayers greater than 1 (and listenServer) to launch multiple clients and exercise replication. PIE " +
      "starts on the next editor tick, so poll unreal_pie_status rather than assuming it is already running, and " +
      "call unreal_stop_pie when finished. Compiling a Blueprint proves it is valid; running it is the only thing " +
      "that proves it works.",
    inputSchema: {
      numPlayers: z.number().optional().describe("Number of PIE clients. Defaults to 1. Use 2 or more to test replication."),
      listenServer: z.boolean().optional().describe("Run the first client as a listen server, the usual multiplayer setup. Defaults to false."),
    },
  },
  async ({ numPlayers, listenServer }) => {
    try {
      const result = await bridge.send("start_pie", { numPlayers, listenServer });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_stop_pie",
  {
    title: "Stop Play In Editor",
    description:
      "Ends the running PIE session and reports whether one was running. Always stop PIE before further editing: " +
      "Blueprint writes made while PIE is running act on the editor world, not the running one, and are easy to " +
      "misread as having had no effect.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send("stop_pie", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_pie_status",
  {
    title: "Check whether PIE is running",
    description:
      "Reports whether a PIE session is currently active. Poll this after unreal_start_pie, which takes effect on " +
      "the next editor tick, before concluding anything about runtime behavior.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await bridge.send("pie_status", {});
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_auto_layout_graph",
  {
    title: "Auto-layout a graph and label its sections",
    description:
      "Makes an existing graph read like a careful human built it, in one call, without you working out a single " +
      "coordinate. Nodes are ranked into left-to-right columns so every wire points forward, ordered to minimise " +
      "crossings, straightened so execution chains run along one row, and spaced so nothing overlaps. By default it " +
      "then wraps each execution chain in a comment box titled after the event that starts it, so a reader sees " +
      '"Event BeginPlay" as a labelled region instead of a float of nodes.\n\n' +
      "Run this whenever you have finished a piece of work in a graph, including graphs you did not author: it is " +
      "purely cosmetic, safe to run repeatedly (it will not stack duplicate comment boxes), and it is the difference " +
      "between output that compiles and output someone is happy to inherit. unreal_build_graph already applies the " +
      "positioning half automatically; call this to also get the comment boxes, or to tidy a graph built any other way.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Foo.BP_Foo".'),
      graphName: z.string().describe('Graph to lay out, e.g. "EventGraph" or a function graph name.'),
      addCommentBoxes: z
        .boolean()
        .optional()
        .describe(
          "Wrap each execution chain in a comment box titled after its event. Defaults to true. A chain of fewer " +
            "than two nodes is never boxed, and a box whose title already exists is skipped."
        ),
      columnGap: z.number().optional().describe("Horizontal gap between columns. Defaults to 120."),
      rowGap: z.number().optional().describe("Vertical gap between nodes in a column. Defaults to 56."),
      originX: z.number().optional().describe("X of the leftmost column. Defaults to 0."),
      originY: z.number().optional().describe("Y of the top of the layout. Defaults to 0."),
    },
  },
  async ({ path, graphName, addCommentBoxes, columnGap, rowGap, originX, originY }) => {
    try {
      const report = await autoLayoutGraph(bridge, path, graphName, {
        addCommentBoxes,
        columnGap,
        rowGap,
        originX,
        originY,
      });
      return jsonResult(report);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_review_blueprint",
  {
    title: "Review a Blueprint for the things a senior developer would flag",
    description:
      "The quality gate. Compiling only proves a graph is valid: a Blueprint full of dead nodes, unhandled cast " +
      "failures, leftover Print String debug, placeholder variable names, and per-frame work in Event Tick compiles " +
      "perfectly and is still not finished work. This reads the graphs and reports exactly those things, each with " +
      "the concrete fix and the node ids to fix it on, plus a 0-100 score and a single `nextAction` naming the one " +
      "thing most worth doing next.\n\n" +
      "**Call this before you tell the user a feature is done, and act on what it says.** It costs one cheap read " +
      "per graph, changes nothing, and it is the only feedback available on whether the work is actually good " +
      "rather than merely valid. If you skip it you are grading your own homework.",
    inputSchema: {
      path: z.string().describe('Full asset path of the Blueprint, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      graphName: z.string().optional().describe("Review only this graph. Omit to review every graph in the Blueprint."),
    },
  },
  async ({ path, graphName }) => {
    try {
      const result = await reviewBlueprint(bridge, path, graphName);
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_doctor",
  {
    title: "Diagnose the whole setup in one call",
    description:
      "Run this the moment anything is not working, and run it first in a new session before concluding a tool is " +
      "broken. It checks, in order: the editor bridge is reachable; the loaded plugin's protocol matches this " +
      "server; the editor is responsive rather than grinding on a compile or a modal dialog; the project index is " +
      "built and not still scanning (a still-scanning index reports that things do not exist when they do); the " +
      "engine's live node catalog is readable; and whether a PIE session is running (Blueprint writes during PIE " +
      "apply to the editor world, not the running one, so they look like they did nothing).\n\n" +
      "Every check reports a status and, when it is not ok, the concrete remedy. The report ends with a single " +
      "`nextAction`. It never throws: if the editor cannot be reached at all, that IS the answer, and the remedy " +
      "is the ordered checklist for fixing it. Relay the remedy to the user in plain language; most of these are " +
      "things only they can fix, in the editor.",
    inputSchema: {},
  },
  async () => {
    try {
      const report = await runDoctor(rawBridge, { host: BRIDGE_HOST, port: BRIDGE_PORT, expectedProject: EXPECT_PROJECT });
      // Which mode is active changes what every build costs and how much feedback comes back
      // unasked, so it belongs in the one call people run when something seems off.
      return jsonResult({ ...report, mode: MODE.mode, modeMeans: MODE.description });
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_scaffold_widget",
  {
    title: "Build a whole UI screen in one call",
    description:
      "**Build the entire widget in one call: the Widget Blueprint and every element inside it.** " +
      "Reach for this first whenever you are creating UI. " +
      "Widgets are added in the order given, so declare a panel before the things inside it. " +
      "A step that fails is reported in `failures` and the rest still proceeds.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/UI/W_HUD". Prefix widget assets with W_ by convention.'),
      parentClass: z.string().optional().describe("Parent class. Defaults to UserWidget."),
      rootWidget: z.string().optional().describe('Root panel, e.g. "CanvasPanel" or "VerticalBox".'),
      widgets: z
        .array(
          z.object({
            widgetClass: z.string().describe('e.g. "TextBlock", "Button", "ProgressBar", "Image", "VerticalBox".'),
            name: z.string(),
            parent: z.string().optional().describe("Nest inside this panel instead of the root."),
            properties: z.record(z.string()).optional().describe('Properties to set, e.g. {"Text":"Score"}.'),
          })
        )
        .optional()
        .describe("Everything on the screen, with its properties set for you."),
      save: z.boolean().optional().describe("Save at the end. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, rootWidget, widgets, save }) => {
    try {
      return jsonResult(await scaffoldWidget(bridge, { packagePath, parentClass, rootWidget, widgets, save }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_widget_blueprint",
  {
    title: "Create a UMG Widget Blueprint",
    description:
      "Creates a Widget Blueprint: the asset behind every health bar, menu, HUD, and inventory screen. It is given " +
      "a CanvasPanel root by default, which is the only root that supports free positioning of children. Choose a " +
      "different root when the layout is inherently stacked (VerticalBox, HorizontalBox) or layered (Overlay), " +
      "because a box that lays itself out is far easier to keep tidy than absolute coordinates.\n\n" +
      "Then: unreal_add_widget to build the tree, unreal_set_widget_property to style it, and " +
      "unreal_compile_blueprint. To actually show it on screen, add a Create Widget + Add to Viewport chain in a " +
      "gameplay Blueprint with unreal_build_graph. A Widget Blueprint that is never added to the viewport is " +
      "invisible, which is the most common reason UI work appears to have done nothing.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/UI/W_HealthBar". Prefix widget assets with W_ by convention.'),
      parentClass: z.string().optional().describe('Parent class. Defaults to UserWidget. Pass your own UserWidget-derived class or Blueprint path to inherit from it.'),
      rootWidget: z
        .string()
        .optional()
        .describe('Root panel class: "CanvasPanel" (default, free positioning), "VerticalBox", "HorizontalBox", "Overlay", "SizeBox". Must be a panel.'),
      save: z.boolean().optional().describe("Save to disk immediately. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, rootWidget, save }) => {
    try {
      const result = await bridge.send("create_widget_blueprint", { packagePath, parentClass, rootWidget, save });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_widget",
  {
    title: "Add a widget to a Widget Blueprint",
    description:
      "Adds one widget to a Widget Blueprint's tree, under the root or under a named panel. Common classes: " +
      "TextBlock, Button, Image, ProgressBar (health/mana bars), Border, SizeBox, Spacer, EditableTextBox, " +
      "CheckBox, Slider, ScrollBox, and the panels CanvasPanel, VerticalBox, HorizontalBox, Overlay, GridPanel.\n\n" +
      "Two things about UMG that are worth knowing before you start guessing:\n" +
      "  - A Button holds exactly ONE child. To put a label on a button, add the Button, then add a TextBlock with " +
      "parent set to the button. Adding a second child to a Button fails with parent_full.\n" +
      "  - Layout (position, size, alignment, padding, anchors) lives on the SLOT, not the widget. Set it with " +
      "unreal_set_widget_property and onSlot: true. The response tells you the slot class you got, which is what " +
      "determines the available layout properties.\n" +
      "Call unreal_list_widgets first if you need the exact name of an existing parent.",
    inputSchema: {
      path: z.string().describe('Widget Blueprint path, e.g. "/Game/UI/W_HealthBar.W_HealthBar".'),
      widgetClass: z.string().describe('Widget class, e.g. "TextBlock", "Button", "ProgressBar", "Image", "VerticalBox".'),
      name: z.string().describe('Name for this widget, e.g. "HealthText". This is how you reference it in every other call, and how a human finds it in the Designer.'),
      parent: z.string().optional().describe("Name of an existing panel widget to add this under. Defaults to the root."),
    },
  },
  async ({ path, widgetClass, name, parent }) => {
    try {
      const result = await bridge.send("add_widget", { path, widgetClass, name, parent });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_widgets",
  {
    title: "Read a Widget Blueprint's widget tree",
    description:
      "Returns the whole widget hierarchy in depth-first order: each widget's name, class, parent, depth, slot " +
      "class, and whether it can hold children. Call this before unreal_add_widget (to pick a valid parent) or " +
      "unreal_set_widget_property (to get an exact name), instead of guessing. The slot class on each entry tells " +
      "you which layout properties that widget actually has, which differs per parent panel type.",
    inputSchema: {
      path: z.string().describe('Widget Blueprint path, e.g. "/Game/UI/W_HealthBar.W_HealthBar".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_widgets", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_widget_property",
  {
    title: "Set a property on a widget or its layout slot",
    description:
      "Sets one property on a widget, or on its layout slot when onSlot is true. This is where UI stops looking " +
      "programmer-art and starts looking designed, so it is worth spending calls on.\n\n" +
      "On the widget: TextBlock Text and ColorAndOpacity, ProgressBar Percent and FillColorAndOpacity, Image " +
      "Brush, Button BackgroundColor, any widget's Visibility, RenderTransform, or ToolTipText.\n" +
      "On the slot (onSlot: true): CanvasPanelSlot has LayoutData (offsets plus anchors), ZOrder, and " +
      "bAutoSize; box slots have Padding, HorizontalAlignment, VerticalAlignment, and Size. Anchors are what make " +
      "UI survive a different screen resolution, so a HUD element pinned to a corner should be anchored to that " +
      "corner rather than placed at fixed coordinates.\n\n" +
      "Values are strings coerced to the property's real type; structs use UE literal syntax such as " +
      '"(R=1,G=0,B=0,A=1)". An asset path that does not resolve fails loudly instead of silently setting None. ' +
      "Get exact widget names from unreal_list_widgets.",
    inputSchema: {
      path: z.string().describe('Widget Blueprint path, e.g. "/Game/UI/W_HealthBar.W_HealthBar".'),
      widget: z.string().describe("Widget name, exactly as returned by unreal_list_widgets."),
      property: z.string().describe('Property name, e.g. "Text", "Percent", "ColorAndOpacity", "Padding", "ZOrder".'),
      value: z.string().describe('Value as a string: "Health", "0.75", "(R=1,G=0,B=0,A=1)", "(Left=8,Top=8,Right=8,Bottom=8)".'),
      onSlot: z
        .boolean()
        .optional()
        .describe("Set the property on the widget's layout slot instead of the widget itself. Use for position, size, padding, alignment, anchors, ZOrder. Defaults to false."),
    },
  },
  async ({ path, widget, property, value, onSlot }) => {
    try {
      const result = await bridge.send("set_widget_property", { path, widget, property, value, onSlot });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_save_asset",
  {
    title: "Save any asset to disk",
    description:
      "Writes an asset to disk. Works on anything - Blueprints, structs, enums, materials, Data Tables. " +
      "**Call this after creating or editing a non-Blueprint asset.** Everything this server creates is live in " +
      "the editor immediately but stays unsaved until something writes it, and unsaved work is lost if the editor " +
      "crashes. Blueprint tools save for you; the rest do not, because saving after every field would be a disk " +
      "write per edit. " +
      "Checks the file out first if the project is under source control, and explains rather than failing with " +
      "'save_failed' if it cannot.",
    inputSchema: {
      path: z.string().describe('Full asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
    },
  },
  async ({ path }) => {
    try {
      return jsonResult(await bridge.send("save_asset", { path }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_data_table",
  {
    title: "Create a Data Table",
    description:
      "Creates a Data Table backed by a struct. **This is how you make gameplay data-driven:** items, weapons, " +
      "enemy stats, dialogue lines and loot tables belong in rows, not in graph nodes. Adding item number two " +
      "hundred then becomes one row, and the Blueprint that reads the table never changes. " +
      "Make the row struct first with unreal_create_struct, then pass it here. " +
      "Returns the row's field names, so you can add rows immediately without looking them up.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Data/DT_Items".'),
      rowStruct: z
        .string()
        .describe('The struct that defines a row, e.g. "/Game/Data/S_Item" or a native row struct name.'),
    },
  },
  async ({ packagePath, rowStruct }) => {
    try {
      return jsonResult(await bridge.send("create_data_table", { packagePath, rowStruct }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_data_table_row",
  {
    title: "Add a row to a Data Table",
    description:
      "Adds one named row and sets its values by field name. " +
      "Every field name is checked before anything is written, so a typo refuses the row rather than leaving it " +
      "half filled - a half-filled row looks correct in the editor until the wrong value shows up in play. " +
      "The stored row is read back and returned, so you see what the engine actually kept rather than what you sent.",
    inputSchema: {
      path: z.string().describe('Data Table asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
      rowName: z.string().describe('The row key, e.g. "Potion". This is what Blueprints look up.'),
      values: z
        .record(z.string())
        .optional()
        .describe('Field values by name, e.g. {"DisplayName":"Health Potion","Value":"25"}.'),
    },
  },
  async ({ path, rowName, values }) => {
    try {
      return jsonResult(await bridge.send("add_data_table_row", { path, rowName, values }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_data_table_rows",
  {
    title: "Read the rows of a Data Table",
    description:
      "Lists rows with their values. Paged deliberately: a Data Table is the one asset designed to get large, and " +
      "returning nine hundred rows of item data would cost more context than the question that needed them. " +
      "Defaults to 25 rows and tells you the total and the next offset.",
    inputSchema: {
      path: z.string().describe('Data Table asset path, e.g. "/Game/Data/DT_Items.DT_Items".'),
      limit: z.number().optional().describe("Rows to return. Defaults to 25, capped at 500."),
      offset: z.number().optional().describe("Rows to skip, for paging through a large table."),
    },
  },
  async ({ path, limit, offset }) => {
    try {
      return jsonResult(await bridge.send("list_data_table_rows", { path, limit, offset }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_struct",
  {
    title: "Create a Blueprint Struct",
    description:
      "Creates a user-defined Struct with typed fields in one call. This is the refactor that stops a project " +
      "accreting loose variables: six variables called ItemName, ItemIcon, ItemCount, ItemWeight, ItemStackable, " +
      "ItemRarity are one S_ItemData struct, and every function that passes them around gets one pin instead of " +
      "six.\n\n" +
      "Use the struct afterwards by passing type \"struct:<Name>\" to unreal_add_variable, unreal_create_function's " +
      "inputs/outputs, or unreal_create_struct's own fields (structs can nest). Break it apart in a graph with a " +
      "Break node, found via unreal_find_node.\n\n" +
      "Every field type is validated BEFORE the asset is created, so a typo in the fifth field fails the call " +
      "cleanly instead of leaving a half-built struct in the project.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Data/S_ItemData". Prefix struct assets with S_ by convention.'),
      fields: z
        .array(z.object({ name: z.string(), type: z.string() }))
        .optional()
        .describe(
          'Fields in order, e.g. [{"name":"DisplayName","type":"text"},{"name":"Icon","type":"object:Texture2D"},' +
            '{"name":"Rarity","type":"enum:E_Rarity"}]. Same type descriptors as unreal_add_variable.'
        ),
    },
  },
  async ({ packagePath, fields }) => {
    try {
      const result = await bridge.send("create_struct", { packagePath, fields });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_struct_field",
  {
    title: "Add a field to an existing Struct",
    description:
      "Appends one typed field to a user-defined Struct and returns the full field list afterwards. Adding a field " +
      "to a struct already in use is safe: existing pins keep their values and gain the new one at its default. " +
      "Native engine structs (Vector, Transform, HitResult) are defined in C++ and cannot be edited; the error " +
      "says so rather than failing obscurely.",
    inputSchema: {
      path: z.string().describe('Struct asset: a short name like "S_ItemData" or a full path like "/Game/Data/S_ItemData".'),
      name: z.string().describe('Field name, e.g. "MaxStackSize".'),
      type: z.string().describe('Field type, e.g. "int", "text", "object:Texture2D", "struct:S_Other", "enum:E_Rarity".'),
    },
  },
  async ({ path, name, type }) => {
    try {
      const result = await bridge.send("add_struct_field", { path, name, type });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_struct_fields",
  {
    title: "Read a Struct's fields",
    description:
      "Returns a struct's fields in order with each one's name, type, sub-type, array-ness, and default value. " +
      "Call this before writing graph logic that breaks a struct apart, so pin names are read rather than guessed.",
    inputSchema: {
      path: z.string().describe('Struct asset: short name or full path.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_struct_fields", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_enum",
  {
    title: "Create a Blueprint Enum",
    description:
      "Creates a user-defined Enum with named entries. Reach for this the moment a variable is a state or a kind: " +
      'an integer 0/1/2 for "Idle/Chasing/Attacking", or a string compared against "Fire"/"Ice", is a bug waiting ' +
      "to happen and unreadable in a graph. An enum gives a Switch node one clearly-labelled pin per case, and " +
      "makes an invalid value unrepresentable.\n\n" +
      'Use it afterwards with type "enum:<Name>" on unreal_add_variable or a struct field, and switch on it with a ' +
      "Switch on <Enum> node found via unreal_find_node.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Data/E_EnemyState". Prefix enum assets with E_ by convention.'),
      entries: z
        .array(z.string())
        .optional()
        .describe('Entry display names in order, e.g. ["Idle","Chasing","Attacking","Dead"]. These are what a designer sees on the pins.'),
    },
  },
  async ({ packagePath, entries }) => {
    try {
      const result = await bridge.send("create_enum", { packagePath, entries });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_enum_entries",
  {
    title: "Read an Enum's entries",
    description:
      "Returns an enum's entries with index, internal name, display name, and value, plus whether the enum is " +
      "editable (user-defined) or native C++. Works on engine enums too, so it doubles as a way to look up the " +
      "exact spelling of a built-in enum value before setting it as a pin default.",
    inputSchema: {
      path: z.string().describe('Enum asset: short name like "E_EnemyState", or a full path.'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_enum_entries", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_enable_tools",
  {
    title: "Turn on a group of Unreal tools",
    description:
      "This server starts with a small set of always-available tools and keeps the rest switched off until asked, " +
      "so a session that never builds UI never pays the context cost of the UI tools. Call this the moment you " +
      "need something from a group, then use those tools normally. Groups:\n" +
      '  - "edit": single-node graph editing (add/remove one node, wire one pin, set one default, move and comment ' +
      "nodes). You usually do NOT need this: unreal_build_graph places whole graphs in one call and auto-lays them " +
      "out. Enable it to adjust an existing graph surgically.\n" +
      '  - "ui": UMG. Create Widget Blueprints, build the widget tree, set widget and layout-slot properties.\n' +
      '  - "data": Structs, Enums, and asset lookup by class.\n' +
      '  - "scene": Levels, actors, components, class defaults (including replication), project settings, input ' +
      "mappings, and Play In Editor.\n" +
      '  - "maintenance": what references an asset, deleting assets safely, and the Refresh Nodes repair.\n\n' +
      "Enabling is cheap, immediate, and permanent for the session, and enabling a group you turn out not to need " +
      "costs nothing but its definitions. Ask for every group the job plausibly needs in one call rather than " +
      "discovering them one at a time. If your client does not appear to pick up the new tools, the response lists " +
      "exactly what was turned on, and re-calling is harmless.",
    inputSchema: {
      groups: z
        .array(z.enum(["edit", "ui", "materials", "data", "scene", "maintenance"]))
        .describe('Groups to turn on, e.g. ["ui","data"].'),
    },
  },
  async ({ groups }) => {
    const enabled: string[] = [];
    for (const group of groups) {
      enabled.push(...enableGroup(group));
    }
    const available = [...toolHandles.entries()].filter(([, h]) => h.enabled).map(([name]) => name);
    return jsonResult({
      requested: groups,
      newlyEnabled: enabled,
      alreadyOn: enabled.length === 0,
      availableTools: available.sort(),
      note:
        enabled.length > 0
          ? "These tools are now available. Your client has been notified that the tool list changed."
          : "Nothing new to enable; those groups were already on.",
    });
  }
);

/**
 * The workflow guide, served as an MCP prompt.
 *
 * docs/AGENT_WORKFLOW.md is the single highest-leverage thing in this repo for a weaker model:
 * the difference between a smooth run and a flailing one is almost never model quality, it is
 * tool-call order. But it only helps if the model actually receives it, and "paste this into your
 * system prompt" is a step a person with zero coding experience will not take.
 *
 * So the server offers it directly. Any MCP client can pull it in without the user configuring
 * anything, and it costs nothing until asked for.
 */
const WORKFLOW_FALLBACK =
  "The workflow guide was not found next to this server. The short version: unreal_doctor if " +
  "anything is broken; unreal_get_project_overview to orient; unreal_search_project to find; " +
  "unreal_find_node and unreal_list_assets to check exact names before writing; unreal_build_graph " +
  "to author whole graphs in one call without passing x/y; unreal_review_blueprint before claiming " +
  "anything is done, and act on what it says; unreal_auto_layout_graph to make it readable; then " +
  "save. Full text: docs/AGENT_WORKFLOW.md in the unreal-mcp repository.";

function loadDoc(fileName: string, fallback: string): string {
  // dist/index.js -> mcp-server/dist -> mcp-server -> repo root
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", fileName),
    join(dirname(fileURLToPath(import.meta.url)), "..", "docs", fileName),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      /* try the next one */
    }
  }
  return fallback;
}

function loadWorkflowGuide(): string {
  return loadDoc("AGENT_WORKFLOW.md", WORKFLOW_FALLBACK);
}

/**
 * Handbooks, for a model that can program but was never trained on Unreal.
 *
 * This is the difference between a local model being unusable and being useful. Qwen, DeepSeek and
 * friends can write logic perfectly well; what they lack is Unreal's vocabulary, its class
 * hierarchy, and the dozen traps that each cost a failed call to discover. That is a gap a document
 * can close, and it costs nothing until asked for.
 *
 * Every function name in the recipes is machine-checked against the running engine by
 * `npm run verify:handbook`, because a handbook of plausible-looking node names is worse than none:
 * the models least able to spot an invented name are exactly the ones relying on this.
 */
server.registerPrompt(
  "unreal_handbook",
  {
    title: "Unreal for a model that was never trained on it",
    description:
      "The engine-specific knowledge a capable programmer is missing: the Blueprint mental model (exec wires versus " +
      "data pins), the class hierarchy and how to choose a parent, how to get a reference to another actor, " +
      "interfaces, the type descriptors this server takes, multiplayer in one page, performance judgment, and the " +
      "specific traps that each cost one failed call. Pull this in at the start of a session if you are not certain " +
      "of Unreal's conventions - and if you are running a local or smaller model, pull it in always.",
  },
  () => ({
    messages: [{ role: "user", content: { type: "text", text: loadDoc("BLUEPRINT_HANDBOOK.md", "See docs/BLUEPRINT_HANDBOOK.md in the unreal-mcp repository.") } }],
  })
);

server.registerPrompt(
  "unreal_recipes",
  {
    title: "Verified builds of the systems people ask for",
    description:
      "Complete, step-by-step builds for health and damage via an interface, interaction by line trace, pickups, a " +
      "HUD bound to a value, timers instead of Tick, spawning, and save/load - each with the exact tool call order " +
      "and the exact node names. Every function name is verified against the running engine, and the guide names " +
      "the nodes that are NOT functions (Branch, Cast, Create Widget, Spawn Actor) which no amount of searching the " +
      "function catalog will ever find. Pull this in before building any common system.",
  },
  () => ({
    messages: [{ role: "user", content: { type: "text", text: loadDoc("RECIPES.md", "See docs/RECIPES.md in the unreal-mcp repository.") } }],
  })
);

server.registerPrompt(
  "unreal_workflow",
  {
    title: "How to drive these Unreal tools well",
    description:
      "The recommended tool-call order for building Blueprint features through this server, plus the sharp edges " +
      "that cost a failed call each to discover: exec pin naming, cast pin spacing, struct default formats, the two " +
      "UMG traps, multiplayer and performance judgment, and the rule that compiling is not the same as done. Pull " +
      "this in at the start of any session that will edit an Unreal project.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: loadWorkflowGuide() },
      },
    ],
  })
);

register(
  "unreal_session_changes",
  {
    title: "What has been changed in this project so far",
    description:
      "Reports every change this server has made to the project during this session, grouped by asset and written " +
      "in plain language rather than command names, plus anything that failed and anything that was deleted. " +
      "Handing an AI direct control of a game engine introduces a failure mode that does not exist when a human is " +
      "clicking the buttons: the human always knows what they touched. Use this to close that gap. Show it to the " +
      "user before they save, when they ask what you did, when they seem unsure about letting you edit their " +
      "project, or before doing anything you cannot easily reverse. It reads the server's own log, costs nothing, " +
      "and touches the editor not at all.",
    inputSchema: {
      detailed: z.boolean().optional().describe("Include the full command-by-command list as well as the summary. Defaults to false."),
    },
  },
  async ({ detailed }) => {
    const summary = journal.summary();
    return jsonResult(detailed ? { ...summary, log: journal.all() } : summary);
  }
);

register(
  "unreal_create_material",
  {
    title: "Create a Material",
    description:
      "Creates a master Material with BaseColor, Metallic and Roughness (and optionally EmissiveColor, a base colour " +
      "texture and a normal map) exposed as " +
      "PARAMETERS rather than baked-in constants. That matters: a parameterised master material can be instanced, " +
      "which is how a real project gets fifty variations without fifty material graphs, and it is what lets the " +
      "look be adjusted later without rebuilding anything.\n\n" +
      "Materials are most of what a player actually sees, so this is usually worth doing before fussing over " +
      "geometry. Make the master once, then make cheap variations with unreal_create_material_instance and " +
      "unreal_set_material_parameter. Assign a material to a mesh with unreal_set_component_property, or to a " +
      "level actor via unreal_spawn_actor's mesh.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Materials/M_Metal". Prefix material assets with M_ by convention.'),
      baseColor: z.string().optional().describe('Base colour as "R,G,B" or "R,G,B,A", each 0-1. Defaults to mid grey. Example: "1,0,0" for red.'),
      metallic: z.number().optional().describe("0 for non-metal (plastic, wood, stone), 1 for bare metal. Values in between are rarely physically correct. Defaults to 0."),
      roughness: z.number().optional().describe("0 is a mirror, 1 is completely matte. Most real surfaces sit between 0.2 and 0.8. Defaults to 0.5."),
      emissiveColor: z.string().optional().describe('Optional glow colour as "R,G,B". Values above 1 glow brighter, e.g. "0,5,10" for a bright blue glow. Omit for non-glowing surfaces.'),
      baseColorTexture: z
        .string()
        .optional()
        .describe(
          'Optional texture asset path for the surface colour. When given, the material becomes texture x tint: ' +
            'baseColor acts as a colour multiplier over the texture rather than replacing it, which is how a master ' +
            'material stays recolourable per instance. Verify the path with unreal_list_assets className=Texture2D.'
        ),
      normalTexture: z
        .string()
        .optional()
        .describe(
          "Optional normal map asset path, sampled as a normal map and wired to the Normal input. This is what gives " +
            "a flat surface visible bumps and detail under lighting, and is most of the difference between a surface " +
            "that reads as a real material and one that reads as coloured plastic."
        ),
    },
  },
  async ({ packagePath, baseColor, metallic, roughness, emissiveColor }) => {
    try {
      const result = await bridge.send("create_material", { packagePath, baseColor, metallic, roughness, emissiveColor });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_create_material_instance",
  {
    title: "Create a Material Instance from a parent material",
    description:
      "Creates a Material Instance: a cheap variation of a parent material that overrides some of its parameters " +
      "and shares everything else. Making ten coloured variants of one master material is ten instances, not ten " +
      "materials, and they cost almost nothing to add.\n\n" +
      "Override parameters afterwards with unreal_set_material_parameter. If the parent has no parameters, the " +
      "instance has nothing to override, which usually means the parent was built with constants instead of " +
      "parameters.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Materials/MI_RedMetal". Prefix instances with MI_ by convention.'),
      parentMaterial: z.string().describe('Full path of the parent, e.g. "/Game/Materials/M_Metal.M_Metal". A Material or another Material Instance.'),
    },
  },
  async ({ packagePath, parentMaterial }) => {
    try {
      const result = await bridge.send("create_material_instance", { packagePath, parentMaterial });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_material_parameter",
  {
    title: "Override a parameter on a Material Instance",
    description:
      "Sets one parameter on a Material Instance. Pass exactly one of scalar, color, or texture, matching the " +
      "parameter's kind. Parameters are overridden on an INSTANCE, never on the master material: that is the whole " +
      "point of the split, and setting it on the master would change every instance at once.\n\n" +
      "Call unreal_list_material_parameters first if you are unsure what a material exposes, rather than guessing " +
      "names.",
    inputSchema: {
      path: z.string().describe('Material Instance path, e.g. "/Game/Materials/MI_RedMetal.MI_RedMetal".'),
      parameter: z.string().describe('Parameter name, e.g. "BaseColor", "Roughness".'),
      scalar: z.number().optional().describe("Value for a scalar parameter, e.g. 0.2 for Roughness."),
      color: z.string().optional().describe('Value for a vector/colour parameter, as "R,G,B" or "R,G,B,A", each 0-1.'),
      texture: z.string().optional().describe('Full path of a texture asset for a texture parameter. Verify it with unreal_list_assets className=Texture2D.'),
    },
  },
  async ({ path, parameter, scalar, color, texture }) => {
    try {
      const result = await bridge.send("set_material_parameter", { path, parameter, scalar, color, texture });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_material_parameters",
  {
    title: "List a material's parameters",
    description:
      "Returns every scalar, colour, and texture parameter a Material or Material Instance exposes, with its kind, " +
      "and whether the asset is an instance. Use it before unreal_set_material_parameter to get names and kinds " +
      "right, and to check whether a material someone else authored is instanceable at all.",
    inputSchema: {
      path: z.string().describe('Material or Material Instance path, e.g. "/Game/Materials/M_Metal.M_Metal".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("list_material_parameters", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_map_system",
  {
    title: "Map an existing system across the Blueprints it spans",
    description:
      "**Call this FIRST on any request that touches an existing project, before reading a single graph.**\n\n" +
      "Give it a concept (\"health\", \"inventory\", \"door\", \"save\") and it returns the assets that make up that " +
      "system, how they reference each other, which ones are risky to change, and the order to read them in. It is " +
      "built entirely from the project index and the asset dependency graph, so mapping a twenty-asset system costs " +
      "a fraction of reading one large Blueprint.\n\n" +
      "This exists because of the single hardest thing about working on a real project: one Blueprint is wired to " +
      "five others, and no amount of describing it in prose conveys that. Without the map, the usual failure is to " +
      "read the first matching asset, assume it is the whole system, and edit it - which is how a working project " +
      "gets broken.\n\n" +
      "Use it for three things:\n" +
      "  1. **Before building anything**, to find out whether the system already exists. If it does, extend it " +
      "instead of adding a second one, and tell the user what you found.\n" +
      "  2. **Before editing**, to see what else depends on what you are about to change. `highRisk` lists assets " +
      "with referencers outside the system: changing those is a project-wide event.\n" +
      "  3. **To decide what to read**, using `readingOrder`, which puts the most depended-on assets first because " +
      "they define the contracts the rest obey.\n\n" +
      "An empty result is informative: it means the system genuinely is not there, or is named something else.",
    inputSchema: {
      query: z.string().describe('The concept, in the project\'s own words, e.g. "health", "inventory", "vacuum". Try one word first; narrow only if the map is truncated.'),
      maxAssets: z.number().optional().describe("Cap on assets in the map. Defaults to 25. Raise it if the map reports being truncated."),
      depth: z.number().optional().describe("How many reference hops to follow out from the matches. Defaults to 2, which is usually the whole system. 1 is tighter, 3 tends to pull in the entire project."),
    },
  },
  async ({ query, maxAssets, depth }) => {
    try {
      const result = await mapSystem(bridge, query, { maxAssets, depth });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_plan_feature",
  {
    title: "Check a feature request against the project before building it",
    description:
      "**Call this the moment the user asks for a feature, before anything else.** Give it their request in their " +
      "own words. It checks every concept in the request against the project and reports what already exists, what " +
      "a change would affect, what is genuinely new, and the project's own naming and folder conventions.\n\n" +
      "This is the difference between a code generator and a colleague. A colleague asked for a stamina system " +
      "does not immediately start typing: they say \"you already have a stamina variable on BP_Player and a HUD bar " +
      "reading it - do you want me to extend that, or did you mean something else?\" That one sentence is worth more " +
      "than any graph you could build instead, because the alternative is a second system quietly competing with " +
      "the first, and the user will not find out for weeks.\n\n" +
      "**Relay `raiseWithUser` to the user in plain language and wait for an answer** when it says something already " +
      "exists or that a change reaches outside the system. Do not treat it as advisory and proceed anyway; that is " +
      "the exact behaviour that makes people distrust these tools.\n\n" +
      "Read-only, index-backed, and costs a fraction of one Blueprint read, so there is no budget excuse to skip it. " +
      "Follow `conventions` when naming new assets: work that looks like the rest of the project is work someone " +
      "will keep.",
    inputSchema: {
      request: z.string().describe("The user's request, in their own words. Do not rewrite or summarise it first; the wording carries the concepts."),
      concepts: z
        .array(z.string())
        .optional()
        .describe("Override the concepts to check, if you already know the project's vocabulary better than the request does (e.g. the user says \"energy\" but the project calls it Stamina)."),
    },
  },
  async ({ request, concepts }) => {
    try {
      const plan = await planFeature(bridge, request, { concepts });
      return jsonResult(plan);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_list_actors",
  {
    title: "Read what is already in the open level",
    description:
      "**Call this before changing anything in a level.** Returns every actor in the currently open level with its " +
      "label, name, class, rounded location, and the Blueprint behind it where there is one, plus a per-class " +
      "census so a large level is legible without listing all of it.\n\n" +
      "Spawning into a level you have not read is how an agent ends up with two PlayerStarts, a second directional " +
      "light fighting the first, or a duplicate of something that was already there under a different name. On a " +
      "level someone has spent months dressing, that is worse than doing nothing.\n\n" +
      "The `blueprint` field on an entry tells you which actors have logic behind them, and therefore which are " +
      "worth reading with unreal_read_blueprint_summary next. Use classFilter to narrow a big level (it matches on " +
      "the class name), and remember that this reads the OPEN level: call unreal_open_level first if you mean a " +
      "different one.",
    inputSchema: {
      classFilter: z.string().optional().describe('Only return actors whose class name contains this, e.g. "Light", "PlayerStart", "BP_".'),
      maxResults: z.number().optional().describe("Cap on actors returned. Defaults to 200. The per-class census always covers the whole level regardless."),
    },
  },
  async ({ classFilter, maxResults }) => {
    try {
      const result = await bridge.send("list_actors", { classFilter, maxResults });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_set_actor_property",
  {
    title: "Set a property on one placed actor",
    description:
      "Overrides a property on a single actor instance in the open level, by its World Outliner label or its name. " +
      "This is how a specific door gets a different open angle, one light gets a different colour, or one spawner " +
      "gets a different enemy class, without touching the Blueprint they all come from.\n\n" +
      "**This changes only that one instance.** To change every instance, use unreal_set_class_default on the " +
      "Blueprint instead. Getting this backwards is the classic level-editing mistake, so the response states which " +
      "one happened. Values follow the same string coercion as the other property tools, and an asset path that " +
      "does not resolve fails rather than silently setting None.\n\n" +
      "Changes live in memory until unreal_save_level.",
    inputSchema: {
      actor: z.string().describe("The actor's World Outliner label, or its internal name. Get exact values from unreal_list_actors."),
      property: z.string().describe('Property name, e.g. "LightColor", "Intensity", "bHidden".'),
      value: z.string().describe('Value as a string: "true", "3000.0", an asset path, or a struct literal like "(R=1,G=0,B=0,A=1)".'),
    },
  },
  async ({ actor, property, value }) => {
    try {
      const result = await bridge.send("set_actor_property", { actor, property, value });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_delete_actor",
  {
    title: "Remove one actor from the open level",
    description:
      "Deletes a single placed actor from the currently open level, by label or name. Use it to remove template " +
      "debris, a duplicate that should not have been spawned, or something the user has asked to take out.\n\n" +
      "Read the level with unreal_list_actors first and be certain of the label: unlike unreal_delete_asset, which " +
      "refuses when something still references the target, an actor in a level can be referenced by other actors " +
      "in ways that are not checkable here. The removal is undoable in the editor and lives in memory until " +
      "unreal_save_level, so a mistake is recoverable - but only if it is noticed.",
    inputSchema: {
      actor: z.string().describe("The actor's World Outliner label, or its internal name, exactly as unreal_list_actors reports it."),
    },
  },
  async ({ actor }) => {
    try {
      const result = await bridge.send("delete_actor", { actor });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_undo_history",
  {
    title: "What the editor can currently undo",
    description:
      "Reads the editor's real undo stack, newest first. Position 1 is what the next Ctrl+Z will reverse, and every " +
      'entry says whether this bridge made it (they are titled "MCP: ..."). ' +
      "Pair it with unreal_session_changes: that reports what this server believes it changed, this reports what the " +
      "editor will actually give back. Show it to a user who is nervous about letting an agent edit their project, " +
      "or before doing something you would want reversed. Being able to say \"the last four entries are mine and " +
      "Ctrl+Z takes them back in order\" is worth more than any reassurance. " +
      "This is a read. Undo itself is performed by a human in the editor, deliberately: an agent that can silently " +
      "undo its own work can also silently undo yours.",
    inputSchema: {
      maxResults: z.number().optional().describe("How many entries to return, newest first. Defaults to 20."),
    },
  },
  async ({ maxResults }) => {
    try {
      const result = await bridge.send("undo_history", { maxResults });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_project_health",
  {
    title: "Find where the project needs attention, without reading it",
    description:
      "Scans the whole project for the Blueprints most worth looking at: graphs too large to read at a glance, " +
      "Blueprints that have grown into systems rather than classes, and cast-heavy Blueprints where an interface " +
      "should have replaced the chain. " +
      "unreal_review_blueprint answers \"is this one Blueprint good?\". Nobody asks that first. On a project someone " +
      "has been building for months the real question is \"where is the damage?\", and answering it by reviewing " +
      "every Blueprint in turn costs a read per asset. This costs none: it is computed from node-type histograms " +
      "the project index already keeps. " +
      "Use it to orient at the start of work on an unfamiliar project, or when a user asks what needs cleaning up. " +
      "Then run unreal_review_blueprint on the specific Blueprints it names. " +
      "Every finding says what it measured and every threshold explains itself, because these are places worth " +
      "LOOKING at rather than defects. A large graph can be perfectly fine. Deliberately absent: per-frame Tick " +
      "work, because the index stores node classes and cannot tell an Event Tick from an Event BeginPlay - " +
      "guessing would produce confident false positives on the measure people most want to trust. " +
      "unreal_review_blueprint reads real titles and reports that properly.",
    inputSchema: {
      maxPerCategory: z.number().optional().describe("How many offenders to list per category, worst first. Defaults to 10."),
    },
  },
  async ({ maxPerCategory }) => {
    try {
      const result = await bridge.send("project_health", { maxPerCategory });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_cleanup_blueprint",
  {
    title: "Act on the review findings that are safe to fix automatically",
    description:
      "Runs the quality review and applies the fixes that cannot change what the Blueprint does: removing nodes " +
      "wired to nothing, and laying the graph out with each execution chain in a labelled comment box. Then it " +
      "re-reviews and reports the score before and after, because a cleanup that claims success without checking is " +
      "the same failure as a model that reads findings and declares victory. " +
      "What it deliberately does NOT touch is listed in `leftForYou`, each with the reason. Removing a leftover " +
      "Print String means healing the execution chain around it; renaming a placeholder variable needs a name; an " +
      "unhandled cast failure needs a decision about what should happen. Those are yours, and the tool says so " +
      "rather than silently leaving them. " +
      "The narrowness is the design. A cleanup tool that quietly changes behaviour is far more damaging than one " +
      "that leaves work on the table, because whoever runs it is least able to notice. Pass dryRun to see what " +
      "would change first.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      removeDeadNodes: z.boolean().optional().describe("Remove nodes connected to nothing. Defaults to true; they cannot affect behaviour."),
      labelSections: z.boolean().optional().describe("Lay out the graph and wrap each execution chain in a titled comment box. Defaults to true; purely cosmetic."),
      dryRun: z.boolean().optional().describe("Report what would change without changing anything. Defaults to false."),
    },
  },
  async ({ path, removeDeadNodes, labelSections, dryRun }) => {
    try {
      const report = await cleanupBlueprint(bridge, path, { removeDeadNodes, labelSections, dryRun });
      return jsonResult(report);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_add_event_handler",
  {
    title: "When this happens, do these things",
    description:
      "**The easiest way to make something happen, and the first thing to reach for.** Give an event and the calls " +
      "that should follow, in order; the execution chain is wired for you, so you name no pins, refs, or " +
      'connections. Events: "BeginPlay", "Tick", "ActorBeginOverlap" map to the engine ones; any other name makes a ' +
      "Custom Event. A function's class is looked up in the live engine if you omit it, and one this engine does " +
      "not have is refused before anything is built. Everything lands in one atomic call. " +
      "For branches, loops, or wiring one node's output into another's input, use unreal_build_graph.",
    inputSchema: {
      path: z.string().describe('Blueprint asset path, e.g. "/Game/Blueprints/BP_Player.BP_Player".'),
      graphName: z.string().optional().describe('Graph to build in. Defaults to "EventGraph".'),
      event: z
        .string()
        .describe('The trigger: "BeginPlay", "Tick", "ActorBeginOverlap", or any other name to make a Custom Event.'),
      actions: z
        .array(
          z.object({
            function: z.string().describe('Function to call, e.g. "PrintString".'),
            className: z.string().optional().describe('Owning class, e.g. "KismetSystemLibrary". Looked up if omitted.'),
            params: z
              .record(z.string())
              .optional()
              .describe('Input values by pin name, e.g. {"In String":"hello"}. Near-miss pin names are resolved for you.'),
          })
        )
        .describe("What happens, in order. They are chained together for you."),
      compile: z.boolean().optional().describe("Compile afterwards. Defaults to true."),
    },
  },
  async ({ path, graphName, event, actions, compile }) => {
    try {
      const result = await addEventHandler(bridge, path, graphName ?? "EventGraph", event, actions, { compile });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_scaffold_blueprint",
  {
    title: "Build a whole Blueprint in one call",
    // The rationale for this tool - the measured four-step failure of small models - lives in
    // src/scaffold.ts and docs/LOCAL_MODEL_BENCHMARK.md, deliberately not here. A description is
    // paid on every request by every client; the reasoning behind it is paid once by a reader.
    // This project measured ~600 extra characters pushing a 7B into truncating its output
    // mid-JSON, so the budget is spent on what a caller needs in order to act.
    description:
      "**Build the entire thing in one call: the Blueprint, its variables, its components, and its event logic.** " +
      "Reach for this first whenever you are creating something new. " +
      "The order is handled for you: variables and components exist before any graph references them, and the " +
      "Blueprint is compiled once at the end, then laid out, reviewed and saved. " +
      "A step that fails is reported in `failures` and the rest still proceeds. " +
      "Everything here is also available as separate tools if you need finer control.",
    inputSchema: {
      packagePath: z.string().describe('Where to create it, e.g. "/Game/Blueprints/BP_Pickup".'),
      parentClass: z.string().describe('Parent class: "Actor", "Pawn", "Character", "ActorComponent", or a Blueprint path.'),
      variables: z
        .array(
          z.object({
            name: z.string(),
            type: z.string().describe('Compact type: "float", "int", "bool", "text", "object:Texture2D", "struct:S_Item", "enum:E_State".'),
            defaultValue: z.string().optional(),
          })
        )
        .optional()
        .describe("Member variables. Added before any graph logic that might reference them."),
      components: z
        .array(
          z.object({
            componentClass: z.string().describe('e.g. "StaticMeshComponent", "SphereComponent", "AudioComponent", "NiagaraComponent".'),
            name: z.string(),
            parent: z.string().optional().describe("Attach under this component instead of the root."),
            properties: z.record(z.string()).optional().describe('Properties to set, e.g. {"SphereRadius":"120"}.'),
          })
        )
        .optional()
        .describe("Components, with their properties set for you."),
      handlers: z
        .array(
          z.object({
            event: z.string().describe('"BeginPlay", "Tick", "ActorBeginOverlap", or any name for a Custom Event.'),
            actions: z
              .array(
                z.object({
                  function: z.string(),
                  className: z.string().optional().describe("Looked up in the live engine when omitted."),
                  params: z.record(z.string()).optional(),
                })
              )
              .describe("What happens, in order. The execution chain is wired for you."),
          })
        )
        .optional()
        .describe("Event logic. No pin names, refs, or connections needed."),
      save: z.boolean().optional().describe("Save at the end. Defaults to true."),
    },
  },
  async ({ packagePath, parentClass, variables, components, handlers, save }) => {
    try {
      const result = await scaffoldBlueprint(bridge, {
        packagePath,
        parentClass,
        variables,
        components,
        handlers,
        save,
      });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

register(
  "unreal_asset_status",
  {
    title: "Can this asset actually be written?",
    description:
      "Reports whether an asset can be saved, and if not, why - **before** you spend a sequence of edits on it. " +
      "On a team project a Blueprint is a binary asset that cannot be merged, so it is locked by whoever checked it " +
      "out, and without this the failure only surfaces at save time, after the work is done. " +
      "**Check this before editing anything in a project that uses source control.** If it comes back not writable, " +
      "say so to the user and offer to work on something else: \"BP_Door is checked out by alice, so I cannot save " +
      "changes to it\" is a far better answer than a pile of edits that cannot be written. " +
      "Deliberately a separate call rather than a check inside every write, because querying source control can hit " +
      "the network and paying that per node placement would slow the common case to protect the rare one.",
    inputSchema: {
      path: z.string().describe('Asset path, e.g. "/Game/Blueprints/BP_Door.BP_Door".'),
    },
  },
  async ({ path }) => {
    try {
      const result = await bridge.send("asset_status", { path });
      return jsonResult(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main() {
  // `unreal-mcp-server --doctor` runs the same diagnosis from a terminal, with no MCP client
  // involved. When the complaint is "my AI tool cannot see Unreal", removing the AI tool from the
  // picture is the fastest way to find out which half is broken.
  // "lazy": everything is registered with full schemas, but only the core group is switched on.
  // The rest arrive when unreal_enable_tools asks for them.
  if (PROFILE === "lazy") {
    for (const [name, handle] of toolHandles) {
      if (!CORE_PROFILE_TOOLS.has(name)) handle.disable();
    }
  }

  // `--print-config` emits the exact JSON to paste into a client, with absolute paths already
  // resolved.
  //
  // Client setup is its own category of failure, and it is entirely self-inflicted: a missing comma
  // breaks the whole file, a relative path silently does not resolve, and on Windows a bare "node"
  // may not be on the PATH the client uses. Every one of those produces the same symptom - the
  // server never starts and the user has no idea why. None of it is interesting, and none of it
  // should be typed by hand by someone whose actual goal is to make a game.
  if (process.argv.includes("--print-config")) {
    const entry = fileURLToPath(import.meta.url);
    const clientIndex = process.argv.indexOf("--client");
    const client = clientIndex >= 0 ? process.argv[clientIndex + 1] : "claude-desktop";
    const isWindows = process.platform === "win32";
    // Built from a char code: a literal backslash in a path string is the single most common
    // thing to lose to an editor, a shell, or a copy-paste on the way here.
    const BACKSLASH = String.fromCharCode(92);

    // process.execPath is the node that is running THIS, so it is guaranteed to exist and to be
    // the right one. "node" would depend on the client's PATH, which is the usual cause of a
    // server that never starts.
    const server = {
      command: process.execPath,
      args: [entry],
      env: {
        UNREAL_MCP_PROFILE: process.env.UNREAL_MCP_PROFILE ?? "lazy",
        UNREAL_MCP_MODE: process.env.UNREAL_MCP_MODE ?? "standard",
      },
    };

    const configs: Record<string, unknown> = {
      "claude-desktop": { mcpServers: { unreal: server } },
      cursor: { mcpServers: { unreal: server } },
      "claude-code": { mcpServers: { unreal: server } },
    };
    const chosen = configs[client] ?? configs["claude-desktop"];

    const where: Record<string, string> = {
      "claude-desktop": isWindows
        ? `%APPDATA%${BACKSLASH}Claude${BACKSLASH}claude_desktop_config.json`
        : "~/Library/Application Support/Claude/claude_desktop_config.json",
      cursor: isWindows ? `%USERPROFILE%${BACKSLASH}.cursor${BACKSLASH}mcp.json` : "~/.cursor/mcp.json",
      "claude-code": "run: claude mcp add-json unreal '<the JSON below>'",
    };

    console.log(`# Paste this into: ${where[client] ?? where["claude-desktop"]}`);
    console.log("#");
    console.log("# Paths are absolute and already correct for this machine. If the file already has");
    console.log('# an "mcpServers" block, add the "unreal" entry inside it rather than replacing it.');
    console.log("# Then FULLY QUIT the client and reopen it - closing the window is not enough.");
    console.log("");
    console.log(JSON.stringify(chosen, null, 2));
    process.exit(0);
  }

  if (process.argv.includes("--doctor")) {
    const report = await runDoctor(rawBridge, { host: BRIDGE_HOST, port: BRIDGE_PORT, expectedProject: EXPECT_PROJECT });
    console.log(formatDoctorReport(report));
    process.exit(report.verdict === "not_connected" ? 1 : 0);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `unreal-mcp-server: connected via stdio; bridge target ${BRIDGE_HOST}:${BRIDGE_PORT}; ` +
      `profile "${PROFILE}" with ${[...toolHandles.values()].filter((h) => h.enabled).length}/${registeredToolNames.length} tools enabled; ` +
      `mode "${MODE.mode}"`
  );
  if (MODE_WARNING) {
    console.error(`unreal-mcp-server: ${MODE_WARNING}`);
  }
  if (PROFILE !== "core" && PROFILE !== "full" && PROFILE !== "lazy" && PROFILE !== "minimal") {
    console.error(
      `unreal-mcp-server: unknown UNREAL_MCP_PROFILE "${PROFILE}", treated as "full". Valid: minimal, core, lazy, full.`
    );
  }
}

main().catch((err) => {
  console.error("unreal-mcp-server: fatal error", err);
  process.exit(1);
});

