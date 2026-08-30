/**
 * Niagara systems that cannot render anything.
 *
 * Deliberately narrow. A *disabled emitter* is not reported as a fault: turning one off is ordinary
 * authoring, and on the project this was measured against `NS_Wind_Swirl` has three of six disabled
 * on purpose. A check that fired on that would fire on every VFX project and be ignored on all of
 * them - the same trap the animation checks avoid by leaving single-state machines alone.
 *
 * What IS always wrong is a system that can produce nothing at all: no emitters, or every emitter
 * disabled. Both look like perfectly valid assets in the content browser, spawn without complaint,
 * and render nothing - so the Blueprint that spawns them looks correct too, and the bug presents as
 * "the effect doesn't play" with nothing anywhere to search for.
 */

export interface NiagaraEmitterLike {
  emitter: string;
  disabled?: boolean;
}

export interface NiagaraSystemLike {
  emitters?: NiagaraEmitterLike[];
  userParameters?: Array<{ parameter: string; type?: string }>;
}

export interface NiagaraFinding {
  check: string;
  severity: "warning" | "info";
  message: string;
  fix: string;
  observed?: string;
}

export function findNiagaraFaults(system: NiagaraSystemLike, assetName: string): NiagaraFinding[] {
  const emitters = system.emitters ?? [];

  if (emitters.length === 0) {
    return [
      {
        check: "niagara-system-empty",
        severity: "warning",
        message: `${assetName} has no emitters, so spawning it renders nothing.`,
        fix:
          `Add an emitter, or delete the system and remove whatever spawns it. As it stands the spawn call ` +
          `succeeds and produces nothing, which is why this reads as "the effect does not play" with no error ` +
          `to search for.`,
      },
    ];
  }

  const disabled = emitters.filter((e) => e.disabled);
  if (disabled.length === emitters.length) {
    return [
      {
        check: "niagara-all-emitters-disabled",
        severity: "warning",
        message: `${assetName}: all ${emitters.length} emitters are disabled, so spawning it renders nothing.`,
        fix: `Enable at least one emitter, or stop spawning this system.`,
        observed: `Disabled: ${disabled.map((e) => e.emitter).join(", ")}.`,
      },
    ];
  }

  // Some disabled and some not is ordinary authoring, and is deliberately NOT reported.
  return [];
}
