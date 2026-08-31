/**
 * Check a feature request against the project that already exists, before building anything.
 *
 * The behaviour people actually want is not a code generator, it is a competent colleague: you say
 * "add a stamina system", and before touching anything they come back with "you already have a
 * stamina variable on BP_Player and a HUD bar reading it - do you want me to extend that, or did
 * you mean something else?". That one exchange is worth more than any amount of generated graph,
 * because the alternative is a second stamina system quietly competing with the first.
 *
 * A model cannot do that from a chat window: it does not know what is in the project. This closes
 * that gap using only index reads, so the check costs a fraction of one Blueprint read and there is
 * no excuse to skip it.
 *
 * What this does NOT do is design the feature. Judgement is the model's job. This supplies the
 * facts the model cannot otherwise have: what exists, what it would collide with, what the project's
 * own conventions are, and which questions are worth asking a human before starting.
 */

import type { BridgeLike } from "./autoLayout.js";
import { mapSystem, type SystemMap } from "./systemMap.js";
import type { GetProjectOverviewResult, ListBlueprintsResult } from "./types.js";

/** Words that carry no project meaning, so mapping them wastes a round trip and returns noise. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "to", "for", "of", "in", "on", "at",
  "by", "with", "from", "up", "down", "out", "add", "make", "create", "build", "implement", "new",
  "system", "feature", "want", "need", "should", "would", "like", "can", "please", "me", "my",
  "i", "it", "its", "this", "that", "these", "those", "when", "where", "how", "some", "any",
  "have", "has", "had", "do", "does", "did", "be", "is", "are", "was", "were", "will", "just",
  "also", "there", "their", "them", "they", "he", "she", "we", "you", "your", "our",
  "better", "faster", "nicer", "good", "best", "more", "less", "very", "really", "thing", "stuff",
]);

export interface ExistingSystem {
  concept: string;
  assetCount: number;
  /** The assets most central to it, by name, so the model can name them back to the user. */
  keyAssets: string[];
  highRisk: string[];
  readingOrder: string[];
}

export interface ProjectConventions {
  /** Prefixes the project actually uses, most common first, e.g. "BP_ (42)". */
  namingPrefixes: string[];
  /** Content folders in use, so new assets land where the project already puts things. */
  folders: string[];
  /** Parent classes the project builds on, so a new actor matches the house style. */
  commonParentClasses: string[];
}

export interface FeaturePlan {
  request: string;
  conceptsExamined: string[];
  /** Systems that already exist and should be extended rather than duplicated. */
  existingSystems: ExistingSystem[];
  /** Things worth raising with the user BEFORE building. The whole point of the tool. */
  raiseWithUser: string[];
  /** Concepts with nothing in the project behind them: genuinely new work. */
  newWork: string[];
  conventions: ProjectConventions;
  suggestedOrder: string[];
  notes: string[];
}

/** Pull the words worth looking up out of a plain-English request. */
export function extractConcepts(request: string, limit = 6): string[] {
  const words = request
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));

  // Keep first occurrence order: the earlier words in a request are usually the subject.
  const seen = new Set<string>();
  const concepts: string[] = [];
  for (const word of words) {
    const singular = word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word;
    if (seen.has(singular)) continue;
    seen.add(singular);
    concepts.push(singular);
    if (concepts.length >= limit) break;
  }
  return concepts;
}

/** What does this project call things? New work should look like the work already there. */
async function readConventions(bridge: BridgeLike, notes: string[]): Promise<ProjectConventions> {
  const conventions: ProjectConventions = { namingPrefixes: [], folders: [], commonParentClasses: [] };

  try {
    const listed = await bridge.send<ListBlueprintsResult>("list_blueprints", {});
    const prefixCounts = new Map<string, number>();
    for (const bp of listed.blueprints ?? []) {
      const match = bp.name.match(/^([A-Za-z]{1,4}_)/);
      if (!match) continue;
      prefixCounts.set(match[1], (prefixCounts.get(match[1]) ?? 0) + 1);
    }
    conventions.namingPrefixes = [...prefixCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([prefix, count]) => `${prefix} (${count})`);
  } catch {
    notes.push("Could not read the Blueprint list, so naming conventions are unknown. Ask the user rather than inventing one.");
  }

  try {
    const overview = await bridge.send<GetProjectOverviewResult>("get_project_overview", {});
    conventions.folders = (overview.folders ?? []).slice(0, 8).map((f: { folder?: string; name?: string; count?: number }) =>
      `${f.folder ?? f.name}${f.count !== undefined ? ` (${f.count})` : ""}`
    );
    conventions.commonParentClasses = (overview.byParentClass ?? [])
      .slice(0, 6)
      .map((p: { parentClass?: string; name?: string; count?: number }) =>
        `${p.parentClass ?? p.name}${p.count !== undefined ? ` (${p.count})` : ""}`
      );
    if (overview.assetRegistryStillScanning) {
      notes.push(
        "The asset registry is still scanning, so this plan may miss parts of the project. Anything reported as " +
          "new work should be re-checked once scanning finishes."
      );
    }
  } catch {
    notes.push("Could not read the project overview, so folder and parent-class conventions are unknown.");
  }

  return conventions;
}

