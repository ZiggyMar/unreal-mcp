#!/usr/bin/env node
// A tool description must not send a model to a tool its profile does not have.
//
// The standing instructions had exactly this bug and it was found by hand: the shared text named 18
// tools, `minimal` registers 11, and 13 were unreachable - including the first thing step 1 said to
// call. That was fixed in buildInstructions and nothing stopped it happening one level down, in the
// tool descriptions, which are read in the same breath and cost the same tokens on every request.
//
// It had already happened. `unreal_build_graph` is the recommended way to author a graph on `core`
// and its `nodes` field said "Same per-type params as unreal_add_node" - a tool `core` does not
// register, deliberately, because it is a worse path for a weak model. So the profile built for the
// weakest models pointed them at a tool they cannot call, in the one field that decides whether the
// call is well formed.
//
// This checks the direction that matters: a tool IN a profile naming a tool NOT in it. The reverse
// is fine - a full-profile tool may mention anything.
//
// Run: npm run check:profilerefs  (also part of npm test)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

/**
 * References that are deliberate, each with the reason it is not a defect.
 *
 * An entry here is a promise that a model reading it will not be stranded. "It is only a mention"
 * is not a reason - the question is always whether a model could ACT on the sentence and fail.
 */
const ALLOWED = {
  // Naming what a profile deliberately withholds, to explain why the recommended tool is better.
  // The model is being told NOT to reach for these, so it cannot be stranded by them.
  "core:unreal_save_blueprint->unreal_create_blueprint": "names the tool core withholds, to say what to use instead",
  "minimal:unreal_save_blueprint->unreal_create_blueprint": "same",

  // Naming a path to steer a model AWAY from it. "Prefer this over individual add_node calls" and
  // "edits made via add_node exist in memory until saved" both describe a route rather than send
  // anyone down it, so a model on a profile without those tools loses nothing by reading it - it
  // was being told not to use them anyway. The distinction this guard turns on is DIRECTING versus
  // DESCRIBING: "call X" strands a caller, "instead of X" cannot.
  "core:unreal_build_graph->unreal_add_node": "steers away from the per-node path, does not send anyone to it",
  "core:unreal_build_graph->unreal_connect_pins": "same",
  "core:unreal_compile_blueprint->unreal_add_node": "names what compiling is a safety net for",
  "core:unreal_compile_blueprint->unreal_connect_pins": "same",
  "core:unreal_save_blueprint->unreal_add_node": "names which edits are the ones sitting unsaved",
  "core:unreal_save_blueprint->unreal_connect_pins": "same",
  "minimal:unreal_compile_blueprint->unreal_add_node": "names what compiling is a safety net for",
  "minimal:unreal_compile_blueprint->unreal_connect_pins": "same",
  "minimal:unreal_save_blueprint->unreal_add_node": "names which edits are the ones sitting unsaved",
  "minimal:unreal_save_blueprint->unreal_connect_pins": "same",

  // list_tools is how a model discovers what it does not have; naming those tools is its job.
  "core:unreal_list_tools->unreal_call_tool": "list_tools exists to describe tools that are switched off",
  "core:unreal_list_tools->unreal_save_asset": "same",
};

const profileSet = (marker) => {
  const i = source.indexOf(marker);
  if (i < 0) return null;
  return new Set([...source.slice(i, source.indexOf("]);", i)).matchAll(/"(unreal_[a-z0-9_]+)"/g)].map((m) => m[1]));
};

const PROFILES = {
  core: profileSet("const CORE_PROFILE_TOOLS"),
  minimal: profileSet("const MINIMAL_PROFILE_TOOLS"),
};

// Each registered tool paired with its config block - the title, description and schema a model
// reads. The handler below it is code, not text, so it stops there.
const registered = new Map();
for (const m of source.matchAll(/register\(\s*"(unreal_[a-z0-9_]+)",\s*\{/g)) {
  const handlerAt = source.indexOf("\n  async (", m.index);
  registered.set(m[1], source.slice(m.index, handlerAt > 0 ? handlerAt : m.index + 4000));
}

const problems = [];
const unusedAllowances = new Set(Object.keys(ALLOWED));

for (const [profileName, tools] of Object.entries(PROFILES)) {
  if (!tools) {
    problems.push(`could not read the ${profileName} profile set - this guard has drifted from index.ts`);
    continue;
  }
  for (const [tool, body] of registered) {
    if (!tools.has(tool)) continue;
    const mentioned = new Set([...body.matchAll(/`?(unreal_[a-z0-9_]+)`?/g)].map((m) => m[1]));
    for (const other of mentioned) {
      if (other === tool || !registered.has(other) || tools.has(other)) continue;
      const key = `${profileName}:${tool}->${other}`;
      if (key in ALLOWED) {
        unusedAllowances.delete(key);
        continue;
      }
      problems.push(
        `${profileName}: ${tool}'s description names ${other}, which ${profileName} does not register.\n` +
          `      A model on this profile cannot call it, and this text is read before every decision.`
      );
    }
  }
}

// An allowance for a reference that no longer exists is a note about nothing, and the next person
// reading it learns something false about the current code.
for (const stale of unusedAllowances) {
  problems.push(`ALLOWED has an entry for "${stale}", which no longer happens. Delete it.`);
}

if (problems.length > 0) {
  console.error(`\nprofile reference check failed (${problems.length} problem(s)):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\n  Fix by rewording the description, or by adding the reference to ALLOWED in this script with\n` +
      `  the reason a model cannot be stranded by it.\n`
  );
  process.exit(1);
}

const counts = Object.entries(PROFILES)
  .map(([n, s]) => `${n} ${s.size}`)
  .join(", ");
console.log(
  `profile references ok: ${registered.size} tools, profiles checked (${counts}), ` +
    `${Object.keys(ALLOWED).length} deliberate reference(s) allowed`
);
