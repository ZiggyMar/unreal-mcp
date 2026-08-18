#!/usr/bin/env node
// Sync the plugin source into every target project and build it against every engine.
//
// This plugin supports two engine versions, and the routine that keeps them honest was, until now,
// a human remembering to do the second one. That failed three times, each time producing a failure
// that looked like broken code and was really a binary older than the change.
//
// So it is one command, and it refuses to report success unless every target actually built. A
// partial success reported as success is the whole problem restated.
//
// Targets live in build-targets.json next to this script, because engine and project paths are
// specific to a machine and hardcoding them here would make this script a lie on anyone else's.
//
// Usage: node scripts/build-engines.mjs [--only 5.6]

import { readFileSync, existsSync } from "node:fs";
import { cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "build-targets.json");
const PLUGIN_SOURCE = join(here, "..", "..", "UnrealMCPBridge", "Source");

const valueOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = valueOf("--only");

if (!existsSync(CONFIG)) {
  console.error(
    `no build targets configured.\n\n` +
      `Create ${CONFIG} listing the engines and projects to build against, for example:\n\n` +
      JSON.stringify(
        {
          targets: [
            { name: "5.6", engine: "M:/Unreal/UE_5.6", project: "A:/UnrealProjects/YourProject/YourProject.uproject" },
          ],
        },
        null,
        2
      )
  );
  process.exit(2);
}

const { targets } = JSON.parse(readFileSync(CONFIG, "utf8"));
const chosen = only ? targets.filter((t) => t.name === only) : targets;

if (chosen.length === 0) {
  console.error(`no target named "${only}". Available: ${targets.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const target of chosen) {
  const projectDir = dirname(target.project);
  const pluginDir = join(projectDir, "Plugins", "UnrealMCPBridge", "Source");

  process.stdout.write(`${target.name}: syncing source... `);
  try {
    cpSync(PLUGIN_SOURCE, pluginDir, { recursive: true, force: true });
  } catch (err) {
    console.log("FAILED");
    results.push({ target, ok: false, why: `sync failed: ${err instanceof Error ? err.message : err}` });
    continue;
  }

  process.stdout.write("building... ");
  const batch = join(target.engine, "Engine", "Build", "BatchFiles", "Build.bat");
  const started = Date.now();
  const run = spawnSync(
    batch,
    [
      "UnrealEditor",
      "Win64",
      "Development",
      `-Project=${target.project}`,
      "-TargetType=Editor",
      "-Progress",
      "-NoHotReloadFromIDE",
    ],
    { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 }
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  // Build.bat prints "Result: Succeeded". Trusting the exit code alone has bitten people before,
  // so both are required.
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const succeeded = run.status === 0 && /Result:\s*Succeeded/i.test(output);
  console.log(succeeded ? `ok (${seconds}s)` : `FAILED (${seconds}s)`);

  if (!succeeded) {
    const errorLines = output
      .split(/\r?\n/)
      .filter((line) => /error\s|error[A-Z]?\d|Result:\s*Failed/i.test(line))
      .slice(-8);
    for (const line of errorLines) console.log(`    ${line.trim().slice(0, 160)}`);
  }
  results.push({ target, ok: succeeded, why: succeeded ? `${seconds}s` : "build failed" });
}

console.log("");
const failed = results.filter((r) => !r.ok);
for (const result of results) {
  console.log(`  ${result.ok ? "ok  " : "FAIL"}  ${result.target.name.padEnd(6)} ${result.why}`);
}

if (failed.length > 0) {
  console.log(`\n${failed.length} of ${results.length} target(s) failed. Nothing here is verified.`);
  process.exit(1);
}

// The point of the whole script: saying "built" only when every engine really did.
console.log(`\nall ${results.length} target(s) built. Restart any editor that was running before testing.`);
