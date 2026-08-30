/**
 * Compile the project's C++, and report what broke in the same shape a Blueprint compile does.
 *
 * This closes the half of the C++ story that `find_source` opened. Locating a symbol lets a model
 * read and edit a .cpp; nothing let it find out whether the edit compiled. In a client with a shell
 * that is merely inconvenient - the model shells out to UnrealBuildTool and reads a wall of output.
 * In Claude Desktop, which has no shell, it is a hard stop: the model edits C++ and then guesses.
 * "Tell it a bug and it fixes it, whether it is C++ or Blueprints" is not true while one of those
 * two cannot be verified.
 *
 * Two decisions shape this.
 *
 * **Single-file by default.** UnrealBuildTool's `-SingleFile` compiles one translation unit and
 * skips linking: measured at 33 seconds against this plugin's own 6,900-line handler, where a full
 * editor build is minutes. It also sidesteps the problem that makes a naive "just build it" tool
 * useless here - a running editor holds the module DLL open, so the link step fails no matter how
 * correct the code is. The bridge lives INSIDE that editor, so it cannot be closed to satisfy the
 * build without killing the thing being asked. Compiling without linking answers "does my edit
 * compile" honestly and leaves the editor alone.
 *
 * **The output is parsed, not forwarded.** A UBT run emits megabytes; the answer is usually one line
 * of it. Forwarding the log would be the single most expensive reply this server has, which is the
 * failure this whole project exists to avoid.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NativeDiagnostic {
  /** Project-relative where possible, so it is stable to quote and cheap to read. */
  file: string;
  line: number;
  column?: number;
  /** The compiler's code, e.g. "C2065". Worth keeping: it is searchable and short. */
  code?: string;
  message: string;
  severity: "error" | "warning";
}

export interface NativeBuildResult {
  succeeded: boolean;
  errors: NativeDiagnostic[];
  /** What the build said when it failed without producing a compiler diagnostic. */
  reason?: string[];
  /** Set when the errors look like a unity-build include artifact rather than a fresh mistake. */
  note?: string;
  warnings: NativeDiagnostic[];
  totalErrors: number;
  totalWarnings: number;
  truncated?: boolean;
  seconds: number;
  compiled?: string;
  next?: string;
}

/**
 * MSVC and clang diagnostics, which is what UBT emits on Windows and everywhere else respectively.
 *
 *   C:\path\Foo.cpp(42): error C2065: 'Bar': undeclared identifier
 *   /path/Foo.cpp:42:9: error: use of undeclared identifier 'Bar'
 */
const MSVC = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s+([A-Z]+\d+)\s*:\s*(.+)$/;
const CLANG = /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/;

/** How many diagnostics are worth returning. The first few explain the rest. */
export const MAX_DIAGNOSTICS = 15;

