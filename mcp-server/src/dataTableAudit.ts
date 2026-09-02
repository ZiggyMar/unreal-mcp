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
  /**
   * The struct the row is an instance of, carried so a reader can reach the code that
   * consumes the empty field rather than only the row that holds it.
   *
   * Measured on a real table: the finding said "whatever consumes it silently does nothing",
   * which was generically true and specifically wrong. FShopUpgradeDef.UpgradeClass is read
   * by AC_ShopComponent.cpp to COUNT ownership by class equality, so an empty one means the
   * upgrade never registers as owned, never reaches MaxTiers, and can be bought forever. That
   * is a worse bug than doing nothing, and the thread to it is the struct name.
   */
  rowStruct?: string;
  /** An example of the same field, filled in, from another row. Shows what it should look like. */
  exampleFromRow?: string;
  exampleValue?: string;
}

export interface DataTableAuditResult {
  tablesScanned: number;
  rowsScanned: number;
  nullReferences: NullReference[];
  /**
   * Rows sharing an asset reference in a column where almost every other row has its own.
   *
   * A smell rather than a certainty - two rows legitimately pointing at one asset is a real thing -
   * so it reports what it saw and leaves the judgement to the reader. Found on a real project:
   * DT_Upgrades has nine rows whose UpgradeClass is a distinct Blueprint each, except
   * "Survival_MobileAgent", which points at BP_BulletSize_C - the same class as "Stat_BulletSize",
   * and nothing to do with survival or mobile agents. The empty-reference check walked straight past
   * it, because the field is filled in.
   */
  duplicateReferences: Array<{
    table: string;
    field: string;
    value: string;
    rows: string[];
    ofFilled: number;
    rowStruct?: string;
  }>;
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
  /** The struct each row is an instance of. `/Script/...` means it is declared in C++. */
  rowStruct?: string;
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
  const duplicateReferences: DataTableAuditResult["duplicateReferences"] = [];
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
    /** Every filled value in a reference column, and which rows carry it. */
    const rowsByValue = new Map<string, Map<string, string[]>>();

    for (const row of rows) {
      for (const [field, raw] of Object.entries(row.values ?? {})) {
        const value = String(raw);
        if (looksLikeAssetPath(value)) {
          if (!referenceFields.has(field)) referenceFields.set(field, { row: row.rowName, value });
          const seen = rowsByValue.get(field) ?? new Map<string, string[]>();
          seen.set(value, [...(seen.get(value) ?? []), row.rowName]);
          rowsByValue.set(field, seen);
        } else if (isEmptyReference(value)) {
          const list = emptyByField.get(field) ?? [];
          list.push(row.rowName);
          emptyByField.set(field, list);
        }
      }
    }

    // A shared reference is only worth mentioning where it is the exception.
    //
    // Plenty of columns share on purpose - a dozen rows pointing at one default icon is a design, not
    // a defect - and flagging those would make this noise. So it reports only when the column is
    // overwhelmingly one-asset-per-row and something breaks the pattern: at least four filled rows,
    // and at least 70% of them carrying a value nothing else uses. DT_Upgrades scores 6 distinct of 7.
    for (const [field, byValue] of rowsByValue) {
      const filled = [...byValue.values()].reduce((n, list) => n + list.length, 0);
      if (filled < 4) continue;
      if (byValue.size / filled < 0.7) continue;
      for (const [value, rowNames] of byValue) {
        if (rowNames.length < 2) continue;
        // CLASS references only, and the first run of this is the argument for it.
        //
        // It reported two duplicates on a real project. One is a bug: two upgrades whose UpgradeClass
        // is the same Blueprint, so "Survival_MobileAgent" instantiates the bullet-size upgrade. The
        // other is a design: two health upgrades sharing a heart icon, which is what icons are for.
        //
        // A shared class means two rows DO the same thing while claiming to be different. A shared
        // texture, material or sound means two rows look or sound alike, which is ordinary. Keeping
        // both would have made this check noise on its first outing.
        if (!/BlueprintGeneratedClass|\.Class'/.test(value)) continue;
        duplicateReferences.push({ table, field, value, rows: rowNames, ofFilled: filled, rowStruct: read.rowStruct });
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
            rowStruct: read.rowStruct,
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
    duplicateReferences,
    undecidable,
    unreadable,
    verdict,
    next:
      nullReferences.length > 0
        ? `${nullReferences.length} row(s) have an empty asset reference in a field that other rows fill in. ` +
          `Each one is a silent failure at runtime: the engine resolves it to null and whatever consumes it ` +
          `does nothing, without an error. Set the right value with unreal_set_data_table_row, then ` +
          `unreal_save_asset.

` +
          // The warning exists because the obvious next move is wrong.
          //
          // `exampleValue` is the value from a filled SIBLING row, carried so a caller can see the
          // shape a correct value has. Copying it is a different thing entirely. On this project the
          // example offered for the row "Weapon_MachineGun" is BP_BulletSize, taken from
          // "Survival_MobileAgent" - paste that in and the machine gun grants a bullet-size upgrade.
          // The table then passes every check, and the game is quietly wrong.
          //
          // "This asset was never built" is also a real answer. Two rows here name upgrades that do
          // not exist as Blueprints anywhere in the project, and the honest fix is to build them or
          // drop the rows - not to point them at something that happens to be the right type.
          `exampleValue shows the SHAPE a correct value takes, from another row in the same table. It ` +
          `is not the answer for this row. Choose the asset this row actually means; if none exists ` +
          `yet, that is the finding - the row names something that was never built, and pointing it at ` +
          `a same-typed asset makes the table pass every check while the game does the wrong thing.`
        : `No Data Table row has an empty reference in a field that other rows fill in.` +
          (undecidable.length > 0
            ? ` ${undecidable.length} field(s) could not be judged - see undecidable.`
            : ""),
  };
}
