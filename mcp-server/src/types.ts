// Shapes returned by UnrealMCPBridge (see UnrealMCPBridge/Source/UnrealMCPBridge/Private/MCPCommandHandler.cpp).
// Kept intentionally minimal/compact to match the bridge's token-lean wire format.

export interface PingResult {
  status: string;
  plugin: string;
  protocolVersion: number;
}

export interface BlueprintListEntry {
  name: string;
  path: string;
  parentClass: string;
}

export interface ListBlueprintsResult {
  blueprints: BlueprintListEntry[];
  count: number;
}

export interface BlueprintGraphEntry {
  name: string;
  nodeCount: number;
}

export interface ListBlueprintGraphsResult {
  path: string;
  graphs: BlueprintGraphEntry[];
}

export interface PinLink {
  node: string;
  pin: string;
}

export interface GraphSummaryPin {
  pin: string;
  direction: "in" | "out";
  linkedTo: PinLink[];
}

export interface GraphSummaryNode {
  id: string;
  type: string;
  title: string;
  connectedPins: GraphSummaryPin[];
}

export interface ReadBlueprintGraphSummaryResult {
  path: string;
  graphName: string;
  nodes: GraphSummaryNode[];
}

export interface NodeDetailPin {
  name: string;
  direction: "in" | "out";
  category: string;
  subCategory?: string;
  defaultValue: string;
  isArray: boolean;
  linkedTo: PinLink[];
}

