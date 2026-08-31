import { test } from "node:test";
import assert from "node:assert/strict";

import { mapSystem, matchesAsWord } from "../dist/systemMap.js";

/**
 * A fake project: a health system spread over five Blueprints, the shape that makes a real
 * project impossible to explain to a model.
 *
 *   BP_Player  ---uses--->  BPI_Damageable  <---uses---  BP_Enemy
 *   W_HealthBar ---uses---> BP_Player
 *   BP_HealthPickup ---uses---> BPI_Damageable
 */
const PROJECT = {
  search: {
    health: [
      { kind: "blueprint", path: "/Game/UI/W_HealthBar.W_HealthBar", name: "W_HealthBar", context: "" },
      { kind: "variable", path: "/Game/BP/BP_Player.BP_Player", name: "Health", context: "float" },
      { kind: "function", path: "/Game/BP/BP_Enemy.BP_Enemy", name: "ApplyHealthChange", context: "" },
    ],
  },
  references: {
    "/Game/UI/W_HealthBar": { referencedBy: [], dependsOn: [{ package: "/Game/BP/BP_Player" }] },
    "/Game/BP/BP_Player": {
      referencedBy: [{ package: "/Game/UI/W_HealthBar" }, { package: "/Game/BP/BP_GameMode" }],
      dependsOn: [{ package: "/Game/BP/BPI_Damageable" }],
    },
    "/Game/BP/BP_Enemy": {
      referencedBy: [{ package: "/Game/BP/BP_Spawner" }],
      dependsOn: [{ package: "/Game/BP/BPI_Damageable" }],
    },
    "/Game/BP/BPI_Damageable": {
      referencedBy: [
        { package: "/Game/BP/BP_Player" },
        { package: "/Game/BP/BP_Enemy" },
        { package: "/Game/BP/BP_HealthPickup" },
        { package: "/Game/BP/BP_Trap" },
        { package: "/Game/BP/BP_Explosive" },
        { package: "/Game/BP/BP_Turret" },
      ],
      dependsOn: [],
    },
  },
  blueprints: [
    { name: "BP_Player", path: "/Game/BP/BP_Player.BP_Player", parentClass: "Character" },
    { name: "BP_Enemy", path: "/Game/BP/BP_Enemy.BP_Enemy", parentClass: "Character" },
    { name: "W_HealthBar", path: "/Game/UI/W_HealthBar.W_HealthBar", parentClass: "UserWidget" },
    { name: "BPI_Damageable", path: "/Game/BP/BPI_Damageable.BPI_Damageable", parentClass: "Interface" },
  ],
};

function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd, params) {
      calls.push({ cmd, params });
      if (overrides[cmd]) return overrides[cmd](params);
      if (cmd === "search_project") {
        const hits = PROJECT.search[params.query] ?? [];
        return { query: params.query, hits, hitCount: hits.length, truncated: false };
      }
      if (cmd === "find_references") {
        const pkg = params.path.includes(".") ? params.path.slice(0, params.path.lastIndexOf(".")) : params.path;
        const entry = PROJECT.references[pkg] ?? { referencedBy: [], dependsOn: [] };
        return {
          path: params.path,
          referencedBy: entry.referencedBy,
          referencedByCount: entry.referencedBy.length,
          dependsOn: entry.dependsOn,
          dependsOnCount: entry.dependsOn.length,
        };
      }
      if (cmd === "list_blueprints") return { blueprints: PROJECT.blueprints, count: PROJECT.blueprints.length };
      throw new Error(`unexpected ${cmd}`);
    },
  };
}

const names = (map) => map.assets.map((a) => a.name);

test("a concept spread over several Blueprints comes back as one connected system", async () => {
  const map = await mapSystem(fakeBridge(), "health");

  // The three direct matches, plus what they are wired to. This is the thing a user cannot
  // explain to a chatbot: that these five assets are one system.
  for (const expected of ["W_HealthBar", "BP_Player", "BP_Enemy", "BPI_Damageable"]) {
    assert.ok(names(map).includes(expected), `${expected} missing from ${names(map).join(", ")}`);
  }
  assert.equal(map.seeds.length, 3);
});

