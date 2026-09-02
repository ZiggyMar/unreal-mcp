/**
 * Everything connected to one Blueprint, in one call.
 *
 * The request this answers, in a user's own words: "take BP_Player and make me a full document of
 * every feature that's connected to BP_Player."
 *
 * Every part of that answer was already reachable and no tool gave it. Assembling it by hand is
 * eight calls - list_blueprint_graphs, list_variables, list_components, describe_class,
 * find_references, explain_graph, and the tracers - and the eight are not the problem. The problem
 * is that a model has to KNOW all eight, and the evidence that it does not is this project's own
 * history: search_project was called for a variable, answered with its declaration, and the tool
 * that says where it is read and written went unused for ten more calls because nothing named it.
 *
 * A document is also the shape a person actually asked for. A model can summarise eight replies
 * into prose, but then the structure is invented per session, differs every time, and quietly drops
 * whatever the model found least interesting. Deciding once what "connected to" means, and always
 * returning that, is the difference between a report and a recollection.
 *
 * ## What "connected" means here
 *
 * Four kinds of connection, ordered by how much they constrain a change:
 *
 *   inherits   the ancestry, and the interfaces it promises to implement
 *   owns       its components and variables - and which of those replicate
 *   does       its graphs, each entry point with where it RUNS
 *   reaches    what it references, and what references it
 *
 * The last one is the one people mean by "connected" and the one hand-assembly usually misses:
 * a change to this asset is felt by everything in referencedBy.
 */

import type { GraphSummary } from "./explainGraph.js";
import { explainGraph } from "./explainGraph.js";

export interface BridgeLike {
  send<T>(command: string, params: Record<string, unknown>): Promise<T>;
}

export interface DocumentedVariable {
  name: string;
  type: string;
  /** Only when it is not "none" - the common case costs nothing. */
  replication?: string;
}

export interface DocumentedGraph {
  name: string;
  /** One line per entry point: what starts, and the chain it runs. */
  entries: string[];
  nodeCount?: number;
}

export interface AssetDocument {
  path: string;
  ancestry?: string[];
  interfaces?: string[];
  components?: Array<{ name: string; class?: string }>;
  variables?: DocumentedVariable[];
  replicatedCount?: number;
  graphs?: DocumentedGraph[];
  referencedBy?: string[];
  dependsOn?: string[];
  notes?: string[];
  text: string;
}

/** Package path without the ".Asset" tail, so the two spellings of one asset compare equal. */
function packageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

function shortName(path: string): string {
  const pkg = packageOf(path);
  return pkg.slice(pkg.lastIndexOf("/") + 1);
}

/** Engine and script paths are not "features of this project", which is what was asked for. */
function isProjectAsset(path: string): boolean {
  return path.startsWith("/Game/");
}

async function safe<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch {
    return null;
  }
}

/**
 * Build the document.
 *
 * `graphDetail` is the one real cost knob. A big Blueprint has 800 nodes across 40 graphs, and the
 * chains are the expensive half of this reply - so "entries" (the default) explains the EventGraph
 * and names the rest, "all" explains every graph, and "none" lists them. Nothing else here scales
 * with project size except referencedBy, which is the answer people came for.
 */
