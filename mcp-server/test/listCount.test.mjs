import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `count` means the rows in front of you. In every list tool, in every branch.
//
// unreal_list_blueprints({match:"Player"}) returned 19 Blueprints and reported count: 355. The
// bridge sets count to the number it sent, this server then filters by `match`, and nothing put the
// field right - so a model asking how many Player Blueprints exist read 355, and no field anywhere
// said 19.
//
// It survived because every trial in this repo runs against a scratch folder where the filter
// matches everything and count happens to be correct. It took pointing the tools at a real
// 356-Blueprint project to see it, which is the argument for doing that regularly.
//
// Three sibling tools had three meanings for one field name: list_assets used it for rows returned,
// list_actors omitted it, list_blueprints used it for the project total. This checks the shape that
// makes them agree, at the source, because the live check needs an editor and this must fail in CI.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

/**
 * Everything one tool registration covers: its schema and the handler that builds the reply.
 *
 * Brace-matching from the tool name was the obvious way and the wrong one - the first brace after
 * the name opens the OPTIONS object (title, description, inputSchema), so the slice ended before the
 * handler and this test found zero list branches while reporting the shape was fine. Slicing to the
 * next registration is dull and correct.
 */
function handlerFor(toolName) {
  // Anchored on `register(`, not on the name. The name appears three times in this file - twice in
  // profile tool lists before the registration - and starting at the first hit sliced a region with
  // no handler in it, so this test reported zero list branches and passed its own shape check.
  const at = source.search(new RegExp(`register\\(\\s*"${toolName}"`));
  assert.ok(at > 0, `${toolName} is not registered any more - this test has drifted`);
  const next = source.indexOf("\nregister(", at + 10);
  return source.slice(at, next === -1 ? source.length : next);
}

test("every list reply that filters also corrects its count", () => {
  // Each branch that narrows what it returns has to say so. `filtered` and `.slice(0, limit)` are
  // the two ways this file cuts a list down; both must set count in the same object literal.
  const body = handlerFor("unreal_list_blueprints");

  const narrowing = [...body.matchAll(/blueprints:\s*compact\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(narrowing.length >= 2, `expected several list branches, found ${narrowing.length}`);

  // Every branch that emits a blueprints array must also emit a count in the same literal. Anything
  // else means the bridge's count rides through describing a different set of rows.
  const branches = [...body.matchAll(/blueprints:\s*compact\([^)]*\),/g)];
  for (const branch of branches) {
    const after = body.slice(branch.index, branch.index + 400);
    assert.match(
      after,
      /count:/,
      `a list branch returns rows without setting count - the bridge's count would describe a different set:\n${after.slice(0, 160)}`
    );
  }
});

test("shown is not reintroduced alongside count", () => {
  // `shown` said exactly what `count` says. Two names for one number is the thing this project keeps
  // having to undo, so the duplicate stays gone.
  const body = handlerFor("unreal_list_blueprints");
  assert.ok(!/\bshown:/.test(body), "`shown` is back, and it duplicates `count`");
});

test("matched appears only where it differs from count", () => {
  // It is the number of rows the filter found, which is only news when some of them were cut. In a
  // branch that returns everything it matched, it would repeat count in every reply.
  const body = handlerFor("unreal_list_blueprints");
  const matchedAt = [...body.matchAll(/matched:/g)];
  assert.equal(
    matchedAt.length,
    1,
    `matched should appear once, in the truncated branch only; found ${matchedAt.length}`
  );
  const context = body.slice(Math.max(0, matchedAt[0].index - 400), matchedAt[0].index + 200);
  assert.match(context, /slice\(0, limit\)|truncated/, "matched is not in the truncated branch");
});