test("every asset says why it is in the map", async () => {
  const map = await mapSystem(fakeBridge(), "health");
  for (const asset of map.assets) {
    assert.ok(asset.reasons.length > 0, `${asset.name} has no reason`);
    assert.ok(asset.reasons[0].length > 5);
  }
  const player = map.assets.find((a) => a.name === "BP_Player");
  assert.ok(
    player.reasons.some((r) => r.includes("variable")),
    `a variable match should say so, got: ${player.reasons.join(" | ")}`
  );
});

test("direct matches rank above things merely connected to them", async () => {
  const map = await mapSystem(fakeBridge(), "health");
  const seedNames = map.seeds.map((s) => s.slice(s.lastIndexOf("/") + 1));
  const firstThree = names(map).slice(0, 3);
  for (const seed of seedNames) {
    assert.ok(firstThree.includes(seed), `seed ${seed} should rank first, order was ${names(map).join(", ")}`);
  }
});

test("edges record the direction of the dependency", async () => {
  const map = await mapSystem(fakeBridge(), "health");
  const hasEdge = (from, to) => map.edges.some((e) => e.from === from && e.to === to);
  assert.ok(hasEdge("/Game/UI/W_HealthBar", "/Game/BP/BP_Player"), "the widget uses the player");
  assert.ok(hasEdge("/Game/BP/BP_Player", "/Game/BP/BPI_Damageable"), "the player uses the interface");
  // Self-edges would be noise.
  assert.ok(!map.edges.some((e) => e.from === e.to));
});

test("the widely-used interface is flagged as risky to change", async () => {
  const map = await mapSystem(fakeBridge(), "health");
  assert.ok(
    map.highRisk.some((r) => r.includes("BPI_Damageable")),
    `expected the interface in highRisk, got ${JSON.stringify(map.highRisk)}`
  );
  assert.ok(map.notes.some((n) => n.includes("outside this system")));
});

test("reading order puts the most depended-on asset first", async () => {
  const map = await mapSystem(fakeBridge(), "health");
  // The interface defines the contract the rest obey; reading a leaf first means re-reading it.
  assert.match(map.readingOrder[0], /BPI_Damageable/);
});

test("engine and plugin assets are kept out of the map", async () => {
  const bridge = fakeBridge({
    search: undefined,
    find_references: undefined,
  });
  const withEngine = fakeBridge({
    find_references: (params) => ({
      path: params.path,
      referencedBy: [{ package: "/Engine/SomeEngineThing" }, { package: "/Game/BP/BP_Real" }],
      referencedByCount: 2,
      dependsOn: [],
      dependsOnCount: 0,
    }),
  });
  const map = await mapSystem(withEngine, "health");
  assert.ok(!names(map).some((n) => n === "SomeEngineThing"), "engine content is noise in a system map");
  assert.ok(names(map).includes("BP_Real"));
  assert.ok(bridge.calls.length === 0);
});

test("a concept that does not exist says so, instead of returning an empty map", async () => {
  const map = await mapSystem(fakeBridge(), "teleportation");
  assert.deepEqual(map.assets, []);
  assert.equal(map.notes.length, 1);
  assert.match(map.notes[0], /does not exist yet, or it is named differently/);
});

test("the map is capped, and says so rather than pretending to be complete", async () => {
  const wide = fakeBridge({
    find_references: (params) => ({
      path: params.path,
      referencedBy: Array.from({ length: 40 }, (_, i) => ({ package: `/Game/Gen/BP_Gen${i}` })),
      referencedByCount: 40,
      dependsOn: [],
      dependsOnCount: 0,
    }),
  });
  const map = await mapSystem(wide, "health", { maxAssets: 10 });
  assert.equal(map.assets.length, 10);
  assert.equal(map.truncated, true);
  assert.ok(map.notes.some((n) => n.includes("larger than the map")));
});