export async function planFeature(
  bridge: BridgeLike,
  request: string,
  options: { concepts?: string[] } = {}
): Promise<FeaturePlan> {
  const notes: string[] = [];
  const concepts = options.concepts?.length ? options.concepts : extractConcepts(request);

  if (concepts.length === 0) {
    return {
      request,
      conceptsExamined: [],
      existingSystems: [],
      raiseWithUser: [
        "This request has no concrete nouns to check against the project. Ask the user what the feature should " +
          "actually be called or which existing thing it relates to, rather than guessing.",
      ],
      newWork: [],
      conventions: { namingPrefixes: [], folders: [], commonParentClasses: [] },
      suggestedOrder: [],
      notes,
    };
  }

  const existingSystems: ExistingSystem[] = [];
  /** Concepts that already exist, so the liveness question can be asked once for all of them. */
  const conceptsToCheck: string[] = [];
  const newWork: string[] = [];
  const raiseWithUser: string[] = [];

  for (const concept of concepts) {
    let map: SystemMap;
    try {
      map = await mapSystem(bridge, concept, { maxAssets: 12, depth: 1 });
    } catch {
      notes.push(`Could not map "${concept}"; treat it as unknown rather than as new work.`);
      continue;
    }

    if (map.assets.length === 0) {
      newWork.push(concept);
      continue;
    }

    // Only assets that matched the concept directly count as "this already exists". Everything
    // else in the map is just a neighbour, and reporting neighbours as duplicates would make the
    // tool cry wolf until the model stopped listening.
    const direct = map.assets.filter((a) => a.distance === 0);
    if (direct.length === 0) {
      newWork.push(concept);
      continue;
    }

    existingSystems.push({
      concept,
      assetCount: map.assets.length,
      keyAssets: direct.slice(0, 5).map((a) => a.name),
      highRisk: map.highRisk,
      readingOrder: map.readingOrder.slice(0, 4),
    });

    raiseWithUser.push(
      `"${concept}" already exists in this project: ${direct.slice(0, 3).map((a) => a.name).join(", ")}` +
        `${direct.length > 3 ? ` and ${direct.length - 3} more` : ""}. Extend it rather than adding a second one, ` +
        `and confirm with the user if their request implies replacing it.`
    );

    // "Already exists" and "already exists and is dead" lead to opposite plans.
    //
    // This is the same gap map_system had, and it matters more here. Told a system exists, a plan
    // extends it - and extending something nothing calls produces a feature that cannot run, built
    // carefully on top of code that was replaced and left on the canvas.
    //
    // Measured on the real project: "add a countdown before the wave starts" reports the countdown
    // system across GM_Gameplay, GS_Gameplay and WBP_HUD, naming ShowCountdown among the assets to
    // read - and nothing anywhere calls ShowCountdown, UpdateCountdown or HideCountdown.
    //
    // Deciding it here would mean reading every graph in the project, which this tool does not do,
    // so it names the call that settles it - ONCE, after the loop, however many concepts matched.
    // A request like "add a countdown before the wave starts" examines three of them, and three
    // copies of one paragraph is the per-row boilerplate this repo removes everywhere else.
    conceptsToCheck.push(concept);

    if (map.highRisk.length > 0) {
      raiseWithUser.push(
        `Changing ${map.highRisk.join(", ")} affects assets outside the "${concept}" system. Prefer adding to ` +
          `these over altering what is already there, and say so before doing either.`
      );
    }
  }

  // Nothing matched anything. That is either genuinely new work or, just as often, the project
  // calls it something else - and the difference matters enormously, because building a second
  // system under a different name is the exact failure this tool exists to prevent. A stopword
  // list can never settle it; asking can.
  if (existingSystems.length === 0 && newWork.length > 0) {
    raiseWithUser.push(
      `None of ${newWork.map((c) => `"${c}"`).join(", ")} matches anything in this project. Either it is genuinely ` +
        `new, or this project names it differently. Confirm the terms with the user before creating assets: ` +
        `a second system under a different name is worse than no system.`
    );
  }

  const suggestedOrder: string[] = [];
  if (existingSystems.length > 0) {
    suggestedOrder.push(
      `Read the existing work first: ${existingSystems.flatMap((s) => s.readingOrder).slice(0, 3).join("; ") || "see readingOrder per system"}`
    );
    suggestedOrder.push("Confirm with the user whether to extend or replace what already exists");
  }
  if (newWork.length > 0) {
    suggestedOrder.push(
      `Model the data for the new parts first (structs and enums for ${newWork.slice(0, 3).join(", ")}), then the logic`
    );
    suggestedOrder.push("Create assets following the naming and folder conventions reported above");
    suggestedOrder.push("Build each graph in one unreal_build_graph call, then review and act on the findings");
  }
  if (existingSystems.length === 0 && newWork.length === 0) {
    notes.push("Nothing conclusive was found either way. Ask the user to name the systems involved.");
  }


  if (conceptsToCheck.length > 0) {
    const names = conceptsToCheck.map((c) => `"${c}"`).join(", ");
    raiseWithUser.push(
      `Before extending ${names}, check each still runs: unreal_trace_function_calls on one of its ` +
        `functions says whether anything reaches it. A system that was replaced and left in place reads ` +
        `exactly like a live one, and building on it produces a feature that cannot work.`
    );
  }

  return {
    request,
    conceptsExamined: concepts,
    existingSystems,
    raiseWithUser,
    newWork,
    conventions: await readConventions(bridge, notes),
    suggestedOrder,
    notes,
  };
}
