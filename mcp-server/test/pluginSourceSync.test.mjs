// The check that stops unreal_hot_reload_cpp claiming a success it did not have.
//
// A project installs this plugin by copying its source in, and live coding compiles the project's
// copy. So an edit in the repo reaches the running editor only after it is copied across - and
// before this check, the tool answered "patched: running in the editor now" either way. These tests
// pin the two things that make such a guard worth having: it fires when it can prove a difference,
// and it is silent every other time. A guard that cries wolf gets ignored, and then it is not a
// guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { comparePluginSource, outOfSyncNote } from "../dist/pluginSourceSync.js";

/** A throwaway pair of trees: a repo source dir, and a project with its own copy of it. */
function scaffold({ repoFiles, projectFiles }) {
  const root = mkdtempSync(join(tmpdir(), "mcp-sync-"));
  const repoSource = join(root, "repo", "UnrealMCPBridge", "Source");
  const projectDir = join(root, "Project");
  const projectSource = join(projectDir, "Plugins", "UnrealMCPBridge", "Source");

  for (const [dir, files] of [
    [repoSource, repoFiles],
    [projectSource, projectFiles],
  ]) {
    if (files === null) continue;
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), body);
    }
  }

  return { root, repoSource, projectFile: join(projectDir, "Thing.uproject") };
}

test("says nothing when the two trees hold the same code", () => {
  const { root, repoSource, projectFile } = scaffold({
    repoFiles: { "A.cpp": "int a = 1;\n", "A.h": "#pragma once\n" },
    projectFiles: { "A.cpp": "int a = 1;\n", "A.h": "#pragma once\n" },
  });
  try {
    assert.equal(comparePluginSource(repoSource, projectFile).differing.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names the file whose content differs", () => {
  const { root, repoSource, projectFile } = scaffold({
    repoFiles: { "A.cpp": "int a = 2;\n", "B.cpp": "int b = 0;\n" },
    projectFiles: { "A.cpp": "int a = 1;\n", "B.cpp": "int b = 0;\n" },
  });
  try {
    const r = comparePluginSource(repoSource, projectFile);
    assert.deepEqual(r.differing, ["A.cpp"]);
    // The note has to carry the command, not just the diagnosis: the whole failure it guards
    // against is a reader believing the work is done when a step is missing.
    assert.match(outOfSyncNote(r, repoSource), /cp -r/);
    assert.match(outOfSyncNote(r, repoSource), /A\.cpp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counts a file missing from either side as a difference", () => {
  const { root, repoSource, projectFile } = scaffold({
    repoFiles: { "A.cpp": "x\n", "OnlyInRepo.cpp": "new\n" },
    projectFiles: { "A.cpp": "x\n", "OnlyInProject.cpp": "stale\n" },
  });
  try {
    const r = comparePluginSource(repoSource, projectFile);
    assert.deepEqual(r.differing, ["OnlyInProject.cpp", "OnlyInRepo.cpp"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stays silent when the project has no copy at all", () => {
  // A junction, a symlink, or an engine-plugin install all land here, and in every one of those the
  // two trees are the same files. Speaking would be a false alarm on a correct setup.
  const { root, repoSource, projectFile } = scaffold({
    repoFiles: { "A.cpp": "x\n" },
    projectFiles: null,
  });
  try {
    assert.equal(comparePluginSource(repoSource, projectFile), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores files that are not compiled", () => {
  const { root, repoSource, projectFile } = scaffold({
    repoFiles: { "A.cpp": "x\n", "notes.md": "rewritten\n" },
    projectFiles: { "A.cpp": "x\n", "notes.md": "original\n" },
  });
  try {
    assert.equal(comparePluginSource(repoSource, projectFile).differing.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stays silent when there is no project file to locate a copy from", () => {
  const { root, repoSource } = scaffold({ repoFiles: { "A.cpp": "x\n" }, projectFiles: null });
  try {
    assert.equal(comparePluginSource(repoSource, ""), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
