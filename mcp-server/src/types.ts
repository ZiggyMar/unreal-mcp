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
