import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(join(REPO_ROOT, "docs", name), "utf8").replace(/\r\n/g, "\n");
// Line endings normalised. This repo converts to CRLF on checkout, and the first version of this
// test searched for a marker containing a bare newline - which matched nothing, so the extraction returned
// an empty block and the test failed for a reason that had nothing to do with the guides.
const instructionsSource = readFileSync(join(REPO_ROOT, "mcp-server/src/index.ts"), "utf8").replace(/\r\n/g, "\n");

/**
 * The instructions field, as text. Taken from the source rather than by starting a server, so this
 * test needs no editor and no spawn - and the thing being compared is the thing that ships.
 */
function instructionBlock(startMarker, endMarker) {
  const start = instructionsSource.indexOf(startMarker);
  const end = instructionsSource.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, `could not find the instruction block ${startMarker}`);
  return instructionsSource.slice(start, end);
}

test("the workflow guide is the long form of the order the instructions give", () => {
  // The instructions call unreal_workflow "the long form of the order above". It was not: the golden
  // path ended at Save, and the instructions' step 8 - verify_feature, "before you report anything
  // as done" - appeared nowhere in it. A model that pulled the long form got an order that stops
  // before the step whose entire job is to catch work reported finished when it is not.
  //
  // Also missing were list_blueprints, find_source and describe_class.
  const howToWork = instructionBlock('"HOW TO WORK",\n    "1. Anything broken', '"GROUND TRUTH');
  const named = [...new Set([...howToWork.matchAll(/unreal_[a-z0-9_]+/g)].map((m) => m[0]))];
  assert.ok(named.length >= 10, `expected the instruction steps to name tools, found ${named.length}`);

  const workflow = read("AGENT_WORKFLOW.md");
  const missing = named.filter((tool) => !workflow.includes(tool)).sort();
  assert.deepEqual(
    missing,
    [],
    `the instructions call the workflow guide their long form, but it never mentions: ${missing.join(", ")}`
  );
});

test("every exact string the instructions call unguessable is in the handbook", () => {
  // The instructions tell a model to "pull in the handbook before your first write of a session",
  // and separately list the strings it cannot derive. If the handbook does not carry them, that
  // advice sends the model to a document missing the thing it was sent for.
  //
  // "Spawn Actor and Create Widget are NOT buildable here" was exactly that case - a fact learned by
  // building the node, crashing the editor four times and reverting the feature, written into the
  // instructions and not into the handbook a model is told to read.
  const handbook = read("BLUEPRINT_HANDBOOK.md");
  const facts = [
    "self",
    "then_0",
    "Pitch, Yaw, Roll",
    "KismetSystemLibrary",
    "Spawn Actor",
    "Create Widget",
    "nodeType",
  ];
  const missing = facts.filter((fact) => !handbook.includes(fact));
  assert.deepEqual(missing, [], `the handbook is missing ground truth the instructions rely on: ${missing.join(", ")}`);
});

test("no guide names a tool this server does not register", () => {
  // The other direction, and the one that goes stale silently: a guide telling a model to call
  // something that was renamed or removed spends a failed call and then a recovery.
  const registered = new Set(
    [...instructionsSource.matchAll(/register\(\s*\n\s*"(unreal_[a-z0-9_]+)"/g)].map((m) => m[1])
  );
  assert.ok(registered.size > 80, `expected to find the registrations, found ${registered.size}`);

  for (const doc of ["AGENT_WORKFLOW.md", "BLUEPRINT_HANDBOOK.md", "RECIPES.md"]) {
    const named = new Set([...read(doc).matchAll(/unreal_[a-z0-9_]+/g)].map((m) => m[0]));
    const gone = [...named].filter((tool) => !registered.has(tool)).sort();
    assert.deepEqual(gone, [], `${doc} names tools that no longer exist: ${gone.join(", ")}`);
  }
});
