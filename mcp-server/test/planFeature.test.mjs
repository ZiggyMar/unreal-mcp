import { test } from "node:test";
import assert from "node:assert/strict";

import { planFeature, extractConcepts } from "../dist/planFeature.js";

/** A project that already has a health system and nothing resembling stamina. */
const HITS = {
  health: [
    { kind: "variable", path: "/Game/BP/BP_Player.BP_Player", name: "Health", context: "float" },
    { kind: "blueprint", path: "/Game/UI/W_HealthBar.W_HealthBar", name: "W_HealthBar", context: "" },
  ],
  regen: [],
  stamina: [],
  sprint: [],
};

const REFS = {
  "/Game/BP/BP_Player": {
    referencedBy: Array.from({ length: 7 }, (_, i) => ({ package: `/Game/BP/BP_User${i}` })),
    dependsOn: [],
  },
  "/Game/UI/W_HealthBar": { referencedBy: [], dependsOn: [{ package: "/Game/BP/BP_Player" }] },
};

function fakeBridge(overrides = {}) {
  return {
    async send(cmd, params) {
      if (overrides[cmd]) return overrides[cmd](params);
      if (cmd === "search_project") {
        const hits = HITS[params.query] ?? [];
        return { query: params.query, hits, hitCount: hits.length, truncated: false };
      }
      if (cmd === "find_references") {
        const pkg = params.path.includes(".") ? params.path.slice(0, params.path.lastIndexOf(".")) : params.path;
        const e = REFS[pkg] ?? { referencedBy: [], dependsOn: [] };
        return {
          path: params.path,
          referencedBy: e.referencedBy,
          referencedByCount: e.referencedBy.length,
          dependsOn: e.dependsOn,
          dependsOnCount: e.dependsOn.length,
        };
      }
      if (cmd === "list_blueprints") {
        return {
          blueprints: [
            { name: "BP_Player", path: "/Game/BP/BP_Player.BP_Player", parentClass: "Character" },
            { name: "BP_Enemy", path: "/Game/BP/BP_Enemy.BP_Enemy", parentClass: "Character" },
            { name: "BP_Door", path: "/Game/BP/BP_Door.BP_Door", parentClass: "Actor" },
            { name: "W_HealthBar", path: "/Game/UI/W_HealthBar.W_HealthBar", parentClass: "UserWidget" },
            { name: "W_Menu", path: "/Game/UI/W_Menu.W_Menu", parentClass: "UserWidget" },
          ],
          count: 5,
        };
      }
      if (cmd === "get_project_overview") {
        return {
          blueprintCount: 5,
          totalFunctions: 12,
          totalVariables: 20,
          totalGraphs: 9,
          totalNodes: 200,
          folders: [{ folder: "/Game/BP", count: 3 }, { folder: "/Game/UI", count: 2 }],
          byParentClass: [{ parentClass: "Character", count: 2 }, { parentClass: "Actor", count: 1 }],
          assetRegistryStillScanning: false,
        };
      }
      throw new Error(`unexpected ${cmd}`);
    },
  };
}

test("concept extraction keeps the subject and drops the filler", () => {
  const concepts = extractConcepts("Please can you add a new health regen system for me");
  assert.ok(concepts.includes("health"));
  assert.ok(concepts.includes("regen"));
  for (const filler of ["please", "add", "new", "system", "for"]) {
    assert.ok(!concepts.includes(filler), `"${filler}" should have been dropped`);
  }
});

test("plurals collapse onto one concept", () => {
  const concepts = extractConcepts("add pickups and pickup sounds");
  assert.equal(concepts.filter((c) => c === "pickup").length, 1);
});

test("an existing system is raised with the user rather than duplicated", async () => {
  const plan = await planFeature(fakeBridge(), "add a health regen system");

  const health = plan.existingSystems.find((s) => s.concept === "health");
  assert.ok(health, `health should be found; got ${JSON.stringify(plan.existingSystems)}`);
  assert.ok(health.keyAssets.includes("BP_Player"));

  // This sentence is the entire point of the tool.
  assert.ok(
    plan.raiseWithUser.some((r) => r.includes("already exists") && r.includes("health")),
    `expected a "you already have this" warning, got ${JSON.stringify(plan.raiseWithUser)}`
  );
});

test("a genuinely new concept is reported as new work, not as a conflict", async () => {
  const plan = await planFeature(fakeBridge(), "add a stamina sprint system");
  assert.ok(plan.newWork.includes("stamina"));
  assert.deepEqual(plan.existingSystems, []);
  assert.ok(
    !plan.raiseWithUser.some((r) => r.includes("already exists")),
    "nothing collides, so nothing should be reported as a duplicate"
  );
});

