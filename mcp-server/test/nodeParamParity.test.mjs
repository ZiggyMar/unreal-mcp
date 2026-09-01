import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// unreal_build_graph and unreal_add_node build the same nodes, so they have to accept the same
// things to build them with.
//
// build_graph's own description says "Same per-type params as unreal_add_node", and the standing
// instructions tell every model to prefer it: "Build whole graphs with unreal_build_graph, in one
// call. Do not place nodes one at a time." It was missing four - netMode, reliable, inputs and
// ownerClass - which means the recommended way to author a graph could not declare a custom event's
// parameters or make one a Server RPC. All multiplayer logic is built from that.
//
// Nothing noticed, because check:nodetypes compares the nodeType VALUES the two tools offer and
// nothing compared their parameters. The only way to find it was to need one and be told the
// variable did not exist.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

/** The whole register(...) block for one tool. */
function toolBlock(name) {
  const at = source.search(new RegExp(`register\\(\\s*"${name}"`));
  assert.ok(at > 0, `${name} is not registered any more - this test has drifted`);
  const next = source.indexOf("\nregister(", at + 10);
  return source.slice(at, next === -1 ? source.length : next);
}

test("build_graph accepts every per-node parameter add_node does", () => {
  const addBlock = toolBlock("unreal_add_node");
  const addSchema = /inputSchema:\s*\{([\s\S]*?)\n    \},/.exec(addBlock);
  assert.ok(addSchema, "could not find unreal_add_node's inputSchema");
  const addParams = [...addSchema[1].matchAll(/^ {6}([a-zA-Z]+):/gm)].map((m) => m[1]);
  assert.ok(addParams.length >= 10, `expected add_node to take many params, found ${addParams.length}`);

  const buildBlock = toolBlock("unreal_build_graph");
  const nodeObject = /nodes:\s*z[\s\S]*?z\.object\(\{([\s\S]*?)\n {10}\}\)/.exec(buildBlock);
  assert.ok(nodeObject, "could not find build_graph's per-node object");
  const buildParams = [...nodeObject[1].matchAll(/^ {12}([a-zA-Z]+):/gm)].map((m) => m[1]);

  // path and graphName belong to the call, not to a node inside it; build_graph takes them once at
  // the top. Everything else describes the node and has to be expressible in both.
  const perCall = new Set(["path", "graphName"]);
  const missing = addParams.filter((p) => !perCall.has(p) && !buildParams.includes(p));

  assert.deepEqual(
    missing,
    [],
    `unreal_build_graph cannot express ${missing.join(", ")}, which unreal_add_node can. Its own ` +
      `description promises "Same per-type params as unreal_add_node", and the instructions tell ` +
      `models to prefer it - so anything only add_node can do is a thing the recommended path cannot.`
  );
});

test("build_graph returns one node shape on both its reply paths", () => {
  // It has two: one when auto-layout runs, one when it is skipped because the graph is already
  // large. The skipped path returned the untrimmed result, so `nodes.ref` was an object on a big
  // graph and a bare id string on a small one - and code reading `nodes.ref.id` worked until the day
  // it did not. The big graph also got the LARGER reply, which is backwards.
  const block = toolBlock("unreal_build_graph");
  const spreads = [...block.matchAll(/return jsonResult\(\{\s*\.\.\.(\w+)/g)].map((m) => m[1]);
  assert.ok(spreads.length >= 2, `expected several reply paths, found ${spreads.length}`);
  const raw = spreads.filter((name) => name === "result");
  assert.deepEqual(
    raw,
    [],
    `${raw.length} reply path(s) spread the raw bridge result instead of the trimmed buildPart, so ` +
      `this tool answers in more than one shape depending on how big the graph was.`
  );
});
