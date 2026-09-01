import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyEditorWindows } from "../dist/bridgeClient.js";

// This decides what a timeout message TELLS you, and a timeout message is read when things are
// already going wrong - the worst place to be confidently wrong.

test("a PIE window is the running game, not a dialog", () => {
  // The exact title that was reported as "a modal dialog... it halts the game thread until a human
  // clicks it" while nothing was blocked and the game was simply running.
  const found = classifyEditorWindows(["AVS Preview [NetMode: Client 1]  (64-bit/PC D3D SM6)"]);
  assert.equal(found.kind, "pie");
});

test("a standalone preview window is also the game", () => {
  assert.equal(classifyEditorWindows(["AntiVirusSquad Preview (64-bit/PC D3D SM6)"]).kind, "pie");
});

test("a real dialog is still a dialog", () => {
  assert.equal(classifyEditorWindows(["Message", "AntiVirusSquad - Unreal Editor"]).kind, "dialog");
});

test("the ordinary editor window alone means nothing is in the way", () => {
  assert.equal(classifyEditorWindows(["AntiVirusSquad - Unreal Editor"]), null);
  assert.equal(classifyEditorWindows([]), null);
});

test("a PIE window wins over a dialog title in the same list", () => {
  // If the game is up, that is the explanation worth leading with: it needs no action, and telling
  // someone to dismiss a dialog they cannot find is the failure this exists to prevent.
  const found = classifyEditorWindows(["Some Window", "AVS Preview [NetMode: Standalone]"]);
  assert.equal(found.kind, "pie");
});

test("the crash-recovery prompt is told apart from any other dialog", () => {
  // Observed exactly as written: an editor killed mid-session came back with only this window
  // enabled, the bridge listening and answering nothing, and the log ending cleanly at
  // "Engine is initialized". It reads as a dead bridge and is a blocked one.
  const found = classifyEditorWindows(["Restore Packages"]);
  assert.equal(found.kind, "recovery");
  assert.equal(found.title, "Restore Packages");
});

test("a genuine dialog is still a dialog, and PIE still outranks both", () => {
  assert.equal(classifyEditorWindows(["Message"]).kind, "dialog");
  assert.equal(classifyEditorWindows(["Blueprint Compilation Errors"]).kind, "dialog");
  // A recovery prompt behind a running game is not what stopped the game thread; the game is.
  assert.equal(
    classifyEditorWindows(["Restore Packages", "AVS Preview [NetMode: Client 1]"]).kind,
    "pie"
  );
});

test("the ordinary editor window alone means nothing is in the way", () => {
  assert.equal(classifyEditorWindows(["AntiVirusSquad - Unreal Editor"]), null);
});
