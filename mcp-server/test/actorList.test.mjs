import { test } from "node:test";
import assert from "node:assert/strict";

import { capActorList, DEFAULT_UNFILTERED_ACTORS } from "../dist/actorList.js";

const actor = (label, name, cls, blueprint) => ({
  label,
  name,
  class: cls,
  location: "-4018,1350,2440",
  ...(blueprint ? { blueprint } : {}),
});

/** A level shaped like a real one: 889 actors, 96 of which have a Blueprint behind them. */
function bigLevel(count = 889, withLogic = 96) {
  const actors = [];
  // Dressing first, so a cap that just takes the head of the list would miss every Blueprint -
  // which is exactly the order a level tends to be in.
  for (let i = 0; i < count - withLogic; i++) {
    actors.push(actor(`Mesh${i}`, `StaticMeshActor_${i}`, i % 50 === 0 ? "PointLight" : "StaticMeshActor"));
  }
  for (let i = 0; i < withLogic; i++) {
    actors.push(actor(`Enemy${i}`, `BP_Enemy_C_${i}`, "BP_Enemy_C", "/Game/AV/BP_Enemy.BP_Enemy_C"));
  }
  return { actors, totalActors: count, byClass: [{ class: "StaticMeshActor", count: count - withLogic }] };
}

test("a small level comes back whole, with no truncation bookkeeping", () => {
  const level = { actors: [actor("PlayerStart", "PlayerStart_0", "PlayerStart")], totalActors: 1 };
  const out = capActorList(level);
  assert.equal(out.actors.length, 1);
  assert.equal(out.truncated, undefined);
  assert.equal(out.next, undefined);
});

test("the unfiltered reply keeps the actors that carry logic, not the head of the list", () => {
  // Measured: 889 actors cost 26,698 tokens, while the per-class census in the same reply described
  // the whole level in 193. The dump was not answering a question.
  const out = capActorList(bigLevel());
  assert.equal(out.actors.length, DEFAULT_UNFILTERED_ACTORS);
  // "Carries logic" means Blueprint-backed. The path itself now lives in blueprintByClass whenever
  // several actors share a class, so the question has to be asked of both places - the property is
  // unchanged, only where the answer is written.
  // Both hoists can fire at once: when every kept actor is the same Blueprint, the path goes to
  // blueprintByClass AND the class itself is lifted to `out.class`, so a row carries neither.
  const hasLogic = (a) => Boolean(a.blueprint) || Boolean(out.blueprintByClass?.[a.class ?? out.class]);
  assert.ok(
    out.actors.every(hasLogic),
    "every slot should have gone to an actor with logic before any dressing was shown"
  );
  assert.equal(out.totalActors, 889);
  assert.equal(out.omitted, 889 - DEFAULT_UNFILTERED_ACTORS);
  assert.equal(out.truncated, true);
  assert.match(out.next, /classFilter/, "it must say how to ask a real question");
});

test("the census is never touched, because it is what makes the cap safe", () => {
  const level = bigLevel();
  const out = capActorList(level);
  assert.deepEqual(out.byClass, level.byClass, "the whole-level census must survive intact");
});

test("classes with no logic still get one actor shown, so nothing is invisible", () => {
  // A level of pure dressing: if the cap only kept Blueprints it would return nothing at all.
  const actors = [];
  for (let i = 0; i < 300; i++) actors.push(actor(`A${i}`, `A_${i}`, `Class${i % 12}`));
  const out = capActorList({ actors, totalActors: 300 });
  const shownClasses = new Set(out.actors.map((a) => a.class));
  assert.equal(shownClasses.size, 12, "one of every class should be present");
});

test("a filtered call returns actors, because the caller asked something specific", () => {
  const out = capActorList(bigLevel(), { classFilter: "BP_" });
  // 889 actors still arrive from the bridge; the filter is the engine's, and the point here is that
  // asking a specific question raises the budget rather than lowering it.
  assert.ok(out.actors.length > DEFAULT_UNFILTERED_ACTORS, "a specific question deserves a real answer");
});

test("a shared class is stated once instead of on every actor", () => {
  const actors = [];
  for (let i = 0; i < 30; i++) actors.push(actor(`Enemy${i}`, `BP_Enemy_C_${i}`, "BP_Enemy_C"));
  const out = capActorList({ actors, totalActors: 30 }, { classFilter: "BP_Enemy" });
  assert.equal(out.class, "BP_Enemy_C");
  assert.ok(
    out.actors.every((a) => a.class === undefined),
    "repeating one class name 30 times is 30 copies of the same fact"
  );
});

test("a mixed result keeps the class on each actor", () => {
  const actors = [actor("A", "A_0", "PointLight"), actor("B", "B_0", "SpotLight"), actor("C", "C_0", "PointLight")];
  const out = capActorList({ actors, totalActors: 3 }, { classFilter: "Light" });
  assert.equal(out.class, undefined);
  assert.ok(out.actors.every((a) => a.class));
});