test("one unreadable asset does not abandon the whole map", async () => {
  let calls = 0;
  const flaky = fakeBridge({
    find_references: (params) => {
      calls++;
      if (calls === 1) throw new Error("asset_load_failed");
      return { path: params.path, referencedBy: [{ package: "/Game/BP/BP_Still" }], referencedByCount: 1, dependsOn: [], dependsOnCount: 0 };
    },
  });
  const map = await mapSystem(flaky, "health");
  assert.ok(map.assets.length > 1, "the rest of the system should still be mapped");
});

test("parent classes are attached, so the map says what kind of thing each asset is", async () => {
  const map = await mapSystem(fakeBridge(), "health");
  const player = map.assets.find((a) => a.name === "BP_Player");
  assert.equal(player.parentClass, "Character");
});

test("no graph is ever read: the map must stay cheap", async () => {
  const bridge = fakeBridge();
  await mapSystem(bridge, "health");
  const expensive = bridge.calls.filter((c) =>
    ["read_blueprint_graph_summary", "read_blueprint_node_detail"].includes(c.cmd)
  );
  assert.deepEqual(expensive, [], "the map is what you consult BEFORE deciding what to read");
});

test("many similar reasons collapse into one sentence", async () => {
  // Measured on a real project: one asset carried twenty-four reasons, sixteen of them
  // "has variable <name> matching vacuum". That is the payload being mostly repetition of its own
  // field names, priced per call.
  const hit = (kind, name) => ({ path: "/Game/BP_Vacuum", name, kind });
  const bridge = fakeBridge({
    search_project: () => ({
      hits: [
        { path: "/Game/BP_Vacuum", name: "BP_Vacuum", kind: "blueprint" },
        hit("function", "VacuumObjects"),
        hit("function", "VacuumPush"),
        hit("function", "GetVacuumable"),
        hit("function", "VacuumTick"),
        hit("variable", "VacuumTimer"),
        hit("variable", "BaseVacuumStrength"),
        hit("variable", "VacuumAngle"),
        hit("variable", "VacuumSize"),
        hit("variable", "VacuumSpeed"),
      ],
    }),
  });
  const map = await mapSystem(bridge, "vacuum");
  const node = map.assets.find((a) => a.name === "BP_Vacuum");
  assert.ok(node, "the asset was not mapped");
  assert.ok(node.summary, `no summary produced from ${JSON.stringify(node.reasons)}`);
  // Named examples plus a count, rather than one line per match.
  assert.match(node.summary, /4 matching function\(s\)/);
  assert.match(node.summary, /5 matching variable\(s\)/);
  assert.match(node.summary, /and \d+ more/);
  assert.ok(
    node.summary.length < JSON.stringify(node.reasons).length,
    "the summary is not smaller than the reasons it replaces"
  );
});

test("the prose form is dramatically cheaper than the structure", async () => {
  const bridge = fakeBridge({
    search_project: () => ({
      hits: Array.from({ length: 10 }, (_, i) => ({
        path: `/Game/BP_Thing${i}`,
        name: `BP_Thing${i}`,
        kind: "blueprint",
      })),
    }),
  });
  const map = await mapSystem(bridge, "thing");
  assert.ok(map.text, "no text form");
  const ratio = JSON.stringify(map).length / map.text.length;
  assert.ok(ratio > 2, `expected the prose to be much smaller, got ${ratio.toFixed(1)}x`);
});

test("the prose names the assets and how to read them", async () => {
  const bridge = fakeBridge({
    search_project: () => ({
      hits: [{ path: "/Game/BP_Core", name: "BP_Core", kind: "blueprint" }],
    }),
  });
  const map = await mapSystem(bridge, "core");
  assert.match(map.text, /BP_Core/);
  assert.match(map.text, /asset\(s\)/);
});

