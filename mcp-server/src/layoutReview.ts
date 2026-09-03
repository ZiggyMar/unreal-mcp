import { isEntryType } from "./entryTypes.js";

/**
 * Is this graph laid out like a person laid it out?
 *
 * A model can add correct nodes and leave a graph that reads as scrambled wire, and nothing in this
 * tool noticed. It took a human opening BP_Player to say so: *"it's like taking headphones and you
 * scramble the wires... if someone looks at this, it's gonna be like, this is AI, bro."* Sixty nodes
 * had gone in at invented coordinates, across four regions, overlapping 154 of his own nodes.
 *
 * Correctness was never the problem - it compiled, it ran. The problem is that disorderly work costs
 * the person who has to edit it next, and no amount of "remember to be tidy" survives the moment a
 * feature does not work yet and tidiness feels postponable.
 *
 * So the conventions are checked instead of remembered. Every rule here came from measuring a graph
 * a person maintains by hand, not from taste:
 *
 *   - **Flow runs rightward.** His 306 execution wires had 0 running backwards; the ones added by a
 *     model had 4. Epic's own guidance is "align wires, not nodes" - you cannot control pin
 *     positions, but you can place nodes so the wire has a straight run. A chain that jumps left
 *     makes the reader backtrack, and enough of those is what spaghetti is.
 *   - **Nothing is stacked.** Two nodes at the same coordinates are invisible until one is dragged.
 *   - **Every system is in a comment box.** In his graphs each system - Vaccum, Inputs, Healing,
 *     Spawn Ping - sits in a titled box, and the prose lives on the box. A loose node belongs to
 *     nothing, and in the editor a box OWNS what is inside it, so a node outside the box is left
 *     behind when the box is moved.
 *   - **Wires stay short.** "A human never runs a wire across the whole canvas."
 *
 * Data wires are deliberately not direction-checked. A Get feeding a node from below and slightly
 * left is normal and correct; only execution order is reading order.
 */

/** A node as the summary returns it, with `withPositions` asked for. */
export interface LayoutNode {
  id?: string;
  type?: string;
  title?: string;
  x?: number;
  y?: number;
  /** Comment boxes only: how far the box extends. Absent on ordinary nodes. */
  width?: number;
  height?: number;
  /** Comment boxes only: the box's first line, which is its name. */
  text?: string;
  /** Flattened wiring, e.g. "out then -> A1B2C3D4.execute". */
  pins?: string[];
}

export interface LayoutFinding {
  /** Short machine-readable kind, so a caller can filter. */
  kind: "backwardFlow" | "stacked" | "unboxed" | "longWire" | "untitledBox" | "overlappingBoxes" | "emptyBox";
  /** One sentence a person can act on. */
  detail: string;
  nodes: string[];
  /**
   * For an `unboxed` finding: a rectangle that would box the cluster without partially overlapping
   * an existing box or capturing a node outside it. Pass it straight to organize_graph
   * add_comment_box. Absent when no safe rectangle exists, which is not the same as "draw one anyway".
   */
  suggest?: Array<{ x: number; y: number; width: number; height: number; text: string }>;
  /**
   * Boxes that were ONE or two nodes away from being drawable, and which node is in the way.
   * Measured on BP_FireWall: three systems each blocked by a single node, reported as silence.
   */
  almost?: string[];
}

export interface LayoutReport {
  findings: LayoutFinding[];
  stats: {
    nodes: number;
    commentBoxes: number;
    execWires: number;
    backwardWires: number;
    /**
     * Wire lengths, because a single threshold turned out to be the wrong shape of answer.
     *
     * Measured on a graph a person maintains by hand: 849 wires, median 272, p90 608, max 3632. The
     * max alone would fail any fixed limit, and that graph is the standard. What actually separated
     * the hand-built code from the generated code was the p90 - 608 against 1068 - which says the
     * generated layout is uniformly more spread out, not that it has one bad wire.
     *
     * So the numbers are reported and the caller compares. Only genuine canvas-crossers are flagged.
     */
    wireMedian: number;
    wireP90: number;
    wireMax: number;
  };
}

export interface LayoutOptions {
  /** Only look at nodes in this Y band - lets a caller audit one system rather than a whole graph. */
  minY?: number;
  maxY?: number;
  /**
   * And in this X band. A system built to the RIGHT of somebody's code shares its rows, so a Y band
   * alone cannot separate the two - auditing one returned twelve findings that all belonged to the
   * other.
   */
  minX?: number;
  maxX?: number;
  /** A wire longer than this reads as a canvas-crossing run. */
  maxWire?: number;
  /** Nodes closer than this in both axes are visually on top of each other. */
  tooClose?: number;
  /** Max gap between two unboxed nodes for them to count as one system. */
  nearby?: number;
}