export function parseBuildOutput(output: string, projectDir?: string): {
  errors: NativeDiagnostic[];
  warnings: NativeDiagnostic[];
  succeeded: boolean;
} {
  const errors: NativeDiagnostic[] = [];
  const warnings: NativeDiagnostic[] = [];
  const seen = new Set<string>();

  // Deliberately string work rather than node:path. UnrealBuildTool emits Windows paths with
  // backslashes, and node:path answers questions about the platform it is RUNNING on: on Linux
  // isAbsolute("M:/Proj/X.cpp") is false and relative() treats the whole thing as a filename, so
  // every diagnostic came back with its full path instead of a project-relative one. CI caught that
  // on the first Linux run of these tests, which is exactly what CI is for - it had been correct on
  // the one machine that wrote it.
  //
  // Case-insensitive because Windows is, and a project at M:\Proj reporting m:\proj\... in a
  // diagnostic is a real thing UBT does.
  const root = (projectDir ?? "").split("\\").join("/").replace(/\/+$/, "");
  const shorten = (file: string) => {
    const forward = file.trim().split("\\").join("/");
    if (!root) return forward;
    if (!forward.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      // Not under the project - an engine header, most often. Clearer left absolute than as a path
      // that climbs out with a row of "..".
      return forward;
    }
    return forward.slice(root.length + 1);
  };

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let diagnostic: NativeDiagnostic | undefined;
    const msvc = MSVC.exec(line);
    if (msvc) {
      diagnostic = {
        file: shorten(msvc[1]),
        line: Number(msvc[2]),
        ...(msvc[3] ? { column: Number(msvc[3]) } : {}),
        code: msvc[5],
        message: msvc[6].trim(),
        severity: msvc[4] as "error" | "warning",
      };
    } else {
      const clang = CLANG.exec(line);
      if (clang) {
        diagnostic = {
          file: shorten(clang[1]),
          line: Number(clang[2]),
          column: Number(clang[3]),
          message: clang[5].trim(),
          severity: clang[4] as "error" | "warning",
        };
      }
    }
    if (!diagnostic) continue;

    // UBT echoes the same diagnostic more than once - once from the compiler, once in its summary.
    // Counting those twice would report four errors where a human sees two.
    const key = `${diagnostic.severity}:${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (diagnostic.severity === "error" ? errors : warnings).push(diagnostic);
  }

  // Both are required. UBT's exit code has been trusted alone before and it is not enough, and
  // "Result: Succeeded" appearing with errors present would mean something has gone very wrong.
  const succeeded = /Result:\s*Succeeded/i.test(output) && errors.length === 0;
  return { errors, warnings, succeeded };
}

/**
 * Why a build failed when it produced no compiler diagnostic at all.
 *
 * Found by running the tool against a real project: it failed with zero errors and the reply
 * confidently blamed a link step holding the module DLL open. It was nothing of the sort - the
 * project has a Wwise plugin referencing an `AkAudio` module that is not installed, so
 * UnrealBuildTool refused at the makefile stage, before compiling a single file. UBT said so in one
 * clear line, and the parser threw it away because it has no file(line) prefix.
 *
 * A wrong explanation is worse than no explanation: it sends a model looking for a problem that is
 * not there, in code that is fine. So the failure lines are captured verbatim and the guidance is
 * chosen from what they actually say.
 */
const FAILURE_LINES = [
  /Could not find definition for module/i,
  /Result:\s*Failed/i,
  /^ERROR:/i,
  /fatal error/i,
  /Unable to find/i,
  /is not a valid/i,
];

export function extractFailureReason(output: string): string[] {
  const found: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || found.includes(line)) continue;
    if (FAILURE_LINES.some((re) => re.test(line))) found.push(line.slice(0, 300));
    if (found.length >= 4) break;
  }
  return found;
}

/**
 * Compiler codes that mean "this name is not declared here".
 *
 * These matter specially for a single-file compile. Unreal builds with unity enabled by default,
 * merging many .cpp files into one translation unit, so a file can use a type whose header it never
 * includes and still build - it gets the include for free from a neighbour in the same blob.
 * Compiled alone, it fails.
 *
 * This is not hypothetical: the first live run of this tool reported ten errors in THIS plugin's own
 * MCPTcpServer.cpp, which builds cleanly on both engines. The file used TJsonWriterFactory and
 * TCondensedJsonPrintPolicy without including them. The errors were real - the file genuinely could
 * not be built on its own - but they were not caused by any edit, and a model told "ten errors"
 * with no further explanation would set about fixing code that was not broken by it.
 *
 * So the errors are still reported, because they describe a real defect worth fixing, and a note
 * explains where they came from.
 */
const MISSING_DECLARATION_CODES = /\b(C2065|C2039|C2504|C2653|C2143|C3203|C2955|C7568|C2672|C2665)\b/;
const MISSING_DECLARATION_TEXT = /undeclared identifier|unknown type name|no member named|not declared|incomplete type/i;

export function unityNote(file: string | undefined, errors: NativeDiagnostic[]): string | undefined {
  if (!file || errors.length === 0) return undefined;
  const looksLikeIncludes = errors.some(
    (e) => MISSING_DECLARATION_CODES.test(e.code ?? "") || MISSING_DECLARATION_TEXT.test(e.message)
  );
  if (!looksLikeIncludes) return undefined;
  return (
    "Some of these look like missing declarations. Unreal builds with unity enabled by default, so a " +
    "file can use a type whose header it never includes and still build - it gets it from a neighbour " +
    "in the same translation unit. Compiling one file alone removes that, so these may predate your " +
    "edit. They are still real: the file cannot be built on its own, and the fix is to include what it " +
    "uses. To check whether your edit specifically broke something, compare against a file you have " +
    "not touched."
  );
}

/** Turn those lines into advice that matches the actual failure rather than the likeliest one. */
export function guidanceFor(reason: string[]): string {
  const text = reason.join(" ");
  if (/Could not find definition for module|RulesError/i.test(text)) {
    return (
      "UnrealBuildTool refused before compiling anything: this is the PROJECT's configuration, not " +
      "your code. A plugin references a module that is not installed, so nothing in this project can " +
      "be compiled until it is fixed or that plugin is disabled in the .uproject."
    );
  }
  if (/LNK|link/i.test(text)) {
    return (
      "The compile succeeded and the LINK failed. That is usually the editor running and holding the " +
      "module DLL open - pass a single `file`, which compiles without linking."
    );
  }
  return "The build failed without a compiler diagnostic. The lines in `reason` are what it did say.";
}

export interface CompileOptions {
  /** Absolute path to the .uproject, from unreal_ping. */
  projectFile: string;
  /** Absolute path to the engine, from unreal_ping's engineDir. */
  engineDir: string;
  /** One source file to compile. Omit to build the whole editor target. */
  file?: string;
  timeoutMs?: number;
}

/** Where UnrealBuildTool lives, given an engine directory. Ping reports .../Engine/, and it varies. */
export function buildBatchPath(engineDir: string): string {
  const normalized = engineDir.replace(/[\\/]+$/, "");
  const withEngine = normalized.toLowerCase().endsWith("engine")
    ? normalized
    : join(normalized, "Engine");
  return join(withEngine, "Build", "BatchFiles", "Build.bat");
}

export async function compileNative(options: CompileOptions): Promise<NativeBuildResult> {
  const { projectFile, engineDir, file } = options;
  const projectDir = dirname(projectFile);
  const batch = buildBatchPath(engineDir);
  if (!existsSync(batch)) {
    throw new Error(
      `unreal_build_tool_not_found: ${batch}. engineDir came from unreal_ping; if this project runs ` +
        `on a source build of the engine the path may differ.`
    );
  }

  const args = [
    // The editor target is what a running editor is; building anything else answers a question
    // nobody asked.
    "UnrealEditor",
    "Win64",
    "Development",
    `-Project=${projectFile}`,
    "-TargetType=Editor",
    "-Progress",
    "-NoHotReloadFromIDE",
    ...(file ? [`-SingleFile=${file}`] : []),
  ];

  const started = Date.now();
  const output = await new Promise<string>((resolve) => {
    execFile(
      `"${batch}"`,
      args.map((a) => (a.includes(" ") ? `"${a}"` : a)),
      { shell: true, maxBuffer: 128 * 1024 * 1024, timeout: options.timeoutMs ?? 20 * 60 * 1000 },
      (_err, stdout, stderr) => resolve(`${stdout ?? ""}${stderr ?? ""}`)
    );
  });
  const seconds = Math.round((Date.now() - started) / 1000);

  const { errors, warnings, succeeded } = parseBuildOutput(output, projectDir);
  const kept = errors.slice(0, MAX_DIAGNOSTICS);

  return {
    succeeded,
    errors: kept,
    // Warnings are real but rarely the question, and a UE build emits a great many of them.
    warnings: errors.length === 0 ? warnings.slice(0, 5) : [],
    totalErrors: errors.length,
    totalWarnings: warnings.length,
    ...(errors.length > kept.length ? { truncated: true } : {}),
    seconds,
    // What was actually built, not a target name derived from the project: the arguments above pass
    // "UnrealEditor" with -TargetType=Editor, and reporting a different name would be a small lie in
    // the one field a caller uses to confirm it compiled the thing it meant to.
    compiled: file ?? "the editor target",
    ...(succeeded
      ? {}
      : errors.length === 0
        ? // No compiler diagnostic at all. Report what the build actually said rather than guessing.
          (() => {
            const reason = extractFailureReason(output);
            return { reason, next: guidanceFor(reason) };
          })()
        : (() => {
            const note = unityNote(file, kept);
            return {
              ...(note ? { note } : {}),
              next:
                `Fix the first error and compile again; the rest are often the same cause. Paths are ` +
                `relative to the project.`,
            };
          })()),
  };
}
