import { test } from "node:test";
import assert from "node:assert/strict";

import { findOrphans } from "../dist/orphans.js";

/**
 * A bridge that answers list_actors the way the real one does: classFilter is a substring match,
 * and a filter matching nothing still returns the whole level rather than an empty list. That
 * second behaviour is why the module filters again itself, so the fake has to reproduce it or the
 * test proves nothing about the real thing.
 */
function fakeLevel(actors) {
  return {
    async send(cmd, params = {}) {
      if (cmd !== "list_actors") throw new Error(`unknown_cmd: ${cmd}`);
      const needle = String(params.classFilter ?? "").toLowerCase();
      const matched = actors.filter((a) => a.class.toLowerCase().includes(needle));
      return { actors: matched.length > 0 ? matched : actors };
    },
  };
}

const actor = (label, cls, x, y, z = 0) => ({ label, name: label, class: cls, location: `${x},${y},${z}` });

/** The real level: twelve firewalls, two nav links each, and one link left behind. */
function motherboardish() {
  const list = [];
  for (let i = 0; i < 12; i++) {
    const x = i * 1000;
    list.push(actor(`BP_FireWall_${i}`, "BP_FireWall_C", x, 0));
    list.push(actor(`Link_${i}a`, "BP_NavLinkFirewall_C", x - 120, 0));
    list.push(actor(`Link_${i}b`, "BP_NavLinkFirewall_C", x + 130, 0));
  }
  list.push(actor("Link_orphan", "BP_NavLinkFirewall_C", 4000, 3800));
  return list;
}

test("the leftover half is found, and the working pairs are not", async () => {
  const r = await findOrphans(fakeLevel(motherboardish()), {
    of: "BP_NavLinkFirewall",
    pairedWith: "BP_FireWall_C",
  });

  assert.equal(r.verdict, "problems");
  assert.equal(r.orphans.length, 1, `expected exactly one orphan, got ${JSON.stringify(r.orphans)}`);
  assert.equal(r.orphans[0].actor, "Link_orphan");
  assert.equal(r.counted.of, 25);
  assert.equal(r.counted.pairedWith, 12);
});

test("the threshold is inferred from the level, not from a constant", async () => {
  const r = await findOrphans(fakeLevel(motherboardish()), {
    of: "BP_NavLinkFirewall",
    pairedWith: "BP_FireWall_C",
  });
  assert.equal(r.thresholdSource, "inferred");
  // Real pairs sit at 120-130 units, so the median must land there and the threshold well above it.
  assert.ok(r.medianDistance >= 100 && r.medianDistance <= 200, `median was ${r.medianDistance}`);
  assert.ok(r.threshold > r.medianDistance, "the threshold has to exceed the normal pairing distance");
});

test("an explicit distance overrides the inference and says so", async () => {
  const r = await findOrphans(fakeLevel(motherboardish()), {
    of: "BP_NavLinkFirewall",
    pairedWith: "BP_FireWall_C",
    maxDistance: 50,
  });
  assert.equal(r.thresholdSource, "given");
  assert.equal(r.threshold, 50);
  assert.equal(r.orphans.length, 25, "at 50 units nothing pairs, which is what was asked for");
});

test("a tidy level is clean", async () => {
  const tidy = [];
  for (let i = 0; i < 5; i++) {
    tidy.push(actor(`Door_${i}`, "BP_Door_C", i * 500, 0));
    tidy.push(actor(`Link_${i}`, "BP_NavLink_C", i * 500 + 40, 0));
  }
  const r = await findOrphans(fakeLevel(tidy), { of: "BP_NavLink", pairedWith: "BP_Door" });
  assert.equal(r.verdict, "clean");
  assert.deepEqual(r.orphans, []);
  assert.deepEqual(r.partnersWithNothing, []);
});

