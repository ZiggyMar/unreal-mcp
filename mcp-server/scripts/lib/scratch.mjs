// The scratch namespace the trials build in, and the sweep that keeps it empty.
//
// /Game/MCPTrial exists so a trial can create real assets in the real project without touching
// anything a person made. Every trial deletes what it created in a `finally`.
//
// That was not enough. Seven BP_TrialParent* Blueprints had accumulated there, from runs killed
// before `finally` could execute - an editor restart mid-trial, a timeout, a Ctrl-C. Nothing was
// broken and nothing complained, which is why they sat there long enough to reach seven: the next
// run creates its own uniquely-stamped assets and never looks at what is already present.
//
// They surfaced only when an unrelated script crashed on one - list_blueprints still reported a
// Blueprint whose file had gone, and reading it threw. So a leak nobody was paying for became a
// confusing failure somewhere else entirely, which is the usual way scratch data eventually costs
// something.
//
// Two rules, and the first is the one that matters:
//
//   1. Sweep on the way IN, not only on the way out. An exit path cannot clean up after a process
//      that is no longer running, and it is the crashed runs that leak by definition.
//   2. A failed delete is reported. `.catch(() => {})` in a cleanup block is how a trial prints
//      "cleaned up 2 assets" while leaving both behind.
//   3. A delete is judged by what it deleted, not by whether it threw. delete_asset returns
//      {requested: 1, deleted: 0} as a SUCCESS response when the engine refuses, so a cleanup that
//      only catches exceptions counts that as done. Checking the count is the difference between
//      this sweep working and it printing the same reassuring line the old one did.

export const SCRATCH_ROOT = "/Game/MCPTrial";

/**
 * Did a delete that returned successfully actually delete anything?
 *
 * delete_asset answers {requested: 1, deleted: 0} without raising, so "it did not throw" is not the
 * same question as "it worked". Only a reply that explicitly reports deleting nothing counts as a
 * failure here - a caller shape without those fields is left alone rather than assumed broken.
 */
function deletedNothing(outcome) {
  if (!outcome || typeof outcome !== "object") return false;
  const body = typeof outcome.deleted === "number" ? outcome : safeJson(outcome);
  if (!body || typeof body.deleted !== "number" || typeof body.requested !== "number") return false;
  return body.requested > 0 && body.deleted < body.requested;
}

/** delete_asset comes back as MCP content in one trial and as a plain object in the other. */
function safeJson(outcome) {
  const text = outcome?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Delete everything already under the scratch root, and say what was found.
 *
 * Called at the START of a trial. Anything here is by definition left over from a run that did not
 * finish, because a run that finishes deletes its own.
 *
 * `list` and `remove` are passed in because the two trials talk to different layers - one through
 * the MCP tools, one straight at the bridge - and this should not care which.
 */
export async function sweepScratch({ list, remove, log = console.log }) {
  let leftovers;
  try {
    leftovers = await list();
  } catch (err) {
    // Not fatal. A trial that cannot check for leftovers should still run; it just says so rather
    // than starting quietly on an unknown state.
    log(`could not check ${SCRATCH_ROOT} for leftovers: ${String(err?.message ?? err).slice(0, 120)}`);
    return { found: 0, removed: 0, failed: [] };
  }

  // The boundary matters. A plain startsWith(SCRATCH_ROOT) also matches /Game/MCPTrialish/, and this
  // runs against the real project with force:true - the one function here that must never be
  // approximately right. Caught by a test that had been written to assert the loose behaviour.
  const stale = (leftovers ?? []).filter(
    (path) => typeof path === "string" && (path === SCRATCH_ROOT || path.startsWith(`${SCRATCH_ROOT}/`))
  );
  if (stale.length === 0) return { found: 0, removed: 0, failed: [] };

  const failed = [];
  let removed = 0;
  for (const path of stale) {
    try {
      const outcome = await remove(path);
      if (deletedNothing(outcome)) {
        failed.push({ path, error: "the engine reported the delete as done and deleted nothing" });
      } else {
        removed += 1;
      }
    } catch (err) {
      failed.push({ path, error: String(err?.message ?? err).slice(0, 120) });
    }
  }

  log(
    `swept ${removed} leftover asset(s) from ${SCRATCH_ROOT} - from an earlier run that was killed ` +
      `before it could clean up` +
      (failed.length > 0 ? `; ${failed.length} could not be deleted` : "")
  );
  for (const f of failed) log(`  could not delete ${f.path}: ${f.error}`);
  return { found: stale.length, removed, failed };
}

/**
 * Delete what this run created, and report anything that would not go.
 *
 * The reverse order matters: a child is deleted before the parent it derives from.
 */
export async function cleanUpScratch(paths, remove, log = console.log) {
  const failed = [];
  for (const path of [...paths].reverse()) {
    try {
      const outcome = await remove(path);
      if (deletedNothing(outcome)) {
        failed.push({ path, error: "the engine reported the delete as done and deleted nothing" });
      }
    } catch (err) {
      failed.push({ path, error: String(err?.message ?? err).slice(0, 120) });
    }
  }
  if (failed.length === 0) {
    log(`cleaned up ${paths.length} asset(s)`);
    return true;
  }
  // Said plainly rather than swallowed. A cleanup block that reports success unconditionally is how
  // seven Blueprints accumulated without one line of output to say so.
  log(`cleaned up ${paths.length - failed.length} of ${paths.length} asset(s) - ${failed.length} left behind:`);
  for (const f of failed) log(`  ${f.path}: ${f.error}`);
  return false;
}