const COMMENT_TYPE = /Comment/i;

/**
 * A reroute node is a knot on a wire, not a node.
 *
 * It draws as a dot a fraction the size of a real node, and a person places them in runs to bend a
 * wire around something. Measured against a hand-maintained graph, counting them as nodes produced
 * 8 of 11 "stacked" findings - pairs of knots 32 apart, which is exactly what a deliberate run of
 * them looks like - and a heap of "in no comment box", which is true and meaningless for a bend in
 * a wire.
 *
 * Those were false positives against the very code being used as the standard, which is the clearest
 * evidence a rule is wrong. explainGraph steps over knots for the same reason: they are wires, not
 * behaviour. They still count for wire LENGTH, because bending a wire does not shorten it.
 */
const KNOT_TYPE = /Knot/i;

/**
 * Split a cluster into one group per entry event, each owning what runs from it.
 *
 * First come, first served, so a node fed by two systems belongs to the one that runs it. Claiming
 * it twice would suggest two boxes that both contain it - the partial overlap this file reports as
 * the worst fault there is.
 */
function splitByEntry(cluster: LayoutNode[]): Array<{ title: string; nodes: LayoutNode[] }> {
  const byId = new Map(cluster.map((n) => [n.id ?? "", n]));
  const near = (id: string) =>
    byId.get(id) ?? [...byId.entries()].find(([k]) => k.startsWith(id) || id.startsWith(k))?.[1];
  const claimed = new Set<string>();
  const out: Array<{ title: string; nodes: LayoutNode[] }> = [];

  for (const ev of cluster.filter((n) => isEntryType(n.type))) {
    const own: LayoutNode[] = [];
    const queue = [ev];
    while (queue.length > 0) {
      const n = queue.shift() as LayoutNode;
      const id = n.id ?? "";
      if (!id || claimed.has(id)) continue;
      claimed.add(id);
      own.push(n);
      for (const line of n.pins ?? []) {
        if (!line.includes("->")) continue;
        for (const t of targetsOf(line)) {
          const nxt = near(t);
          if (nxt && !claimed.has(nxt.id ?? "")) queue.push(nxt);
        }
      }
    }
    // Now pull in the pure nodes that FEED this chain.
    //
    // The walk above only follows "->" out of the event, and a getter points INTO the chain rather
    // than along it - a Self-Reference emits "out self -> SomeNode.self". So every variable Get,
    // Self reference and bit of maths hanging under a system was claimed by nobody, and then blocked
    // that system's own box as a stranger. Measured: Self-Reference was the single blocker for
    // "Power On" and "Power Off" in BP_AntlineCable and for "Start Repair" in BP_FireWall - the same
    // name three times over, which is what a systematic miss looks like rather than a coincidence.
    //
    // Repeated until stable, because a getter can feed a getter. Only PURE nodes: anything with an
    // exec pin belongs to whichever chain runs it, and claiming those would take nodes from another
    // system rather than reuniting a system with its own.
    for (let pass = 0; pass < 8; pass++) {
      const mine = new Set(own.map((n) => n.id ?? ""));
      let added = 0;
      for (const cand of cluster) {
        const id = cand.id ?? "";
        if (!id || claimed.has(id) || !isPure(cand)) continue;
        const feedsMine = (cand.pins ?? []).some(
          (line) => line.includes("->") && targetsOf(line).some((t) => mine.has(t) || [...mine].some((m) => m.startsWith(t) || t.startsWith(m)))
        );
        if (!feedsMine) continue;
        claimed.add(id);
        own.push(cand);
        added++;
      }
      if (added === 0) break;
    }

    // A lone event is a stub, not a system; a box round one node explains nothing.
    if (own.length >= 2) out.push({ title: (ev.title ?? "").trim(), nodes: own });
  }
  return out;
}

/**
 * A box title in the shape this project uses: a name, not plumbing, not shouted.
 *
 * Measured over 148 graphs - titles run two words, 3% are shouted. Suggestions were carrying the
 * raw node title, so they offered "CE_Client_ShowDamageNumber" and "Event On Enter Game" as box
 * names in a project whose boxes are called "Movement" and "Firing".
 *
 * Kept here rather than imported from placeNewNodes so this file stays standalone; the rules are
 * the same and both are measured from the same graphs.
 */
function houseTitle(raw: string): string {
  let t = (raw ?? "").trim();
  if (!t) return "";
  t = t.replace(/^(CE_|BND_|InpActEvt_|Event\s+)/i, "").trim();
  if (!t.includes(" ")) t = t.replace(/_+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) t = t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return t.split(/\s+/).filter(Boolean).slice(0, 4).join(" ").replace(/[\s,:;\-—]+$/, "");
}

