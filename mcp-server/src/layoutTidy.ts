/**
 * Tidy a system's layout: make the flow read rightward, and pull its inputs in beside what reads them.
 *
 * `review_layout` says what is wrong. This fixes the two faults worth fixing mechanically, and it
 * exists because doing it by hand took three passes and produced two new bugs on the way - a node
 * moved onto another, and a pass computed against a stale snapshot. Both are the kind of mistake a
 * function does not make twice.
 *
 * ## Why it refuses to work on a whole graph
 *
 * `auto_layout_graph` relays out everything, and on a graph somebody maintains by hand that is a far
 * larger change than the one being asked for - measured once at 209 nodes moved to place four. This
 * takes a SCOPE and moves nothing outside it, so tidying what you added cannot disturb what was
 * already there. A call with no scope is refused rather than quietly interpreted as "all of it".
 *
 * ## The two passes
 *
 * **Straighten.** Every execution wire should point rightward; that is the measurable form of "reads
 * like a book". Hand-written code in this project manages 306 exec wires with 0 backwards. A chain
 * is only monotonic if every step is, so pushing one node right can expose the next - it repeats
 * until nothing points left, rather than fixing a list of coordinates once.
 *
 * **Compact.** Pure nodes - getters, maths, casts with no exec pins - have no place they must be,
 * only a place they should be. Moving them beside what they touch took the generated system's p90
 * wire length from 1068 to 672, against 608 for the hand-built code beside it. Distance is measured
 * to everything wired to a node, in BOTH directions: the first version looked only at outputs, so a
 * node whose consumer was close but whose source was 2000 away looked settled and never moved.
 *
 * Y is left alone in the straighten pass. Rows carry meaning - a loop body on one line with its
 * inputs hanging below - and moving vertically trades one kind of mess for another.
 */

export interface TidyNode {
  id?: string;
  type?: string;
  title?: string;
  x?: number;
  y?: number;
  pins?: string[];
  /** Comment boxes only: how far the box extends, so a move can be checked against its edges. */
  width?: number;
  height?: number;
}

export interface TidyMove {
  nodeId: string;
  x: number;
  y: number;
  /** Which pass asked for it, so a caller can see what the tidy actually did. */
  reason: "straighten" | "compact";
  /**
   * The box that must grow first for this move to be safe, if any.
   *
   * Recorded rather than re-derived. The caller used to work it out from geometry - "is this move
   * past the box's right edge" - against the GROWN extent, so a move landing inside the grown box
   * but outside the real one passed the test and was applied anyway. Measured end to end: the
   * resize was refused by an older plugin, the moves were supposedly dropped, and a node still left
   * its box. The planner knows which move needed which growth; nobody else should have to guess.
   */
  needsBox?: string;
}

