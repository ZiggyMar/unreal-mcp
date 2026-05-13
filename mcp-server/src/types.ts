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

export interface ReadBlueprintNodeDetailResult {
  id: string;
  type: string;
  title: string;
  comment: string;
  enabled: boolean;
  pins: NodeDetailPin[];
}

// --- Milestone 2: write/edit result shapes ---

export interface CreateBlueprintResult {
  path: string;
  name: string;
  parentClass: string;
  saved: boolean;
  saveError?: string;
}

export interface AddNodeResult {
  id: string;
  type: string;
  title: string;
  /** True if this was an existing override-event node reused instead of creating a duplicate. */
  alreadyExisted?: boolean;
}

export interface ConnectPinsResult {
  connected: boolean;
  note?: string;
}

export interface SetPinDefaultValueResult {
  set: boolean;
  pin: string;
  value: string;
}

export interface RemoveNodeResult {
  removed: boolean;
  id: string;
  type: string;
}

export interface AddVariableResult {
  added: boolean;
  name: string;
  type: string;
}

export type CompileMessageSeverity = "error" | "warning" | "performance_warning" | "info";

export interface CompileMessage {
  severity: CompileMessageSeverity;
  text: string;
}

export interface CompileBlueprintResult {
  success: boolean;
  errorCount: number;
  warningCount: number;
  status: string;
  messages: CompileMessage[];
}

export interface SaveBlueprintResult {
  saved: boolean;
  path: string;
}

// --- Milestone 3: project-wide index result shapes ---

export type SearchHitKind = "blueprint" | "function" | "variable";

export interface SearchHit {
  kind: SearchHitKind;
  path: string;
  name: string;
  context: string;
  /** Optional one-line natural-language description, added client-side by enrichment.ts
   * when UNREAL_MCP_LOCAL_LLM_URL is configured. Never present in the raw bridge response. */
  summary?: string;
}

export interface SearchProjectResult {
  query: string;
  hits: SearchHit[];