/**
 * A rectangle that would box this cluster without breaking anything, or nothing.
 *
 * Two ways a suggested box can be wrong, and both have happened in this project for real:
 *
 *   - It partially overlaps an existing box. A box OWNS what is inside it, so two boxes sharing a
 *     region both claim the same nodes and dragging either corrupts the other. Nesting is fine -
 *     that is the convention here - so only PARTIAL overlap disqualifies.
 *   - It covers a node that is not in the cluster. That box would adopt somebody else's node.
 *
 * Padding shrinks before the answer becomes "no". A tight box is still a box; no box at all leaves
 * the nodes loose forever, which is the fault being reported.
 */
function safeBoxAround(
  cluster: LayoutNode[],
  boxes: LayoutNode[],
  allNodes: LayoutNode[],
  title: string
):
  | { box: { x: number; y: number; width: number; height: number; text: string } }
  | { blockedBy: LayoutNode[]; title: string }
  | undefined {
  const mine = new Set(cluster);
  const xs = cluster.map((n) => n.x as number);
  const ys = cluster.map((n) => n.y as number);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let blocked: LayoutNode[] | undefined;

  for (const pad of [180, 120, 80, 48]) {
    // A node is drawn down-and-right of its position, so the box needs room past the last one for
    // the node body itself - not just for the padding.
    const box = { x: x0 - pad, y: y0 - pad, width: x1 - x0 + pad * 2 + 280, height: y1 - y0 + pad * 2 + 90 };

    const strangers = allNodes.filter(
      (n) =>
        !mine.has(n) &&
        (n.x as number) >= box.x &&
        (n.x as number) <= box.x + box.width &&
        (n.y as number) >= box.y &&
        (n.y as number) <= box.y + box.height
    );
    if (strangers.length > 0) {
      // Remember the closest miss. Measured on BP_FireWall, three of its systems were blocked by a
      // SINGLE node standing in the way, and the tool said nothing at all - the caller could not
      // tell "impossible" from "one node short". Naming the blocker is the difference between a
      // refusal and a next step.
      if (!blocked || strangers.length < blocked.length) blocked = strangers;
      continue;
    }

    const clashes = boxes.some((b) => {
      const bx = b.x as number, by = b.y as number, bw = b.width as number, bh = b.height as number;
      const overlaps = box.x < bx + bw && bx < box.x + box.width && box.y < by + bh && by < box.y + box.height;
      if (!overlaps) return false;
      const nests =
        (box.x >= bx && box.y >= by && box.x + box.width <= bx + bw && box.y + box.height <= by + bh) ||
        (bx >= box.x && by >= box.y && bx + bw <= box.x + box.width && by + bh <= box.y + box.height);
      return !nests;
    });
    if (clashes) continue;

    // A box with no name groups nodes while explaining nothing, which this file reports as a fault
    // in its own right. Offering one would be suggesting the next finding.
    if (!title) return undefined;
    return { box: { ...box, text: title } };
  }
  // Only a NEAR miss is worth naming. A box blocked by sixteen nodes is genuinely impossible here -
  // the systems are interleaved and the answer is to move one of them out, not to shuffle a node.
  return blocked && blocked.length <= 2 && title ? { blockedBy: blocked, title } : undefined;
}

/** Exec pin names, which are what carry reading order. Data pins are not direction-checked. */
const EXEC_OUT = /^out (then|Then \d+|LoopBody|Completed|execute|Exec)\b/i;

/**
 * Either direction, for telling a pure node from one in an execution chain.
 *
 * A pure node - a getter, a Self reference, a bit of maths - has no place it MUST be, and belongs
 * to whatever reads it. A node with an exec pin belongs to the chain that runs it.
 */
const EXEC_ANY = /^(in|out) (then|Then \d+|LoopBody|Completed|execute|Exec)\b/i;
const isPure = (n: LayoutNode) => !(n.pins ?? []).some((l) => EXEC_ANY.test(l));

/** Node ids a pin line points at. The line format is "out then -> A1B2.execute, C3D4.execute". */
function targetsOf(line: string): string[] {
  const arrow = line.includes("->") ? "->" : "<-";
  const rhs = line.split(arrow)[1];
  if (!rhs) return [];
  return rhs
    .split(",")
    .map((part) => part.trim().split(".")[0])
    .filter(Boolean);
}

/**
 * Audit one graph's layout.
 *
 * Reports rather than fixes: the caller decides whether a finding is worth moving somebody's nodes
 * for, and on a graph a person maintains by hand that is not a decision to take automatically.
 */