/** A box that must grow so a tidied chain stays inside the system that owns it. */
export interface BoxGrowth {
  boxId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TidyOptions {
  /** Nodes at or below this Y are in scope. At least one bound is required. */
  minY?: number;
  maxY?: number;
  /** Horizontal air between a node and the next in its chain. */
  gap?: number;
  /** A node further than this from what it wires to is worth moving. */
  pullOver?: number;
  /** Two nodes closer than this in both axes collide on screen. */
  clearX?: number;
  clearY?: number;
}

/**
 * Exec pins, named by the node rather than by any convention.
 *
 * A Branch's second output is "else", a Sequence's are "then_0" and "then_1", a Switch Has Authority
 * says "Authority", an Is Valid macro says "Is Valid". The list here knew none of those, so on one
 * real graph it saw 69 execution wires where there were 82, and this pass could not straighten a
 * chain that went through a Branch's else - four such wires were sitting unstraightened in a system
 * this tool had been calling clean.
 *
 * An exec output lands on an exec input, spelled .execute or .exec whatever the source is called, so
 * the target settles the cases the names miss.
 */
const EXEC = /^(in|out) (then|then_\d+|Then \d+|LoopBody|Loop Body|Completed|else|execute|Exec)\b/i;
const EXEC_OUT = /^out (then|then_\d+|Then \d+|LoopBody|Loop Body|Completed|else|execute|Exec)\b/i;
const EXEC_TARGET = /->\s*[^,]*\.(execute|exec)\b/i;
const isExecOut = (line: string) => line.startsWith("out ") && (EXEC_OUT.test(line) || EXEC_TARGET.test(line));
const hasExecPin = (line: string) => EXEC.test(line) || (line.startsWith("out ") && EXEC_TARGET.test(line));
const COMMENT = /Comment/i;

function targets(line: string): string[] {
  const arrow = line.includes("->") ? "->" : "<-";
  const rhs = line.split(arrow)[1];
  if (!rhs) return [];
  return rhs.split(",").map((p) => p.trim().split(".")[0]).filter(Boolean);
}

/** Everything a node is wired to, either direction. Half a view produces half a layout. */
function neighbourIds(n: TidyNode): string[] {
  const out: string[] = [];
  for (const line of n.pins ?? []) {
    if (!line.includes("->") && !line.includes("<-")) continue;
    out.push(...targets(line));
  }
  return out;
}

function execTargets(n: TidyNode): string[] {
  const out: string[] = [];
  for (const line of n.pins ?? []) {
    if (!isExecOut(line) || !line.includes("->")) continue;
    out.push(...targets(line));
  }
  return out;
}

/** A getter or a bit of maths: no exec pin either way, so it has no place it MUST be. */
const isPure = (n: TidyNode) => !(n.pins ?? []).some((l) => hasExecPin(l));

/**
 * Work out where a system's nodes should sit.
 *
 * Pure: takes nodes and returns moves. The editor is touched by the caller, so the part with the
 * arithmetic in it is testable without one.
 */
export function planTidy(
  all: TidyNode[],
  options: TidyOptions
): { moves: TidyMove[]; growths: BoxGrowth[]; scoped: number; heldByBox: number } {
  const gap = options.gap ?? 220;
  const pullOver = options.pullOver ?? 700;
  const clearX = options.clearX ?? 150;
  const clearY = options.clearY ?? 60;
  const minY = options.minY ?? -Infinity;
  const maxY = options.maxY ?? Infinity;

  const scoped = all.filter(
    (n) =>
      typeof n.x === "number" &&
      typeof n.y === "number" &&
      !COMMENT.test(n.type ?? "") &&
      (n.y as number) >= minY &&
      (n.y as number) <= maxY
  );
  const byId = new Map(scoped.map((n) => [n.id ?? "", n]));
  const pos = new Map(scoped.map((n) => [n.id ?? "", { x: n.x as number, y: n.y as number }]));
  const moved = new Map<string, TidyMove["reason"]>();

  // --- straighten: every exec wire points rightward ---
  //
  // Capped rather than while(true): a graph with an exec cycle would otherwise push nodes right
  // forever, and a layout pass that hangs is worse than one that gives up and says so.
  for (let pass = 0; pass < 40; pass++) {
    let fixed = 0;
    for (const n of scoped) {
      const from = pos.get(n.id ?? "");
      if (!from) continue;
      for (const id of execTargets(n)) {
        const to = pos.get(id);
        if (!to || to.x >= from.x + gap) continue;
        to.x = from.x + gap;
        moved.set(id, "straighten");
        fixed++;
      }
    }
    if (fixed === 0) break;
  }

  // --- separate: no straightened node may sit on another ---
  //
  // The straighten pass sets x and checks nothing, and only the compact pass looked for collisions.
  // So a straighten could drop a node onto one already standing there: measured on a real system,
  // which came back reporting "Add and Cast To BP_VirusData are 33 apart" that the tidy itself had
  // just created. A pass that fixes one fault by causing another is not a fix.
  //
  // This runs AFTER straightening rather than inside it, which was tried first and was worse: mid-
  // pass, every node in a chain collides with its own successors, which have not moved yet. One
  // node slid from x 220 to 370 to avoid a node that was about to leave. Separating once the chain
  // has settled avoids reacting to positions nobody is keeping.
  //
  // Only nodes this pass MOVED are nudged, and only rightward, which cannot break the rightward
  // invariant that straightening just established.
  for (let pass = 0; pass < 6; pass++) {
    let bumped = 0;
    for (const [id] of moved) {
      const me = pos.get(id);
      if (!me) continue;
      for (let tries = 0; tries < 8; tries++) {
        const clash = scoped.some((o) => {
          const oid = o.id ?? "";
          if (oid === id) return false;
          const p = pos.get(oid);
          return !!p && Math.abs(p.x - me.x) < clearX && Math.abs(p.y - me.y) < clearY;
        });
        if (!clash) break;
        me.x += clearX;
        bumped++;
      }
    }
    if (bumped === 0) break;
  }

  // --- compact: pure nodes move beside what they touch ---
  const occupied = (x: number, y: number, selfId: string) =>
    scoped.some((o) => {
      if ((o.id ?? "") === selfId) return false;
      const p = pos.get(o.id ?? "");
      return !!p && Math.abs(p.x - x) < clearX && Math.abs(p.y - y) < clearY;
    });

  const worstOf = (id: string, at: { x: number; y: number }, ns: TidyNode[]) =>
    ns.reduce((w, c) => {
      const p = pos.get(c.id ?? "");
      return p ? Math.max(w, Math.abs(p.x - at.x), Math.abs(p.y - at.y)) : w;
    }, 0);

  const candidates = scoped
    .filter((n) => isPure(n))
    .map((n) => {
      const ns = neighbourIds(n).map((id) => byId.get(id)).filter(Boolean) as TidyNode[];
      return { n, ns, worst: ns.length ? worstOf(n.id ?? "", pos.get(n.id ?? "")!, ns) : 0 };
    })
    .filter((c) => c.ns.length > 0 && c.worst > pullOver)
    // Worst first, so the biggest wins land before the space around them fills up.
    .sort((a, b) => b.worst - a.worst);

  for (const { n, ns } of candidates) {
    const id = n.id ?? "";
    const here = pos.get(id);
    if (!here) continue;
    const targetX = Math.round(ns.reduce((t, c) => t + (pos.get(c.id ?? "")?.x ?? 0), 0) / ns.length) - 120;
    const targetY = Math.round(ns.reduce((t, c) => t + (pos.get(c.id ?? "")?.y ?? 0), 0) / ns.length);

    let placed: { x: number; y: number } | undefined;
    for (const dy of [0, 70, -70, 140, -140, 210, -210, 280, -280]) {
      for (const dx of [0, -160, -320]) {
        const cand = { x: targetX + dx, y: targetY + dy };
        if (!occupied(cand.x, cand.y, id)) { placed = cand; break; }
      }
      if (placed) break;
    }
    if (!placed) continue;
    // Never make a node worse off than it was. Without this a crowded target can push a node further
    // from its neighbours than where it started.
    if (worstOf(id, placed, ns) >= worstOf(id, here, ns)) continue;

    pos.set(id, placed);
    moved.set(id, "compact");
  }

  // --- a move must not change which comment box owns the node ---
  //
  // This pass filtered comment boxes out entirely and so had no idea they existed, while a box OWNS
  // what is inside it. Both directions were demonstrable: straightening a five-node chain pushed its
  // last node from x 160 to x 880, out through the right edge of a box ending at 700; and compacting
  // pulled a node at x -5000 to x 440, INTO a box that had never held it.
  //
  // Either way the node quietly changes system - it now moves with a box it does not belong to, or
  // stops moving with the one it does - and nothing in the graph shows that happened. A tidier that
  // silently re-homes nodes is worse than an untidy graph.
  //
  // The fix is to refuse, not to resize. Growing the box to keep the node would be what a person
  // does, but there is no resize in the bridge, and adding one means a C++ rebuild with the editor
  // closed. A refused move leaves a wire slightly less straight, which is the smaller harm and an
  // honest one, so refusals are counted and reported rather than hidden.
  const boxes = all.filter(
    (n) =>
      COMMENT.test(n.type ?? "") &&
      typeof n.x === "number" &&
      typeof n.y === "number" &&
      typeof n.width === "number" &&
      typeof n.height === "number"
  );
  const ownersOf = (x: number, y: number) =>
    boxes
      .filter(
        (b) =>
          x >= (b.x as number) &&
          x <= (b.x as number) + (b.width as number) &&
          y >= (b.y as number) &&
          y <= (b.y as number) + (b.height as number)
      )
      .map((b) => b.id ?? "")
      .sort()
      .join("|");

  // Live box extents, so a second growth sees the first.
  const extent = new Map(
    boxes.map((b) => [
      b.id ?? "",
      { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number },
    ])
  );
  const holds = (e: { x: number; y: number; width: number; height: number }, x: number, y: number) =>
    x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height;

  /**
   * Can this box grow to keep a node that has moved just outside it?
   *
   * Growing is what a person does when a chain outgrows its box, but it is only safe when the new
   * area is empty. A box that grows over somebody else's node CAPTURES it - the same ownership bug
   * in the other direction - and a box that grows into another box makes the partial overlap that
   * corrupts both when either is dragged.
   */
  const growthFor = (boxId: string, x: number, y: number, movingId: string) => {
    const e = extent.get(boxId);
    if (!e) return undefined;
    const pad = 80;
    const x0 = Math.min(e.x, x - pad);
    const y0 = Math.min(e.y, y - pad);
    const x1 = Math.max(e.x + e.width, x + pad);
    const y1 = Math.max(e.y + e.height, y + pad);
    const grown = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };

    for (const other of scoped) {
      const oid = other.id ?? "";
      const p = pos.get(oid);
      if (!p) continue;
      // Newly covered ground must be empty. A node already inside stays inside; one outside must
      // stay outside, or growing the box silently adopts it.
      // Skipped by ID, not by position. Comparing coordinates matched any node that happened to
      // sit where the moving one lands, so a stranger already standing there was mistaken for the
      // node being moved and the box grew over it - the adoption bug this check exists to stop.
      if (oid === movingId) continue;
      // Membership BEFORE is judged on where the node started, against the box as it started.
      // Judging it on the final position was wrong in a way that only showed up once boxes could
      // grow: a node the tidy had already pushed out looked like it was never a member, and the
      // grown box was then free to swallow something it should not have.
      const orig = byId.get(oid);
      const wasIn = !!orig && holds(e, orig.x as number, orig.y as number);
      if (!wasIn && holds(grown, p.x, p.y)) return undefined;
    }
    for (const [otherId, o] of extent) {
      if (otherId === boxId) continue;
      const overlaps = grown.x < o.x + o.width && o.x < grown.x + grown.width && grown.y < o.y + o.height && o.y < grown.y + grown.height;
      if (!overlaps) continue;
      const nests =
        (grown.x >= o.x && grown.y >= o.y && grown.x + grown.width <= o.x + o.width && grown.y + grown.height <= o.y + o.height) ||
        (o.x >= grown.x && o.y >= grown.y && o.x + o.width <= grown.x + grown.width && o.y + o.height <= grown.y + grown.height);
      if (!nests) return undefined;
    }
    return grown;
  };

