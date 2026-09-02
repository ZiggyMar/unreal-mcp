import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

import { portIsAccepting, editorGoneMessage } from "../dist/editorGone.js";

test("a port nothing listens on is reported as not accepting", async () => {
  assert.equal(await portIsAccepting("127.0.0.1", 8799, 800), false);
});

test("a port something listens on is reported as accepting", async () => {
  // The distinction that matters: a BUSY editor still accepts, because accepting happens below the
  // game thread. A listener that never replies is exactly that case.
  const server = createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    assert.equal(await portIsAccepting("127.0.0.1", port, 800), true);
  } finally {
    server.close();
  }
});

test("the gone message says it is gone, and what is worth doing", async () => {
  const m = editorGoneMessage("create_struct", "60s");
  assert.match(m, /editor is GONE, not busy/);
  assert.match(m, /crashed or was closed/);
  // Retrying is the wrong instinct here and the old message actively encouraged it.
  assert.match(m, /Nothing about this is worth retrying/);
  // And it points at the two things that actually diagnose it.
  assert.match(m, /Critical error/);
  assert.match(m, /Live Coding patches/);
});
