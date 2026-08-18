/**
 * Put a node behind an authority check, without breaking the chain it is already in.
 *
 * This is the mechanical half of the most expensive finding this project knows how to make. A
 * GameMode exists only on the server, so casting to one from a PlayerController, a Pawn, a
 * GameState or a widget fails on every client - silently, taking every node after it with it. A
 * real project had twelve of them.
 *
 * The fix is always the same shape: run that part only where it can work. What it is NOT is a
 * decision about design - moving the state to the GameState may well be the better answer, and this
 * cannot know that. It does the edit people would otherwise do by hand, correctly, and says exactly
 * what it changed.
 *
 * ## Why this and not a general "insert a node" tool
 *
 * Because the general version has to be told how to wire itself, and getting that wrong silently
 * rearranges someone's graph. This knows the one shape it is building:
 *
 *     before:   ...predecessors -> TARGET
 *     after:    ...predecessors -> Branch(HasAuthority) --true--> TARGET
 *
 * ## Safety
 *
 * Three things, in order of how much they matter:
 *
 *   - It refuses when the target has no incoming execution at all. There is nothing to guard, and
 *     guessing would mean inventing a chain.
 *   - `dryRun` reports the exact edit without making it.
 *   - Afterwards it re-reads the graph and checks the target is now reached through the Branch, and
 *     that the Blueprint still compiles. An edit tool that reports success without looking is how a
 *     working project gets broken quietly.
 */

import type { BridgeLike } from "./autoLayout.js";

export interface AuthorityGuardOptions {
  /** Report what would change without changing it. */
  dryRun?: boolean;
  /** Compile afterwards to prove the graph is still valid. Defaults to true. */
  compile?: boolean;
}

export interface AuthorityGuardResult {
  path: string;
  graphName: string;
  targetNodeId: string;
  targetTitle: string;
  dryRun: boolean;
  /** The exec links that were rerouted through the guard. */
  rerouted: Array<{ fromNode: string; fromPin: string }>;
  guarded: boolean;
  compiled?: unknown;
  /** Compile errors before this edit, so "did I break it" is a comparison and not a guess. */
  errorsBefore?: number;
  errorsAfter?: number;
  /** True only when this edit made the compile worse than it already was. */
  introducedErrors?: boolean;
  verified: boolean;
  summary: string;
}

interface SummaryNode {
  id: string;
  type: string;
  title: string;
  connectedPins?: Array<{ pin: string; direction: string; linkedTo?: Array<{ node: string; pin: string }> }>;
}

const EXEC_INPUT = /^(execute|exec|in|then)$/i;

