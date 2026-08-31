/**
 * Where the project's C++ actually lives, and which file defines a given symbol.
 *
 * A Blueprint-only bridge answers half the question. Real projects put the base classes, the damage
 * maths and the replicated state in C++, so "the health bar does not update when I take damage" is
 * routinely a question about a .cpp file that no Blueprint tool can see. The model then has two bad
 * options: guess, or give up on the C++ half of the project.
 *
 * The fix is deliberately not "add file reading to this server". Every client that drives this -
 * Claude Code, Cursor, Claude Desktop with filesystem access - can already open and edit files far
 * better than a tool wrapper would. What it cannot do is know *where*: the project root is not the
 * working directory, plugins have their own Source trees, and nothing in the MCP surface ever said
 * so. `ping` has always returned the absolute .uproject path; this turns that into a map.
 *
 * So this returns locations, never file contents. A match is a path, a line number and the one line
 * that matched, and the model reads what it wants with the tools it already has. That keeps a
 * whole-project symbol lookup at a few hundred tokens instead of several thousand, which is the
 * same bargain the rest of this server makes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export interface SourceRoot {
  /** The module name, i.e. the directory under Source/. */
  module: string;
  /** Absolute path to the module's source directory. */
  dir: string;
  /** Whether this is project code or a plugin's. */
  kind: "project" | "plugin";
}

export interface SourceMatch {
  /** Path relative to the project root, with forward slashes, so it is stable to quote. */
  file: string;
  line: number;
  /** What the line appears to be: a class, a UFUNCTION, a UPROPERTY, a definition, or a mention. */
  kind: "class" | "function" | "property" | "definition" | "mention";
  text: string;
}

/** Files worth reading. Anything else in a Source tree is build plumbing. */
const SOURCE_EXTENSIONS = [".h", ".cpp", ".hpp", ".inl", ".cs"];

/** Directories that are always build output or vendored code, never the project's own source. */
const SKIP_DIRS = new Set([
  "Binaries",
  "Intermediate",
  "Saved",
  "DerivedDataCache",
  "ThirdParty",
  ".git",
  "node_modules",
]);

/** A single file this large is generated or vendored; reading it costs more than it can be worth. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Enough to cover a large project without letting a pathological tree run forever. */
const MAX_FILES_SCANNED = 4000;

/**
 * The Source directories belonging to a project, given its .uproject path.
 *
 * Plugins are included because that is where a studio's own systems usually live, and excluding
 * them would answer "no such class" for code the user is looking straight at.
 */
export function findSourceRoots(projectFile: string): SourceRoot[] {
  const projectDir = dirname(projectFile);
  const roots: SourceRoot[] = [];

  // A directory under Source/ is a module when it declares itself one with a .Build.cs. That is how
  // UnrealBuildTool decides, and treating every directory as a module gets it wrong in a way that
  // misleads: plugins that put Public/ and Private/ straight under Source/ were being reported as
  // modules called "Public" and "Private", so a model asking where new code belongs was offered two
  // directories that are not modules at all. Measured on a real project: 26 "modules" became 12.
  const addModulesUnder = (sourceDir: string, kind: "project" | "plugin") => {
    let entries: string[];
    try {
      entries = readdirSync(sourceDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(sourceDir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
        const declaresItself = readdirSync(full).some((f) => f.toLowerCase().endsWith(".build.cs"));
        if (declaresItself) {
          roots.push({ module: entry, dir: full, kind });
        }
      } catch {
        /* a directory that vanished between listing and stat is not worth raising */
      }
    }
  };

  addModulesUnder(join(projectDir, "Source"), "project");

  let plugins: string[] = [];
  try {
    plugins = readdirSync(join(projectDir, "Plugins"));
  } catch {
    /* a project with no Plugins directory is entirely normal */
  }
  for (const plugin of plugins) {
    addModulesUnder(join(projectDir, "Plugins", plugin, "Source"), "plugin");
  }

  return roots;
}

/** Every source file under a set of roots, breadth-first, capped. */
function collectFiles(roots: SourceRoot[]): string[] {
  const files: string[] = [];
  const queue = roots.map((r) => r.dir);

  while (queue.length > 0 && files.length < MAX_FILES_SCANNED) {
    const dir = queue.shift() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        queue.push(full);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext))) {
        files.push(full);
        if (files.length >= MAX_FILES_SCANNED) break;
      }
    }
  }
  return files;
}

/** Escape a symbol so it can sit inside a RegExp without changing its meaning. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Classify a matching line, so the most useful hit can be ranked first.
 *
 * A symbol appears dozens of times in a real codebase and only one or two of those are its
 * definition. Returning them in file order would bury the answer, which is the failure mode of
 * handing a model a raw grep.
 */
