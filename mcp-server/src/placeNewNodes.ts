import { isEntryType } from "./entryTypes.js";

/**
 * Where do nodes go when the graph is too big to lay out?
 *
 * `build_graph` lays out a graph it effectively built, and skips that on a graph that already has
 * nodes - correctly, because relaying out somebody's 982-node EventGraph to place four is a far
 * larger change than the one being asked for. But skipping the layout left the new nodes wherever
 * the engine defaulted them, which is the origin.
 *
 * Measured, after the guidance had been corrected to say "omit x/y and each node is placed beside
 * what it connects to": three nodes built with no coordinates all arrived at (0,0), stacked on each
 * other and on top of a node called UpdateLocalVanPing. So on a large graph BOTH options were wrong -
 * passing coordinates lands on somebody's system, and omitting them lands on the origin, which is
 * usually somebody's system too.
 *
 * This closes that. New nodes are placed relative to whatever they connect to, and a batch that
 * connects to nothing is put in clear canvas below everything rather than at the origin. Nothing
 * that already existed is moved.
 */

export interface PlaceNode {
  id?: string;
  type?: string;
  title?: string;
  x?: number;
  y?: number;
  pins?: string[];
}

export interface Placement {
  nodeId: string;
  x: number;
  y: number;
}

const COMMENT = /Comment/i;

function linkedIds(n: PlaceNode): string[] {
  const out: string[] = [];
  for (const line of n.pins ?? []) {
    const arrow = line.includes("->") ? "->" : line.includes("<-") ? "<-" : "";
    if (!arrow) continue;
    const rhs = line.split(arrow)[1];
    if (!rhs) continue;
    for (const part of rhs.split(",")) {
      const id = part.trim().split(".")[0];
      if (id) out.push(id);
    }
  }
  return out;
}

/**
 * Decide where a freshly built batch should sit.
 *
 * `newIds` are the nodes this build created; everything else in `all` is existing work and is never
 * moved. Returns only the nodes that need repositioning, so a caller can skip the round trip
 * entirely when the answer is "nowhere".
 */
export function placeNewNodes(
  all: PlaceNode[],
  newIds: string[],
  options: { columnGap?: number; rowGap?: number; clearX?: number; clearY?: number } = {}
): Placement[] {
  const columnGap = options.columnGap ?? 260;
  const rowGap = options.rowGap ?? 130;
  const clearX = options.clearX ?? 150;
  const clearY = options.clearY ?? 60;

  // build_graph reports FULL 32-character ids; the graph summary shortens them. Comparing the two
  // directly matched nothing, and the placement silently did nothing at all - a fix that reported
  // "0 nodes placed" and looked like it had run. One is always a prefix of the other.
  const wanted = newIds.filter(Boolean);
  const isNewId = (id: string) =>
    id !== "" && wanted.some((w) => w === id || w.startsWith(id) || id.startsWith(w));
  const isNew = { has: (id: string) => isNewId(id) };
  const placedNodes = all.filter((n) => typeof n.x === "number" && typeof n.y === "number");
  const byId = new Map(placedNodes.map((n) => [n.id ?? "", n]));
  const existing = placedNodes.filter((n) => !isNew.has(n.id ?? "") && !COMMENT.test(n.type ?? ""));
  const fresh = placedNodes.filter((n) => isNew.has(n.id ?? ""));
  if (fresh.length === 0) return [];

  // Live positions, so each placement sees the ones before it.
  const pos = new Map(placedNodes.map((n) => [n.id ?? "", { x: n.x as number, y: n.y as number }]));

  const free = (x: number, y: number, selfId: string) =>
    placedNodes.every((o) => {
      const oid = o.id ?? "";
      if (oid === selfId) return true;
      if (COMMENT.test(o.type ?? "")) return true;
      const p = pos.get(oid);
      return !p || Math.abs(p.x - x) >= clearX || Math.abs(p.y - y) >= clearY;
    });

  /** First free slot at or below a wanted spot, searching outward so nothing is buried. */
  const nearestFree = (wantX: number, wantY: number, selfId: string) => {
    for (let ring = 0; ring < 40; ring++) {
      for (const dy of ring === 0 ? [0] : [ring * rowGap, -ring * rowGap]) {
        for (const dx of [0, columnGap, -columnGap]) {
          const x = wantX + dx, y = wantY + dy;
          if (free(x, y, selfId)) return { x, y };
        }
      }
    }
    return { x: wantX, y: wantY };
  };

  // Anchor: the existing nodes this batch touches. A batch wired into a chain belongs beside that
  // chain; a batch wired to nothing belongs in clear canvas, NOT at the origin.
  const anchors: Array<{ x: number; y: number }> = [];
  for (const n of fresh) {
    for (const id of linkedIds(n)) {
      if (isNew.has(id)) continue;
      const a = byId.get(id);
      if (a && typeof a.x === "number") anchors.push({ x: a.x, y: a.y as number });
    }
  }

  let originX: number;
  let originY: number;
  if (anchors.length > 0) {
    // Just right of what it attaches to, level with it: the direction a graph is read.
    originX = Math.max(...anchors.map((a) => a.x)) + columnGap;
    originY = Math.round(anchors.reduce((t, a) => t + a.y, 0) / anchors.length);
  } else {
    // Nothing to attach to. Below everything, where there is certainly room - the same rule a person
    // follows when they "go out into the void" to build something new.
    originX = existing.length ? Math.min(...existing.map((n) => n.x as number)) : 0;
    originY = existing.length ? Math.max(...existing.map((n) => n.y as number)) + 1200 : 0;
  }

  // Left to right in the order the caller declared them, which is the order they were reasoned about
  // and usually the order they run.
  const out: Placement[] = [];
  let cursorX = originX;
  for (const n of fresh) {
    const id = n.id ?? "";
    const slot = nearestFree(cursorX, originY, id);
    pos.set(id, slot);
    out.push({ nodeId: id, x: slot.x, y: slot.y });
    cursorX = slot.x + columnGap;
  }
  return out;
}

