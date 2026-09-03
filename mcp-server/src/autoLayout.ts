import { computeGraphLayout, groupIntoChains, type LayoutOptions, type PlacedNode } from "./layout.js";
import type { ReadBlueprintGraphSummaryResult } from "./types.js";

/** Just enough of UnrealBridgeClient to run this, so it can be tested against a fake bridge. */
export interface BridgeLike {
  send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T>;
}

export interface AutoLayoutOptions extends LayoutOptions {
  /** Wrap each execution chain in a comment box titled after its event. Defaults to true. */
  addCommentBoxes?: boolean;
}

export interface AutoLayoutReport {
  path: string;
  graphName: string;
  nodesMoved: number;
  columns: number;
  commentBoxesAdded: string[];
  commentBoxesSkipped: string[];
  /** Comment boxes already in the graph, left alone. */
  existingCommentBoxes: number;
  failures: Array<{ nodeId: string; error: string }>;
}

/** Padding between a comment box's edges and the nodes it contains, in graph units. */
const BOX_PADDING = 48;
/** Extra headroom above the nodes, because a comment box's title bar is drawn above its top edge. */
const BOX_TITLE_HEIGHT = 64;
/**
 * Vertical clearance between two execution chains.
 *
 * Column packing alone separates chains by one row gap, which is not enough once each chain is
 * wrapped in a padded, title-barred comment box: the boxes then overlap and hide each other. This
 * is sized so two boxes always clear, and it doubles as the reason a laid-out EventGraph reads as
 * distinct stacked sections rather than one dense field of nodes.
 */
const CHAIN_CLEARANCE = (BOX_PADDING + BOX_TITLE_HEIGHT) * 2;

/**
 * Push whole execution chains apart vertically so each one occupies its own horizontal band.
 *
 * Chains are moved as rigid blocks, so the straightened rows and column alignment computed by the
 * layout survive untouched. Nodes that belong to no chain (pure data islands, orphans) are treated
 * as one final block rather than dropped.
 */
function separateChains(positions: PlacedNode[], groups: Array<{ nodeIds: string[] }>): void {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const blocks: PlacedNode[][] = [];
  const assigned = new Set<string>();

  for (const group of groups) {
    const members = group.nodeIds.map((id) => byId.get(id)).filter((p): p is PlacedNode => Boolean(p));
    if (members.length === 0) continue;
    members.forEach((m) => assigned.add(m.id));
    blocks.push(members);
  }
  const leftovers = positions.filter((p) => !assigned.has(p.id));
  if (leftovers.length > 0) blocks.push(leftovers);
  if (blocks.length < 2) return;

  const topOf = (block: PlacedNode[]) => Math.min(...block.map((p) => p.y));
  const bottomOf = (block: PlacedNode[]) => Math.max(...block.map((p) => p.y + p.height));

  blocks.sort((a, b) => topOf(a) - topOf(b));

  let floor = -Infinity;
  for (const block of blocks) {
    const top = topOf(block);
    if (top < floor) {
      const shift = floor - top;
      for (const node of block) node.y += shift;
    }
    floor = bottomOf(block) + CHAIN_CLEARANCE;
  }
}

/**
 * Lay out an existing graph and (by default) wrap each execution chain in a labelled comment box.
 *
 * This is composed client-side out of read_blueprint_graph_summary + organize_graph rather than
 * implemented in the plugin, which has one consequence worth stating plainly: each node move is
 * its own editor transaction, so undoing a layout takes several Ctrl+Z presses rather than one.
 * A batched move command in the bridge would fix that; until then, laying out is cheap, safe, and
 * purely cosmetic, so the trade is worth taking.
 */
export async function autoLayoutGraph(
  bridge: BridgeLike,
  path: string,
  graphName: string,
  options: AutoLayoutOptions = {}
): Promise<AutoLayoutReport> {
  const summary = await bridge.send<ReadBlueprintGraphSummaryResult>("read_blueprint_graph_summary", {
    path,
    graphName,
  });

  const nodes = summary.nodes ?? [];
  const layout = computeGraphLayout(nodes, options);
  const chains = groupIntoChains(nodes);
  separateChains(layout.positions, chains);

  const report: AutoLayoutReport = {
    path,
    graphName,
    nodesMoved: 0,
    columns: layout.columns,
    commentBoxesAdded: [],
    commentBoxesSkipped: [],
    existingCommentBoxes: layout.skipped.length,
    failures: [],
  };

  for (const placed of layout.positions) {
    try {
      await bridge.send("organize_graph", {
        path,
        graphName,
        action: "move_node",
        nodeId: placed.id,
        x: placed.x,
        y: placed.y,
      });
      report.nodesMoved++;
    } catch (err) {
      // One unmovable node should not abandon the rest of the graph half laid out.
      report.failures.push({ nodeId: placed.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (options.addCommentBoxes === false) {
    return report;
  }

  const placedById = new Map<string, PlacedNode>(layout.positions.map((p) => [p.id, p]));

  // A graph that already has comment boxes does not get more.
  //
  // This used to dedupe by title, and it never worked: for a comment box the `title` field is the
  // literal string "Comment" - the box's name lives in `text`, which LayoutNode does not even carry.
  // So the set being compared against contained "Comment" and nothing else, matched nothing, and
  // every run added a fresh box over the top of whatever was there. Run on a Blueprint with one
  // hand-titled box, it reported `existingCommentBoxes: 1` and then boxed the same twelve nodes
  // again, leaving an overlappingBoxes fault where both boxes claim every node.
  //
  // Titles could not have saved it anyway. A box is titled after its entry event when this draws it
  // ("Event BeginPlay") and renamed to a feature name afterwards ("Turn M.O.M Evil"), so the two
  // names never match even when they describe the same nodes.
  //
  // So the rule is the honest one: boxing is for a graph this tool has just laid out from nothing.
  // If somebody has already drawn boxes, they have organised it, and adding to that is the
  // destructive half of this tool - the same reason it does not relayout other people's graphs. The
  // groups are reported as skipped so the caller can see what was left alone.
  if (layout.skipped.length > 0) {
    for (const group of chains) {
      if (group.nodeIds.length >= 2) {
        report.commentBoxesSkipped.push(group.title.trim() || "Section");
      }
    }
    return report;
  }

  const existingTitles = new Set<string>();

  for (const group of chains) {
    const members = group.nodeIds.map((id) => placedById.get(id)).filter((p): p is PlacedNode => Boolean(p));
    // A lone node is not a section; boxing it adds visual noise without adding meaning.
    if (members.length < 2) continue;

    const title = group.title.trim() || "Section";
    if (existingTitles.has(title)) {
      report.commentBoxesSkipped.push(title);
      continue;
    }

    const minX = Math.min(...members.map((m) => m.x));
    const minY = Math.min(...members.map((m) => m.y));
    const maxX = Math.max(...members.map((m) => m.x + m.width));
    const maxY = Math.max(...members.map((m) => m.y + m.height));

    try {
      await bridge.send("organize_graph", {
        path,
        graphName,
        action: "add_comment_box",
        text: title,
        x: Math.round(minX - BOX_PADDING),
        y: Math.round(minY - BOX_PADDING - BOX_TITLE_HEIGHT),
        width: Math.round(maxX - minX + BOX_PADDING * 2),
        height: Math.round(maxY - minY + BOX_PADDING * 2 + BOX_TITLE_HEIGHT),
      });
      report.commentBoxesAdded.push(title);
      existingTitles.add(title);
    } catch (err) {
      report.failures.push({ nodeId: group.rootId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return report;
}
