/**
 * Understanding a system that already exists, across the Blueprints it is spread over.
 *
 * This is the problem people actually have with an eight-month-old project: one Blueprint is wired
 * to five others, and there is no way to explain that to a model. Chat without tools cannot be told
 * the context. Tools that only read one asset at a time make the model reconstruct the shape by
 * hand, one expensive read at a time, and it usually gives up and edits the first file it found -
 * which is how an agent breaks a working project.
 *
 * So this answers the question directly: given a concept ("health", "inventory", "the vacuum"),
 * which assets make up that system, how are they connected, and in what order should they be read.
 *
 * The whole thing is built from cheap reads - the project index and the asset dependency graph -
 * and never opens a graph. A map of a twenty-asset system costs a fraction of reading one large
 * Blueprint, which is the point: the map is what you look at BEFORE deciding what to read.
 */

import type { BridgeLike } from "./autoLayout.js";
import type { FindReferencesResult, ListBlueprintsResult, SearchProjectResult } from "./types.js";

export interface SystemNode {
  path: string;
  name: string;
  /** Why this asset is in the map. The model should not have to guess. */
  reasons: string[];
  /** How many other assets in this map reference it. High means "core to the system". */
  referencedByInSystem: number;
  /** How many assets anywhere reference it. High means "changing it is risky". */
  referencedByTotal: number;
  parentClass?: string;
  /** How far from a search hit: 0 = matched the query itself. */
  distance: number;
}

export interface SystemEdge {
  from: string;
  to: string;
}

export interface SystemMap {
  query: string;
  /** Assets in the system, most central first. */
  assets: SystemNode[];
  edges: SystemEdge[];
  /** What matched the query directly, before following references. */
  seeds: string[];
  /** Where to start reading, and why. */
  readingOrder: string[];
  /** Assets that lots of things depend on: changing these has blast radius. */
  highRisk: string[];
  notes: string[];
  truncated: boolean;
}

const DEFAULT_MAX_ASSETS = 25;
const DEFAULT_DEPTH = 2;
/** Above this many referencers, a change is a project-wide event rather than a local one. */
const HIGH_RISK_REFERENCERS = 5;

/** Normalise "/Game/X/BP_A.BP_A" and "/Game/X/BP_A" to one key. */
function packageOf(path: string): string {
  const withoutObject = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : path;
  return withoutObject;
}

function nameOf(path: string): string {
  const pkg = packageOf(path);
  return pkg.slice(pkg.lastIndexOf("/") + 1);
}

/** Only project content is interesting; engine and plugin assets are noise in a system map. */
function isProjectAsset(path: string): boolean {
  return path.startsWith("/Game");
}

