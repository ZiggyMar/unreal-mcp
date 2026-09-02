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

import { readFileSync, existsSync, cpSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(here, "..", "build-targets.json");
const PLUGIN_SOURCE = join(here, "..", "..", "UnrealMCPBridge", "Source");

/** Where BuildPlugin drops its output for a target. */
const packageDir = (target) => join(tmpdir(), `mcp-plugin-${target.name}`);

/**
 * Copy a packaged plugin's binaries into the target project.
 *
 * Binaries only, deliberately. The source is already synced into the project by the step above, and
 * copying the packaged Source over it would replace files with BuildPlugin's own staged copies -
 * which are the same content today and are not guaranteed to be. What the editor loads is the DLL.
 */
function installPackagedPlugin(target) {
  const from = join(packageDir(target), "Binaries", "Win64");
  if (!existsSync(from)) {
    throw new Error(`BuildPlugin reported success but wrote no binaries to ${from}`);
  }
  const projectDir = dirname(target.project);
  const to = join(projectDir, "Plugins", "UnrealMCPBridge", "Binaries", "Win64");
  mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(from)) {
    // The .dll is what loads; the .pdb is what makes a crash readable. Everything else is staging.
    if (!name.endsWith(".dll") && !name.endsWith(".pdb") && !name.endsWith(".modules")) continue;
    cpSync(join(from, name), join(to, name));
    copied += 1;
  }
  if (copied === 0) {
    throw new Error(`nothing to copy from ${from}`);
  }
}

/**
 * The project's own editor target name, e.g. "AntiVirusSquadEditor".
 *
 * Mirrors editorTargetName in src/nativeBuild.ts. Duplicated deliberately: this script has to work
 * before and after a TypeScript build, and importing from dist/ would make the thing that builds
 * the plugin depend on the thing it builds.
 */
function editorTargetName(projectFile) {
  const sourceDir = join(dirname(projectFile), "Source");
  if (!existsSync(sourceDir)) return "UnrealEditor";
  try {
    const targets = readdirSync(sourceDir)
      .filter((name) => name.endsWith(".Target.cs"))
      .map((name) => name.slice(0, -".Target.cs".length));
    return targets.find((name) => name.endsWith("Editor")) ?? "UnrealEditor";
  } catch {
    return "UnrealEditor";
  }
}

const valueOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const only = valueOf("--only");
// --package: compile the plugin on its own and INSTALL the result into each target project.
//
// The reason this exists is a real project that cannot build its editor target at all. The game
// here has a second, complete sample project nested inside it, so UnrealBuildTool discovers two
// copies of several plugins and refuses with "Action graph is invalid" before compiling anything.
// The plugin was fine; the host was not. Default mode therefore delivered nothing to the one editor
// doing actual work, and every C++ improvement stopped at two scratch projects - which is exactly
// the invisible failure build-targets.json warns about, arriving by a route nobody had considered.
//
// BuildPlugin does not load the host project, so a broken host cannot block it. It compiles against
// public engine APIs only, which is a narrower check than the editor target - so this is the
// delivery route when the full build is unavailable, not a replacement for it.
const packageMode = process.argv.includes("--package");
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
const selected = only ? targets.filter((t) => t.name === only) : targets;

/**
 * One compile per ENGINE, not per target, when nothing is being installed.
 *
 * --isolated runs RunUAT BuildPlugin against an engine's public headers. The command it builds names
 * the engine and the plugin and nothing else - `target.project` is never read on that path. So two
 * targets pointing at the same engine compile the same source against the same headers and produce
 * the same answer, twice.
 *
 * This configuration has exactly that: `5.6` and `game` are both M:/Unreal/UE_5.6, differing only in
 * which project they install into, which --isolated does not do. A third of every C++ pre-push was
 * proving something already proved - about a hundred seconds, on the hook that runs before every
 * push that touches the plugin. It cost a push: the hook ran past a ten-minute limit and was killed.
 *
 * A normal (installing) build still visits every target, because there the project is the whole
 * point - a project that is not a target never receives the plugin, and nothing says so.
 */
const chosen =
  isolated && !only
    ? selected.filter(
        (t, i) => selected.findIndex((other) => other.engine.toLowerCase() === t.engine.toLowerCase()) === i
      )
    : selected;

if (isolated && chosen.length < selected.length) {
  const dropped = selected.filter((t) => !chosen.includes(t)).map((t) => t.name);
  console.log(
    `--isolated: ${dropped.join(", ")} share an engine with a target already being built, and this ` +
      `mode installs nothing, so they would compile the same source against the same headers. Building ` +
      `${chosen.map((t) => t.name).join(", ")}.\n`
  );
}

