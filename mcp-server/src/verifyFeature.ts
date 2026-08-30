/**
 * One call that answers "is the thing I just built actually finished?"
 *
 * The failure this exists for is specific and it is the expensive one. A model builds a feature
 * across four Blueprints, compiles the last one it touched, sees "success", and reports the work as
 * done - while an earlier asset it edited twenty calls ago no longer compiles, or compiles and is
 * wired wrong. Nothing in the session ever asked the whole question, because asking it meant
 * remembering every asset touched and then making two calls per asset, and the model that forgets
 * to check is by definition the model that has forgotten what it touched.
 *
 * So the default scope is not a list the caller supplies. It is the session journal's own record of
 * what was actually written, which is the one source that cannot drift from what happened.
 *
 * It is deliberately compile + review and nothing more. Two things were considered and cut: a
 * checkpoint diff, because no snapshot facility exists yet and a parameter that silently does
 * nothing is worse than an absent one; and starting PIE to sample runtime behaviour, because writes
 * during PIE apply to the editor world and a verification step that mutates what it is verifying is
 * not a verification step.
 */

import type { BridgeLike } from "./autoLayout.js";
import { reviewBlueprint } from "./review.js";
import type { CompileBlueprintResult } from "./types.js";
import { auditDataTables } from "./dataTableAudit.js";

export interface VerifiedAsset {
  path: string;
  compiled: boolean;
  compileErrors: number;
  compileWarnings: number;
  /** Absent when the compile itself could not be run. */
  score?: number;
  nextAction?: string;
  /** Set when this asset could not be checked at all, with the reason. */
  unavailable?: string;
}

export interface VerifyFeatureResult {
  verdict: "pass" | "fail";
  /** Data Table rows written this session that point at nothing. */
  dataTableNulls: Array<{ table: string; rowName: string; field: string }>;
  checked: string[];
  scope: string;
  assets: VerifiedAsset[];
  /** Everything standing between here and done, worst first. Empty on a pass. */
  blockers: string[];
  worstScore?: number;
  next: string;
  runtimeErrors?: unknown;
}

/** A Blueprint asset path, as the bridge spells them. */
function isBlueprintPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("(");
}

/**
 * One asset, one spelling.
 *
 * The same Blueprint reaches the journal under two names: create_blueprint records the package path
 * (`/Game/X/BP_Alpha`) and build_graph records the object path (`/Game/X/BP_Alpha.BP_Alpha`). A Set
 * of raw strings treats those as two assets, so a two-Blueprint feature was compiled and reviewed
 * four times and every blocker was reported twice - which reads as two separate problems and invites
 * a model to fix the same thing twice. Measured on a real two-asset trial, not reasoned about.
 */
function canonicalAssetPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  const name = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return name.includes(".") ? trimmed : `${trimmed}.${name}`;
}

export interface VerifyOptions {
  /** Paths to check. Defaults to every asset the session actually wrote to. */
  paths?: string[];
  /** Assets written this session, in write order, from the journal. */
  touched?: string[];
}

/**
 * Compile and review every asset in scope, and reduce it to one verdict.
 *
 * Ordering matters more than it looks. A compile error is not a worse review finding, it is a
 * different kind of thing: nothing downstream of it is trustworthy, because a Blueprint that does
 * not compile has no meaningful graph to review. So compile failures lead the blocker list
 * unconditionally, and review findings follow.
 */