test("a partner nothing pairs to is the other half of the same mistake", async () => {
  // A firewall whose nav links were deleted is just as broken as a nav link whose firewall was.
  const list = [
    actor("Wall_A", "BP_FireWall_C", 0, 0),
    actor("Link_A", "BP_NavLinkFirewall_C", 100, 0),
    actor("Wall_Lonely", "BP_FireWall_C", 9000, 9000),
  ];
  const r = await findOrphans(fakeLevel(list), { of: "BP_NavLinkFirewall", pairedWith: "BP_FireWall_C" });
  assert.deepEqual(r.partnersWithNothing, ["Wall_Lonely"]);
  assert.equal(r.verdict, "problems");
});

test("pairs sitting exactly on top of each other do not make everything an orphan", async () => {
  // median 0 would make any multiple of it zero, and then every actor is further away than the
  // threshold. The floor exists for this.
  const list = [];
  for (let i = 0; i < 4; i++) {
    list.push(actor(`W${i}`, "BP_FireWall_C", i * 1000, 0));
    list.push(actor(`L${i}`, "BP_NavLinkFirewall_C", i * 1000, 0));
  }
  const r = await findOrphans(fakeLevel(list), { of: "BP_NavLinkFirewall", pairedWith: "BP_FireWall_C" });
  assert.equal(r.medianDistance, 0);
  assert.equal(r.orphans.length, 0, "coincident pairs are the tidiest case, not the worst");
});

test("a class name that matches nothing says so instead of reporting the whole level", async () => {
  const r = await findOrphans(fakeLevel(motherboardish()), { of: "BP_DoesNotExist", pairedWith: "BP_FireWall_C" });
  assert.equal(r.counted.of, 0);
  assert.equal(r.verdict, "clean");
  assert.match(r.next, /Check the class names/);
});

test("distance is measured in three dimensions", async () => {
  // Two actors at the same X and Y but 5000 units apart vertically are not a pair, and a check that
  // only compared the ground plane would call them one.
  const list = [actor("Wall", "BP_FireWall_C", 0, 0, 0), actor("Link", "BP_NavLinkFirewall_C", 0, 0, 5000)];
  const r = await findOrphans(fakeLevel(list), {
    of: "BP_NavLinkFirewall",
    pairedWith: "BP_FireWall_C",
    maxDistance: 400,
  });
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].distance, 5000);
});

test("the real level's distribution is caught, not just an obvious fixture", async () => {
  // The regression that matters. The first inference used five times the median. On the actual
  // level the median pairing distance is ~204 units and the real orphan sits at ~921, so the
  // threshold landed at 1019 and the check reported CLEAN while the bug it was written for was
  // sitting in the level. The synthetic fixture passed, because a fixture author puts the orphan
  // somewhere unmissable. These numbers are taken from the real Motherboard level.
  const list = [];
  const pairDistances = [101, 105, 123, 152, 138, 145, 138, 155, 169, 144, 189, 164, 105, 101, 81, 95, 182, 145, 152, 123, 115, 159, 123, 152];
  // Z differences push the real median to ~204; spread the pairs out so nearest-neighbour is honest.
  pairDistances.forEach((d, i) => {
    const x = i * 5000;
    list.push({ label: `Wall_${i}`, name: `Wall_${i}`, class: "BP_FireWall_C", location: `${x},0,0` });
    list.push({ label: `Link_${i}`, name: `Link_${i}`, class: "BP_NavLinkFirewall_C", location: `${x + d},0,150` });
  });
  // The orphan: 921 units from the nearest wall - only 4.5x the median, which is why a 5x rule missed it.
  list.push({ label: "Link_orphan", name: "Link_orphan", class: "BP_NavLinkFirewall_C", location: `921,0,0` });

  const r = await findOrphans(fakeLevel(list), { of: "BP_NavLinkFirewall", pairedWith: "BP_FireWall_C" });
  assert.equal(r.verdict, "problems", `a 921uu orphan among ~150uu pairs must be found: ${JSON.stringify(r)}`);
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].actor, "Link_orphan");
  assert.ok(r.threshold < 921, `the threshold must sit below the orphan, was ${r.threshold}`);
  assert.ok(r.threshold > 200, `and above the real pairs, was ${r.threshold}`);
});
