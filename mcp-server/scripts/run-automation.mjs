#!/usr/bin/env node
// Run the bridge's own automation tests against every configured engine, and answer the one
// question this repository could not answer about its own authentication.
//
// mcp-server/src/sessionToken.ts works out where the editor writes its session file by mirroring
// UE's per-platform settings directory by hand. Nothing on the Node side can check that mirroring:
// the value comes from FPlatformProcess::UserSettingsDir(), which needs an engine to observe. If it
// is wrong the client silently finds no token, and the day someone turns enforcement on, every call
// fails at once with a cause nobody has ever seen printed.
//
// So the engine half prints its answer, as "MCPSessionPathProbe: <path>", and this compares it
// against the paths the client actually searches. That turns "the mirroring looks right" into
// something a machine reports, on any machine that has an engine, and keeps reporting it after the
// next person edits either half.
//
// Deliberately NOT part of `npm test`: that runs in CI, which has no engine, and this repo's CI
// comment is explicit that pretending editor-dependent checks run there would make the badge mean
// less than it does.
//
// Usage: node scripts/run-automation.mjs [--only 5.6]

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionFileCandidates } from "../dist/sessionToken.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "build-targets.json");

/** The port the probe reports for. Only has to match what the C++ test asks for. */
export const PROBE_PORT = 8765;

/**
 * Compare two paths the way the two languages that produced them differ, and no further.
 *
 * UE writes forward slashes, Node's `join` writes the platform separator, and Windows filesystems
 * do not care about case. Normalising those three things is fair. Normalising anything else would
 * be this script deciding the answer it was written to find out.
 */
export function samePath(a, b, platform = process.platform) {
  const normalise = (p) => {
    const slashed = String(p).trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return normalise(a) === normalise(b);
}

/**
 * Pull the probe and the test results out of an editor log.
 *
 * Result lines are matched leniently because their exact wording is the automation framework's, not
 * ours, and it has changed between engine versions before. When none match, this says so rather than
 * reporting a pass: a log it could not read is not evidence of anything, and the whole point of this
 * file is to stop treating absence of evidence as evidence.
 */
export function parseAutomationLog(text) {
  const probeMatch = /MCPSessionPathProbe:\s*(\S.*?)\s*$/m.exec(text);
  const results = [];
  const resultPattern = /Test Completed\.\s*Result=\{(\w+)\}\s*Name=\{([^}]+)\}/g;
  let match;
  while ((match = resultPattern.exec(text)) !== null) {
    results.push({ outcome: match[1].toLowerCase(), name: match[2] });
  }
  return {
    probedPath: probeMatch ? probeMatch[1] : null,
    results,
    readableResults: results.length > 0,
  };
}

/**
 * Decide what a single engine's run proved, given its log and how the process exited.
 *
 * Split out from the running so it can be tested without an engine, which is the only part of this
 * script that can be. A checker nobody has ever seen fail is a checker nobody should believe.
 */
export function judgeRun({ status, log, candidates }) {
  const problems = [];
  const parsed = parseAutomationLog(log);

  if (!parsed.readableResults) {
    problems.push(
      "no test results could be read out of the log, so this run proves nothing either way. " +
        "The automation framework's result format may have changed; check the log by hand."
    );
  }

  const failures = parsed.results.filter((r) => r.outcome !== "passed");
  for (const failure of failures) {
    problems.push(`${failure.name} reported ${failure.outcome}`);
  }

  if (status !== 0) {
    problems.push(`the editor exited with status ${status}`);
  }

  if (!parsed.probedPath) {
    problems.push(
      "the UnrealMCPBridge.SessionPath test did not print MCPSessionPathProbe, so where " +
        "FPlatformProcess::UserSettingsDir() actually points is still unknown"
    );
  } else if (!candidates.some((candidate) => samePath(candidate, parsed.probedPath))) {
    // The failure this whole script exists for.
    problems.push(
      `the bridge writes its session file to\n      ${parsed.probedPath}\n` +
        `    which is NOT one of the ${candidates.length} path(s) mcp-server/src/sessionToken.ts searches:\n` +
        candidates.map((c) => `      ${c}`).join("\n") +
        `\n    Every call would fail unauthenticated the moment -MCPRequireAuth is used. Fix ` +
        `sessionFileCandidates() in sessionToken.ts to include the path above.`
    );
  }

  return { ok: problems.length === 0, problems, probedPath: parsed.probedPath, results: parsed.results };
}

/** Where UnrealEditor-Cmd lives, which build-engines.mjs never had to care about. */
export function editorCommandPath(engineDir, platform = process.platform) {
  const binaries = join(engineDir, "Engine", "Binaries");
  if (platform === "win32") return join(binaries, "Win64", "UnrealEditor-Cmd.exe");
  if (platform === "darwin") return join(binaries, "Mac", "UnrealEditor-Cmd");
  return join(binaries, "Linux", "UnrealEditor-Cmd");
}

function main() {
  const valueOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const only = valueOf("--only");

  if (!existsSync(CONFIG)) {
    console.error(
      `no build targets configured.\n\n` +
        `Create ${CONFIG} listing the engines and projects to test against. It is the same file ` +
        `scripts/build-engines.mjs uses, so if you have built the plugin you already have one.`
    );
    process.exit(2);
  }

  const { targets } = JSON.parse(readFileSync(CONFIG, "utf8"));
  const chosen = only ? targets.filter((t) => t.name === only) : targets;

  if (chosen.length === 0) {
    console.error(`no target named "${only}". Available: ${targets.map((t) => t.name).join(", ")}`);
    process.exit(2);
  }

  const candidates = sessionFileCandidates(PROBE_PORT);
  const results = [];

  for (const target of chosen) {
    process.stdout.write(`${target.name}: running UnrealMCPBridge automation tests... `);

    const editor = editorCommandPath(target.engine);
    if (!existsSync(editor)) {
      console.log("FAILED");
      results.push({ target, ok: false, problems: [`no editor at ${editor}`] });
      continue;
    }

    const started = Date.now();
    const run = spawnSync(
      editor,
      [
        target.project,
        "-ExecCmds=Automation RunTests UnrealMCPBridge; Quit",
        "-unattended",
        "-nopause",
        "-nosplash",
        "-nullrhi",
        "-stdout",
        "-fullstdoutlogoutput",
      ],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(0);

    const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const verdict = judgeRun({ status: run.status, log, candidates });
    console.log(verdict.ok ? `ok (${seconds}s)` : `FAILED (${seconds}s)`);
    if (verdict.probedPath) {
      console.log(`    session file: ${verdict.probedPath}`);
    }
    for (const problem of verdict.problems) {
      console.log(`    ${problem}`);
    }
    results.push({ target, ...verdict });
  }

  console.log("");
  for (const result of results) {
    console.log(`  ${result.ok ? "ok  " : "FAIL"}  ${result.target.name}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${results.length} target(s) failed. Nothing here is verified.`);
    process.exit(1);
  }

  console.log(
    `\nall ${results.length} target(s) passed, and the session file path the bridge writes is one ` +
      `the MCP server searches. -MCPRequireAuth is safe to turn on for these engine versions.`
  );
}

// Only run when invoked directly, so the judging above can be imported by a test.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
