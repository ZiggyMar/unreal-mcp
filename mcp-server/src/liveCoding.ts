/**
 * Hot-reload C++ into the editor that is already running.
 *
 * This closes the one leg of this server that could not finish its own job. A model could find a bug
 * in native code, write the fix, and prove it compiles - and then the change sat on disk, because the
 * running editor holds the DLL it was built from. Applying it meant a human closing the editor,
 * rebuilding, and reopening. A human working on their own does not do that: they press Ctrl+Alt+F11.
 *
 * The bridge half is deliberately two non-blocking commands (see MCPLiveCoding.cpp for why the
 * engine's own blocking form would hang the editor and open a modal dialog). The waiting belongs
 * here, where it is free: this polls, and the model spends one tool call for the whole thing.
 *
 * The interesting work is reading the result honestly, and the engine makes that easy to get wrong.
 * Every outcome it logs starts with the same four words:
 *
 *   "Live coding succeeded"                                        - patched, running now
 *   "Live coding succeeded, no code changes detected"              - compiled nothing at all
 *   "Live coding succeeded, data type changes ... likely ... crash"- patched, and now unsafe
 *
 * A substring test for "Live coding succeeded" reports all three as a win, and the middle one is the
 * common case: a model saves a file, calls this, is told it succeeded, and concludes its fix is live
 * when nothing was rebuilt. So the checks below run most-specific first, and the no-op case has its
 * own outcome rather than sharing a word with the real one.
 */

export interface LiveCodingStatusReply {
  available?: boolean;
  started?: boolean;
  enabled?: boolean;
  canEnable?: boolean;
  compiling?: boolean;
  done?: boolean;
  why?: string;
  enableError?: string;
  log?: string[];
}

export interface LiveCodingCompileReply {
  started?: boolean;
  result?: string;
  why?: string;
  alreadyRunning?: boolean;
  log?: string[];
}

export type HotReloadOutcome =
  | "patched"
  | "patched-but-unsafe"
  | "no-changes"
  | "compile-failed"
  | "cancelled"
  | "unavailable"
  | "still-running"
  | "unclear";

export interface HotReloadReport {
  outcome: HotReloadOutcome;
  meaning: string;
  next?: string;
  log?: string[];
}

/**
 * The rebuild-and-restart instruction, in one place.
 *
 * Every "cannot hot reload" path ends here, and they should all end at the same sentence: a reader
 * who is told live coding is unavailable needs the thing that does work, not just the refusal.
 */
const FULL_REBUILD =
  "Close the editor, rebuild the project's C++ (the project's own build, or `npm run build:engines` " +
  "for this plugin), and reopen it. That applies any C++ change, including the ones live coding cannot.";

/**
 * Read the engine's own log lines and say which of the six things happened.
 *
 * Order matters and is the whole point - see the note at the top of this file. Kept pure and exported
 * so the ordering can be tested against the exact strings the engine emits, without an editor.
 */
export function interpretLiveCodingLog(lines: string[]): HotReloadReport {
  const text = lines.join("\n");
  const has = (needle: string) => text.toLowerCase().includes(needle.toLowerCase());

  // Most specific first. "no code changes detected" is a SUFFIX of the success line, so it has to be
  // asked about before the success line is.
  if (has("no code changes detected")) {
    return {
      outcome: "no-changes",
      meaning:
        "Live coding compiled nothing: it saw no changed C++ since the last build. Nothing about the " +
        "running editor is different.",
      next:
        "If you did edit a file, check it was saved, that it belongs to a module this editor has " +
        "loaded, and that it is inside the project or plugin source rather than a copy elsewhere.",
    };
  }

  if (has("live coding failed") || has("unable to start live coding")) {
    return {
      outcome: "compile-failed",
      meaning: "The compile failed, so nothing was patched. The editor is still running the old code.",
      // Being straight about a real limit: the compiler errors go to the live coding console process,
      // which this server cannot read. compile_cpp builds the same file through UnrealBuildTool and
      // parses the diagnostics, so the errors are one call away rather than unavailable.
      next:
        "The errors themselves go to the Live Coding console window, which is a separate process and " +
        "not readable from here. Run unreal_compile_cpp on the file you changed to get the actual " +
        "diagnostics, fix them, and call this again.",
      log: lines,
    };
  }

  if (has("live coding canceled") || has("live coding cancelled")) {
    return {
      outcome: "cancelled",
      meaning: "The compile was cancelled before it finished. Nothing was patched.",
      next: "Call this again. If it keeps being cancelled, something is cancelling it in the editor UI.",
      log: lines,
    };
  }

  if (has("live coding succeeded")) {
    // The engine only warns about re-instancing when data types actually changed, so this branch is
    // driven by what it observed rather than by guessing from the diff.
    const warnings = lines.filter((l) => /^warning:/i.test(l));
    if (warnings.length > 0) {
      return {
        outcome: "patched-but-unsafe",
        meaning:
          "The code was patched into the running editor, and the engine flagged it: the change altered " +
          "data types, not just function bodies. Live coding re-instances existing objects to match, " +
          "and that is the part it does not fully guarantee.",
        next:
          "Adding, removing or reordering a UPROPERTY on a live UCLASS or USTRUCT is the usual cause. " +
          "Treat the editor as usable for a quick check and not much more: restart it before trusting " +
          "anything you observe, and before saving assets that reference the changed type. " +
          FULL_REBUILD,
        log: warnings,
      };
    }
    return {
      outcome: "patched",
      meaning: "The code compiled and is running in the editor now. No restart needed.",
      // "It compiles" is a claim about ONE engine, and this plugin supports several.
      //
      // A call to FAnimNotifyEvent::LinkMontage compiled here for months. It was deprecated in 5.1
      // and removed in 5.8, so on 5.6 it built with a warning nobody read and the 5.8 build failed
      // outright - discovered only because someone asked whether 5.8 still worked.
      //
      // `npm run check:engines` compiles against every configured engine and installs nothing; it
      // existed the whole time, the README names it in eight places, and the gap was never tooling
      // or documentation. It was that nothing said so at the one moment the belief "this works" is
      // actually being formed, which is here.
      next:
        "Verified on THIS engine only. If the change touched engine APIs, `npm run check:engines` " +
        "compiles it against every configured engine without installing anything - an API removed " +
        "in a later version fails there and passes here.",
    };
  }

  // Something happened that this does not recognise. Hand back what was said rather than picking one
  // of the outcomes above and being confidently wrong about it.
  return {
    outcome: "unclear",
    meaning:
      lines.length > 0
        ? "The compile finished, but the engine did not log an outcome this recognises. The lines are below."
        : "The compile finished without logging anything. Whether it patched cannot be told from here.",
    next: `Verify the change some other way before relying on it. ${FULL_REBUILD}`,
    log: lines.length > 0 ? lines : undefined,
  };
}