export function reviewLayout(nodes: LayoutNode[], options: LayoutOptions = {}): LayoutReport {
  const minY = options.minY ?? -Infinity;
  const maxY = options.maxY ?? Infinity;
  const minX = options.minX ?? -Infinity;
  const maxX = options.maxX ?? Infinity;
  // 2000, from measuring a hand-maintained graph rather than from taste: its wires run to 3632, so a
  // tighter limit would fail the very code being used as the standard. Length alone is not a fault -
  // the p90 in the stats is the number that separates a tidy layout from a sprawling one.
  const maxWire = options.maxWire ?? 2000;
  const tooClose = options.tooClose ?? 40;
  // How far apart two unboxed nodes can be and still read as one system. Roughly a screen at normal
  // zoom: the measured gap BETWEEN the seven unboxed systems in a real graph was over 1900, and the
  // widest gap inside any one of them was well under this.
  const nearby = options.nearby ?? 900;

  // A node is in scope if its position is. A BOX is in scope if it REACHES into it - because a box
  // starts up and left of everything it holds, so its origin is routinely outside a region its
  // contents are well inside.
  //
  // Filtering boxes by origin reported "there is no comment box in scope" over fourteen nodes that
  // were sitting in two of them. That is the worst kind of wrong answer this tool can give: it
  // accuses correctly-organised work of being loose, and the obvious fix - drawing another box -
  // would have made a real overlap out of nothing.
  const inScope = (n: LayoutNode, x0: number, y0: number, x1: number, y1: number) =>
    x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY;
  const placed = nodes.filter((n) => {
    if (typeof n.x !== "number" || typeof n.y !== "number") return false;
    const x = n.x as number, y = n.y as number;
    if (!COMMENT_TYPE.test(n.type ?? "")) return y >= minY && y <= maxY && x >= minX && x <= maxX;
    const w = typeof n.width === "number" ? (n.width as number) : 0;
    const h = typeof n.height === "number" ? (n.height as number) : 0;
    return inScope(n, x, y, x + w, y + h);
  });
  const boxes = placed.filter((n) => COMMENT_TYPE.test(n.type ?? ""));
  const real = placed.filter((n) => !COMMENT_TYPE.test(n.type ?? ""));
  const byId = new Map(real.map((n) => [n.id ?? "", n]));

  const findings: LayoutFinding[] = [];
  let execWires = 0;
  let backwardWires = 0;
  const wireLengths: number[] = [];

  const name = (n: LayoutNode | undefined) => (n?.title ?? n?.id ?? "?").slice(0, 40);

  // --- flow direction, and wire length ---
  for (const n of real) {
    for (const line of n.pins ?? []) {
      const isExec = line.startsWith("out ") && EXEC_OUT.test(line);
      if (!line.includes("->")) continue;
      for (const id of targetsOf(line)) {
        const t = byId.get(id);
        if (!t) continue;
        if (isExec) {
          execWires++;
          if ((t.x as number) < (n.x as number)) {
            backwardWires++;
            findings.push({
              kind: "backwardFlow",
              detail: `${name(n)} runs on to ${name(t)}, which sits ${(n.x as number) - (t.x as number)} to its LEFT - the chain reads backwards here.`,
              nodes: [n.id ?? "", t.id ?? ""],
            });
          }
        }
        const dx = Math.abs((t.x as number) - (n.x as number));
        const dy = Math.abs((t.y as number) - (n.y as number));
        const len = Math.max(dx, dy);
        wireLengths.push(len);
        if (len > maxWire) {
          findings.push({
            kind: "longWire",
            // The remedy differs by wire kind, and the first version gave the exec answer for both.
            // You cannot route a data wire through a custom event - a value needs a variable, or the
            // source node moved nearer whatever reads it.
            detail: isExec
              ? `${name(n)} runs on to ${name(t)} ${len} away. A call through a custom event costs no wire at all.`
              : `${name(n)} feeds ${name(t)} from ${len} away. Move it beside what reads it, or carry the value in a variable.`,
            nodes: [n.id ?? "", t.id ?? ""],
          });
        }
      }
    }
  }

  // --- stacked or near-stacked nodes ---
  const solid = real.filter((n) => !KNOT_TYPE.test(n.type ?? ""));
  const sorted = [...solid].sort((a, b) => (a.x as number) - (b.x as number) || (a.y as number) - (b.y as number));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      if ((b.x as number) - (a.x as number) > tooClose) break; // sorted by x, so nothing further can be close
      if (Math.abs((b.y as number) - (a.y as number)) > tooClose) continue;
      const exact = a.x === b.x && a.y === b.y;
      findings.push({
        kind: "stacked",
        detail: exact
          ? `${name(a)} and ${name(b)} are at exactly the same place - one is hidden under the other.`
          : `${name(a)} and ${name(b)} are ${Math.max(Math.abs((b.x as number) - (a.x as number)), Math.abs((b.y as number) - (a.y as number)))} apart and will overlap on screen.`,
        nodes: [a.id ?? "", b.id ?? ""],
      });
    }
  }

  // --- nodes belonging to no comment box ---
  //
  // Needs the box's SIZE, not just its origin. The first version of this check compared against the
  // origin and an `&& true`, which made `.some()` succeed for any box up and left of the node - so it
  // could never report anything. A check that cannot fail is worse than no check: it reads as a clean
  // bill of health.
  //
  // So it runs only when the boxes actually carry dimensions, and says nothing when they do not,
  // rather than guessing containment from position alone.
  const sized = boxes.filter((b) => typeof b.width === "number" && typeof b.height === "number");
  // Only when the graph HAS boxes, which is deliberate and was re-tested rather than assumed.
  //
  // Running it on boxless graphs too looked obviously right - a graph with no comment boxes has
  // nothing boxed, and that is knowable. Measured, it took the project from 85 clean graphs to 3
  // and flagged BP_TestTarget, which has two nodes. It is wrong for the same reason every other
  // over-eager rule here was: this project's own convention is 54% of nodes in a box, and its
  // author leaves 30-to-60-node widget and anim graphs unboxed on purpose. Reporting those imposes
  // a rule the standard does not follow.
  //
  // The real complaint - that a boxless graph read as "clean" - is a reporting problem, and belongs
  // in the sweep's clean count rather than in the findings. Single-graph review already says
  // "there is no comment box in scope" instead of claiming everything is boxed.
  if (sized.length > 0) {
    const loose = solid.filter(
      (n) =>
        !sized.some(
          (b) =>
            (n.x as number) >= (b.x as number) &&
            (n.x as number) <= (b.x as number) + (b.width as number) &&
            (n.y as number) >= (b.y as number) &&
            (n.y as number) <= (b.y as number) + (b.height as number)
        )
    );
    // One finding per SYSTEM, not per node.
    //
    // This reported each loose node separately, and capped the list at 20 - so a real graph returned
    // twenty lines of "X is inside no comment box", all saying the same thing, with 56 more silently
    // dropped. Nothing in that tells you how many boxes are actually missing.
    //
    // Clustered by what they are wired to, those same 76 nodes are SEVEN systems, each with its own
    // entry event: IgnoreData, CE_ServerSound, UpdateLocalVanPing, ApplyTicketSkin, CE_TraceForMOMPing,
    // KillPlayer. That is seven boxes to draw, it is the shape the work actually takes, and it costs a
    // fraction of the tokens the node-by-node list did.
    const looseIds = new Set(loose.map((n) => n.id ?? ""));
    const parent = new Map<string, string>(loose.map((n) => [n.id ?? "", n.id ?? ""]));
    const find = (a: string): string => {
      let r = a;
      while (parent.get(r) !== r) r = parent.get(r) as string;
      while (parent.get(a) !== r) { const nxt = parent.get(a) as string; parent.set(a, r); a = nxt; }
      return r;
    };
    const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

    // Wired together is the strongest signal: these nodes run as one thing, so they want one box.
    for (const n of loose) {
      for (const line of n.pins ?? []) {
        if (!line.includes("->")) continue;
        for (const id of targetsOf(line)) if (looseIds.has(id)) union(n.id ?? "", id);
      }
    }
    // Then proximity, for the pure-data nodes that hang off a chain without being wired along it.
    // A person reads two nodes a screen apart as one system; a whole screen away, they do not.
    for (let i = 0; i < loose.length; i++) {
      for (let j = i + 1; j < loose.length; j++) {
        const a = loose[i], b = loose[j];
        if (Math.abs((a.x as number) - (b.x as number)) <= nearby && Math.abs((a.y as number) - (b.y as number)) <= nearby) {
          union(a.id ?? "", b.id ?? "");
        }
      }
    }

    const groups = new Map<string, LayoutNode[]>();
    for (const n of loose) {
      const root = find(n.id ?? "");
      (groups.get(root) ?? groups.set(root, []).get(root) as LayoutNode[]).push(n);
    }
    const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
    for (const g of clusters.slice(0, 12)) {
      // Named after its entry event, because that is what the system IS and what the box should be
      // titled. Without one there is nothing honest to call it, so it is described by size and place.
      // ALL its entry events, not the first. Proximity merges systems that sit next to each other,
      // and "17 nodes starting at KillPlayer" hid a second event inside the same cluster - which
      // reads as one system and is really two, so it would have suggested one box where two belong.
      const entries = g.filter((n) => isEntryType(n.type));
      const entry = entries[0];
      const entryNames = entries.slice(0, 3).map(name).join(", ");
      const label = entries.length > 3 ? `${entryNames} and ${entries.length - 3} more` : entryNames;
      const xs = g.map((n) => n.x as number), ys = g.map((n) => n.y as number);
      const where = `x ${Math.min(...xs)}, y ${Math.min(...ys)}`;
      findings.push({
        kind: "unboxed",
        detail:
          g.length === 1
            ? `${name(g[0])} sits in no comment box, at ${where}. A box owns the nodes inside it, so this one is left behind whenever a box is moved.`
            : entries.length > 1
              ? `${g.length} nodes in no comment box at ${where}, covering ${entries.length} entry points: ${label}. That is ${entries.length} systems sitting together - give each its own titled box.`
            : entry
              ? `${g.length} nodes starting at ${name(entry)} are in no comment box (${where}). They are wired as one system - give them one titled box so it can be read and moved as a unit.`
              : `${g.length} nodes at ${where} are in no comment box and have no entry event. They are wired together, so they want one titled box naming what they do.`,
        nodes: g.slice(0, 8).map((n) => n.id ?? ""),
        // The rectangle to actually draw, when one can be drawn safely.
        //
        // "Give them a titled box" left the caller to invent the geometry, and that is precisely
        // where this project's box faults come from: a box padded past its neighbour's edge makes
        // the partial overlap that corrupts both when either is dragged, and a box drawn a little
        // too wide adopts a node belonging to somebody else's system. Both were live bugs here.
        //
        // So the check that can already see every box and every node does the arithmetic, and says
        // nothing when there is no safe answer rather than offering a rectangle that would need
        // fixing afterwards.
        ...(() => {
          // A cluster with several entry events is several systems, and refusing it outright left
          // the largest bucket unserved: measured over the project, 53 of 100 unboxed findings were
          // multi-entry, against 20 unnameable and 12 with no room. Each event owns the run of nodes
          // reachable from it, so each gets its own box - which is what the nesting convention says
          // anyway, and what boxesForBatch already does when building.
          const groups = entries.length > 1 ? splitByEntry(g) : [{ title: entry ? name(entry) : "", nodes: g }];
          const drawn: NonNullable<LayoutFinding["suggest"]> = [];
          const nearMiss: string[] = [];
          // Each box must clear the ones already suggested here, not just the ones on the canvas.
          const against = [...sized];
          for (const part of groups) {
            const s = safeBoxAround(part.nodes, against, solid, houseTitle(part.title));
            if (!s) continue;
            if ("blockedBy" in s) {
              nearMiss.push(`"${s.title}" needs ${s.blockedBy.map((n) => name(n)).join(" and ")} moved out of the way`);
              continue;
            }
            drawn.push(s.box);
            against.push({ type: "EdGraphNode_Comment", x: s.box.x, y: s.box.y, width: s.box.width, height: s.box.height });
          }
          return {
            ...(drawn.length > 0 ? { suggest: drawn } : {}),
            ...(nearMiss.length > 0 ? { almost: nearMiss.slice(0, 3) } : {}),
          };
        })(),
      });
    }
  }

  const sortedWires = [...wireLengths].sort((a, b) => a - b);
  const at = (p: number) => (sortedWires.length === 0 ? 0 : sortedWires[Math.min(sortedWires.length - 1, Math.floor(sortedWires.length * p))]);

  // --- boxes that half-overlap ---
  //
  // Worse than any other fault here, and the one this checker missed while its author hit it by
  // hand: in the editor a comment box OWNS the nodes inside it and drags them. Two boxes that share
  // a region both claim the same nodes, so moving either corrupts the other, and which nodes belong
  // to which is decided by whichever was clicked.
  //
  // Nesting is fine and is the convention here - 40 nested pairs in one hand-organised graph, an
  // outer box naming the system and inner ones naming its parts. Only PARTIAL overlap is a fault.
  const sizedBoxes = boxes.filter((b) => typeof b.width === "number" && typeof b.height === "number");
  const contains = (outer: LayoutNode, inner: LayoutNode) =>
    (inner.x as number) >= (outer.x as number) &&
    (inner.y as number) >= (outer.y as number) &&
    (inner.x as number) + (inner.width as number) <= (outer.x as number) + (outer.width as number) &&
    (inner.y as number) + (inner.height as number) <= (outer.y as number) + (outer.height as number);

  for (let i = 0; i < sizedBoxes.length; i++) {
    for (let j = i + 1; j < sizedBoxes.length; j++) {
      const a = sizedBoxes[i], b = sizedBoxes[j];
      const overlaps =
        (a.x as number) < (b.x as number) + (b.width as number) &&
        (b.x as number) < (a.x as number) + (a.width as number) &&
        (a.y as number) < (b.y as number) + (b.height as number) &&
        (b.y as number) < (a.y as number) + (a.height as number);
      if (!overlaps || contains(a, b) || contains(b, a)) continue;

      // The harm is not the geometry, it is the nodes caught in the shared region: both boxes claim
      // them, and dragging either takes them. So ask that directly, instead of measuring rectangles.
      //
      // Measured on a hand-maintained graph, this is the whole difference between signal and noise.
      // Of nine overlaps, four shared a region 16 to 64 units thin - a hairline from dragging a box
      // by hand, with nothing inside it and nothing that can go wrong. The other five each had real
      // nodes in the contested area, including six caught between "Interacts" and "Recoil".
      //
      // It also makes the finding actionable: it can now say WHICH nodes are contested, which is the
      // thing you need in order to fix it.
      const x0 = Math.max(a.x as number, b.x as number);
      const x1 = Math.min((a.x as number) + (a.width as number), (b.x as number) + (b.width as number));
      const y0 = Math.max(a.y as number, b.y as number);
      const y1 = Math.min((a.y as number) + (a.height as number), (b.y as number) + (b.height as number));
      const contested = solid.filter(
        (n) => (n.x as number) >= x0 && (n.x as number) <= x1 && (n.y as number) >= y0 && (n.y as number) <= y1
      );
      if (contested.length === 0) continue;

      const boxName = (n: LayoutNode) => ((n.text ?? "").split("\n")[0] || "an untitled box").slice(0, 34);
      const caught = contested.slice(0, 3).map((n) => name(n)).join(", ");
      const more = contested.length > 3 ? ` and ${contested.length - 3} more` : "";
      findings.push({
        kind: "overlappingBoxes",
        detail: `"${boxName(a)}" and "${boxName(b)}" half-overlap, and ${contested.length === 1 ? "1 node is" : `${contested.length} nodes are`} caught in the shared region: ${caught}${more}. Both boxes claim ${contested.length === 1 ? "it" : "them"}, so dragging either takes ${contested.length === 1 ? "it" : "them"} out of the other. Nest one inside the other, or separate them.`,
        nodes: [a.id ?? "", b.id ?? "", ...contested.slice(0, 6).map((n) => n.id ?? "")],
      });
    }
  }

  // --- boxes that group without naming ---
  //
  // Half the convention is the box; the other half is what it says. In this project every system
  // carries a name a person navigates by - Vaccum, Inputs, Healing, Spawn Ping - and an untitled box
  // draws a rectangle round some nodes while explaining nothing about them.
  // --- a titled box with nothing in it ---
  //
  // Found by accident and then measured: 17 of this project's 377 boxes hold nothing at all, and
  // ELEVEN of those are in one graph - the same graph the sweep flags as the outlier at wire p90
  // 2840. That graph has 63 of its 206 nodes at x=0 and only 21 distinct x values across a 6928-unit
  // span, which is column-grid output from an automatic layout, not a hand-built graph.
  //
  // So the boxes are not decoration somebody forgot to fill. A relayout moved the nodes and left the
  // boxes where they were, and "Countdown", "Win Screen" and "Begin Play" now name empty rectangles
  // while the code they described sits elsewhere. That is the box-ownership problem at full scale,
  // and it is invisible to every other check here: the nodes are fine, the boxes are fine, and the
  // relationship between them is gone.
  //
  // A box holding only other boxes is NOT empty - that is the nesting convention, an outer box whose
  // parts each have their own.
  //
  // A DUPLICATE box title is deliberately not checked, having been measured and rejected. Seven
  // exist across three graphs, and none is a fault: WB_ShopSlot's three pairs are each offset by
  // exactly +1296, a copied UI block, and BP_Player's "Vaccum"/"Vacuum Push" pairs are separate
  // populated systems that happen to share a name. Emptiness is the signal that actually separates
  // leftover from real - the one duplicate worth removing was empty, and this check already had it.
  for (const b of sized) {
    const title = (b.text ?? "").split("\n")[0].trim();
    if (!title) continue; // untitled boxes are reported below, and one finding per box is enough
    const holdsAnything = placed.some((n) => {
      if (n === b) return false;
      if (KNOT_TYPE.test(n.type ?? "")) return false;
      return (
        (n.x as number) >= (b.x as number) &&
        (n.x as number) <= (b.x as number) + (b.width as number) &&
        (n.y as number) >= (b.y as number) &&
        (n.y as number) <= (b.y as number) + (b.height as number)
      );
    });
    if (holdsAnything) continue;
    findings.push({
      kind: "emptyBox",
      detail: `"${title}" is a comment box with nothing inside it (${b.width}x${b.height} at ${b.x}, ${b.y}). Either the nodes it described were moved out from under it - a whole-graph relayout does this - or it is a leftover. Delete it or put its system back inside it.`,
      nodes: [b.id ?? ""],
    });
  }

  for (const b of boxes) {
    const title = (b.text ?? "").trim();
    if (title.length > 0) continue;
    findings.push({
      kind: "untitledBox",
      detail: `A comment box at ${b.x}, ${b.y} has no text. A box groups nodes; its title is what says which system they are.`,
      nodes: [b.id ?? ""],
    });
  }

  return {
    findings,
    stats: {
      nodes: real.length,
      commentBoxes: boxes.length,
      execWires,
      backwardWires,
      wireMedian: at(0.5),
      wireP90: at(0.9),
      wireMax: sortedWires[sortedWires.length - 1] ?? 0,
    },
  };
}

