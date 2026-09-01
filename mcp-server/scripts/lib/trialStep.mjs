/**
 * One `step()` for every trial, because the last bug here was in two copies of it.
 *
 * Trials each grew their own step helper, and they agreed on everything except the thing that
 * mattered. Both computed a verdict like:
 *
 *     const problem = r.error ? "JSON-RPC error" : check ? check(text, parsed) : null;
 *
 * `r.error` is the JSON-RPC TRANSPORT error. A tool that refuses arrives as `result.isError` with
 * the reason as ordinary text content, so a step whose check was "did anything come back" passed on
 * the refusal - because a refusal is words. That hid six steps across two trials that had never once
 * executed, including both halves of the replication trial's setup and both of the steps that
 * actually play the game.
 *
 * Fixing it meant editing the same four lines twice, which is how it got there. So it lives here.
 *
 * What a caller still owns is the CHECK - whether the reply says something the trial claims - and
 * that is the part which should differ per trial. What it no longer owns is deciding whether a reply
 * happened at all.
 */

/**
 * @param server      an initialised client from mcpStdio.js
 * @param options.pad label column width, so a trial's output lines up
 * @param options.downgrade  (text) => string | null. Return a reason to record the step as a warning
 *                    and skip its check - for conditions that are about the environment rather than
 *                    the claim, like a plugin binary older than this server.
 */
export function createStepper(server, options = {}) {
  const pad = options.pad ?? 38;
  const downgrade = options.downgrade ?? (() => null);

  const stalls = [];
  const warnings = [];
  const counters = { calls: 0, tokens: 0 };

  async function step(label, name, args, check) {
    counters.calls++;
    const r = await server.request("tools/call", { name, arguments: args });
    const text =
      ((r.result && r.result.content) || []).map((c) => c.text || "").join("") || JSON.stringify(r.error || {});
    const tokens = Math.round(text.length / 4);
    counters.tokens += tokens;

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not every reply is JSON */
    }

    // Environmental conditions first: they are not this trial's claim, and reporting them as
    // failures is how a guard teaches people to ignore it.
    const excuse = downgrade(text);
    if (excuse) {
      warnings.push(`${label}: ${excuse}`);
      console.log(`  ${label.padEnd(pad)} ${String(tokens).padStart(5)} tok   <-- cannot run yet`);
      return { text, parsed, tokens, unavailable: true };
    }

    // A tool that REFUSED did not answer, whatever its own check thinks.
    const problem = r.error
      ? `JSON-RPC error: ${JSON.stringify(r.error).slice(0, 160)}`
      : r.result?.isError === true
        ? "the tool refused the call"
        : check
          ? check(text, parsed)
          : null;

    if (problem) stalls.push({ label, problem, reply: text.slice(0, 300).split(String.fromCharCode(10)).join(" ") });
    console.log(`  ${label.padEnd(pad)} ${String(tokens).padStart(5)} tok${problem ? "   <-- STALL" : ""}`);
    return { text, parsed, tokens };
  }

  return { step, stalls, warnings, counters };
}
