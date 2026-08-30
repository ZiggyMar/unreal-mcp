import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { TOOL_PRESETS, PRESET_NAMES, presetTools } from "../dist/toolPresets.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

/** Every tool the server actually registers. */
const registered = new Set(
  [...indexSource.matchAll(/(?:server\.registerTool|register)\(\s*"(unreal_[a-z0-9_]+)"/g)].map((m) => m[1])
);

test("every tool named by a preset actually exists", () => {
  // The failure this prevents is silent: enable_tools reports an unknown name in `unknown` and
  // carries on, so a typo would leave a model one tool short with a preset that reported success.
  // Nothing else in the build would notice - a preset is just an array of strings.
  assert.ok(registered.size > 50, `expected to find the registered tools, found ${registered.size}`);
  for (const [name, preset] of Object.entries(TOOL_PRESETS)) {
    for (const tool of preset.tools) {
      assert.ok(registered.has(tool), `preset "${name}" names ${tool}, which is not registered`);
    }
  }
});

test("no preset repeats a tool, which would only hide a mistake", () => {
  for (const [name, preset] of Object.entries(TOOL_PRESETS)) {
    assert.equal(new Set(preset.tools).size, preset.tools.length, `preset "${name}" lists a tool twice`);
  }
});

test("every preset can read a project before it changes one", () => {
  // "Scans the current work, adapts to it, builds with it" is the requirement. A preset that can
  // write but not look would produce exactly the confident, ungrounded edit this project exists to
  // prevent.
  for (const [name, preset] of Object.entries(TOOL_PRESETS)) {
    assert.ok(
      preset.tools.includes("unreal_get_project_overview"),
      `preset "${name}" cannot orient itself in the project`
    );
    assert.ok(preset.tools.includes("unreal_search_project"), `preset "${name}" cannot search the project`);
  }
});

test("the diagnose preset can also fix, not only report", () => {
  // A preset that finds a bug and cannot act on it forces the round trip presets exist to remove.
  const diagnose = presetTools("diagnose");
  assert.ok(diagnose.includes("unreal_build_graph"));
  assert.ok(diagnose.includes("unreal_save_blueprint"), "a fix that is never saved is not a fix");
  assert.ok(diagnose.includes("unreal_find_orphans"), "this was missing until a trial run caught it");
});

test("an unknown preset name resolves to nothing rather than to something wrong", () => {
  assert.equal(presetTools("nonsense"), undefined);
  assert.deepEqual(PRESET_NAMES.sort(), ["cpp", "data", "diagnose", "feature", "ui"]);
});

test("every preset is named in the enable_tools schema, or it cannot be asked for", () => {
  // The enum in the tool schema is what a model is allowed to pass. A preset missing from it is
  // unreachable however correct its contents are.
  const enumMatch = /preset: z\s*\.enum\(\[([^\]]+)\]\)/.exec(indexSource);
  assert.ok(enumMatch, "could not find the preset enum in the tool schema");
  const exposed = [...enumMatch[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(exposed, PRESET_NAMES.sort(), "the schema enum and the preset table disagree");
});
