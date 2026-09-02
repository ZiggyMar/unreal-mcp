import { test } from "node:test";
import assert from "node:assert/strict";

import { findGameModeWiringFaults, isProjectClass } from "../dist/gameModeWiring.js";

// The five GameModes on a real project, exactly as read from their class defaults.
const PROJECT = [
  { name: "GM_Gameplay", defaultPawnClass: "/Game/.../BP_Player.BP_Player_C", gameStateClass: "/Game/.../GS_PlacementManager.GS_PlacementManager_C", playerControllerClass: "/Game/.../PC_Gameplay.PC_Gameplay_C" },
  { name: "GM_Lobby", defaultPawnClass: "/Game/.../BP_Player.BP_Player_C", gameStateClass: "/Game/.../GS_Lobby.GS_Lobby_C", playerControllerClass: "/Game/.../PC_Lobby.PC_Lobby_C" },
  { name: "BP_FirstPersonGameMode", defaultPawnClass: "/Game/.../BP_FirstPersonCharacter.BP_FirstPersonCharacter_C", playerControllerClass: "/Game/.../BP_FirstPersonController.BP_FirstPersonController_C" },
  { name: "GM_TutGameplay", gameStateClass: "/Game/.../GS_PlacementManager.GS_PlacementManager_C", playerControllerClass: "/Game/.../PC_Gameplay.PC_Gameplay_C" },
  { name: "GM_MainMenu", playerControllerClass: "/Game/.../PC_MainMenu.PC_MainMenu_C" },
];

test("only the GameMode that runs gameplay without a pawn is reported", () => {
  // Two of the five have no pawn and only one is a defect. GM_MainMenu is a menu - no gameplay, no
  // project GameState, nothing to possess - and flagging it would be the noise this project keeps
  // removing.
  const found = findGameModeWiringFaults(PROJECT);
  assert.equal(found.length, 1);
  assert.equal(found[0].blueprint, "GM_TutGameplay");
  assert.equal(found[0].check, "gamemode-has-no-pawn");
});

test("the finding says what was seen, and leaves room for the mode possessing pawns itself", () => {
  const [f] = findGameModeWiringFaults(PROJECT);
  assert.match(f.observed, /DefaultPawnClass is the engine default/);
  assert.match(f.message, /ADefaultPawn/);
  // A GameMode can spawn and possess pawns in its own graph, and then the default is never used.
  assert.match(f.fix, /spawns and possesses pawns itself/);
});

test("a GameMode with a pawn is never reported, whatever else it sets", () => {
  assert.deepEqual(findGameModeWiringFaults([PROJECT[0], PROJECT[1], PROJECT[2]]), []);
});

test("an engine class is not a project class", () => {
  assert.equal(isProjectClass("/Script/Engine.DefaultPawn"), false);
  assert.equal(isProjectClass(undefined), false);
  assert.equal(isProjectClass(""), false);
  assert.equal(isProjectClass("/Game/AVS/BP_Player.BP_Player_C"), true);
});
