import { test } from "node:test";
import assert from "node:assert/strict";

import { highestPatchIndex, patchDepthWarning, PATCH_DEPTH_WARN_AT } from "../dist/livePatchDepth.js";

// The line the real crash log carried.
const CRASH = `LogWindows: Error: [Callstack] 0x00007ffd9f24fce0 UnrealEditor-UnrealMCPBridge.patch_166.exe!FMCPCommandHandler::HandleCreateStruct()`;

test("the highest patch index is found, not the first or the last", () => {
  const log = "UnrealMCPBridge.patch_3\nUnrealMCPBridge.patch_166\nUnrealMCPBridge.patch_12\n";
  assert.equal(highestPatchIndex(log), 166);
});

test("a log with no patched module reports zero", () => {
  assert.equal(highestPatchIndex("nothing to see here"), 0);
  assert.equal(patchDepthWarning("nothing to see here"), undefined);
});

test("a handful of patches says nothing", () => {
  // Live Coding doing its job. A check that fires on ordinary use is the noise this project keeps
  // removing.
  const log = `UnrealMCPBridge.patch_${PATCH_DEPTH_WARN_AT - 1}`;
  assert.equal(patchDepthWarning(log), undefined);
});

test("a session deep into hot-patching is reported, with the reason", () => {
  const w = patchDepthWarning(CRASH);
  assert.ok(w);
  assert.equal(w.depth, 166);
  assert.match(w.detail, /166 times/);
  // It has to say what to do, and it has to be clear the SOURCE is not the suspect.
  assert.match(w.remedy, /Restart the editor/);
  assert.match(w.remedy, /Nothing is wrong with the C\+\+ on disk/);
});

test("another module's patches are not counted as the bridge's", () => {
  assert.equal(highestPatchIndex("UnrealEditor-SomethingElse.patch_400.exe"), 0);
});
