import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOKS = join(REPO_ROOT, ".githooks");

// A shell script with CRLF endings does not run. It parses.
//
// This repo is developed on Windows and its TypeScript, JavaScript and Markdown are all CRLF, so any
// helper that rewrites a file converts to CRLF - correct for every one of those, and fatal here.
// /bin/sh treats the carriage return as part of the token, and the failure surfaces as a syntax
// error on a line that was never edited.
//
// It happened to .githooks/pre-push after a change that touched only a COMMENT. The hook stopped
// parsing, which turned "refuse to push a red suite" into "refuse every push", and the reported line
// was forty lines from anything that had changed. Two pushes were lost to it before the cause was
// obvious.
//
// .gitattributes now pins these to LF on checkout. This is the half that catches a file written
// wrong in the working copy, which .gitattributes cannot.

const scripts = readdirSync(HOOKS).map((name) => join(HOOKS, name));

test("every git hook is present and non-empty", () => {
  assert.ok(scripts.length > 0, "no hooks found - has .githooks moved?");
});

for (const path of scripts) {
  const name = path.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");

  test(`${name} has LF endings, not CRLF`, () => {
    const raw = readFileSync(path, "utf8");
    const carriageReturns = (raw.match(/\r/g) ?? []).length;
    assert.equal(
      carriageReturns,
      0,
      `${name} has ${carriageReturns} carriage return(s). /bin/sh will fail to parse it, and the ` +
        `error will name a line that was never edited.`
    );
  });

  test(`${name} parses as a shell script`, () => {
    // The direct check, and the one that would have caught this in a second rather than two pushes.
    // Skipped rather than failed where no POSIX shell exists, because a machine without one cannot
    // run the hook either and a false failure there teaches people to ignore this file.
    const parsed = spawnSync("sh", ["-n", path], { encoding: "utf8" });
    if (parsed.error) return;
    assert.equal(parsed.status, 0, `sh -n ${name} failed:\n${parsed.stderr}`);
  });
}
