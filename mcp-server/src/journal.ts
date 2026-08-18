/**
 * A record of everything this session changed.
 *
 * The complaint this answers is the one people raise about handing an AI direct control of an
 * engine: it introduces failure modes that do not exist when a human is clicking the buttons. The
 * human knows what they touched. The agent's user does not, and the user this project is aimed at
 * cannot read a Blueprint diff to find out.
 *
 * Undo already exists (every write lands in the editor's undo history under an "MCP:" prefix), but
 * undo is useless if you cannot see what there is to undo. So the server keeps a plain-language
 * log of every write it sent, which asset it targeted, and whether it worked - and will tell the
 * user on request, in an order that makes sense to someone who has never opened a Blueprint.
 *
 * Deliberately scoped: this records what THIS SERVER did. It is not an audit of the project, and
 * it does not claim to see edits made by a human in the editor or by another tool. That limit is
 * stated in the response rather than left for someone to discover.
 */

/** Commands that only read. Everything else is treated as a write, which is the safe default. */
const READ_ONLY_COMMANDS = new Set([
  "ping",
  "list_blueprints",
  "list_blueprint_graphs",
  "read_blueprint_graph_summary",
  "read_blueprint_node_detail",
  "search_project",
  "find_references",
  "get_project_overview",
  "find_node",
  "get_node_signature",
  "list_assets",
  "list_components",
  "list_widgets",
  "list_struct_fields",
  "list_enum_entries",
  "pie_status",
]);

/** Plain-language names, because "set_class_default" means nothing to the person being told. */
const HUMAN_READABLE: Record<string, string> = {
  create_blueprint: "created a Blueprint",
  create_widget_blueprint: "created a UI widget",
  create_struct: "created a data structure",
  create_enum: "created a list of named options",
  create_level: "created a level",
  create_function: "added a function",
  add_node: "added a node to a graph",
  build_graph: "built graph logic",
  connect_pins: "connected two nodes",
  set_pin_default_value: "set a value on a node",
  remove_node: "removed a node",
  add_variable: "added a variable",
  add_component: "added a component",
  set_component_property: "changed a component setting",
  set_class_default: "changed a class default",
  add_widget: "added a UI element",
  set_widget_property: "changed a UI element's appearance or layout",
  add_struct_field: "added a field to a data structure",
  organize_graph: "tidied a graph's layout",
  compile_blueprint: "compiled a Blueprint",
  save_blueprint: "saved a Blueprint",
  save_level: "saved the level",
  spawn_actor: "placed something in the level",
  open_level: "opened a level",
  delete_asset: "DELETED an asset",
  refresh_blueprint: "repaired a Blueprint's nodes",
  set_game_settings: "changed project settings",
  add_input_mapping: "added an input binding",
  start_pie: "started Play In Editor",
  stop_pie: "stopped Play In Editor",
};

export interface ChangeRecord {
  seq: number;
  command: string;
  /** The asset this touched, when the command names one. */
  target?: string;
  ok: boolean;
  error?: string;
}

export interface AssetChanges {
  asset: string;
  changes: string[];
  writeCount: number;
}

export interface SessionSummary {
  totalWrites: number;
  succeeded: number;
  failed: number;
  assetsTouched: number;
  destructive: ChangeRecord[];
  byAsset: AssetChanges[];
  failures: ChangeRecord[];
  scope: string;
  undo: string;
}

export function isWrite(command: string): boolean {
  return !READ_ONLY_COMMANDS.has(command);
}

/** Pull the asset a command acted on out of its parameters, whatever that command calls it. */
export function targetOf(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  const single = params.path ?? params.packagePath;
  if (typeof single === "string" && single.length > 0) return single;
  if (Array.isArray(params.paths)) {
    const paths = params.paths.filter((p): p is string => typeof p === "string");
    if (paths.length > 0) return paths.join(", ");
  }
  return undefined;
}

export class SessionJournal {
  private readonly records: ChangeRecord[] = [];
  private seq = 0;

  /** Record one attempted command. Reads are ignored: they change nothing and would drown the log. */
  record(command: string, params: Record<string, unknown> | undefined, ok: boolean, error?: string): void {
    if (!isWrite(command)) return;
    this.records.push({ seq: ++this.seq, command, target: targetOf(params), ok, error });
  }

  /** Everything recorded, oldest first. */
  all(): ChangeRecord[] {
    return [...this.records];
  }

  summary(): SessionSummary {
    const writes = this.records;
    const succeeded = writes.filter((r) => r.ok);
    const failures = writes.filter((r) => !r.ok);

    const byAssetMap = new Map<string, AssetChanges>();
    for (const record of succeeded) {
      const asset = record.target ?? "(project-wide)";
      if (!byAssetMap.has(asset)) byAssetMap.set(asset, { asset, changes: [], writeCount: 0 });
      const entry = byAssetMap.get(asset)!;
      const phrase = HUMAN_READABLE[record.command] ?? record.command;
      // Collapse repeats: "added a node to a graph x12" is readable, twelve identical lines are not.
      if (!entry.changes.includes(phrase)) entry.changes.push(phrase);
      entry.writeCount++;
    }

    const byAsset = [...byAssetMap.values()].sort((a, b) => b.writeCount - a.writeCount);

    return {
      totalWrites: writes.length,
      succeeded: succeeded.length,
      failed: failures.length,
      assetsTouched: byAsset.filter((a) => a.asset !== "(project-wide)").length,
      // Surfaced separately because these are the ones a user would most want to know about.
      destructive: succeeded.filter((r) => r.command === "delete_asset"),
      byAsset,
      failures,
      scope:
        "This lists what this MCP server changed during this session only. It does not see edits " +
        "made by hand in the editor, by another tool, or in an earlier session.",
      undo:
        "Every change above is in the editor's undo history under an \"MCP:\" prefix, so Ctrl+Z in " +
        "the editor reverses them one at a time, newest first. Nothing here is saved to disk until " +
        "a save command runs.",
    };
  }
}