/**
 * A box title in the shape this project actually uses.
 *
 * Measured over 148 graphs: box titles run a median of TWO words, 3% are shouted in caps, and they
 * are names - "Movement", "Firing", "Aim Server", "Set HUD Values" - not sentences.
 *
 * This exists because the alternative was demonstrated. Left to write its own titles, a model
 * produced "Otherwise: the nearest pool nobody else is closer to" and "Tutorial Guide 3 - Pick
 * Target", averaging five words with one shouted, and eleven of them had to be renamed by hand. A
 * convention that has to be remembered every time is one that will be forgotten; encoded here, the
 * mistake cannot recur.
 *
 * Deliberately NOT applied to titles a person wrote. Their graph is the standard, and rewriting
 * somebody's "GAMEPLAY TAGS" to match a rule derived from their own work is the tail wagging the dog.
 */
export function houseStyleTitle(raw: string, options: { maxWords?: number } = {}): string {
  const maxWords = options.maxWords ?? 4;
  let t = raw.trim();
  if (!t) return "";

  // Event prefixes name the plumbing, not the system: CE_ServerToggleHealPrompt is a multicast
  // detail, "Server Toggle Heal Prompt" is what the box is for.
  t = t.replace(/^(CE_|BND_|InpActEvt_|Event\s+)/i, "").trim();

  // It also tried to cut narration at a colon or dash, and that is removed on the evidence:
  // "Otherwise: the nearest pool nobody else is closer to" became "Otherwise", and "Tutorial Guide
  // 3 - Pick Target" became "Tutorial Guide". Both kept the generic half and threw away the meaning,
  // which is worse than leaving the title alone.
  //
  // It was also solving a problem this path never sees. The title here comes from an entry EVENT
  // node, which is always a name like CE_ServerSound or ApplyTicketSkin - never prose. The prose
  // titles that motivated it were hand-written ones, and those are not this function's to rewrite.

  // ThisIsOneWordToAPerson -> This Is One Word To A Person, so the word count means something.
  // Underscores count as spaces here, or CE_MC_Sound keeps its plumbing as "MC_Sound".
  if (!t.includes(" ")) t = t.replace(/_+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();

  // Shouting is 3% of this project. Anything wholly upper-case gets sentence-cased back.
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) {
    t = t
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  const words = t.split(/\s+/).filter(Boolean);
  // Trailing punctuation left by the cut - "Tutorial Guide 3 -" - is just litter.
  return words.slice(0, maxWords).join(" ").replace(/[\s,:;\-—]+$/, "");
}

/**
 * A comment box for a batch that arrived as a new system, or nothing.
 *
 * The project's convention is that every system sits in a titled box, and the title is how a person
 * navigates a large graph. A batch built into an existing chain does not need one - it belongs to
 * whatever already owns that chain - so this only offers a box for a batch that landed in clear
 * canvas on its own, which is the case that would otherwise be loose nodes forever.
 *
 * Named after the event that starts it, because that is what the system IS. A batch with no entry
 * event gets no box: an untitled box groups nodes while explaining nothing, which review_layout
 * reports as a fault in its own right.
 */
export function boxForBatch(
  all: PlaceNode[],
  newIds: string[],
  placements: Placement[],
  options: { minNodes?: number; pad?: number; boxedAbove?: number } = {}
): { x: number; y: number; width: number; height: number; title: string } | undefined {
  const minNodes = options.minNodes ?? 3;
  const pad = options.pad ?? 180;
  if (placements.length < minNodes) return undefined;

  // Does this graph box things at all?
  //
  // Boxing every standalone batch ignored the question. Measured across 148 graphs, whether a graph
  // has comment boxes is a SIZE rule and a sharp one: 8% of graphs under 10 nodes are boxed, 38% at
  // 20-29, 52% at 30-49, 90% at 50-79, and 100% above 80. Dropping a titled box into a twelve-node
  // graph is not tidiness, it is a foreign convention - and it is what produced a comment box round
  // a two-node graph when the same mistake was made in the checker.
  //
  // The graph answers first, and that costs nothing and travels: a graph that ALREADY uses boxes
  // wants one for a new system, whatever its size. Only a graph with none needs a threshold.
  //
  // 30, not the 50 the sweep reports. Those answer different questions. 50 is where boxing becomes
  // the NORM here (90% of graphs), which is what a checker wants before complaining. The question
  // when ADDING a box is whether one would look out of place, and below 30 nodes it clearly would -
  // 8% boxed under 10, 18% at 10-19, 38% at 20-29. From 30 it is 52%, a coin flip, and a freshly
  // built system that has its own entry event is the half that benefits.
  const boxedAbove = options.boxedAbove ?? 30;
  const graphNodes = all.filter((n) => !COMMENT.test(n.type ?? ""));
  const graphUsesBoxes = all.some((n) => COMMENT.test(n.type ?? ""));
  if (!graphUsesBoxes && graphNodes.length < boxedAbove) return undefined;

  const wanted = newIds.filter(Boolean);
  const isNewId = (id: string) =>
    id !== "" && wanted.some((w) => w === id || w.startsWith(id) || id.startsWith(w));
  const fresh = all.filter((n) => isNewId(n.id ?? ""));

  // Anchored to existing work? Then it is part of that, not a system of its own.
  const byId = new Map(all.map((n) => [n.id ?? "", n]));
  for (const n of fresh) {
    for (const id of linkedIds(n)) {
      if (isNewId(id)) continue;
      if (byId.has(id)) return undefined;
    }
  }

  const entry = fresh.find((n) => isEntryType(n.type));
  const title = houseStyleTitle(entry?.title ?? "");
  if (!title) return undefined;

  const xs = placements.map((p) => p.x);
  const ys = placements.map((p) => p.y);
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + pad * 2 + 260,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2,
    title,
  };
}