test("only direct matches count as existing, so the tool does not cry wolf", async () => {
  // W_HealthBar depends on BP_Player, so BP_Player appears in the "regen" map only as a
  // neighbour. Reporting a neighbour as a duplicate would make every request look like a
  // conflict, and a model would learn to ignore the warnings.
  const neighbourOnly = fakeBridge({
    search_project: (params) => ({
      query: params.query,
      hits: params.query === "regen" ? [] : HITS[params.query] ?? [],
      hitCount: 0,
      truncated: false,
    }),
  });
  const plan = await planFeature(neighbourOnly, "add regen");
  assert.ok(plan.newWork.includes("regen"));
});

test("blast radius is raised separately from existence", async () => {
  const plan = await planFeature(fakeBridge(), "change health");
  assert.ok(
    plan.raiseWithUser.some((r) => r.includes("affects assets outside")),
    `expected a blast-radius warning, got ${JSON.stringify(plan.raiseWithUser)}`
  );
});

test("the project's own conventions are reported, so new work matches the old", async () => {
  const plan = await planFeature(fakeBridge(), "add stamina");
  assert.ok(plan.conventions.namingPrefixes.some((p) => p.startsWith("BP_")));
  assert.ok(plan.conventions.namingPrefixes.some((p) => p.startsWith("W_")));
  assert.ok(plan.conventions.folders.some((f) => f.includes("/Game/UI")));
  assert.ok(plan.conventions.commonParentClasses.some((c) => c.includes("Character")));
});

test("a request with no concrete nouns asks the user instead of guessing", async () => {
  const plan = await planFeature(fakeBridge(), "please can you make it better");
  assert.deepEqual(plan.conceptsExamined, []);
  assert.match(plan.raiseWithUser[0], /Ask the user/);
});

test("when nothing matches, it asks whether the project names it differently", async () => {
  // The dangerous reading of "nothing found" is "therefore build it". A project that calls
  // stamina "Endurance" would get a second system, which is the exact failure this prevents,
  // and no stopword list can tell the two cases apart.
  const plan = await planFeature(fakeBridge(), "add stamina");
  assert.ok(
    plan.raiseWithUser.some((r) => r.includes("names it differently")),
    `expected a naming check, got ${JSON.stringify(plan.raiseWithUser)}`
  );
  assert.ok(plan.newWork.includes("stamina"));
});

test("a still-scanning registry is flagged, because 'new work' might be wrong", async () => {
  const scanning = fakeBridge({
    get_project_overview: () => ({
      blueprintCount: 0,
      folders: [],
      byParentClass: [],
      assetRegistryStillScanning: true,
    }),
  });
  const plan = await planFeature(scanning, "add stamina");
  assert.ok(plan.notes.some((n) => n.includes("still scanning")));
});

test("the suggested order puts reading and confirming ahead of building", async () => {
  const plan = await planFeature(fakeBridge(), "add health regen");
  assert.match(plan.suggestedOrder[0], /Read the existing work first/);
  assert.ok(plan.suggestedOrder.some((s) => /Confirm with the user/.test(s)));
});

test("planning never writes anything", async () => {
  const calls = [];
  const watched = {
    async send(cmd, params) {
      calls.push(cmd);
      return fakeBridge().send(cmd, params);
    },
  };
  await planFeature(watched, "add a health regen system");
  const writes = calls.filter(
    (c) => !["search_project", "find_references", "list_blueprints", "get_project_overview"].includes(c)
  );
  assert.deepEqual(writes, [], `planning must be read-only; it called ${writes.join(", ")}`);
});

test("a plan that finds an existing system asks whether it still runs", async () => {
  // "Already exists" and "already exists and is dead" lead to opposite plans. Told a system exists,
  // a plan extends it - and extending something nothing calls produces a feature that cannot run,
  // built carefully on top of code that was replaced and left on the canvas.
  //
  // Measured on the real project: "add a countdown before the wave starts" reports the countdown
  // system across GM_Gameplay, GS_Gameplay and WBP_HUD and names ShowCountdown among the assets to
  // read. Nothing anywhere calls ShowCountdown, UpdateCountdown or HideCountdown.
  const plan = await planFeature(fakeBridge(), "add a health bar");
  assert.ok(plan.existingSystems.length > 0, "the fixture must actually find something to extend");
  const asked = plan.raiseWithUser.some((r) => /trace_function_calls/.test(r));
  assert.ok(asked, `expected a liveness question; got ${JSON.stringify(plan.raiseWithUser).slice(0, 300)}`);
});

test("a plan that finds nothing existing does not ask", async () => {
  // The question is about EXTENDING something. On a genuinely new feature it would be noise, and a
  // warning that appears on every reply stops being read.
  //
  // Written properly on the second attempt: the first version of this test was `assert.ok(true)`,
  // which is the vacuous guard this repo refuses everywhere else.
  const plan = await planFeature(fakeBridge(), "add a stamina sprint system");
  assert.equal(plan.existingSystems.length, 0, "the fixture must find nothing for this to be the case under test");
  assert.ok(
    !plan.raiseWithUser.some((r) => /trace_function_calls/.test(r)),
    `nothing exists to be dead, so nothing should be asked: ${JSON.stringify(plan.raiseWithUser).slice(0, 200)}`
  );
});
