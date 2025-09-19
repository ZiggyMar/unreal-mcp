// Shapes returned by UnrealMCPBridge (see UnrealMCPBridge/Source/UnrealMCPBridge/Private/MCPCommandHandler.cpp).
// Kept intentionally minimal/compact to match the bridge's token-lean wire format.

export interface PingResult {
  status: string;
  plugin: string;
  protocolVersion: number;
}
