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
// Two modes, because they catch different mistakes:
//
//   (default)    sync the source into each target project and build its editor target. This is what
//                actually happens to a user, and it is the only mode that leaves usable binaries.
//   --isolated   RunUAT BuildPlugin instead. Compiles against PUBLIC engine APIs only, needs no
//                configured project, and does not drag in the host project's other plugins - the
//                real game project used here cannot build its editor target at all, because a Wwise
//                plugin references an AkAudio module that is not installed. Building the whole
//                project would let that unrelated failure mask this plugin's own result.
//
// Usage: node scripts/build-engines.mjs [--only 5.6] [--isolated]

import { readFileSync, existsSync } from "node:fs";
import { cpSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "build-targets.json");
const PLUGIN_SOURCE = join(here, "..", "..", "UnrealMCPBridge", "Source");

const valueOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = valueOf("--only");
const isolated = process.argv.includes("--isolated");

/** Engines are not in the same place on any two machines, so --isolated can find them itself. */
function discoverEngines() {
  const explicit = (process.env.UNREAL_ENGINES ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  const roots = explicit.length > 0 ? explicit : [];
  if (roots.length === 0) {
    for (const root of ["C:/Program Files/Epic Games", "D:/Epic Games", "E:/Epic Games", "F:/", "M:/Unreal", "M:/"]) {
      for (const version of ["UE_5.6", "UE_5.8"]) {
        const dir = join(root, version);
        if (existsSync(join(dir, "Engine/Build/BatchFiles/RunUAT.bat"))) roots.push(dir);
      }
    }
  }
  return [...new Set(roots)].map((engine) => ({ name: engine.split(/[\\/]/).filter(Boolean).pop(), engine }));
}

if (!existsSync(CONFIG) && isolated) {
  // --isolated needs an engine and nothing else, so a missing config is not fatal here.
  const found = discoverEngines();
  if (found.length === 0) {
    console.error("no engines found. Set UNREAL_ENGINES to a semicolon-separated list of engine roots.");
    process.exit(2);
  }
  globalThis.__discovered = found;
} else if (!existsSync(CONFIG)) {
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

const { targets } = globalThis.__discovered
  ? { targets: globalThis.__discovered }
  : JSON.parse(readFileSync(CONFIG, "utf8"));
const chosen = only ? targets.filter((t) => t.name === only) : targets;

if (chosen.length === 0) {
  console.error(`no target named "${only}". Available: ${targets.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const target of chosen) {
  if (!isolated) {
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
  } else {
    process.stdout.write(`${target.name}: `);
  }

  process.stdout.write("building... ");
  const started = Date.now();

  // shell: true is required for both, not stylistic: Node refuses to exec a .bat directly, and
  // without it this throws EINVAL before UnrealBuildTool ever starts - which reads exactly like a
  // compile failure on every engine at once.
  const run = isolated
    ? spawnSync(
        join(target.engine, "Engine", "Build", "BatchFiles", "RunUAT.bat"),
        [
          "BuildPlugin",
          `"-Plugin=${join(PLUGIN_SOURCE, "..", "UnrealMCPBridge.uplugin")}"`,
          `"-Package=${join(tmpdir(), `mcp-plugin-${target.name}`)}"`,
          "-TargetPlatforms=Win64",
        ],
        { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 }
      )
    : spawnSync(
        join(target.engine, "Engine", "Build", "BatchFiles", "Build.bat"),
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

  // Each tool announces success in its own words. Trusting the exit code alone has bitten people
  // before, so both are required.
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const claim = isolated ? /BUILD SUCCESSFUL/i : /Result:\s*Succeeded/i;
  const succeeded = run.status === 0 && claim.test(output);
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

// The point of the whole script: saying "built" only when every engine really did - and saying
// precisely what was built, because --isolated installs nothing and telling someone to restart
// their editor to pick up binaries that were never copied is how a "verified" fix stays unverified.
console.log(
  isolated
    ? `\nall ${results.length} engine(s) compile this plugin against public APIs. NO binaries were ` +
        `installed - run without --isolated to sync the source and build into the target projects.`
    : `\nall ${results.length} target(s) built. Restart any editor that was running before testing.`
);