/**
 * What this project's layout actually looks like, measured rather than assumed.
 *
 * Every threshold in the reviewer above started as a guess, and the ones that were wrong were wrong
 * because nothing here knew what normal looked like in this codebase. The same gap hurts a model
 * BUILDING a graph: told to "use comment boxes", it has no idea whether a box here holds 3 nodes or
 * 30, or whether titles are `Firing` or `GUN VFX SPAWN NODE, CAN ADD MORE`.
 *
 * These are per-graph tallies, kept as raw counts so a sweep can add them up across a project and
 * take medians over the whole thing. A single graph is not a convention.
 */
export interface StyleSample {
  nodes: number;
  nodesInBoxes: number;
  boxes: number;
  /** Direct node count per box, for a median over the project. */
  perBox: number[];
  /** Word counts of box titles, and how many are shouted in caps. */
  titleWords: number[];
  upperTitles: number;
  /** Boxes wholly inside another box - the outer-system, inner-part convention. */
  nested: number;
}

export function measureStyle(nodes: LayoutNode[]): StyleSample {
  const placed = nodes.filter((n) => typeof n.x === "number" && typeof n.y === "number");
  const boxes = placed.filter(
    (n) => COMMENT_TYPE.test(n.type ?? "") && typeof n.width === "number" && typeof n.height === "number"
  );
  const real = placed.filter((n) => !COMMENT_TYPE.test(n.type ?? "") && !KNOT_TYPE.test(n.type ?? ""));

  const holds = (b: LayoutNode, n: LayoutNode) =>
    (n.x as number) >= (b.x as number) &&
    (n.x as number) <= (b.x as number) + (b.width as number) &&
    (n.y as number) >= (b.y as number) &&
    (n.y as number) <= (b.y as number) + (b.height as number);

  const inAny = real.filter((n) => boxes.some((b) => holds(b, n)));

  // DIRECT contents: a node in a nested box belongs to the inner one. Counting it for the outer box
  // too would make every outer box look enormous and teach exactly the wrong lesson about size.
  const perBox: number[] = [];
  for (const b of boxes) {
    const mine = real.filter((n) => {
      if (!holds(b, n)) return false;
      return !boxes.some(
        (o) =>
          o !== b &&
          holds(o, n) &&
          (o.width as number) * (o.height as number) < (b.width as number) * (b.height as number)
      );
    });
    perBox.push(mine.length);
  }

  const titleWords: number[] = [];
  let upperTitles = 0;
  for (const b of boxes) {
    const title = ((b.text ?? "").split("\n")[0] ?? "").trim();
    if (!title) continue;
    titleWords.push(title.split(/\s+/).length);
    if (title === title.toUpperCase() && /[A-Z]/.test(title)) upperTitles++;
  }

  let nested = 0;
  for (const a of boxes) {
    for (const b of boxes) {
      if (a === b) continue;
      if (
        (b.x as number) >= (a.x as number) &&
        (b.y as number) >= (a.y as number) &&
        (b.x as number) + (b.width as number) <= (a.x as number) + (a.width as number) &&
        (b.y as number) + (b.height as number) <= (a.y as number) + (a.height as number)
      ) {
        nested++;
      }
    }
  }

  return { nodes: real.length, nodesInBoxes: inAny.length, boxes: boxes.length, perBox, titleWords, upperTitles, nested };
}