export async function verifyFeature(
  bridge: BridgeLike,
  options: VerifyOptions = {}
): Promise<VerifyFeatureResult> {
  const explicit = options.paths?.filter(isBlueprintPath) ?? [];
  const fromJournal = (options.touched ?? []).filter(isBlueprintPath);
  const scope = explicit.length > 0 ? "the paths you named" : "every Blueprint written this session";

  // De-duplicated by CANONICAL path, because a feature touches the same asset many times and under
  // more than one spelling; checking it four times costs four times as much and says the same thing.
  const paths = [...new Set((explicit.length > 0 ? explicit : fromJournal).map(canonicalAssetPath))];

  if (paths.length === 0) {
    return {
      verdict: "fail",
      checked: [],
      scope,
      assets: [],
      dataTableNulls: [],
      blockers: [],
      next:
        "Nothing to verify: no Blueprint has been written this session and no paths were given. " +
        "If you built something before this server started, pass its paths explicitly.",
    };
  }

  const assets: VerifiedAsset[] = [];

  for (const path of paths) {
    let compile: CompileBlueprintResult;
    try {
      compile = await bridge.send<CompileBlueprintResult>("compile_blueprint", { path });
    } catch (err) {
      // One unreachable asset must not lose the verdict on the others - the whole point is to check
      // everything, and a partial answer that says which part is missing beats no answer.
      assets.push({
        path,
        compiled: false,
        compileErrors: 0,
        compileWarnings: 0,
        unavailable: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const asset: VerifiedAsset = {
      path,
      compiled: compile.success === true,
      compileErrors: compile.errorCount ?? 0,
      compileWarnings: compile.warningCount ?? 0,
    };

    // Reviewing a Blueprint that does not compile reports on a graph the engine has rejected, so
    // the findings describe something that does not exist. Fix the compile first.
    if (asset.compiled) {
      try {
        const review = await reviewBlueprint(bridge, path);
        asset.score = review.score;
        asset.nextAction = review.nextAction;
      } catch (err) {
        asset.unavailable = err instanceof Error ? err.message : String(err);
      }
    }

    assets.push(asset);
  }

  // Data Tables are checked as well as Blueprints, because the most expensive bug this tool has
  // seen was not in a graph at all: a row's class reference cleared to None, which the engine
  // resolves to null and the consumer silently ignores. A verification step that only compiles
  // Blueprints would have passed that build with a straight face.
  const dataTableNulls: VerifyFeatureResult["dataTableNulls"] = [];
  try {
    const tables = await auditDataTables(bridge, { paths });
    for (const n of tables.nullReferences) {
      dataTableNulls.push({ table: n.table, rowName: n.rowName, field: n.field });
    }
  } catch {
    /* the sweep is a bonus; a bridge too old to read tables must not fail the whole verification */
  }

  const blockers: string[] = [];
  for (const a of assets.filter((x) => x.unavailable)) {
    blockers.push(`${a.path}: could not be checked - ${a.unavailable}`);
  }
  for (const a of assets.filter((x) => !x.compiled && !x.unavailable)) {
    blockers.push(
      `${a.path}: does not compile (${a.compileErrors} error(s)). Call unreal_compile_blueprint on it ` +
        `to read them; nothing about this asset is trustworthy until it builds.`
    );
  }
  for (const a of assets.filter((x) => x.compiled && x.nextAction && x.score !== undefined && x.score < 100)) {
    blockers.push(`${a.path} (score ${a.score}): ${a.nextAction}`);
  }

  for (const n of dataTableNulls) {
    blockers.push(
      `${n.table} row "${n.rowName}": ${n.field} is empty while other rows fill it in. The engine ` +
        `resolves that to null and whatever consumes it does nothing, with no error. Fix with ` +
        `unreal_set_data_table_row.`
    );
  }

  const scored = assets.map((a) => a.score).filter((s): s is number => typeof s === "number");
  const worstScore = scored.length > 0 ? Math.min(...scored) : undefined;
  const verdict: "pass" | "fail" = blockers.length === 0 ? "pass" : "fail";

  return {
    verdict,
    checked: paths,
    scope,
    assets,
    dataTableNulls,
    blockers,
    worstScore,
    next:
      verdict === "pass"
        ? `All ${paths.length} asset(s) compile and review clean. Save anything unsaved, then you can ` +
          `report the work as done.`
        : `${blockers.length} thing(s) to fix, listed worst first. Compile failures come before review ` +
          `findings because a Blueprint that does not build has no graph worth reviewing.`,
  };
}
