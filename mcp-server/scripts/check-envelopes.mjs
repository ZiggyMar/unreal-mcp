#!/usr/bin/env node
// Every command handler must answer in the reply envelope, or a working command reports failure.
//
// The dispatcher reads a reply with no `ok` field as an error. So a handler that returns its result
// object bare is not merely untidy - it tells the caller its work failed, while having done it. That
// is worse than failing: a model told a write failed retries it, or works around it, or reports to
// the user that the feature is broken.
//
// This has now happened twice. MCPResponse.h was written the first time, after eight ops commands
// shipped bare and rename_variable reported an error carrying the successful rename. Four more files
// were missed in that sweep and shipped the same way - run_console_command among them, which is how
// it was found: a console command answered `{"recognised": true}` inside an error.
//
// Compiling cannot catch it. Running every command against a live editor can, but only if someone
// runs them. Reading the source catches it in a second, so that is what this does.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PRIVATE = join(here, "..", "..", "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private");

/** The wrappers that produce a valid envelope. Anything else returned from a handler is suspect. */
const WRAPPED = /return\s+(MCPResponse::(Ok|Fail)|MakeOkResponse|MakeErrorResponse|Handle\w+)\s*\(/;

const problems = [];
let handlersChecked = 0;

for (const file of readdirSync(PRIVATE).filter((f) => f.endsWith(".cpp"))) {
  const lines = readFileSync(join(PRIVATE, file), "utf8").split(/\r?\n/);

  // Track the enclosing function so only real handlers are judged. A helper that builds a
  // sub-object legitimately returns it bare - FMCPProjectIndex::GetOverview is consumed by a
  // handler that wraps it, and flagging that would train people to ignore this check.
  let current = "";
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const declaration = line.match(/^\s*(?:static\s+)?TShared(?:Ref|Ptr)<FJsonObject>\s+(?:(\w+)::)?(\w+)\s*\(/);
    if (declaration && depth === 0) {
      current = `${declaration[1] ? declaration[1] + "::" : ""}${declaration[2]}`;
      if (/^FMCPCommandHandler::Handle/.test(current)) handlersChecked += 1;
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0 && declaration === null && /^\}/.test(line)) current = "";

    if (!/^FMCPCommandHandler::Handle/.test(current)) continue;

    const returned = line.match(/^\s*return\s+(\w+)\s*;/);
    if (returned && !WRAPPED.test(line)) {
      // `return Response;` where Response was built by a wrapper is fine; the give-away is
      // returning the raw result object every handler calls `Result`.
      if (/^(Result|Out|Obj|Entry)$/.test(returned[1])) {
        problems.push(
          `${file}:${i + 1} — ${current} returns \`${returned[1]}\` bare. Wrap it: ` +
            `MCPResponse::Ok(${returned[1]}) — a reply with no \`ok\` is read as a failure, so this ` +
            `command reports an error while having done its work.`
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\nreply envelope check failed (${problems.length} problem(s)):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log(`reply envelopes ok: ${handlersChecked} handlers, none returning a bare result object`);
