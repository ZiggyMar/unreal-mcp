import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";

import { UnrealBridgeClient, toObjectPath } from "../dist/bridgeClient.js";

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

test("the _C class path resolves to the asset it is generated from", () => {
  // parentClass comes back as "BP_ShopUpgrade_C", so a model that reads a Blueprint, sees its
  // parent, and asks to inspect that parent writes exactly this. Measured against the editor before
  // the fix: /Game/Dir/BP_X.BP_X_C was blueprint_not_found.
  assert.equal(toObjectPath("/Game/Dir/BP_X.BP_X_C"), "/Game/Dir/BP_X.BP_X");
});

test("an asset genuinely named Foo_C is not mangled", () => {
  // The test is that the object name equals the asset name plus _C, not merely that it ends in _C.
  // /Game/Dir/Foo_C.Foo_C is an ordinary asset whose name happens to end that way, and stripping
  // blindly would send every call about it to an asset that does not exist.
  assert.equal(toObjectPath("/Game/Dir/Foo_C.Foo_C"), "/Game/Dir/Foo_C.Foo_C");
});

test("/Content/ means /Game/", () => {
  // The folder on disk is Content; the path the engine uses is /Game/. It is the single most common
  // thing to get wrong about an Unreal path, and a model that has looked at the filesystem has seen
  // the wrong one of the two.
  assert.equal(toObjectPath("/Content/Dir/BP_X"), "/Game/Dir/BP_X.BP_X");
  assert.equal(toObjectPath("/Content/Dir/BP_X.BP_X_C"), "/Game/Dir/BP_X.BP_X", "both corrections at once");
});

test("a project folder actually called Content is left alone", () => {
  // Only a LEADING /Content/ is rewritten. /Game/Content/ is a real folder some projects have.
  assert.equal(toObjectPath("/Game/Content/Thing"), "/Game/Content/Thing.Thing");
});

test("a trailing slash is a folder spelling of the same asset", () => {
  assert.equal(toObjectPath("/Game/Dir/BP_X/"), "/Game/Dir/BP_X.BP_X");
});

test("filesystem paths are still untouched", () => {
  // compile_cpp takes a FILESYSTEM path in a parameter also called `path`. Rewriting it would break
  // the one tool that compiles C++, and none of the new rules may reach it.
  assert.equal(toObjectPath("M:/Proj/Source/Foo.cpp"), "M:/Proj/Source/Foo.cpp");
  assert.equal(toObjectPath("Source/AntiVirusSquad/Foo.cpp"), "Source/AntiVirusSquad/Foo.cpp");
  assert.equal(toObjectPath("C:\Proj\Foo.cpp"), "C:\Proj\Foo.cpp");
});

test("a bare asset name is not guessed at", () => {
  // Unlike the other four, this one is genuinely ambiguous - the same name can exist in several
  // folders - so it stays an error. The bridge's message already names the right path shape and the
  // tool that lists the real ones.
  assert.equal(toObjectPath("BP_X"), "BP_X");
});

test("a read-only session refuses a write before anything is sent", async () => {
  // The profiles decide what a model is HANDED. This decides what it can DO, and only the first
  // question had an answer: on any profile a model can call unreal_enable_tools and turn the writes
  // back on, which is right for a session meant to build and wrong for one meant to review.
  //
  // Refused at the same choke point the path expansion and the change journal use, so "nothing was
  // changed" is a fact rather than a hope - there is no socket connection to race.
  const client = new UnrealBridgeClient({ port: 1, readOnly: true });
  await assert.rejects(
    () => client.send("create_blueprint", { packagePath: "/Game/Nope" }),
    (err) => {
      assert.match(err.message, /read_only_session/);
      assert.match(err.message, /nothing was sent/);
      assert.match(err.message, /UNREAL_MCP_READONLY/, "and says how to turn it off");
      return true;
    }
  );
});

test("a read-only session lets reads through to the socket", async () => {
  // The refusal must be keyed on what the command DOES, not on it being read-only mode. Port 1 has
  // nothing listening, so a read gets a connection error - which is the proof it was sent.
  const client = new UnrealBridgeClient({ port: 1, readOnly: true });
  await assert.rejects(
    () => client.send("list_blueprints", {}),
    (err) => {
      assert.ok(!/read_only_session/.test(err.message), `a read was refused: ${err.message}`);
      return true;
    }
  );
});

test("the classification is the journal's, not a second copy", async () => {
  // READ_ONLY_COMMANDS in journal.ts is 38 commands, each read out of its C++ handler and confirmed
  // to touch nothing, with check:journal failing if a read-named command drifts out of it. A second
  // list here would be two things describing one fact, which is this repo's most repeated defect -
  // and the failure mode would be a write slipping through a session that promised it could not.
  const { isWrite } = await import("../dist/journal.js");
  const client = new UnrealBridgeClient({ port: 1, readOnly: true });
  for (const command of ["list_variables", "read_class_defaults", "describe_class", "project_health"]) {
    assert.equal(isWrite(command), false, `${command} is classified as a read`);
    await assert.rejects(
      () => client.send(command, {}),
      (err) => !/read_only_session/.test(err.message),
      `${command} should reach the socket`
    );
  }
});

test("an ordinary session is unaffected", async () => {
  // The flag defaults off, and a change that made every session read-only would be far worse than
  // the gap it closes.
  const client = new UnrealBridgeClient({ port: 1 });
  await assert.rejects(
    () => client.send("create_blueprint", { packagePath: "/Game/Yes" }),
    (err) => !/read_only_session/.test(err.message)
  );
});