export async function documentAsset(
  bridge: BridgeLike,
  path: string,
  options: { graphDetail?: "none" | "entries" | "all"; maxReferences?: number } = {}
): Promise<AssetDocument> {
  const graphDetail = options.graphDetail ?? "entries";
  const maxReferences = options.maxReferences ?? 40;
  const notes: string[] = [];
  const doc: AssetDocument = { path, notes, text: "" };

  // --- inherits ---------------------------------------------------------------------------------
  const cls = await safe(
    bridge.send<{ ancestry?: string[]; interfaces?: string[] }>("describe_class", {
      className: `${shortName(path)}_C`,
    })
  );
  if (cls?.ancestry) doc.ancestry = cls.ancestry;
  if (cls?.interfaces?.length) doc.interfaces = cls.interfaces;

  // --- owns -------------------------------------------------------------------------------------
  const comps = await safe(
    bridge.send<{ components?: Array<{ name?: string; class?: string; componentClass?: string }> }>(
      "list_components",
      { path }
    )
  );
  if (comps?.components?.length) {
    doc.components = comps.components.map((c) => ({
      name: String(c.name ?? "?"),
      class: c.class ?? c.componentClass,
    }));
  }

  const vars = await safe(
    bridge.send<{ variables?: Array<Record<string, unknown>> }>("list_variables", { path })
  );
  if (vars?.variables?.length) {
    doc.variables = vars.variables.map((v) => {
      const rep = v.replication ?? v.replicated;
      const out: DocumentedVariable = {
        name: String(v.name ?? "?"),
        type: String(v.type ?? "?"),
      };
      // The bridge spells this either as a mode string or as a bare true; both mean "this crosses
      // the network", and a document that showed one and not the other would be wrong half the time.
      if (rep === true) out.replication = "replicated";
      else if (typeof rep === "string" && rep !== "none") out.replication = rep;
      return out;
    });
    doc.replicatedCount = doc.variables.filter((v) => v.replication).length;
  }

  // --- does -------------------------------------------------------------------------------------
  const graphs = await safe(
    bridge.send<{ graphs?: Array<{ name?: string; nodeCount?: number }> }>("list_blueprint_graphs", { path })
  );
  const graphNames = (graphs?.graphs ?? []).map((g) => String(g.name ?? "")).filter(Boolean);

  if (graphDetail !== "none" && graphNames.length > 0) {
    // "entries" explains the event graphs only. That is not an arbitrary cut: an event graph is
    // where a Blueprint's behaviour is triggered from, and a function graph is reached from one of
    // those - so the event graphs are the map and the functions are the streets.
    const wanted =
      graphDetail === "all"
        ? graphNames
        : graphNames.filter((n) => /event\s*graph/i.test(n) || /^ubergraph/i.test(n));
    const chosen = wanted.length > 0 ? wanted : graphNames.slice(0, 1);

    doc.graphs = [];
    for (const name of chosen) {
      const summary = await safe(
        bridge.send<GraphSummary>("read_blueprint_graph_summary", { path, graphName: name })
      );
      if (!summary) continue;
      const explained = explainGraph(summary);
      doc.graphs.push({
        name,
        nodeCount: explained.nodeCount,
        entries: explained.text.split("\n").filter((l) => l.startsWith("- ")),
      });
    }
    const undocumented = graphNames.filter((n) => !chosen.includes(n));
    if (undocumented.length > 0) {
      notes.push(
        `${undocumented.length} other graph(s) not expanded: ${undocumented.slice(0, 12).join(", ")}` +
          `${undocumented.length > 12 ? ", ..." : ""}. Pass graphDetail:"all" for every one, or ` +
          `unreal_explain_graph for a single named graph.`
      );
    }
  } else if (graphNames.length > 0) {
    doc.graphs = graphNames.map((name) => ({ name, entries: [] }));
  }

  // --- reaches ----------------------------------------------------------------------------------
  // Objects here, not strings.
  //
  // unreal_find_references REPLIES with plain path strings, and that is the tool layer compacting
  // them - the bridge command underneath returns {package, assetName, assetClass}. Reading the
  // tool's output and building against it is how this first shipped broken, with
  // "path.startsWith is not a function": every composite talks to the bridge, and the bridge is the
  // only shape that matters here. Both are accepted anyway, because a composite that breaks when a
  // compaction layer changes shape is a composite that will break.
  type Reference = string | { package?: string; assetName?: string };
  const refs = await safe(
    bridge.send<{ referencedBy?: Reference[]; dependsOn?: Reference[] }>("find_references", { path })
  );
  const pathOf = (r: Reference): string =>
    typeof r === "string" ? r : String(r?.package ?? r?.assetName ?? "");
  const trim = (list: Reference[] | undefined) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of list ?? []) {
      const r = pathOf(raw);
      if (!r || !isProjectAsset(r)) continue;
      const n = shortName(r);
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const referencedBy = trim(refs?.referencedBy);
  const dependsOn = trim(refs?.dependsOn);
  if (referencedBy.length > 0) doc.referencedBy = referencedBy.slice(0, maxReferences);
  if (dependsOn.length > 0) doc.dependsOn = dependsOn.slice(0, maxReferences);
  for (const [label, full, kept] of [
    ["referencedBy", referencedBy, doc.referencedBy],
    ["dependsOn", dependsOn, doc.dependsOn],
  ] as const) {
    if (kept && full.length > kept.length) {
      // Named, not silently dropped: a truncated list that does not say it is truncated reads as
      // "this is all of them", which is the one thing a document must never get wrong.
      notes.push(`${label} truncated to ${kept.length} of ${full.length}; raise maxReferences to see the rest.`);
    }
  }

  doc.text = render(doc);

  // The prose is the product; the structure it was rendered from is not sent as well.
  //
  // Measured on BP_Player: 31,192 characters, of which `text` was 13,735 and the arrays it is
  // rendered FROM were another 16,000. Seventy-eight percent of the biggest reply this server sends
  // was one set of facts said twice - the exact defect this project keeps removing from other
  // people's replies, in a tool written this morning.
  //
  // What survives is what prose cannot carry or a caller cannot re-derive: the path it is about,
  // the counts, and the notes that say where a list was truncated. Everything else is in the text
  // verbatim, and anything wanted as DATA rather than as a document has its own tool one call away -
  // list_variables, list_components, find_references - each of which answers it properly instead of
  // as a by-product.
  //
  // The one thing the text used to drop is now in it: the names of the variables that do NOT
  // replicate. They were only ever in the structured array, so removing it without that line would
  // have been a quiet loss of 71 names rather than a compaction.
  delete doc.graphs;
  delete doc.variables;
  delete doc.components;
  delete doc.referencedBy;
  delete doc.dependsOn;

  if (notes.length === 0) delete doc.notes;
  return doc;
}

