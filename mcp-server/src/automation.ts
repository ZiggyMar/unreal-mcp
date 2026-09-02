/**
 * Running the engine's automation tests, and reading what they said.
 *
 * The gap this closes was found by checking what Epic's own first-party MCP plugin exposes, which
 * lists "running automation tests" among its tools. This project had no route to them at all - not
 * in the bridge, not in the server - and running the tests is something a person does from Session
 * Frontend every day. "Supports everything a normal human would have for this engine" has to
 * include the thing that tells them whether the engine still works.
 *
 * ## Why no C++ was needed
 *
 * The obvious implementation is a new bridge command, which means rebuilding the plugin and
 * restarting the editor before anyone can use it. But `Automation` is a console command, the bridge
 * already runs console commands, and the editor writes every automation line to Saved/Logs before
 * anything else happens - the same property runtimeLog.ts is built on. So this is the console
 * command plus a parser, it works on a plugin nobody rebuilt, and it can read a run that has
 * already finished.
 *
 * ## Why it does not return the passing tests
 *
 * `Automation List` reports 4,957 tests on this project. Returning them is thirty thousand tokens
 * of names nobody asked for. A test run answers one question - what broke - so passes are counted
 * and failures are named with the events the engine attached to them. Same rule the audit follows,
 * for the same reason.
 */

import { open, stat } from "node:fs/promises";
import { matchTerms, matchesAllTerms } from "./matchTerms.js";

/** One test the engine reported on. */
export interface TestResult {
  path: string;
  result: string;
  /** Only kept for failures; the engine's own messages, which are the reason it failed. */
  events?: string[];
}

export interface AutomationRun {
  /** How many tests the filter matched, as the engine counted them. */
  found?: number;
  /** How many actually ran, from the engine's own closing line. */
  performed?: number;
  passed: number;
  failed: number;
  failures: TestResult[];
  /** True once the engine printed its terminal line, so a caller can tell a result from a timeout. */
  complete: boolean;
}

/** The line the engine prints when the queue drains. Its presence is the only reliable "done". */
const DONE_RE = /\.\.\.Automation Test Queue Empty (\d+) tests performed\./;

const FOUND_RE = /Found (\d+) automation tests? based on/;
const COMPLETED_RE = /Test Completed\. Result=\{([^}]*)\} Name=\{[^}]*\} Path=\{([^}]*)\}/;

/**
 * Parse a slice of log covering one automation run.
 *
 * Deliberately tolerant: it is reading a log that other systems write to at the same time, so
 * anything unrecognised is skipped rather than treated as a problem. The only line whose absence
 * means anything is the terminal one, and that is reported as `complete: false` rather than guessed
 * at - a run that timed out and a run where everything passed look identical if you only count
 * failures, and telling a caller "0 failed" about a run that never finished would be a lie.
 */
export function parseAutomationRun(text: string): AutomationRun {
  const lines = text.split(/\r?\n/);
  const run: AutomationRun = { passed: 0, failed: 0, failures: [], complete: false };

  // Events arrive between BeginEvents/EndEvents for a named test, AFTER its Completed line.
  const eventsFor = new Map<string, string[]>();
  let collecting: string | undefined;

  for (const line of lines) {
    const found = FOUND_RE.exec(line);
    if (found) {
      run.found = Number(found[1]);
      continue;
    }

    const done = DONE_RE.exec(line);
    if (done) {
      run.performed = Number(done[1]);
      run.complete = true;
      continue;
    }

    const begin = /BeginEvents:\s*(\S.*)$/.exec(line);
    if (begin) {
      collecting = begin[1].trim();
      continue;
    }
    if (/EndEvents:/.test(line)) {
      collecting = undefined;
      continue;
    }
    if (collecting) {
      // Strip the timestamp and category the engine prefixes every line with, keeping the message.
      const message = line.replace(/^\[[^\]]*\]\[[^\]]*\]\s*/, "").replace(/^LogAutomationController:\s*/, "").trim();
      if (message.length > 0) {
        const list = eventsFor.get(collecting) ?? [];
        list.push(message);
        eventsFor.set(collecting, list);
      }
      continue;
    }

    const completed = COMPLETED_RE.exec(line);
    if (completed) {
      const result = completed[1].trim();
      const path = completed[2].trim();
      // "Success" is the engine's word. Anything else - Fail, Skipped, a form added in a later
      // engine version - is not a pass, and counting an unknown verdict as success is the failure
      // mode that makes a test runner worse than no test runner.
      if (/^success$/i.test(result)) run.passed += 1;
      else {
        run.failed += 1;
        run.failures.push({ path, result });
      }
    }
  }

  for (const failure of run.failures) {
    const events = eventsFor.get(failure.path);
    if (events && events.length > 0) failure.events = events;
  }
  return run;
}

/** Has the run finished, judged only by the engine's own terminal line? */
export function runIsComplete(text: string): boolean {
  return DONE_RE.test(text);
}

export interface AutomationList {
  /** Every test the engine knows about, as it counted them. */
  total: number;
  /** The names that matched, capped. */
  names: string[];
  /** How many matched but were not listed. */
  omitted: number;
}

/**
 * Parse `Automation List` output, keeping only what was asked for.
 *
 * The engine prints one quoted name per line and there are nearly five thousand of them. Returning
 * that is thirty thousand tokens to answer "is there a test for X", so the filter is applied here
 * and the count of what it left out is reported rather than silently dropped.
 */
export function parseAutomationList(text: string, match?: string, limit = 100): AutomationList {
  const names: string[] = [];
  const terms = matchTerms(match);
  for (const line of text.split(/\r?\n/)) {
    const m = /Display:\s*\t'?([A-Za-z0-9._+\-]+)'?\s*$/.exec(line);
    if (!m) continue;
    const name = m[1];
    // Every term, not one literal substring: a test is called System.Mass.EntityView.Invalidate
    // and "mass entityview" is how a person asks for it. See matchTerms.ts.
    if (!matchesAllTerms(name, terms)) continue;
    names.push(name);
  }
  const unique = [...new Set(names)];
  const available = /(\d+) tests available/.exec(text);
  return {
    total: available ? Number(available[1]) : unique.length,
    names: unique.slice(0, limit),
    omitted: Math.max(0, unique.length - limit),
  };
}


/** Where the log currently ends, so a run can be read without re-reading the session before it. */
export async function logSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

/**
 * The log from `start` onwards, capped.
 *
 * The cap is not tidiness: this file is 34 MB on a real project and other systems write to it while
 * a test runs, so an uncapped read of "everything since I started" is unbounded in exactly the
 * situation - a long run - where it would hurt most.
 */
export async function readLogFrom(path: string, start: number, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size <= start) return "";
    const length = Math.min(size - start, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}
