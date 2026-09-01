import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewMultiplayer } from "../dist/multiplayer.js";

// The quiet half of the replication family, and one found by hand in a real project before this
// check existed: OnRep_PlayerWhoPlacedName, an event with nothing wired to it, on a variable that
// replicates perfectly. The name arrived on every client and the nameplate never changed. Nothing
// errored, nothing warned.

const varWith = (over = {}) => ({ name: "PlayerWhoPlacedName", type: "Text", replicated: true, repNotify: "OnRep_PlayerWhoPlacedName", ...over });

test("a RepNotify with nothing wired to it is reported", () => {
  // One node is the entry alone. The Blueprint DOES use the variable elsewhere, which is what
  // separates "wire the handler" from the dead-state case below.
  const sizes = new Map([["OnRep_PlayerWhoPlacedName", 1]]);
  const used = [{ id: "g", type: "K2Node_VariableGet", title: "Get PlayerWhoPlacedName", connectedPins: [] }];
  const findings = reviewMultiplayer(used, [varWith()], sizes);
  const hit = findings.find((f) => f.check === "repnotify-does-nothing");
  assert.ok(hit, `expected the finding, got: ${findings.map((f) => f.check).join(", ")}`);
  assert.match(hit.message, /OnRep_PlayerWhoPlacedName/);
  assert.match(hit.fix, /wire|drop the RepNotify/i);
});

test("a RepNotify that does something is not reported", () => {
  const sizes = new Map([["OnRep_PlayerWhoPlacedName", 6]]);
  assert.equal(
    reviewMultiplayer([], [varWith()], sizes).find((f) => f.check === "repnotify-does-nothing"),
    undefined
  );
});

test("a handler that was never read is not called empty", () => {
  // Not read and not there are different answers. Reporting the first as the second is the
  // confident wrong answer this project keeps finding.
  assert.equal(
    reviewMultiplayer([], [varWith()], new Map()).find((f) => f.check === "repnotify-does-nothing"),
    undefined
  );
});

test("a replicated variable with no RepNotify at all is left alone", () => {
  // Asking for a RepNotify nobody requested is a style opinion; this file is for defects.
  const sizes = new Map([["Whatever", 1]]);
  assert.equal(
    reviewMultiplayer([], [varWith({ repNotify: undefined })], sizes).find((f) => f.check === "repnotify-does-nothing"),
    undefined
  );
});

test("it fires even when the Blueprint has no server events", () => {
  // A variable carrying a RepNotify is networked by definition. Gating this behind "does this
  // Blueprint have a server event" would silence it on exactly the Blueprints that only replicate
  // state, which is most of the UI.
  const sizes = new Map([["OnRep_PlayerWhoPlacedName", 1]]);
  const findings = reviewMultiplayer([], [varWith({ replicated: false })], sizes);
  assert.ok(findings.find((f) => f.check === "repnotify-does-nothing"));
});

test("without graph sizes the check stays silent rather than guessing", () => {
  assert.equal(
    reviewMultiplayer([], [varWith()]).find((f) => f.check === "repnotify-does-nothing"),
    undefined
  );
});

test("an empty RepNotify on a variable nothing touches is called dead state", () => {
  // A stronger and much easier answer than "wire the handler": the whole variable is dead, and
  // replicating it pays network for a value nobody looks at. Found on a real ping actor -
  // CurrentDistanceMeters, replicated, RepNotify, zero writes and zero reads, while the distance it
  // was meant to carry is recomputed locally every tick.
  const sizes = new Map([["OnRep_PlayerWhoPlacedName", 1]]);
  const findings = reviewMultiplayer([], [varWith()], sizes);
  const hit = findings.find((f) => f.check === "repnotify-does-nothing");
  assert.match(hit.message, /nothing in this Blueprint reads or writes/);
  assert.match(hit.fix, /Dead state|delete the/i);
});

test("an empty RepNotify on a variable the Blueprint DOES use asks for the handler instead", () => {
  // The two need opposite responses, so they must not read the same.
  const sizes = new Map([["OnRep_PlayerWhoPlacedName", 1]]);
  const nodes = [{ id: "g", type: "K2Node_VariableGet", title: "Get PlayerWhoPlacedName", connectedPins: [] }];
  const hit = reviewMultiplayer(nodes, [varWith()], sizes).find((f) => f.check === "repnotify-does-nothing");
  assert.doesNotMatch(hit.message, /reads or writes/);
  assert.match(hit.fix, /wire OnRep_PlayerWhoPlacedName|drop the RepNotify/i);
});