export async function mapSystem(
  bridge: BridgeLike,
  query: string,
  options: { maxAssets?: number; depth?: number } = {}
): Promise<SystemMap> {
  const maxAssets = options.maxAssets ?? DEFAULT_MAX_ASSETS;
  const depth = options.depth ?? DEFAULT_DEPTH;

  const nodes = new Map<string, SystemNode>();
  const edges: SystemEdge[] = [];
  const edgeKeys = new Set<string>();
  const notes: string[] = [];

  const addNode = (path: string, reason: string, distance: number): SystemNode | undefined => {
    if (!isProjectAsset(path)) return undefined;
    const key = packageOf(path);
    const existing = nodes.get(key);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.distance = Math.min(existing.distance, distance);
      return existing;
    }
    if (nodes.size >= maxAssets) return undefined;
    const node: SystemNode = {
      path: key,
      name: nameOf(key),
      reasons: [reason],
      referencedByInSystem: 0,
      referencedByTotal: 0,
      distance,
    };
    nodes.set(key, node);
    return node;
  };

  const addEdge = (from: string, to: string) => {
    const key = `${packageOf(from)} -> ${packageOf(to)}`;
    if (edgeKeys.has(key) || packageOf(from) === packageOf(to)) return;
    edgeKeys.add(key);
    edges.push({ from: packageOf(from), to: packageOf(to) });
  };

  // --- 1. What matches the concept at all? -----------------------------------------------------
  const search = await bridge.send<SearchProjectResult>("search_project", { query, maxResults: 60 });
  const seeds: string[] = [];
  for (const hit of search.hits ?? []) {
    if (!isProjectAsset(hit.path)) continue;
    // A function or variable hit tells you far more than a name match: it says the system's
    // behaviour lives here, not just its label.
    const reason =
      hit.kind === "blueprint"
        ? `name matches "${query}"`
        : `has ${hit.kind} "${hit.name}" matching "${query}"`;
    const node = addNode(hit.path, reason, 0);
    if (node && !seeds.includes(node.path)) seeds.push(node.path);
  }

  if (seeds.length === 0) {
    return {
      query,
      assets: [],
      edges: [],
      seeds: [],
      readingOrder: [],
      highRisk: [],
      notes: [
        `Nothing in the project matches "${query}". Either this system does not exist yet, or it is ` +
          `named differently. Try unreal_get_project_overview to see the project's actual vocabulary ` +
          `before assuming it is missing.`,
      ],
      truncated: false,
    };
  }
  if (search.truncated) {
    notes.push(`The search hit its result cap, so this map may be missing parts of the system. Narrow the query to be sure.`);
  }

  // --- 2. Follow the reference graph outward ---------------------------------------------------
  let frontier = [...seeds];
  for (let level = 1; level <= depth; level++) {
    const next: string[] = [];
    for (const path of frontier) {
      if (nodes.size >= maxAssets) break;
      let refs: FindReferencesResult;
      try {
        refs = await bridge.send<FindReferencesResult>("find_references", { path });
      } catch {
        // A single unreadable asset must not abandon the whole map.
        continue;
      }

      const node = nodes.get(packageOf(path));
      if (node) node.referencedByTotal = refs.referencedByCount ?? (refs.referencedBy ?? []).length;

      for (const entry of refs.referencedBy ?? []) {
        if (!isProjectAsset(entry.package)) continue;
        const added = addNode(entry.package, `uses ${nameOf(path)}`, level);
        addEdge(entry.package, path);
        if (added && added.distance === level) next.push(added.path);
      }
      for (const entry of refs.dependsOn ?? []) {
        if (!isProjectAsset(entry.package)) continue;
        const added = addNode(entry.package, `used by ${nameOf(path)}`, level);
        addEdge(path, entry.package);
        if (added && added.distance === level) next.push(added.path);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // --- 3. Fill in what kind of thing each asset is ----------------------------------------------
  try {
    const listed = await bridge.send<ListBlueprintsResult>("list_blueprints", {});
    for (const bp of listed.blueprints ?? []) {
      const node = nodes.get(packageOf(bp.path));
      if (node) node.parentClass = bp.parentClass;
    }
  } catch {
    notes.push("Parent classes could not be read, so the map says what is connected but not what kind of thing each asset is.");
  }

  // --- 4. Rank ----------------------------------------------------------------------------------
  for (const edge of edges) {
    const target = nodes.get(edge.to);
    if (target) target.referencedByInSystem++;
  }

  const assets = [...nodes.values()].sort((a, b) => {
    // Things the query actually matched come first, then whatever the system leans on most.
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (b.referencedByInSystem !== a.referencedByInSystem) return b.referencedByInSystem - a.referencedByInSystem;
    return a.name.localeCompare(b.name);
  });

  const highRisk = assets
    .filter((a) => a.referencedByTotal >= HIGH_RISK_REFERENCERS)
    .map((a) => `${a.name} (${a.referencedByTotal} referencers)`);

  // Read the most-depended-on assets first: they define the contracts everything else obeys, so
  // reading a leaf first means re-reading it once the shared type finally shows up.
  const readingOrder = [...assets]
    .sort((a, b) => b.referencedByInSystem - a.referencedByInSystem || a.distance - b.distance)
    .slice(0, 8)
    .map((a) => `${a.name} - ${a.reasons[0]}${a.referencedByInSystem > 0 ? `, ${a.referencedByInSystem} in-system referencers` : ""}`);

  if (nodes.size >= maxAssets) {
    notes.push(
      `Capped at ${maxAssets} assets. This system is larger than the map; raise maxAssets or narrow the query ` +
        `before assuming you have seen all of it.`
    );
  }
  if (highRisk.length > 0) {
    notes.push(
      `Changing ${highRisk.length} of these affects assets outside this system. Read those before editing them, ` +
        `and prefer adding to them over changing what already exists.`
    );
  }

  return {
    query,
    assets,
    edges,
    seeds,
    readingOrder,
    highRisk,
    notes,
    truncated: nodes.size >= maxAssets || Boolean(search.truncated),
  };
}
