#!/usr/bin/env node
/**
 * Build the plugin against every Unreal engine version this project claims to support.
 *
 * The claim "supports 5.6 and 5.8" is only worth what it is checked against. This project targets
 * both from ONE source tree, which is the arrangement most likely to rot quietly: a 5.8-only API
 * slips into a handler, 5.8 keeps building, and nobody finds out until a 5.6 user tries to compile.
 *
 * `RunUAT BuildPlugin` is the right check rather than building the host project, for two reasons.
 * It compiles against public engine APIs only, so it catches exactly that class of mistake. And it
 * does not drag in the host project's OTHER plugins - the real project here fails to build its
 * editor target outright because a Wwise plugin references an AkAudio module that is not installed,
 * which has nothing to do with this bridge and would otherwise mask its result.
 *
 * Engines are discovered rather than hard-coded, because they are not in the same place on any two
 * machines. Set UNREAL_ENGINES to a semicolon-separated list of engine roots to override.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN = resolve(process.cwd(), "..", "UnrealMCPBridge", "UnrealMCPBridge.uplugin");

/** Where engines usually live on Windows, plus anything the user names explicitly. */
const CANDIDATE_ROOTS = [
  "C:/Program Files/Epic Games",
  "D:/Epic Games",
  "E:/Epic Games",
  "F:/",
  "M:/Unreal",
  "M:/",
];

function discoverEngines() {
  const explicit = (process.env.UNREAL_ENGINES ?? "").split(";").map((s) => s.trim()).filter(Boolean);
  if (explicit.length > 0) return explicit;

  const found = [];
  for (const root of CANDIDATE_ROOTS) {
    for (const version of ["UE_5.6", "UE_5.8"]) {
      const dir = join(root, version);
      if (existsSync(join(dir, "Engine/Build/BatchFiles/RunUAT.bat"))) found.push(dir);
    }
  }
  return [...new Set(found)];
}

const engines = discoverEngines();
if (engines.length === 0) {
  console.error("no Unreal engine installs found. Set UNREAL_ENGINES to a semicolon-separated list of roots.");
  process.exit(1);
}
if (!existsSync(PLUGIN)) {
  console.error(`plugin descriptor not found at ${PLUGIN}`);
  process.exit(1);
}

console.log(`building ${PLUGIN}`);
console.log(`against ${engines.length} engine(s):\n`);

const results = [];
for (const engine of engines) {
  const label = engine.split(/[\\/]/).filter(Boolean).pop();
  const out = mkdtempSync(join(tmpdir(), "mcp-plugin-build-"));
  process.stdout.write(`  ${label.padEnd(10)} building... `);
  const started = Date.now();
  try {
    // shell: true is required, not stylistic. Node refuses to exec a .bat directly, and without a
    // shell this throws EINVAL before UnrealBuildTool ever starts - which looked exactly like a
    // compile failure on both engines, seconds after both had built by hand.
    const uat = join(engine, "Engine/Build/BatchFiles/RunUAT.bat");
    execFileSync(
      `"${uat}"`,
      [
        "BuildPlugin",
        `"-Plugin=${PLUGIN}"`,
        `"-Package=${join(out, "UnrealMCPBridge")}"`,
        "-TargetPlatforms=Win64",
      ],
      { stdio: "pipe", timeout: 20 * 60 * 1000, shell: true }
    );
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`ok (${secs}s)`);
    results.push({ label, ok: true });
  } catch (err) {
    console.log("FAILED");
    // The useful lines are the compiler's, and there are usually thousands before them.
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    const errors = text.split("\n").filter((l) => /error|Error:|Result: Failed/.test(l)).slice(0, 12);
    // Never fail silently: an empty filter means the build never ran, and printing nothing there
    // sends the reader hunting for a compile error that does not exist.
    if (errors.length === 0) console.log(`      ${(err.message ?? "no output").split("\n")[0]}`);
    for (const line of errors) console.log(`      ${line.trim()}`);
    results.push({ label, ok: false });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length > 0) {
  console.error(`engine check FAILED on: ${failed.map((r) => r.label).join(", ")}`);
  console.error("This project supports 5.6 and 5.8 from one source tree. A handler that compiles on");
  console.error("only one of them is a regression, not a version requirement - find the API that");
  console.error("differs and guard it, rather than dropping the older engine.");
  process.exit(1);
}
console.log(`engines ok: plugin builds against ${results.map((r) => r.label).join(" and ")}`);
