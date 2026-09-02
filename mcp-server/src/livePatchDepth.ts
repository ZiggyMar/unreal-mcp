/**
 * How many times Live Coding has hot-patched the bridge into the running editor.
 *
 * Live Coding replaces compiled code in a live process. It is the reason a C++ change can be tried
 * without a restart, and it is also cumulative: each patch leaves the previous one resident, and
 * deep into a session the editor is running a stack of patched modules rather than a build.
 *
 * ## Why this is worth a check
 *
 * Written after the editor crashed during a routine `unreal_create_struct` - ordinary input, one int
 * field - with the fault inside the bridge:
 *
 *   Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0xffffffffffffffff
 *   FMCPCommandHandler::HandleCreateStruct()   MCPCommandHandler.cpp:10671
 *   FMCPTcpServer::ProcessClientSocket()
 *
 * The module in that stack is `UnrealEditor-UnrealMCPBridge.patch_166.exe`. One hundred and
 * sixty-six patches deep, with 686 Live Coding lines in the same log.
 *
 * That is a correlation and this file does not claim more. `CreateUserDefinedStruct` registers a new
 * type with the engine's reflection system, which is exactly the sort of thing that goes wrong
 * against hot-patched code - but a crash with one witness is a crash with one witness. What can be
 * said honestly is that the editor was in a state where a crash is much harder to attribute, and
 * that a reader deserves to know that before they go hunting a bug in the source.
 *
 * ## The threshold
 *
 * A handful of patches is ordinary and this must not fire on it. 25 is high enough that a normal
 * afternoon of edits stays silent and low enough to catch a session that has drifted a long way from
 * the binary it started as.
 */

/** The highest `<Module>.patch_N` in a log, or 0 when none appears. */
export function highestPatchIndex(logText: string, moduleName = "UnrealMCPBridge"): number {
  const pattern = new RegExp(`${moduleName}\\.patch_(\\d+)`, "g");
  let highest = 0;
  for (const match of logText.matchAll(pattern)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return highest;
}

/** Fires at 25. Below that Live Coding is doing its job and there is nothing to say. */
export const PATCH_DEPTH_WARN_AT = 25;

export interface PatchDepthVerdict {
  depth: number;
  detail: string;
  remedy: string;
}

/** A warning when the editor is deep into hot-patched code, or undefined when it is not. */
export function patchDepthWarning(logText: string): PatchDepthVerdict | undefined {
  const depth = highestPatchIndex(logText);
  if (depth < PATCH_DEPTH_WARN_AT) return undefined;
  return {
    depth,
    detail:
      `Live Coding has hot-patched the bridge ${depth} times into this editor session, so it is ` +
      `running patched modules rather than the binary it launched with.`,
    remedy:
      "Everything works until it does not, and then the failure is hard to attribute: this project " +
      "has seen an editor crash inside the bridge at patch 166, on input that is ordinary. Restart " +
      "the editor to get back to a clean build before trusting a crash, a hang, or a command that " +
      "behaves differently than it did an hour ago. Nothing is wrong with the C++ on disk - this is " +
      "about the process it has been patched into.",
  };
}