export async function guardWithAuthority(
  bridge: BridgeLike,
  path: string,
  graphName: string,
  targetNodeId: string,
  options: AuthorityGuardOptions = {}
): Promise<AuthorityGuardResult> {
  const dryRun = options.dryRun === true;

  const summary = await bridge.send<{ nodes: SummaryNode[] }>("read_blueprint_graph_summary", {
    path,
    graphName,
  });
  const nodes = summary.nodes ?? [];

  // Accept a short prefix of the id, because that is what a person copies out of a report.
  const target = nodes.find((n) => n.id === targetNodeId || n.id.startsWith(targetNodeId));
  if (!target) {
    throw new Error(
      `node_not_found: no node in ${graphName} with id starting "${targetNodeId}". ` +
        `Ids come from unreal_read_blueprint_summary.`
    );
  }

  // Who currently runs into it. An exec output pin can only have one link, so rerouting these is
  // what actually moves the target behind the guard.
  const rerouted: Array<{ fromNode: string; fromPin: string }> = [];
  for (const node of nodes) {
    for (const pin of node.connectedPins ?? []) {
      if (pin.direction !== "out") continue;
      for (const link of pin.linkedTo ?? []) {
        if (link.node !== target.id) continue;
        if (!EXEC_INPUT.test(link.pin)) continue;
        rerouted.push({ fromNode: node.id, fromPin: pin.pin });
      }
    }
  }

  const result: AuthorityGuardResult = {
    path,
    graphName,
    targetNodeId: target.id,
    targetTitle: target.title,
    dryRun,
    rerouted,
    guarded: false,
    verified: false,
    summary: "",
  };

  if (rerouted.length === 0) {
    throw new Error(
      `nothing_to_guard: "${target.title}" has no incoming execution, so there is no chain to put a ` +
        `guard in front of. If it is meant to run, wire it up first.`
    );
  }

  if (dryRun) {
    result.summary =
      `Dry run: nothing changed. Would insert Branch(HasAuthority) in front of "${target.title}", ` +
      `rerouting ${rerouted.length} incoming execution link(s) through it, so the node runs only on ` +
      `the server.`;
    return result;
  }

  // What the Blueprint's compile looked like before touching it, so "did this break anything" can be
  // answered by comparison rather than by hoping.
  let errorsBefore = 0;
  if (options.compile !== false) {
    const before = await bridge.send<{ errorCount?: number }>("compile_blueprint", { path }).catch(() => null);
    errorsBefore = before?.errorCount ?? 0;
  }

  // The guard itself. Built in one call so a failure leaves nothing half-made.
  const built = await bridge.send<{ nodes: Record<string, { id: string }> }>("build_graph", {
    path,
    graphName,
    nodes: [
      { ref: "mcpHasAuthority", nodeType: "CallFunction", functionName: "HasAuthority", className: "Actor" },
      { ref: "mcpAuthorityBranch", nodeType: "Branch" },
    ],
    // "then" is the true pin's real name; the editor displays it as True.
    connections: [{ from: "mcpHasAuthority.ReturnValue", to: "mcpAuthorityBranch.Condition" }],
  });

  const branchId = built.nodes?.mcpAuthorityBranch?.id;
  if (!branchId) {
    throw new Error("guard_build_failed: the Branch node was not created, so nothing was rewired.");
  }

  // Point the predecessors at the guard. Each of these replaces the old link, because an execution
  // output pin can only feed one thing.
  for (const link of rerouted) {
    await bridge.send("connect_pins", {
      path,
      graphName,
      sourceNodeId: link.fromNode,
      sourcePin: link.fromPin,
      targetNodeId: branchId,
      targetPin: "execute",
    });
  }

  // ...and the guard's true path at the target.
  await bridge.send("connect_pins", {
    path,
    graphName,
    sourceNodeId: branchId,
    sourcePin: "then",
    targetNodeId: target.id,
    targetPin: "execute",
  });
  result.guarded = true;

  if (options.compile !== false) {
    result.compiled = await bridge.send<{ errorCount?: number }>("compile_blueprint", { path });
    // Compared against the count from BEFORE the edit, not against zero.
    //
    // Real Blueprints are not always clean, and refusing to report success because a graph already
    // had two unrelated errors would make this useless exactly where it is needed. What matters is
    // whether THIS edit made things worse, which is a different question and the only one this tool
    // can answer honestly.
    const after = (result.compiled as { errorCount?: number })?.errorCount ?? 0;
    result.errorsBefore = errorsBefore;
    result.errorsAfter = after;
    result.introducedErrors = after > errorsBefore;
  }

  // Look, rather than assume. The whole risk of an editing tool is reporting a success it did not
  // check.
  const after = await bridge.send<{ nodes: SummaryNode[] }>("read_blueprint_graph_summary", { path, graphName });
  const branchAfter = (after.nodes ?? []).find((n) => n.id === branchId);
  const reachesTarget = (branchAfter?.connectedPins ?? []).some(
    (pin) => pin.direction === "out" && (pin.linkedTo ?? []).some((l) => l.node === target.id)
  );
  const stillDirect = (after.nodes ?? []).some(
    (n) =>
      n.id !== branchId &&
      (n.connectedPins ?? []).some(
        (pin) =>
          pin.direction === "out" &&
          (pin.linkedTo ?? []).some((l) => l.node === target.id && EXEC_INPUT.test(l.pin))
      )
  );
  result.verified = reachesTarget && !stillDirect;

  const errorNote = result.introducedErrors
    ? ` WARNING: this edit took the compile from ${result.errorsBefore} error(s) to ${result.errorsAfter} - undo it.`
    : result.errorsAfter
      ? ` The Blueprint still has ${result.errorsAfter} pre-existing compile error(s), unchanged by this edit.`
      : "";

  result.summary = result.verified
    ? `"${target.title}" now runs only on the server: ${rerouted.length} execution link(s) rerouted ` +
      `through Branch(HasAuthority). Verified by re-reading the graph.${errorNote}`
    : `The guard was built but the graph does not look as expected afterwards ` +
      `(reachesTarget=${reachesTarget}, stillReachedDirectly=${stillDirect}). Check the graph before ` +
      `saving, and undo in the editor if it is wrong.`;

  return result;
}
