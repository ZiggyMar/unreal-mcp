import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editorTargetName, guidanceFor } from "../dist/nativeBuild.js";

/** A throwaway project directory with the given files under Source/. */
function projectWith(targetFiles) {
  const root = mkdtempSync(join(tmpdir(), "unreal-target-"));
  if (targetFiles !== null) {
    mkdirSync(join(root, "Source"));
    for (const name of targetFiles) writeFileSync(join(root, "Source", name), "// target");
  }
  return join(root, "MyGame.uproject");
}

test("a project with its own editor target builds that, not the engine's", () => {
  // The bug this exists for: passing "UnrealEditor" here put both editors in one action graph, and
  // each wanted to link the project's plugin DLLs to the same paths. UBT refuses that, and says only
  // "Action graph is invalid" - which points at nothing.
  const projectFile = projectWith(["AntiVirusSquad.Target.cs", "AntiVirusSquadEditor.Target.cs"]);
  assert.equal(editorTargetName(projectFile), "AntiVirusSquadEditor");
});

test("the game target is never mistaken for the editor one", () => {
  const projectFile = projectWith(["AntiVirusSquad.Target.cs"]);
  assert.equal(editorTargetName(projectFile), "UnrealEditor");
});

test("a target whose name does not match the .uproject is still found", () => {
  // A project directory and its module do not have to share a name, and plenty do not. Keying on the
  // "Editor" suffix is what UBT itself does; keying on the project name would miss these.
  const projectFile = projectWith(["ShooterCore.Target.cs", "ShooterCoreEditor.Target.cs"]);
  assert.equal(editorTargetName(projectFile), "ShooterCoreEditor");
});

test("a Blueprint-only project gets the engine editor, which is what it actually runs", () => {
  assert.equal(editorTargetName(projectWith(null)), "UnrealEditor");
});

test("an empty Source directory is not a target", () => {
  assert.equal(editorTargetName(projectWith([])), "UnrealEditor");
});

test("ActionGraphInvalid gets its own explanation instead of the catch-all", () => {
  const advice = guidanceFor(["Action graph is invalid; unable to continue.", "Result: Failed (ActionGraphInvalid)"]);
  // The catch-all is "The build failed without a compiler diagnostic", which is true and tells a
  // reader nothing. This failure has one common cause and it should be named.
  assert.match(advice, /same file/i);
  assert.match(advice, /editor target/i);
  assert.doesNotMatch(advice, /without a compiler diagnostic/);
});
