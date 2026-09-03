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
  /** Flattened wiring, e.g. "out then -> A1B2C3D4.execute". */
  pins?: string[];
}

export interface LayoutFinding {
  /** Short machine-readable kind, so a caller can filter. */
  kind: "backwardFlow" | "stacked" | "unboxed" | "longWire";
  /** One sentence a person can act on. */
  detail: string;
  nodes: string[];
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
  /** A wire longer than this reads as a canvas-crossing run. */
  maxWire?: number;
  /** Nodes closer than this in both axes are visually on top of each other. */
  tooClose?: number;
}

const COMMENT_TYPE = /Comment/i;

/** Exec pin names, which are what carry reading order. Data pins are not direction-checked. */
const EXEC_OUT = /^out (then|Then \d+|LoopBody|Completed|execute|Exec)\b/i;

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
  // 2000, from measuring a hand-maintained graph rather than from taste: its wires run to 3632, so a
  // tighter limit would fail the very code being used as the standard. Length alone is not a fault -
  // the p90 in the stats is the number that separates a tidy layout from a sprawling one.
  const maxWire = options.maxWire ?? 2000;
  const tooClose = options.tooClose ?? 40;

  const placed = nodes.filter(
    (n) => typeof n.x === "number" && typeof n.y === "number" && (n.y as number) >= minY && (n.y as number) <= maxY
  );
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
  const sorted = [...real].sort((a, b) => (a.x as number) - (b.x as number) || (a.y as number) - (b.y as number));
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
  if (sized.length > 0) {
    const loose = real.filter(
      (n) =>
        !sized.some(
          (b) =>
            (n.x as number) >= (b.x as number) &&
            (n.x as number) <= (b.x as number) + (b.width as number) &&
            (n.y as number) >= (b.y as number) &&
            (n.y as number) <= (b.y as number) + (b.height as number)
        )
    );
    for (const n of loose.slice(0, 20)) {
      findings.push({
        kind: "unboxed",
        detail: `${name(n)} is inside no comment box. A box owns the nodes within it, so this one is left behind when the box is moved.`,
        nodes: [n.id ?? ""],
      });
    }
  }

  const sortedWires = [...wireLengths].sort((a, b) => a - b);
  const at = (p: number) => (sortedWires.length === 0 ? 0 : sortedWires[Math.min(sortedWires.length - 1, Math.floor(sortedWires.length * p))]);

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
