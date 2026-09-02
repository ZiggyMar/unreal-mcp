/**
 * A GameMode that runs real gameplay and forgot to say what the player is.
 *
 * `DefaultPawnClass` decides what every joining player possesses. Left at the engine default it is
 * `ADefaultPawn` - the grey flying sphere with no mesh, no animation and no game logic - and nothing
 * warns, because a GameMode with an engine default is a perfectly valid GameMode. It surfaces as
 * "the tutorial spawns me as a floating ball", usually from a player rather than a test.
 *
 * ## Why this is not just "DefaultPawnClass is unset"
 *
 * Measured across this project's five GameModes:
 *
 *   GM_Gameplay              pawn BP_Player                 GS GS_PlacementManager
 *   GM_Lobby                 pawn BP_Player                 GS GS_Lobby
 *   BP_FirstPersonGameMode   pawn BP_FirstPersonCharacter   GS (engine default)
 *   GM_TutGameplay           pawn (engine default)          GS GS_PlacementManager
 *   GM_MainMenu              pawn (engine default)          GS (engine default)
 *
 * Two have no pawn and only one is a defect. `GM_MainMenu` is a menu: it has no gameplay, no project
 * GameState, and nothing to possess. Flagging it would be the noise this project keeps removing.
 *
 * The discriminator is the GameMode's OWN other choices. `GM_TutGameplay` picks a project GameState -
 * so it has replicated match state and is running real gameplay - and then leaves the pawn at the
 * engine's. That inconsistency is inside one asset, which is what makes it evidence rather than a
 * guess about intent.
 *
 * Reported as what was observed. A GameMode can spawn and possess pawns itself, and then the engine
 * default is never used; the finding says what it saw and names the property to look at.
 */

export interface GameModeDefaults {
  /** The Blueprint's own name, for the finding. */
  name: string;
  /** Resolved class for each slot, or undefined when the engine default is in place. */
  defaultPawnClass?: string;
  gameStateClass?: string;
  playerControllerClass?: string;
}

export interface GameModeFinding {
  check: "gamemode-has-no-pawn";
  severity: "warning";
  blueprint: string;
  message: string;
  observed: string;
  fix: string;
}

/** True when a class value points at something in the project rather than at an engine class. */
export function isProjectClass(value: string | undefined): boolean {
  if (!value || value.length === 0) return false;
  // `/Script/...` is native engine or plugin code. A project Blueprint lives under /Game.
  return value.includes("/Game/");
}

export function findGameModeWiringFaults(modes: GameModeDefaults[]): GameModeFinding[] {
  const findings: GameModeFinding[] = [];
  for (const mode of modes) {
    if (isProjectClass(mode.defaultPawnClass)) continue;
    // No project GameState means no evidence this GameMode runs gameplay at all - a menu, a loading
    // screen, a splash. Saying nothing is the right answer there.
    if (!isProjectClass(mode.gameStateClass)) continue;

    const alsoPicks = [
      isProjectClass(mode.gameStateClass) ? "a GameState" : "",
      isProjectClass(mode.playerControllerClass) ? "a PlayerController" : "",
    ].filter(Boolean);

    findings.push({
      check: "gamemode-has-no-pawn",
      severity: "warning",
      blueprint: mode.name,
      message:
        `${mode.name} chooses ${alsoPicks.join(" and ")} from this project but leaves ` +
        `DefaultPawnClass at the engine's, so every player who joins possesses ADefaultPawn - the ` +
        `grey flying sphere - unless something spawns and possesses one instead.`,
      observed:
        `DefaultPawnClass is the engine default; GameStateClass is ${mode.gameStateClass}` +
        `${mode.playerControllerClass ? `, PlayerControllerClass is ${mode.playerControllerClass}` : ""}.`,
      fix:
        `Set DefaultPawnClass to the character this mode is meant to play, or confirm the mode ` +
        `spawns and possesses pawns itself - in which case the engine default is never used and this ` +
        `is not a defect. unreal_read_class_defaults on the other GameModes shows what they set.`,
    });
  }
  return findings;
}
