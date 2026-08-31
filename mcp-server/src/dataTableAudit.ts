/**
 * Find the Data Table rows that point at nothing.
 *
 * This check exists because of a real shipped build. A wave system read its enemy types from a Data
 * Table, one row's class reference had been cleared to None, and the spawner fed that null straight
 * into SpawnActorFromClass. It spawns nothing, raises nothing, and logs nothing. The counter that
 * tracks spawned enemies still incremented, so the wave never completed and the game simply stopped
 * producing enemies - which reads to a player as "the game is broken" and to a developer as "works
 * on my machine", because the row LOOKS fine in the editor: it has a name, a ratio, a wave number,
 * and one empty field among them.
 *
 * Nothing in this server could have found that. Every other check here reads Blueprint graphs, and
 * this bug was not in a graph. It was in data, which is exactly where a project's designers spend
 * their time and exactly where an audit that only reads code has nothing to say.
 *
 * How a null is recognised, given the bridge returns every value as a string. A field is an object
 * reference if ANY row in the table gives it a value that looks like an asset path, and a field
 * known to be an object reference is null when another row gives it "None". That inference is what
 * makes this work without the bridge having to report property types: the table itself carries the
 * evidence, because a table with one broken row necessarily has the working rows to compare against.
 *
 * Its limit is worth stating plainly rather than discovering later: a table whose rows are ALL null
 * for a field cannot be detected this way, because there is no working row left to establish that
 * the field was ever an object reference. That case is reported separately as a table that could not
 * be judged, rather than being silently passed.
 */

export interface BridgeLike {
  send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T>;
}

export interface NullReference {
  table: string;
  rowName: string;
  field: string;
  /** An example of the same field, filled in, from another row. Shows what it should look like. */
  exampleFromRow?: string;
  exampleValue?: string;
}

export interface DataTableAuditResult {
  tablesScanned: number;
  rowsScanned: number;
  nullReferences: NullReference[];
  /** Tables where every row was empty for some field, so nothing could be concluded. */
  undecidable: Array<{ table: string; field: string; why: string }>;
  unreadable: Array<{ table: string; why: string }>;
  /**
   * "clean" means every row was checkable and every one was fine. "partial" means no problems were
   * found AND some rows could not be judged - a whole column empty in every row gives nothing to
   * compare against, so there is no filled row to show whether it should hold an asset reference.
   *
   * Those were both "clean", which reads as a guarantee and was not one. The undecidable rows were
   * always in the reply; the word on the front of it did not admit them.
   */
  verdict: "clean" | "partial" | "problems";
  next: string;
}

/** Does this value look like an asset path the engine would resolve? */
function looksLikeAssetPath(value: string): boolean {
  return /^\/[A-Za-z0-9_]+\//.test(value.trim());
}

/** The engine's rendering of an empty object reference. */
function isEmptyReference(value: string): boolean {
  const v = value.trim();
  return v === "None" || v === "" || v === "null";
}

interface DataTableRows {
  path?: string;
  rows?: Array<{ rowName: string; values: Record<string, string> }>;
}

/**
 * Scan Data Tables for object-reference fields that are empty in some rows and filled in others.
 */
export async function auditDataTables(
  bridge: BridgeLike,
  options: { paths?: string[]; pathPrefix?: string; limit?: number } = {}
): Promise<DataTableAuditResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));

  let tables: string[] = options.paths ?? [];
  if (tables.length === 0) {
    // `className`, singular. The bridge takes one class name, not a list - which a mocked test
    // happily accepted and a real project rejected on the first call. The name is pinned by a test
    // now, because a parameter a fake will take and the engine will not is worth exactly one bug.
    const listed = await bridge.send<{ assets?: Array<{ path?: string } | string> }>("list_assets", {
      className: "DataTable",
      pathPrefix: options.pathPrefix ?? "/Game",
      maxResults: limit,
    });
    tables = (listed.assets ?? [])
      .map((a) => (typeof a === "string" ? a : a.path ?? ""))
      .filter((p) => p.length > 0);
  }
  tables = tables.slice(0, limit);

  const nullReferences: NullReference[] = [];
  const undecidable: DataTableAuditResult["undecidable"] = [];
  const unreadable: DataTableAuditResult["unreadable"] = [];
  let rowsScanned = 0;

  for (const table of tables) {
    let read: DataTableRows;
    try {
      read = await bridge.send<DataTableRows>("list_data_table_rows", { path: table });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // "That is not a Data Table" is not a failure to read one. When the caller hands over a list
      // of assets it touched - which is how verify_feature uses this - most of them are Blueprints,
      // and reporting each as unreadable would bury the one real finding in noise.
      if (options.paths !== undefined && /data_table_not_found|not a datatable|not a data table/i.test(why)) {
        continue;
      }
      // Anything else IS reported rather than skipped: a broken row must not be able to hide behind
      // a permissions or plugin-version problem.
      unreadable.push({ table, why });
      continue;
    }

    const rows = read.rows ?? [];
    rowsScanned += rows.length;
    if (rows.length === 0) continue;

    // Which fields are object references, and a filled-in example of each.
    const referenceFields = new Map<string, { row: string; value: string }>();
    const emptyByField = new Map<string, string[]>();

    for (const row of rows) {
      for (const [field, raw] of Object.entries(row.values ?? {})) {
        const value = String(raw);
        if (looksLikeAssetPath(value)) {
          if (!referenceFields.has(field)) referenceFields.set(field, { row: row.rowName, value });
        } else if (isEmptyReference(value)) {
          const list = emptyByField.get(field) ?? [];
          list.push(row.rowName);
          emptyByField.set(field, list);
        }
      }
    }

    for (const [field, emptyRows] of emptyByField) {
      const example = referenceFields.get(field);
      if (example) {
        for (const rowName of emptyRows) {
          nullReferences.push({
            table,
            rowName,
            field,
            exampleFromRow: example.row,
            exampleValue: example.value,
          });
        }
      } else if (emptyRows.length === rows.length && rows.length > 1) {
        // Every row is empty here, so there is no filled example to prove it is a reference field
        // at all. Could be a genuinely optional field, could be a table broken all the way through.
        undecidable.push({
          table,
          field,
          why: `every row has "${field}" empty, so there is no filled row to show whether it should hold an asset reference`,
        });
      }
    }
  }

  const verdict =
    nullReferences.length > 0 ? "problems" : undecidable.length > 0 ? "partial" : "clean";
  return {
    tablesScanned: tables.length,
    rowsScanned,
    nullReferences,
    undecidable,
    unreadable,
    verdict,
    next:
      nullReferences.length > 0
        ? `${nullReferences.length} row(s) have an empty asset reference in a field that other rows fill in. ` +
          `Each one is a silent failure at runtime: the engine resolves it to null and whatever consumes it ` +
          `does nothing, without an error. Fix with unreal_set_data_table_row, then unreal_save_asset.`
        : `No Data Table row has an empty reference in a field that other rows fill in.` +
          (undecidable.length > 0
            ? ` ${undecidable.length} field(s) could not be judged - see undecidable.`
            : ""),
  };
}