  const moves: TidyMove[] = [];
  const growths: BoxGrowth[] = [];
  let heldByBox = 0;
  for (const [id, reason] of moved) {
    const p = pos.get(id);
    const was = byId.get(id);
    if (!p || !was) continue;
    if (p.x === was.x && p.y === was.y) continue; // pushed and pushed back

    let needsBox: string | undefined;
    if (boxes.length > 0) {
      const before = ownersOf(was.x as number, was.y as number);
      if (ownersOf(p.x, p.y) !== before) {
        // Entering a box it was never in cannot be fixed by growing - the answer would be to shrink
        // somebody else's box, which is not this pass's to do. Refuse.
        const left = before.split("|").filter(Boolean);
        const entered = ownersOf(p.x, p.y).split("|").filter(Boolean).some((b) => !left.includes(b));
        const grown = entered ? undefined : left.map((b) => ({ b, g: growthFor(b, p.x, p.y, id) })).find((r) => r.g);
        if (!grown || !grown.g) {
          heldByBox++;
          continue;
        }
        extent.set(grown.b, grown.g);
        growths.push({ boxId: grown.b, ...grown.g });
        needsBox = grown.b;
      }
    }
    moves.push({ nodeId: id, x: p.x, y: p.y, reason, ...(needsBox ? { needsBox } : {}) });
  }
  return { moves, growths, scoped: scoped.length, heldByBox };
}