test("a map that names functions warns that the system may be the dead one", async () => {
  // This is the tool a plain-text bug report lands on, and it answered "what is this system made
  // of" without ever asking whether the system still runs. That gap cost this project an entire
  // iteration: a skin system found, read and modified before anyone noticed a newer one had replaced
  // it, the old graphs still on the canvas and still compiling. The fixture's health system includes
  // ApplyHealthChange, so the warning applies.
  const map = await mapSystem(fakeBridge(), "health");
  assert.match(map.text, /unreal_trace_function_calls/);
  assert.match(map.text, /replaced and left/);
});

test("a map with no functions in it does not carry the warning", async () => {
  // The advice is about functions. Putting it on a variables-only map would be noise on every reply,
  // which is how a warning stops being read.
  // fakeBridge takes per-command overrides, so the search is replaced rather than the fixture.
  const map = await mapSystem(
    fakeBridge({
      search_project: (params) => {
        const hits = PROJECT.search.health.filter((h) => h.kind !== "function");
        return { query: params.query, hits, hitCount: hits.length, truncated: false };
      },
    }),
    "health"
  );
  assert.doesNotMatch(map.text, /unreal_trace_function_calls/);
});

test("a texture pulled in as a dependency is not part of the system", async () => {
  // Found by asking the map a real question on a real project. "the countdown never shows up"
  // returned, THIRD AND FOURTH in the recommended reading order, two assets called "14" and "5" -
  // genuine assets at /Game/ThirdParty/XP/14 and /5, both Texture2D, in the map only because
  // GM_Gameplay happens to reference them. A model following that order opens a texture before it
  // opens BP_Player.
  //
  // A system map answers "what makes this work and what would I break". A texture has no behaviour,
  // so reading one cannot answer either question - and the reading order is capped, so every slot it
  // takes displaces something that could.
  //
  // The first version of this test passed while testing nothing: it tried to inject a fixture the
  // fake bridge does not read, so the texture was never in the map to be dropped. Overriding the
  // command is the mechanism that actually works.
  const map = await mapSystem(
    fakeBridge({
      find_references: (params) => {
        const isPlayer = params.path.includes("BP_Player");
        return {
          path: params.path,
          referencedBy: [],
          referencedByCount: 0,
          dependsOn: isPlayer
            ? [
                { package: "/Game/BP/BPI_Damageable", assetClass: "Blueprint" },
                { package: "/Game/Art/HealthIcon", assetClass: "Texture2D" },
                { package: "/Game/Audio/HealthLow", assetClass: "SoundCue" },
              ]
            : [],
          dependsOnCount: isPlayer ? 3 : 0,
        };
      },
    }),
    "health"
  );
  const names = (map.assets ?? []).map((a) => a.name);
  assert.ok(names.includes("BP_Player"), "the fixture must actually reach BP_Player, or this tests nothing");
  assert.ok(names.includes("BPI_Damageable"), "a Blueprint dependency is still part of the system");
  assert.ok(!names.includes("HealthIcon"), "a Texture2D dependency is not");
  assert.ok(!names.includes("HealthLow"), "nor is a SoundCue");
});

test("a texture that MATCHES the query is kept, because that is a real question", async () => {
  // The limit on the rule. "the explosion sound" and "the health bar material" are things people
  // actually ask about, so an asset that matched on its own account stays whatever its class - only
  // ones dragged in as a dependency are dropped.
  const map = await mapSystem(
    fakeBridge({
      search_project: () => ({
        query: "health",
        hits: [{ kind: "asset", path: "/Game/Art/HealthIcon.HealthIcon", name: "HealthIcon", context: "" }],
        hitCount: 1,
        truncated: false,
      }),
      find_references: (params) => ({
        path: params.path,
        referencedBy: [],
        referencedByCount: 0,
        dependsOn: [],
        dependsOnCount: 0,
      }),
    }),
    "health"
  );
  const icon = (map.assets ?? []).find((a) => a.name === "HealthIcon");
  assert.ok(icon, "an asset that matched the query by name is part of the answer");
});

