#!/usr/bin/env node
// Check every function name in docs/RECIPES.md against the running engine.
//
// A handbook of plausible-looking node names is worse than no handbook. A model with no Unreal
// training has no way to tell a real function from an invented one, so it will follow either with
// equal confidence, and the failure lands as a confusing error deep in a build it already
// committed to. Documentation aimed at exactly the audience that cannot check it must be checked
// mechanically instead.
//
// This is not hypothetical. Its first run rejected 7 of 26 names in a document written by a model
// that does know Unreal reasonably well: UE5 renamed the float math nodes to Double, GetActorLocation
// is really K2_GetActorLocation, and Create Widget and runtime Spawn Actor are not functions at all.
//
// Usage: node scripts/verify-handbook.mjs        (with an editor open)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const recipes = readFileSync(join(here, "..", "..", "docs", "RECIPES.md"), "utf8");

const bridge = new UnrealBridgeClient({
  host: process.env.UNREAL_MCP_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765),
});

const NEWLINE = String.fromCharCode(10);

/**
 * Rows look like: | Purpose | `FunctionName` | `ClassName` |
 *
 * Only tables that declare themselves with a "functionName | className" header are read. The
 * recipes also contain a table of NATIVE nodes, which are deliberately not functions and would
 * otherwise be reported as missing from the function catalog. That false alarm would be worse than
 * no check, because it trains a reader to ignore the output.
 */
function extractClaims(markdown) {
  const claims = [];
  const seen = new Set();
  let inFunctionTable = false;

  for (const line of markdown.split(NEWLINE)) {
    if (!line.startsWith("|")) {
      inFunctionTable = false;
      continue;
    }
    if (line.includes("functionName") && line.includes("className")) {
      inFunctionTable = true;
      continue;
    }
    if (!inFunctionTable || line.includes("---")) continue;

    const match = line.match(/^\|[^|]+\|\s*`([A-Za-z0-9_]+)`\s*\|\s*`([A-Za-z0-9_]+)`\s*\|/);
    if (!match) continue;
    const [, functionName, className] = match;
    const key = `${className}::${functionName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push({ functionName, className });
  }
  return claims;
}

/** Does the engine have this function, on that class or anywhere? */
async function checkClaim(claim) {
  const found = await bridge.send("find_node", { query: claim.functionName, maxResults: 40 });
  const hits = found.hits ?? [];

  const exact = hits.filter((h) => h.functionName === claim.functionName);
  if (exact.length === 0) {
    const near = hits.slice(0, 3).map((h) => `${h.className.split(/[./]/).pop()}.${h.functionName}`);
    return {
      ok: false,
      reason: "no function with that name exists in this engine",
      suggestion: near.length > 0 ? `closest: ${near.join(", ")}` : "nothing similar found",
    };
  }

  // The docs use a short class name; the catalog reports a full path.
  const onClaimedClass = exact.filter((h) => h.className.split(/[./]/).pop() === claim.className);
  if (onClaimedClass.length === 0) {
    const actual = [...new Set(exact.map((h) => h.className.split(/[./]/).pop()))];
    return {
      ok: false,
      reason: `exists, but not on ${claim.className}`,
      suggestion: `actually on: ${actual.slice(0, 3).join(", ")}`,
    };
  }
  return { ok: true };
}

async function main() {
  const claims = extractClaims(recipes);
  console.log(`checking ${claims.length} function names from docs/RECIPES.md against the running engine`);
  console.log("");

  if (claims.length === 0) {
    console.error("no claims found: the table format in RECIPES.md may have changed");
    process.exit(2);
  }

  let ok = 0;
  const failures = [];
  for (const claim of claims) {
    let result;
    try {
      result = await checkClaim(claim);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("connection refused")) {
        console.error("no editor reachable. Open the editor with the plugin enabled and re-run.");
        process.exit(2);
      }
      result = { ok: false, reason: `lookup failed: ${message.split(NEWLINE)[0]}`, suggestion: "" };
    }

    if (result.ok) {
      ok++;
      process.stdout.write(".");
    } else {
      process.stdout.write("X");
      failures.push({ ...claim, ...result });
    }
  }

  console.log("");
  console.log("");
  console.log(`${ok}/${claims.length} verified against the live engine`);

  if (failures.length > 0) {
    console.log("");
    console.log(`${failures.length} claim(s) the engine does not back up:`);
    for (const f of failures) {
      console.log(`  ${f.className}.${f.functionName}`);
      console.log(`    ${f.reason}`);
      if (f.suggestion) console.log(`    ${f.suggestion}`);
    }
    console.log("");
    console.log(
      "Fix docs/RECIPES.md rather than the check. A recipe naming a function that does not exist " +
        "is followed confidently by exactly the models least able to notice."
    );
    process.exit(1);
  }

  console.log("every recipe names something the engine actually has.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