function classify(line: string, escaped: string): SourceMatch["kind"] | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return null;

  // class AMyChar : public ACharacter  /  class MYGAME_API AMyChar
  if (new RegExp(`\\b(class|struct|enum\\s+class)\\b[^;]*\\b${escaped}\\b`).test(trimmed)) return "class";
  // void AMyChar::TakeDamage(...) and AMyChar::AMyChar()
  if (new RegExp(`\\b${escaped}\\s*::`).test(trimmed) || new RegExp(`::\\s*${escaped}\\s*\\(`).test(trimmed)) {
    return "definition";
  }
  if (/^UFUNCTION\s*\(/.test(trimmed)) return "function";
  if (/^UPROPERTY\s*\(/.test(trimmed)) return "property";
  // A declaration in a header: a type, the name, then a paren, brace, semicolon or assignment.
  if (new RegExp(`\\b${escaped}\\s*[({;=]`).test(trimmed)) return "function";
  return "mention";
}

const KIND_RANK: Record<SourceMatch["kind"], number> = {
  class: 0,
  definition: 1,
  function: 2,
  property: 3,
  mention: 4,
};

export interface SearchOptions {
  /** Hard cap on returned matches. The point is to locate, not to dump. */
  limit?: number;
  /** Only search files whose name contains this. */
  fileFilter?: string;
  /**
   * How many bare mentions to include. Declarations and definitions are never capped by this.
   *
   * Measured: searching a common symbol returned 30 matches of which 25 were mentions - the kind
   * that says "this file also refers to it" and answers nothing. They are ranked last, so they were
   * already the least useful thing in the reply while being most of its cost.
   */
  maxMentions?: number;
}

/**
 * Find where a symbol is declared or defined.
 *
 * Whole-word matching, because a substring search for "Health" in a real project returns every
 * HealthBar, HealthComponent and bHealthDirty and buries the one line that matters.
 */
/**
 * Unreal's class prefixes, and why a search has to know about them.
 *
 * The C++ class is `AAVSGameState`. The editor calls it `AVSGameState`, and so does the
 * `parentClass` field of every Blueprint derived from it. So the natural chain - read a Blueprint,
 * see its parent, ask where that parent is declared - searched for a name that appears in the source
 * only inside `#include "AVSGameState.h"`:
 *
 *   "Source/AntiVirusSquad/AVSGameState.h": ["8 mention: #include \"AVSGameState.generated.h\""]
 *
 * Two include lines, and not one word about the class. `find_source` is the entry point for the
 * whole C++ half of this server, and it was missing declarations for the most common way a name is
 * written down.
 *
 * A = Actor, U = UObject, F = struct, E = enum, I = interface, S = Slate widget, T = template.
 */
const UNREAL_PREFIXES = ["A", "U", "F", "E", "I", "S", "T"];

/** Did this search find the thing, or only places that mention it? */
function foundADeclaration(matches: SourceMatch[]): boolean {
  return matches.some((m) => m.kind !== "mention");
}

function searchOnce(
  projectFile: string,
  roots: SourceRoot[],
  symbol: string,
  options: SearchOptions = {}
): { matches: SourceMatch[]; filesScanned: number; totalMatches: number; mentionsOmitted: number; truncated: boolean } {
  const projectDir = dirname(projectFile);
  const limit = options.limit ?? 40;
  const escaped = escapeRe(symbol);
  const files = collectFiles(roots).filter(
    (f) => !options.fileFilter || basename(f).toLowerCase().includes(options.fileFilter.toLowerCase())
  );

  const word = new RegExp(`\\b${escaped}\\b`);
  const all: SourceMatch[] = [];

  for (const file of files) {
    let text: string;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!word.test(text)) continue;

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!word.test(lines[i])) continue;
      const kind = classify(lines[i], escaped);
      if (kind === null) continue;
      all.push({
        file: relative(projectDir, file).split(sep).join("/"),
        line: i + 1,
        kind,
        text: lines[i].trim().slice(0, 200),
      });
    }
  }

  all.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.file.localeCompare(b.file) || a.line - b.line);

  // Keep every declaration and definition; keep only a sample of the bare mentions.
  const maxMentions = options.maxMentions ?? 5;
  const located = all.filter((m) => m.kind !== "mention");
  const mentions = all.filter((m) => m.kind === "mention");
  const kept = [...located, ...mentions.slice(0, maxMentions)].slice(0, limit);

  return {
    matches: kept,
    filesScanned: files.length,
    totalMatches: all.length,
    mentionsOmitted: Math.max(0, mentions.length - maxMentions),
    truncated: all.length > kept.length,
  };
}