test("a concept matches a word, not a substring inside one", () => {
  // Asking plan_feature for "a stamina bar" produced, in raiseWithUser:
  //   "bar" already exists in this project: BP_DummyTurret, BP_MomBase, BP_Turret and 9 more.
  //
  // BP_DummyTurret is there because it has a variable called TurretBarrelLoc. That claim lands in
  // the one field whose purpose is to stop a model and make it ask the user - so a false one buys a
  // pointless question, or a refusal to build something the project does not have.
  //
  // Every string here is real, taken from the project this was found on.
  assert.equal(matchesAsWord("TurretBarrelLoc", "bar"), false, "Barrel is not a bar");
  assert.equal(matchesAsWord("BP_Turret", "bar"), false);

  assert.equal(matchesAsWord("WBP_DataBar", "bar"), true);
  assert.equal(matchesAsWord("UpdateHealBar", "bar"), true);
  assert.equal(matchesAsWord("EnergyRadialBar", "bar"), true);
  assert.equal(matchesAsWord("ChangeSectionBarColour", "bar"), true, "a word in the middle still counts");
});

test("a plural answers the singular question", () => {
  // "do we have a bar" is answered by a variable called DataBars. Refusing that would trade one kind
  // of false negative for another.
  assert.equal(matchesAsWord("DataBars", "bar"), true);
  assert.equal(matchesAsWord("Enemies", "enemy"), false, "but only regular plurals - this is not a stemmer");
  assert.equal(matchesAsWord("Boxes", "box"), true);
});

test("runs of capitals split where a human would split them", () => {
  // WBP_HUDBar is WBP / HUD / Bar, not WBPHUDB / ar. Getting this wrong loses real matches on a
  // project whose naming is full of prefixes like WBP_, BP_, ABP_ and GS_.
  assert.equal(matchesAsWord("WBP_HUDBar", "bar"), true);
  assert.equal(matchesAsWord("HUDBar", "hud"), true);
  assert.equal(matchesAsWord("BP_PlayerHealth", "health"), true);
});

test("the concept itself, alone, matches", () => {
  assert.equal(matchesAsWord("Bar", "bar"), true);
  assert.equal(matchesAsWord("bar", "bar"), true);
  assert.equal(matchesAsWord("", "bar"), false);
  assert.equal(matchesAsWord("Bar", ""), false, "an empty concept matches nothing, rather than everything");
});

test("a derived form is part of the system, which is why the rule is not just equality", () => {
  // GetVacuumable IS part of the vacuum system, and BPI_Damageable is how half of Unreal names an
  // interface. A rule strict enough to reject "Barrel" must still accept these - and the first
  // version did not, which an existing test caught because its fixture happened to contain
  // GetVacuumable.
  //
  // The distinguishing fact is not prefix-ness: "bar" is a prefix of "barrel" exactly as "vacuum" is
  // of "vacuumable". It is that -able builds a word from another and -rel does not.
  assert.equal(matchesAsWord("GetVacuumable", "vacuum"), true);
  assert.equal(matchesAsWord("BPI_Damageable", "damage"), true);
  assert.equal(matchesAsWord("SpawnerSettings", "spawn"), true);
  assert.equal(matchesAsWord("TurretBarrelLoc", "bar"), false, "and Barrel is still not a bar");
  assert.equal(matchesAsWord("Barrier", "bar"), false);
});

test("a trailing index is not part of the word", () => {
  // BP_Thing0, WBP_HUD2 and BP_Player3 are ordinary Unreal names, and a rule that reads "Thing0" as
  // one word loses every one of them.
  assert.equal(matchesAsWord("BP_Thing0", "thing"), true);
  assert.equal(matchesAsWord("WBP_HUD2", "hud"), true);
  assert.equal(matchesAsWord("BP_Player3", "player"), true);
});
