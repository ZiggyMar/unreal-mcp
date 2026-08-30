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
        if (statSync(full).isDirectory()) {
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
}

/**
 * Find where a symbol is declared or defined.
 *
 * Whole-word matching, because a substring search for "Health" in a real project returns every
 * HealthBar, HealthComponent and bHealthDirty and buries the one line that matters.
 */
export function searchSource(
  projectFile: string,
  roots: SourceRoot[],
  symbol: string,
  options: SearchOptions = {}
): { matches: SourceMatch[]; filesScanned: number; totalMatches: number; truncated: boolean } {
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
  return {
    matches: all.slice(0, limit),
    filesScanned: files.length,
    totalMatches: all.length,
    truncated: all.length > limit,
  };
}
