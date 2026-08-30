import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeRun, parseAutomationLog, samePath, editorCommandPath } from "../scripts/run-automation.mjs";

// The half of scripts/run-automation.mjs that can be checked without an Unreal install: what it
// concludes from a log, and what it concludes from a path. The other half, actually launching an
// editor, cannot be tested here and is not pretended to be.
//
// This exists because the script's entire job is to catch one specific silent failure, and a
// checker nobody has ever seen fail is a checker nobody should believe.

const PASSING_LOG = `
LogAutomationController: Display: Test Started. Name={UnrealMCPBridge.Auth.MissingToken}
LogMCPBridgeAuthTest: Display: MCPSessionPathProbe: C:/Users/dev/AppData/Local/UnrealMCPBridge/session-8765.json
LogAutomationController: Display: Test Completed. Result={Passed} Name={UnrealMCPBridge.Auth.MissingToken} Path={UnrealMCPBridge.Auth.MissingToken}
LogAutomationController: Display: Test Completed. Result={Passed} Name={UnrealMCPBridge.Auth.ValidToken} Path={UnrealMCPBridge.Auth.ValidToken}
LogAutomationController: Display: Test Completed. Result={Passed} Name={UnrealMCPBridge.SessionPath} Path={UnrealMCPBridge.SessionPath}
`;

const WINDOWS_CANDIDATES = [
  "C:\\Users\\dev\\AppData\\Local\\UnrealMCPBridge\\session-8765.json",
  "C:\\Users\\dev\\AppData\\Local\\Epic\\UnrealMCPBridge\\session-8765.json",
];

test("a clean run with a matching path is a pass", () => {
  const verdict = judgeRun({ status: 0, log: PASSING_LOG, candidates: WINDOWS_CANDIDATES });
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.probedPath, "C:/Users/dev/AppData/Local/UnrealMCPBridge/session-8765.json");
  assert.equal(verdict.results.length, 3);
});

test("the mismatch this whole script exists to catch is caught, and named on both sides", () => {
  // The predicted break: UserSettingsDir() has an Epic segment the client never looked under, or
  // one it looked under and the engine does not use. Either way the client finds nothing and every
  // call fails the moment enforcement is on, which is exactly the failure that has no symptom.
  const verdict = judgeRun({
    status: 0,
    log: PASSING_LOG,
    candidates: ["C:\\Users\\dev\\AppData\\Local\\Epic\\UnrealMCPBridge\\session-8765.json"],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems.length, 1);
  assert.match(verdict.problems[0], /NOT one of the 1 path\(s\)/);
  assert.match(verdict.problems[0], /AppData\/Local\/UnrealMCPBridge\/session-8765\.json/, "says what the bridge wrote");
  assert.match(verdict.problems[0], /Epic/, "and what the client looked for");
  assert.match(verdict.problems[0], /sessionFileCandidates/, "and where to fix it");
});

test("a log with no probe line leaves the question open rather than answering it", () => {
  const log = PASSING_LOG.split("\n").filter((l) => !l.includes("MCPSessionPathProbe")).join("\n");
  const verdict = judgeRun({ status: 0, log, candidates: WINDOWS_CANDIDATES });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join("\n"), /still unknown/);
});

test("a log whose results cannot be read is not reported as a pass", () => {
  // The automation framework's line format is not ours and has changed between versions before. If
  // it changes again, this must say so, not quietly report that everything passed.
  const verdict = judgeRun({
    status: 0,
    log: "LogAutomationController: Display: some future format nobody here anticipated\n",
    candidates: WINDOWS_CANDIDATES,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join("\n"), /proves nothing either way/);
});

test("a failing test is reported by name, and a bad exit status is not swallowed", () => {
  const log = PASSING_LOG.replace("Result={Passed} Name={UnrealMCPBridge.Auth.ValidToken}", "Result={Failed} Name={UnrealMCPBridge.Auth.ValidToken}");
  const verdict = judgeRun({ status: 3, log, candidates: WINDOWS_CANDIDATES });
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join("\n"), /UnrealMCPBridge\.Auth\.ValidToken reported failed/);
  assert.match(verdict.problems.join("\n"), /exited with status 3/);
});

test("paths are compared across the separator and case differences the two languages create", () => {
  // UE writes forward slashes, node:path writes the platform separator, and Windows does not care
  // about case. Everything past that is a real difference and must stay one.
  assert.ok(samePath("C:/Users/dev/x.json", "C:\\Users\\dev\\x.json", "win32"));
  assert.ok(samePath("C:/USERS/Dev/X.json", "c:\\users\\dev\\x.json", "win32"));
  assert.ok(samePath("/home/dev/x.json  ", "/home/dev/x.json", "linux"));
  assert.ok(samePath("/home/dev/dir/", "/home/dev/dir", "linux"));

  assert.equal(samePath("/home/dev/X.json", "/home/dev/x.json", "linux"), false, "case matters off Windows");
  assert.equal(samePath("/home/dev/Epic/x.json", "/home/dev/x.json", "linux"), false, "the Epic segment is the whole question");
});

test("the editor binary is looked for where each platform actually puts it", () => {
  assert.match(editorCommandPath("/UE_5.6", "darwin"), /Engine\/Binaries\/Mac\/UnrealEditor-Cmd$/);
  assert.match(editorCommandPath("/UE_5.6", "linux"), /Engine\/Binaries\/Linux\/UnrealEditor-Cmd$/);
  assert.match(editorCommandPath("M:/UE_5.6", "win32"), /Win64.UnrealEditor-Cmd\.exe$/);
});

test("the probe is read even when the log is noisy around it", () => {
  const parsed = parseAutomationLog(
    "LogTemp: something\nLogMCPBridgeAuthTest: Display: MCPSessionPathProbe: /home/d/.config/Epic/UnrealMCPBridge/session-8765.json\nLogTemp: after\n"
  );
  assert.equal(parsed.probedPath, "/home/d/.config/Epic/UnrealMCPBridge/session-8765.json");
});
