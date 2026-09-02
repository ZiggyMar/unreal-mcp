import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// Importing the entry point must not start a server.
//
// main() used to run at module scope, so `import("../dist/index.js")` started a stdio server that
// never exits. Anything reaching into this file for a pure function got a hung process: a test
// importing one timed out after ten minutes with no output and no clue why, because a stdio server
// producing nothing looks exactly like a test that is merely slow.
//
// Run in a CHILD process with a timeout rather than imported here. If this ever regresses, the child
// hangs and is killed and this FAILS - whereas importing it directly would hang the whole suite, which
// is the failure mode being guarded against in the first place.

test("importing the server module does not start a server", () => {
  const probe = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./dist/index.js'); process.exit(0);"],
    { cwd: SERVER_DIR, encoding: "utf8", timeout: 20_000 }
  );

  assert.notEqual(
    probe.signal,
    "SIGTERM",
    "importing dist/index.js hung - main() is running at module scope again, so anything that imports " +
      "this file for a pure function gets a stdio server instead of a value"
  );
  assert.equal(probe.status, 0, `import failed: ${probe.stderr?.slice(0, 300)}`);
});

test("running the server module DOES start a server", () => {
  // The other half. Making it safe to import must not make it impossible to run - the gate is
  // `argv[1] is this file`, and every client and the test harness launch it exactly that way.
  //
  // --print-config exercises the launched path and exits on its own, so this needs no stdio
  // conversation to prove main() ran.
  const run = spawnSync(process.execPath, ["dist/index.js", "--print-config", "--client", "claude-code"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    timeout: 20_000,
  });

  assert.equal(run.status, 0, `launching the server failed: ${run.stderr?.slice(0, 300)}`);
  assert.match(
    run.stdout,
    /UNREAL_MCP_PROFILE/,
    "the launched path produced no config, so main() did not run when it should have"
  );
});