/** Why live coding is not usable in this editor, phrased as an answer rather than a refusal. */
export function unavailableReport(status: LiveCodingStatusReply): HotReloadReport {
  const why = status.why ?? status.enableError ?? "Live coding is not available in this editor.";
  return {
    outcome: "unavailable",
    meaning: why,
    next: FULL_REBUILD,
  };
}

export interface HotReloadDeps {
  send: <T>(cmd: string, params: Record<string, unknown>) => Promise<T>;
  /** Injected so the tests do not spend real seconds waiting. */
  wait: (ms: number) => Promise<void>;
  /** Injected for the same reason: elapsed time has to be fake-able. */
  now: () => number;
}

/**
 * Kick off a live coding compile and wait for it, reporting one outcome.
 *
 * Polls rather than blocking the editor. The interval is 1.5s because a live coding compile of one
 * changed file is usually 5-20 seconds: polling faster buys nothing and polling slower adds latency
 * to the common case. None of this costs the model anything - it is one tool call either way.
 */
export async function hotReloadCpp(
  deps: HotReloadDeps,
  options: { timeoutSeconds?: number } = {}
): Promise<HotReloadReport> {
  const timeoutMs = Math.max(10, options.timeoutSeconds ?? 300) * 1000;
  const POLL_MS = 1500;

  const status = await deps.send<LiveCodingStatusReply>("live_coding_status", {});
  if (!status.available) {
    return unavailableReport(status);
  }

  // A compile already running is somebody else's - the human at the keyboard pressed the shortcut.
  // Waiting for theirs and reporting it beats starting a second one, which the engine refuses anyway.
  let joinedExisting = false;
  if (status.compiling) {
    joinedExisting = true;
  } else {
    const kick = await deps.send<LiveCodingCompileReply>("live_coding_compile", {});
    if (!kick.started) {
      if (kick.alreadyRunning) {
        joinedExisting = true;
      } else {
        return {
          outcome: "unavailable",
          meaning: kick.why ?? `Live coding did not start (${kick.result ?? "no result"}).`,
          next: FULL_REBUILD,
          log: kick.log,
        };
      }
    }
  }

  const deadline = deps.now() + timeoutMs;
  for (;;) {
    await deps.wait(POLL_MS);
    const poll = await deps.send<LiveCodingStatusReply>("live_coding_status", {});
    if (poll.done) {
      const report = interpretLiveCodingLog(poll.log ?? []);
      if (joinedExisting && report.outcome === "patched") {
        report.meaning +=
          " This was a compile that was already running when the call was made, not one it started.";
      }
      return report;
    }
    if (deps.now() >= deadline) {
      return {
        outcome: "still-running",
        meaning:
          `The compile was still going after ${Math.round(timeoutMs / 1000)}s. It has not been stopped - ` +
          "live coding is still working, and this call simply stopped waiting.",
        next:
          "Call this again to pick the same compile back up and report its result. A first compile of " +
          "a session is much slower than later ones, so a long first wait is normal.",
      };
    }
  }
}
