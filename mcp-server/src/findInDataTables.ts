/**
 * Find a value in the project's Data Tables, by row name or by cell contents.
 *
 * This did not exist, and the gap only showed up by trying to do the job. A change request - "the
 * machine gun should cost 500 instead of 300" - starts with finding where that number lives, and
 * nothing in this server could answer it:
 *
 *   search_project "Weapon_MachineGun"  ->  0 hits
 *
 * `Weapon_MachineGun` is a real row in this project's DT_Upgrades. search_project indexes Blueprint
 * names, parent classes, function names and variable names; row names and cell values are simply not
 * in the index, and it returned `{hits: [], hitCount: 0}` without saying so. check_data_tables walks
 * every table but reports PROBLEMS, not values - the row is mentioned in its output only when it
 * happens to be broken.
 *
 * So a whole substrate of the project - the one a data-driven game keeps its tuning in - was
 * unsearchable, which makes "whether it's C++ or Blueprints or a Data Table" untrue for the third of
 * those.
 *
 * ## Composed, not a new bridge command
 *
 * list_assets(DataTable) then list_data_table_rows per table, matched here. That is one round trip
 * per table - 20 on this project - and it needs no plugin rebuild, so it works against the binary a
 * user already has rather than the one they have not rebuilt yet.
 *
 * The rows never reach the caller. Reading all 20 tables on this project is 128 rows and far more
 * than any reply should carry; what comes back is where the match is, not what the table contains.
 */
import type { BridgeLike } from "./autoLayout.js";

export interface DataTableHit {
  table: string;
  rowName: string;
  /** The field the match was found in, or "rowName" when the row's own name matched. */
  field: string;
  /** The matching value, trimmed. Absent when the row name matched rather than a cell. */
  value?: string;
}

export interface FindInDataTablesResult {
  query: string;
  tablesSearched: number;
  rowsSearched: number;
  hitCount: number;
  hits: DataTableHit[];
  /** Tables that could not be read, so "no hits" can be told apart from "could not look". */
  unreadable?: Array<{ table: string; error: string }>;
  truncated?: boolean;
  next: string;
}

interface RowsReply {
  rows?: Array<{ rowName?: string; values?: Record<string, unknown> }>;
}

/** Unreal exports asset references as a long qualified form; the readable part is the asset name. */
function shorten(value: string): string {
  const quoted = /'([^']+)'/.exec(value);
  const path = quoted ? quoted[1] : value;
  return path.length > 90 ? `${path.slice(0, 87)}...` : path;
}

export async function findInDataTables(
  bridge: BridgeLike,
  query: string,
  options: { maxResults?: number; pathPrefix?: string } = {}
): Promise<FindInDataTablesResult> {
  const needle = query.trim().toLowerCase();
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 50, 500));

  const listed = await bridge.send<{ assets?: Array<{ path?: string } | string> }>("list_assets", {
    className: "DataTable",
    pathPrefix: options.pathPrefix,
    maxResults: 500,
  });
  const tables = (listed.assets ?? [])
    .map((a) => (typeof a === "string" ? a : a.path))
    .filter((p): p is string => typeof p === "string" && p.length > 0);

  const hits: DataTableHit[] = [];
  const unreadable: Array<{ table: string; error: string }> = [];
  let rowsSearched = 0;
  let truncated = false;

  for (const table of tables) {
    let reply: RowsReply;
    try {
      reply = await bridge.send<RowsReply>("list_data_table_rows", { path: table });
    } catch (err) {
      // A table that cannot be read is not a table with no matches. Reporting them together would
      // mean "not found" sometimes meant "not looked at", which is the answer this project refuses
      // to give anywhere else.
      unreadable.push({ table, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    for (const row of reply.rows ?? []) {
      rowsSearched += 1;
      if (hits.length >= maxResults) {
        truncated = true;
        continue; // keep counting so rowsSearched stays honest
      }
      const rowName = String(row.rowName ?? "");
      if (rowName.toLowerCase().includes(needle)) {
        hits.push({ table, rowName, field: "rowName" });
        continue; // one hit per row: the row name matching is the whole answer for that row
      }
      for (const [field, raw] of Object.entries(row.values ?? {})) {
        const value = typeof raw === "string" ? raw : JSON.stringify(raw);
        if (value === undefined || value === null) continue;
        if (value.toLowerCase().includes(needle)) {
          hits.push({ table, rowName, field, value: shorten(value) });
          break; // the first matching field locates the row; the rest is the caller's to read
        }
      }
    }
  }

  const next =
    hits.length === 0
      ? `Nothing in ${tables.length} Data Table(s) contains "${query}"` +
        (unreadable.length > 0
          ? `, and ${unreadable.length} table(s) could not be read - see unreadable, this is not a clean "not found".`
          : `. Searched every row name and every cell value. If you expected a match, the spelling in the ` +
            `table may differ, or the value may not live in a Data Table at all: unreal_search_project ` +
            `covers Blueprint names, functions and variables, unreal_list_components covers component ` +
            `properties like walk speed, and unreal_find_source covers C++ defaults.`)
      : `${hits.length} match(es) across ${tables.length} table(s). Read the row with ` +
        `unreal_list_data_table_rows({ path, rowName }) to see every field, and change it with ` +
        `unreal_set_data_table_row, then unreal_save_asset.` +
        (truncated ? ` Stopped at ${maxResults} hits; narrow the query or raise maxResults.` : "") +
        (unreadable.length > 0 ? ` ${unreadable.length} table(s) could not be read - see unreadable.` : "");

  return {
    query,
    tablesSearched: tables.length,
    rowsSearched,
    hitCount: hits.length,
    hits,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    ...(truncated ? { truncated: true } : {}),
    next,
  };
}
