/**
 * Is the plugin source this repo holds the same source the editor compiles?
 *
 * The plugin is INSTALLED into a project by copying it (README: "Copy the `UnrealMCPBridge` plugin
 * folder into your Unreal project's `Plugins/` directory"). So there are two trees, and live coding
 * compiles the project's one. An edit made here reaches the running editor only after it is copied
 * across, and until then unreal_hot_reload_cpp answers, perfectly truthfully about what it did and
 * entirely misleadingly about what it means:
 *
 *   {"outcome":"patched","meaning":"The code compiled and is running in the editor now."}
 *
 * It compiled. It is running. It is not the code that was just written. That reply cost a real
 * debugging detour: a rounding fix was made, reloaded, measured, found unchanged, and the next
 * twenty minutes went on the arithmetic - which was correct - because the one thing the reply
 * ruled out was the thing that was wrong.
 *
 * A confident false success is the worst shape of answer a tool can give an agent, because it is
 * the one an agent cannot recover from by trying harder. Hence this check, and hence it compares
 * FILE CONTENT rather than timestamps: a copy preserves neither mtime ordering nor clock, and the
 * question "are these the same code" has an exact answer that does not need either.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";

/** Only the files that are actually compiled; .uplugin and docs drifting is not a build problem. */
const SOURCE_SUFFIXES = [".h", ".cpp", ".cs", ".inl"];

function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (SOURCE_SUFFIXES.some((s) => e.name.endsWith(s))) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export interface SourceSyncResult {
  /** Files whose content differs, or that exist on only one side. Repo-relative paths. */
  differing: string[];
  /** Where the editor's copy lives, so the caller can name it. */
  projectSourceDir: string;
}

/**
 * Compare this repo's plugin source against the copy inside the project the editor has open.
 *
 * Returns null - deliberately silent - when there is nothing to compare: no project copy at that
 * path means the plugin was installed some other way (an engine plugin, a junction, a symlink), and
 * in every one of those cases the two trees ARE the same files and a warning would be a false alarm.
 * The check only speaks when it can prove a difference.
 */
export function comparePluginSource(repoSourceDir: string, projectFile: string): SourceSyncResult | null {
  if (!projectFile || !existsSync(repoSourceDir)) return null;

  const projectDir = dirname(projectFile.replace(/\//g, sep));
  const projectSourceDir = join(projectDir, "Plugins", "UnrealMCPBridge", "Source");
  if (!existsSync(projectSourceDir)) return null;

  // A junction or symlink means one tree wearing two names; nothing can be out of sync.
  try {
    if (statSync(projectSourceDir).ino !== 0 && statSync(projectSourceDir).ino === statSync(repoSourceDir).ino) {
      return null;
    }
  } catch {
    /* ino is not meaningful on every filesystem; fall through to the content compare. */
  }

  const differing: string[] = [];
  const seen = new Set<string>();

  for (const file of listSources(repoSourceDir)) {
    const rel = relative(repoSourceDir, file);
    seen.add(rel);
    const mirror = join(projectSourceDir, rel);
    if (!existsSync(mirror)) {
      differing.push(rel);
      continue;
    }
    try {
      if (!readFileSync(file).equals(readFileSync(mirror))) differing.push(rel);
    } catch {
      differing.push(rel);
    }
  }

  // A file the project has and this repo does not is equally a mismatch: it is code the editor
  // compiles that nothing here describes.
  for (const file of listSources(projectSourceDir)) {
    const rel = relative(projectSourceDir, file);
    if (!seen.has(rel)) differing.push(rel);
  }

  return { differing: differing.sort(), projectSourceDir };
}

/**
 * The sentence to put in a hot-reload reply when the trees differ.
 *
 * Names the copy command, because "sync them" is advice and a command is an action - and the whole
 * failure this guards against is a reader believing work is done when a step is missing.
 */
export function outOfSyncNote(result: SourceSyncResult, repoSourceDir: string): string {
  const shown = result.differing.slice(0, 5);
  const more = result.differing.length - shown.length;
  return (
    `Your edits are NOT in the tree the editor compiles. This project has its own copy of the ` +
    `plugin source at ${result.projectSourceDir}, live coding compiles that copy, and ` +
    `${result.differing.length} file(s) differ from this repo: ${shown.join(", ")}` +
    `${more > 0 ? ` and ${more} more` : ""}. ` +
    `Copy them across first - ` +
    `\`cp -r "${repoSourceDir}/." "${result.projectSourceDir}/"\` - then hot reload again. ` +
    `Until then a "patched" result is about the old code.`
  );
}