/**
 * Find a symbol, trying Unreal's class prefixes when the plain name only turns up mentions.
 *
 * The retry is gated on "found nothing but mentions" rather than run always, because that is exactly
 * the prefix signature and nothing else looks like it. `AVSGameState` appears in the source only
 * inside `#include "AVSGameState.h"` - two mention lines and no declaration - because the class is
 * `AAVSGameState`. A symbol that IS spelled the way the source spells it finds its own declaration
 * on the first pass and never pays for a second.
 *
 * The prefixed name is reported, so a caller sees `AAVSGameState` and can use it: the whole point is
 * that they did not know it, and finding the file without the real name only half solves it.
 */
export function searchSource(
  projectFile: string,
  roots: SourceRoot[],
  symbol: string,
  options: SearchOptions = {}
): {
  matches: SourceMatch[];
  filesScanned: number;
  totalMatches: number;
  mentionsOmitted: number;
  truncated: boolean;
  foundAs?: string;
} {
  const direct = searchOnce(projectFile, roots, symbol, options);
  if (foundADeclaration(direct.matches) || symbol.length === 0) return direct;

  for (const prefix of UNREAL_PREFIXES) {
    // Deliberately NOT skipping a symbol that already starts with this letter. The case that
    // prompted all this is AVSGameState, whose class is AAVSGameState - the project's own initials
    // begin with A and the Actor prefix puts another one in front. Skipping felt like an obvious
    // saving and would have left the original failure exactly as it was.
    const prefixed = searchOnce(projectFile, roots, `${prefix}${symbol}`, options);
    if (foundADeclaration(prefixed.matches)) {
      return { ...prefixed, foundAs: `${prefix}${symbol}` };
    }
  }
  return direct;
}

/**
 * The module list as a map from module name to where it lives, relative to the project.
 *
 * The rows were `{module, dir, kind}` and all three fields were paying for themselves badly:
 *
 *   {"module":"AdvancedSessions",
 *    "dir":"M:\\Unreal Projects\\Anti-VirusSquad\\Plugins\\AdvancedSessions\\Source\\AdvancedSessions",
 *    "kind":"plugin"}
 *
 * Three problems, in ascending order of cost. `kind` is derivable - a directory under `Plugins/`
 * belongs to a plugin and one under `Source/` belongs to the project, which is the same rule that
 * decided it in the first place. The three field names are spelled once per module, which on a
 * fourteen-module project is 364 characters saying nothing that position does not. And `dir` carries
 * the absolute project path on every row, escaped, so the same forty characters arrive fourteen times.
 *
 * A map fixes all three at once and is the natural shape anyway: the question is "where does module
 * X live", and a map from name to place answers it without the reader scanning a list. Separators
 * are normalised to forward slashes, which Unreal accepts everywhere and JSON does not have to
 * escape - a straight halving of what a path separator costs.
 *
 * A module outside the project root keeps its absolute path, because a relative path that escapes
 * upward would be worse than the thing it replaced.
 */
export function modulesByName(roots: SourceRoot[], projectDir: string): Record<string, string> {
  const prefix = projectDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const out: Record<string, string> = {};
  for (const root of roots) {
    const dir = root.dir.replace(/\\/g, "/");
    out[root.module] = dir.startsWith(prefix) ? dir.slice(prefix.length) : dir;
  }
  return out;
}

/**
 * Matches grouped by the file they are in, which is how every code search worth using presents them.
 *
 * Measured on this project before changing anything: repeated object keys were 16-22% of the reply
 * and repeated file paths another 18-40%, so between a third and three fifths of a symbol lookup was
 * the reply describing its own shape. Searching for a symbol declared and used in one file was the
 * worst case, which is also the most common one.
 *
 * The grouping is not only cheaper, it matches what the caller does next. A model reading this opens
 * a file - so the file is the key, and the hits inside it are what hangs off it. `path:line` remains
 * quotable from `"<file>" + ":" + <line>`, which is the form editors and terminals make clickable.
 *
 * `kind` is kept on every hit and deliberately not defaulted away. It is the difference between "this
 * is where the class is declared" and "this file also mentions it", which is the entire ranking this
 * search exists to provide.
 */
export function matchesByFile(matches: SourceMatch[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const match of matches) {
    const line = `${match.line} ${match.kind}: ${match.text}`;
    (out[match.file] ??= []).push(line);
  }
  return out;
}