test("label is never dropped as derivable from name", () => {
  // It looks redundant and is not: measured on a real level, only 12 of 889 labels could be derived,
  // because UE's label counter and name counter disagree - "PlayerStart2" is "PlayerStart_1".
  const out = capActorList({ actors: [actor("PlayerStart2", "PlayerStart_1", "PlayerStart")], totalActors: 1 });
  assert.equal(out.actors[0].label, "PlayerStart2");
  assert.equal(out.actors[0].name, "PlayerStart_1");
});

test("maxResults can be raised when the whole level is genuinely wanted", () => {
  const out = capActorList(bigLevel(), { maxResults: 5000 });
  assert.equal(out.actors.length, 889);
  assert.equal(out.truncated, undefined);
});

test("one rare Blueprint is not buried under five hundred common ones", () => {
  // The failure this guards: a level with 500 BP_Grass and one BP_Boss would spend every slot on
  // grass and never mention the boss, which is the one actor anybody asked about.
  const actors = [];
  for (let i = 0; i < 500; i++) actors.push(actor(`Grass${i}`, `G_${i}`, "BP_Grass_C", "/Game/BP_Grass.BP_Grass_C"));
  actors.push(actor("Boss", "Boss_0", "BP_Boss_C", "/Game/BP_Boss.BP_Boss_C"));
  const out = capActorList({ actors, totalActors: 501 });
  assert.ok(
    out.actors.some((a) => a.class === "BP_Boss_C"),
    "the one rare Blueprint must survive the cap"
  );
});

test("a Blueprint path shared by several actors is said once, keyed by class", () => {
  // Measured on the project's start level: forty actors carried fourteen distinct paths, and those
  // paths were 39% of the actors block against 736 characters for the class names beside them.
  const out = capActorList({
    actors: [
      actor("A", "BP_Turret_C_0", "BP_Turret_C", "/Game/Placeables/BP_Turret.BP_Turret_C"),
      actor("B", "BP_Turret_C_1", "BP_Turret_C", "/Game/Placeables/BP_Turret.BP_Turret_C"),
      actor("C", "BP_Turret_C_2", "BP_Turret_C", "/Game/Placeables/BP_Turret.BP_Turret_C"),
    ],
  });

  assert.deepEqual(out.blueprintByClass, {
    BP_Turret_C: "/Game/Placeables/BP_Turret.BP_Turret_C",
  });
  for (const a of out.actors) assert.equal(a.blueprint, undefined, "the repeated path is lifted");
});

test("the class stays on every row, because it is what identifies an actor", () => {
  // The reverse trade - dropping `class` and keeping `blueprint` - was measured and reverted at 38
  // tokens, because classFilter matches on class and callers assert on it. This must not undo that.
  const out = capActorList({
    actors: [
      actor("A", "BP_A_C_0", "BP_A_C", "/Game/A.BP_A_C"),
      actor("B", "BP_A_C_1", "BP_A_C", "/Game/A.BP_A_C"),
      actor("C", "BP_B_C_0", "BP_B_C", "/Game/B.BP_B_C"),
      actor("D", "BP_B_C_1", "BP_B_C", "/Game/B.BP_B_C"),
    ],
  });
  for (const a of out.actors) assert.ok(a.class, "every row still says its class");
});

test("two Blueprints generating the same class name keep their own paths", () => {
  // /Game/Red/BP_Thing and /Game/Blue/BP_Thing both produce a class called BP_Thing_C. The class
  // then does not identify the path, and a map keyed by it would be wrong for half the rows.
  const out = capActorList({
    actors: [
      actor("A", "BP_Thing_C_0", "BP_Thing_C", "/Game/Red/BP_Thing.BP_Thing_C"),
      actor("B", "BP_Thing_C_1", "BP_Thing_C", "/Game/Blue/BP_Thing.BP_Thing_C"),
    ],
  });

  assert.equal(out.blueprintByClass, undefined, "an ambiguous class is not lifted");
  assert.deepEqual(
    out.actors.map((a) => a.blueprint),
    ["/Game/Red/BP_Thing.BP_Thing_C", "/Game/Blue/BP_Thing.BP_Thing_C"]
  );
});

test("the only actor of its class keeps its path, because a map entry would only add a lookup", () => {
  const out = capActorList({
    actors: [
      actor("A", "BP_Solo_C_0", "BP_Solo_C", "/Game/Solo.BP_Solo_C"),
      actor("B", "BP_Pair_C_0", "BP_Pair_C", "/Game/Pair.BP_Pair_C"),
      actor("C", "BP_Pair_C_1", "BP_Pair_C", "/Game/Pair.BP_Pair_C"),
    ],
  });

  assert.deepEqual(Object.keys(out.blueprintByClass), ["BP_Pair_C"]);
  const solo = out.actors.find((a) => a.class === "BP_Solo_C");
  assert.equal(solo.blueprint, "/Game/Solo.BP_Solo_C", "said once either way, so left where it was");
});

test("actors with no Blueprint at all are untouched", () => {
  const out = capActorList({
    actors: [
      { label: "Light", name: "PointLight_0", class: "PointLight", location: "0,0,0" },
      { label: "Mesh", name: "StaticMeshActor_0", class: "StaticMeshActor", location: "1,1,1" },
    ],
  });
  assert.equal(out.blueprintByClass, undefined);
  assert.equal(out.actors.length, 2);
});
