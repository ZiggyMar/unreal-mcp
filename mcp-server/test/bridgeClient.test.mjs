import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";

import { UnrealBridgeClient } from "../dist/bridgeClient.js";

/**
 * Stand up a fake bridge that writes a scripted reply, and let the test choose how that reply is
 * chopped into TCP writes.
 *
 * The point of the split control is that the real bug only appears at a chunk boundary, and a
 * boundary is a delivery detail the client does not get to choose. A test that writes the reply in
 * one go passes with or without the fix, which is exactly how this survived so long.
 */
async function withFakeBridge(replyBytes, splits, run) {
  const server = createServer((socket) => {
    socket.once("data", async () => {
      let at = 0;
      for (const cut of splits) {
        socket.write(replyBytes.subarray(at, cut));
        at = cut;
        // A real gap, not just separate write() calls. Without it Node coalesces the writes into
        // one segment, the client sees a single data event, and the test passes whether or not the
        // bug is present - which is exactly the trap this test exists to avoid.
        await new Promise((r) => setTimeout(r, 15));
      }
      socket.write(replyBytes.subarray(at));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("a reply split mid-character is decoded correctly, not turned into U+FFFD", async () => {
  // Emoji and accented Latin: 4-byte and 2-byte sequences, so several places to cut badly.
  const name = "/Game/Ürsprung/Blueprints/BP_Kämpfer_🗡️.BP_Kämpfer_🗡️";
  const reply = Buffer.from(JSON.stringify({ ok: true, id: "x", result: { path: name } }) + "\n", "utf8");

  // Cut inside the multi-byte sequences rather than at a tidy offset.
  const first = reply.indexOf(Buffer.from("Ü", "utf8"));
  const sword = reply.indexOf(Buffer.from("🗡", "utf8"));
  assert.ok(first > 0 && sword > first, "the fixture should actually contain the characters under test");

  const got = await withFakeBridge(reply, [first + 1, sword + 2], async (port) => {
    const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    return client.send("ping");
  });

  assert.equal(got.path, name, "the path must survive a split that lands inside a UTF-8 sequence");
  assert.ok(!JSON.stringify(got).includes("�"), "no replacement characters should appear");
});

test("a reply delivered in one write still works", async () => {
  const reply = Buffer.from(JSON.stringify({ ok: true, id: "x", result: { ok: 1 } }) + "\n", "utf8");
  const got = await withFakeBridge(reply, [], async (port) => {
    const client = new UnrealBridgeClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
    return client.send("ping");
  });
  assert.deepEqual(got, { ok: 1 });
});
