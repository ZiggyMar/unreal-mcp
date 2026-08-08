#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { UnrealBridgeClient } from "./bridgeClient.js";
import { enrichSearchHits, isEnrichmentEnabled } from "./enrichment.js";
import type {
  AddNodeResult,
  AddVariableResult,
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

const bridge = new UnrealBridgeClient({ host: BRIDGE_HOST, port: BRIDGE_PORT });

const server = new McpServer({
  name: "unreal-mcp-server",
  version: "0.1.0",
});

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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
  "unreal_create_blueprint",
  {
    title: "Create a new Blueprint asset",
    description:
      "Creates a new empty Blueprint asset at a given content path with a given parent class, and saves it to disk " +
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
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

server.registerTool(
  "unreal_create_function",
  {
    title: "Create a function in a Blueprint",
    description:
      "Creates a new function graph on a Blueprint with typed inputs and outputs, and returns the graph name plus " +
      "the entry (and result, if outputs exist) node ids so you can immediately add nodes inside it with " +
      "unreal_add_node targeting the new graphName. Wire logic from the entry node's output pins to the result " +
      "node's input pins. Call the function from other graphs via unreal_add_node CallFunction with functionName " +
      "set to this name and no className. Type strings are the same compact descriptors unreal_add_variable uses " +
      '("bool", "int", "float", "string", "vector", "object:<Class>", ...).',
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

server.registerTool(
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`unreal-mcp-server: connected via stdio; bridge target ${BRIDGE_HOST}:${BRIDGE_PORT}`);
}

main().catch((err) => {
  console.error("unreal-mcp-server: fatal error", err);
  process.exit(1);
});