/** A box to draw: the outer one names the system, inner ones name its parts. */
export interface BatchBox {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  /** True for the system box that the others nest inside. */
  outer?: boolean;
}

/**
 * One box, or a nest of them when the batch is really several systems.
 *
 * The project's boxes hold a median of 7 nodes and a p90 of 20, and there are 104 nested pairs -
 * an outer box naming the system, inner ones naming its parts. A single box round forty nodes is
 * not what this codebase looks like.
 *
 * The hard part is that a box needs a NAME. Chopping a chain into "Part 1" and "Part 2" every seven
 * nodes would satisfy the measurement and mean nothing, and fake structure reads worse than one
 * honest box - it is the same failure as a checker tuned until it stays quiet.
 *
 * So it only splits where a real name exists: at the entry events. Each event owns the run of nodes
 * reachable from it, which is exactly how CE_ServerSound / CE_MC_Sound / CE_ClientSound sit as three
 * named parts of one sound system in this graph. A batch with one event stays one box however large
 * it is, because there is nothing honest to call the halves.
 */
export function boxesForBatch(
  all: PlaceNode[],
  newIds: string[],
  placements: Placement[],
  options: { minNodes?: number; pad?: number; splitAbove?: number } = {}
): BatchBox[] {
  const outer = boxForBatch(all, newIds, placements, options);
  if (!outer) return [];

  // The project's p90. Below it, one box is what a person would draw.
  const splitAbove = options.splitAbove ?? 20;
  const pad = options.pad ?? 180;

  const wanted = newIds.filter(Boolean);
  const isNewId = (id: string) =>
    id !== "" && wanted.some((w) => w === id || w.startsWith(id) || id.startsWith(w));
  const fresh = all.filter((n) => isNewId(n.id ?? ""));
  const events = fresh.filter((n) => isEntryType(n.type));
  if (placements.length <= splitAbove || events.length < 2) return [outer];

  const pos = new Map(placements.map((p) => [p.nodeId, p]));
  const at = (id: string) => pos.get(id) ?? [...pos.entries()].find(([k]) => k.startsWith(id) || id.startsWith(k))?.[1];
  const byId = new Map(fresh.map((n) => [n.id ?? "", n]));
  const near = (id: string) => byId.get(id) ?? [...byId.entries()].find(([k]) => k.startsWith(id) || id.startsWith(k))?.[1];

  // Each event takes the nodes reachable from it, first come first served - a node fed by two
  // systems belongs to the one that runs it, and claiming it twice would build the overlapping
  // boxes this whole effort exists to prevent.
  const claimed = new Set<string>();
  const inner: BatchBox[] = [];
  for (const ev of events) {
    const own: PlaceNode[] = [];
    const queue = [ev];
    while (queue.length > 0) {
      const n = queue.shift() as PlaceNode;
      const id = n.id ?? "";
      if (!id || claimed.has(id)) continue;
      claimed.add(id);
      own.push(n);
      for (const nextId of linkedIds(n)) {
        const nxt = near(nextId);
        if (nxt && !claimed.has(nxt.id ?? "")) queue.push(nxt);
      }
    }
    const pts = own.map((n) => at(n.id ?? "")).filter(Boolean) as Placement[];
    if (pts.length < 2) continue;
    const title = houseStyleTitle(ev.title ?? "");
    if (!title) continue;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    inner.push({
      // Half the outer padding, so an inner box sits clearly inside its parent rather than touching.
      x: Math.min(...xs) - pad / 2,
      y: Math.min(...ys) - pad / 2,
      width: Math.max(...xs) - Math.min(...xs) + pad + 260,
      height: Math.max(...ys) - Math.min(...ys) + pad,
      title,
    });
  }

  // One inner box spanning the whole system is just the outer box drawn twice.
  if (inner.length < 2) return [outer];

  // What is the OUTER box called? Not the first event - that is the mistake the unboxed check had
  // to be fixed for, where "17 nodes starting at KillPlayer" quietly hid two more events inside the
  // same cluster and read as one system.
  //
  // The honest name is the word the parts share: Server Sound / MC Sound / Client Sound is a Sound
  // system. When they share nothing, there IS no name for the whole, so no outer box is drawn and
  // the named parts stand on their own - which is still better organised than one box called after
  // whichever event happened to be first.
  const wordSets = inner.map((b) => new Set(b.title.toLowerCase().split(/\s+/)));
  const shared = [...wordSets[0]].filter((w) => wordSets.every((s) => s.has(w)));
  if (shared.length === 0) return inner;

  const title = inner[0]
    .title.split(/\s+/)
    .filter((w) => shared.includes(w.toLowerCase()))
    .join(" ");
  return [{ ...outer, title, outer: true }, ...inner];
}
