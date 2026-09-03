/**
 * Compiling a Blueprint while the game is running crashes the editor.
 *
 * Measured, not theorised: changing one variable's replication flag on `BP_VirusData` - a replicated
 * actor with live instances in two PIE worlds - and calling `compile_blueprint` took UnrealEditor 5.6
 * down with `EXCEPTION_ACCESS_VIOLATION` in `CoreUObject`, and the unsaved change went with it.
 *
 * Recompiling reinstances the class. The running worlds still hold objects of the old class, and the
 * engine does not protect the game thread from that. Replicated actors are the worst case because
 * every world holds instances, but nothing here is specific to replication.
 *
 * The failure is expensive in a way that argues for refusing rather than warning: the editor dies, so
 * the caller loses the edit AND every other unsaved change in the session, then pays a restart. A
 * warning in a reply is read after the fact.
 *
 * ## Why the belief is confirmed before refusing
 *
 * This server knows PIE is running because it started it. That belief goes stale the moment a person
 * clicks Stop in the editor, and a tool that refuses to compile because of something it remembers
 * from ten minutes ago is worse than no guard - it blocks real work and cannot be argued with. So the
 * belief only decides whether to ASK; the editor decides the answer.
 */

/** What `pie_status` reports back. Only the fields the guard reads. */
export interface PieStatusLike {
  running?: boolean;
  worlds?: Array<{ role?: string; map?: string }>;
}

/**
 * The refusal text, given what the editor said.
 *
 * Names the worlds because "PIE is running" understates it: two worlds means two sets of live
 * instances, which is the case that actually crashed.
 */
export function pieGuardMessage(tool: string, path: string, status: PieStatusLike): string {
  const worlds = status.worlds ?? [];
  const roles = worlds.map((w) => w.role).filter(Boolean);
  const where =
    roles.length > 1
      ? `${roles.length} PIE worlds are running (${roles.join(", ")})`
      : "a PIE session is running";

  return (
    `${tool} refused: ${where}, and ${path} may have live instances in ${
      roles.length > 1 ? "them" : "it"
    }. ` +
    `Recompiling a class the running game holds objects of crashes the editor - measured on this ` +
    `project, EXCEPTION_ACCESS_VIOLATION in CoreUObject, taking the unsaved edit and the whole ` +
    `session with it.\n\n` +
    `Nothing was changed. Call unreal_stop_pie, then ${tool} again, then unreal_start_pie. ` +
    `A property flag would not have applied to the running session anyway.`
  );
}

/**
 * Should the call be refused?
 *
 * `believed` is what this server thinks from having started PIE itself; `status` is what the editor
 * just said. Only the editor's answer refuses, and an unreachable editor never does - a guard that
 * fires when it cannot check would block work for the wrong reason.
 */
export function shouldRefuse(believed: boolean, status: PieStatusLike | undefined): boolean {
  if (!believed) return false;
  if (!status) return false;
  return status.running === true;
}
