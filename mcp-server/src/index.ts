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
  FindReferencesResult,
  GetProjectOverviewResult,
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
