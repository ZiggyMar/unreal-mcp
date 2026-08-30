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
import { dirname, isAbsolute, join, relative, sep } from "node:path";

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

  const shorten = (file: string) => {
    const trimmed = file.trim();
    if (!projectDir || !isAbsolute(trimmed)) return trimmed.split(sep).join("/");
    const rel = relative(projectDir, trimmed);
    // A path that climbs out of the project (engine headers) is clearer left absolute.
    return rel.startsWith("..") ? trimmed.split(sep).join("/") : rel.split(sep).join("/");
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
      : {
          next:
            errors.length === 0
              ? `The build did not report "Result: Succeeded" but no diagnostic was parsed. That is ` +
                `usually a link step failing because the editor is running and holds the module DLL ` +
                `open - pass a single \`file\` to compile without linking, which is what this tool ` +
                `does by default.`
              : `Fix the first error and compile again; the rest are often the same cause. Paths are ` +
                `relative to the project.`,
        }),
  };
}