if (chosen.length === 0) {
  console.error(`no target named "${only}". Available: ${targets.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

/**
 * Make the target an exact copy of the source, touching only what actually differs.
 *
 * Two bugs live here, and the obvious one-liners each fix one and cause the other.
 *
 * `cpSync(src, dst, {recursive, force})` alone copies what exists and REMOVES NOTHING, so a file
 * that used to be in the source and is not any more stays in the target forever. Reviewing a pull
 * request is where that bites: install the branch, install main again, and the project holds main's
 * headers plus the branch's extra .cpp referencing symbols main does not have. It does not even fail
 * honestly - UBT's makefile cache saw no reason to rebuild and reported "ok" in four seconds over a
 * source tree that cannot compile.
 *
 * Deleting the tree first fixes that and costs a full recompile EVERY time, because cpSync rewrites
 * every file and UBT rebuilds on timestamp. On this plugin that is one ~9,000-line translation unit
 * and about twenty-five minutes, paid whether or not a single byte changed. Measured across one
 * session of PR review it came to over an hour of waiting for identical output.
 *
 * So: compare contents, copy only what differs, and delete only what the source no longer has.
 * Unchanged files keep their timestamps, so UBT correctly does nothing, and an install after a
 * no-op sync finishes in seconds instead of half an hour.
 */
function syncTree(sourceDir, targetDir) {
  let copied = 0;
  let removed = 0;

  const walk = (dir, base = "") => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };

  const wanted = existsSync(sourceDir) ? walk(sourceDir) : [];
  const present = existsSync(targetDir) ? walk(targetDir) : [];

  for (const rel of wanted) {
    const from = join(sourceDir, rel);
    const to = join(targetDir, rel);
    // Byte comparison rather than mtime or size. Size alone misses an edit that happens to preserve
    // it, and mtime is exactly the thing being protected here.
    let same = false;
    if (existsSync(to)) {
      try {
        same = readFileSync(from).equals(readFileSync(to));
      } catch {
        same = false;
      }
    }
    if (same) continue;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { force: true });
    copied += 1;
  }

  const wantedSet = new Set(wanted);
  for (const rel of present) {
    if (wantedSet.has(rel)) continue;
    rmSync(join(targetDir, rel), { force: true });
    removed += 1;
  }

  return { copied, removed };
}

/**
 * Refuse to start a build that is going to fail on a locked DLL after several minutes.
 *
 * A running editor holds UnrealMCPBridge.dll open, so the compile succeeds and the LINK fails with
 * LNK1104 - a message about a file, several minutes in, that says nothing about editors. This is the
 * one command a user has to run by hand to pick up new bridge commands, so the one obvious way to
 * get it wrong should cost a second rather than a coffee.
 *
 * Asks the bridge rather than the process table where it can, because the bridge answers with WHICH
 * project is open, and "an editor is running" is a much weaker sentence than "AntiVirusSquad is
 * open". Falls back to the process list, which is all that is available when the plugin is not
 * loaded - and a plugin that is not loaded still holds nothing, so that case is a warning rather
 * than a refusal.
 *
 * --isolated builds into a temporary host project and installs nothing, so it is unaffected and this
 * does not run for it.
 */
async function editorHoldingTheDll() {
  // The bridge first: it is precise, and it is the same port the server itself uses.
  try {
    const { UnrealBridgeClient } = await import("../dist/bridgeClient.js");
    const ping = await new UnrealBridgeClient().send("ping", {});
    if (ping && ping.project) {
      return { certain: true, detail: `the editor has "${ping.project}" open (its bridge answered)` };
    }
  } catch {
    // Not reachable is not evidence of absence: an editor without the plugin loaded, or one still
    // starting up, holds the DLL just the same. Fall through to the process list.
  }

  if (process.platform === "win32") {
    const list = spawnSync("tasklist", ["/FI", "IMAGENAME eq UnrealEditor.exe", "/NH"], { encoding: "utf8" });
    if (list.status === 0 && /UnrealEditor\.exe/i.test(list.stdout ?? "")) {
      return { certain: true, detail: "UnrealEditor.exe is running (its bridge did not answer, so it may still be loading)" };
    }
  } else {
    const list = spawnSync("pgrep", ["-f", "UnrealEditor"], { encoding: "utf8" });
    if (list.status === 0 && (list.stdout ?? "").trim().length > 0) {
      return { certain: true, detail: "an UnrealEditor process is running" };
    }
  }
  return { certain: false };
}

if (!isolated) {
  const running = await editorHoldingTheDll();
  if (running.certain) {
    console.error(
      `
Refusing to build: ${running.detail}.

` +
        `A running editor holds UnrealMCPBridge.dll open, so this would compile for several minutes
` +
        `and then fail at the link step with LNK1104 - a message about a file that says nothing about
` +
        `editors. Close the editor and run this again.

` +
        `To compile without installing anything, and without closing anything, use --isolated.`
    );
    process.exit(2);
  }
}

const results = [];
for (const target of chosen) {
  if (!isolated) {
    const projectDir = dirname(target.project);
    const pluginDir = join(projectDir, "Plugins", "UnrealMCPBridge", "Source");

    process.stdout.write(`${target.name}: syncing source... `);
    try {
      const { copied, removed } = syncTree(PLUGIN_SOURCE, pluginDir);
      if (copied + removed > 0) {
        process.stdout.write(`${copied} changed, ${removed} removed... `);
      }
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
  const run = isolated || packageMode
    ? spawnSync(
        join(target.engine, "Engine", "Build", "BatchFiles", "RunUAT.bat"),
        [
          "BuildPlugin",
          `"-Plugin=${join(PLUGIN_SOURCE, "..", "UnrealMCPBridge.uplugin")}"`,
          `"-Package=${packageDir(target)}"`,
          "-TargetPlatforms=Win64",
        ],
        { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 }
      )
    : spawnSync(
        join(target.engine, "Engine", "Build", "BatchFiles", "Build.bat"),
        [
          // The PROJECT's editor target, not the engine's.
          //
          // This said "UnrealEditor" for every project, which is the engine's own editor target.
          // Building that against -Project asks UnrealBuildTool to plan a build in which the
          // engine's editor and the project's own editor both link the same plugin DLLs - two
          // actions producing one file - and it refuses with "Action graph is invalid" before
          // compiling anything.
          //
          // The symptom was a whole target that could never build, and it was blamed on other
          // things for a long time: a duplicate plugin, a nested sample project, the host being
          // "unbuildable". Running Build.bat by hand with the project's real target name succeeded
          // immediately, which is what settled it. nativeBuild.ts had resolved this correctly all
          // along; this script simply never asked it.
          editorTargetName(target.project),
          "Win64",
          "Development",
          // QUOTED. shell:true means the shell re-splits this line, and a project path with a
          // space in it - "M:/Unreal Projects/..." - became two arguments, so UnrealBuildTool was
          // handed "-Project=M:/Unreal" and failed. The isolated branch above quotes its paths and
          // has always worked; this one did not, so the failure only ever appeared on projects
          // whose path contains a space, and looked exactly like an unbuildable project.
          `"-Project=${target.project}"`,
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
  const claim = isolated || packageMode ? /BUILD SUCCESSFUL/i : /Result:\s*Succeeded/i;
  let succeeded = run.status === 0 && claim.test(output);

  // Compiling is not delivering. A plugin packaged to a temp folder and never copied is the same
  // "verified fix that never shipped" this script was written to stop, so the copy is part of the
  // result: if it fails, the target failed.
  if (succeeded && packageMode) {
    try {
      installPackagedPlugin(target);
    } catch (err) {
      succeeded = false;
      console.log(`FAILED to install (${seconds}s): ${err instanceof Error ? err.message : err}`);
      results.push({ target, ok: false, why: "install failed" });
      continue;
    }
  }
  console.log(succeeded ? `ok (${seconds}s)` : `FAILED (${seconds}s)`);

  if (!succeeded) {
    const errorLines = output
      .split(/\r?\n/)
      .filter((line) => /error\s|error[A-Z]?\d|Result:\s*Failed/i.test(line))
      .slice(-8);
    for (const line of errorLines) {
      // Spend the width on the message, not on the path.
      //
      // A compiler line is "<absolute path>(line,col): <severity> <code>: <message>", and the path
      // is boilerplate the reader already knows - the temp build root, the host project, the module,
      // the Private dir. It was charged against the same budget as the diagnosis, and it won. This
      // is the line that made the point, cut at exactly 160 characters:
      //
      //   ...\MCPCommandHandler.cpp(24,1): fatal error C1083: Cannot open include fi
      //
      // One character short of "le: 'Engine/UserDefinedStruct.h'". Everything needed to fix the
      // build was in the half that was dropped; 110 characters of directory nobody can act on were
      // in the half that was kept. Raising the limit would have papered over that - the path grows
      // with wherever the build happens to run.
      const trimmed = line.trim().replace(/^.*[\\/](?=[^\\/]+\(\d+[,\d]*\)\s*:)/, "");
      console.log(`    ${trimmed.slice(0, 220)}`);
    }
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
  packageMode
    ? `
all ${results.length} target(s) built and INSTALLED via BuildPlugin. Compiled against public engine APIs only, which is narrower than the editor target - restart the editor to load them.`
    : isolated
    ? `\nall ${results.length} engine(s) compile this plugin against public APIs. NO binaries were ` +
        `installed - run without --isolated to sync the source and build into the target projects.`
    : `\nall ${results.length} target(s) built. Restart any editor that was running before testing.`
);