/** The prose half. A person asked for a document, so one is written rather than implied. */
function render(doc: AssetDocument): string {
  const name = shortName(doc.path);
  const lines: string[] = [];

  const parent = doc.ancestry && doc.ancestry.length > 1 ? doc.ancestry[1] : undefined;
  lines.push(`${name}${parent ? ` (a ${parent})` : ""}`);
  if (doc.ancestry) lines.push(`  inherits: ${doc.ancestry.join(" <- ")}`);
  if (doc.interfaces?.length) lines.push(`  implements: ${doc.interfaces.join(", ")}`);

  if (doc.components?.length) {
    lines.push(
      `  components (${doc.components.length}): ` +
        doc.components.map((c) => (c.class ? `${c.name} [${c.class}]` : c.name)).join(", ")
    );
  }

  if (doc.variables?.length) {
    const replicated = doc.variables.filter((v) => v.replication);
    const local = doc.variables.filter((v) => !v.replication);
    lines.push(`  variables: ${doc.variables.length}, of which ${replicated.length} cross the network`);
    if (replicated.length > 0) {
      lines.push(
        `  replicated: ` + replicated.map((v) => `${v.name} (${v.type}, ${v.replication})`).join(", ")
      );
    }
    // Names only for the rest. They were previously carried in the structured array and nowhere in
    // the text, so dropping that array without this line would have lost them - and "everything
    // connected to this asset" that omits two thirds of its state is not the thing that was asked
    // for. Types are left out: unreal_list_variables answers that properly and costs less than
    // repeating it here for every variable in the project's largest Blueprint.
    if (local.length > 0) {
      lines.push(`  local (${local.length}): ` + local.map((v) => v.name).join(", "));
    }
  }

  for (const g of doc.graphs ?? []) {
    if (g.entries.length === 0) continue;
    lines.push(`  ${g.name}${g.nodeCount ? ` - ${g.nodeCount} nodes` : ""}:`);
    for (const e of g.entries) lines.push(`    ${e.slice(2)}`);
  }

  if (doc.referencedBy?.length) {
    lines.push(`  used by (${doc.referencedBy.length}): ${doc.referencedBy.join(", ")}`);
    lines.push(`    - a change here is felt by every one of those.`);
  }
  if (doc.dependsOn?.length) {
    lines.push(`  depends on (${doc.dependsOn.length}): ${doc.dependsOn.join(", ")}`);
  }

  for (const n of doc.notes ?? []) lines.push(`  note: ${n}`);
  return lines.join("\n");
}
