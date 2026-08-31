/**
 * Two ways a project sends state to the client and then fails to use it.
 *
 * Both came out of one firewall in a real game, and both are invisible to single-machine testing
 * for the same reason: on a listen server the host IS the server, so everything works on the
 * machine the developer is looking at.
 *
 * ## 1. A server event that touches the UI
 *
 * A widget exists only on the machine that created it. A Server RPC that updates a widget therefore
 * updates the host's screen and nobody else's - and it reads as perfectly reasonable code, because
 * the widget reference is valid, the cast succeeds, and there is no error anywhere.
 *
 * The real one: a repair timer running on the server pushed the progress ring straight into the
 * widget. The host's ring filled. Everybody else watched a wall repair itself with a frozen bar.
 *
 * ## 2. A RepNotify with an empty body
 *
 * Marking a variable RepNotify says "the clients need to react when this arrives". An empty OnRep
 * says nobody wrote the reaction. The value is being sent across the network, on every change, for
 * nothing.
 *
 * It is worth its own check because it is evidence of *intent*: somebody knew the client had to
 * respond here. Finding one usually means finding the missing half of a feature, and it is almost
 * always the half that makes the game work for people who are not hosting.
 */

import { classNameFromCastTitle } from "./multiplayer.js";
import type { FlowNode } from "./execFlow.js";

export interface SyncFinding {
  check: string;
  severity: string;
  message: string;
  fix: string;
}

export interface SyncChain {
  /** The node id of the entry point, so its replication can be looked up only when needed. */
  entryId: string;
  entry: string;
  nodeIds: string[];
}

/** Widget work, by the names the editor gives it. */
const WIDGET_CALLS =
  /^(create widget|add to viewport|remove from parent|add to player screen|add child|set brush from|remove all widgets)/i;

/** "Executes On Server" is what the editor writes into a Server RPC's title. */
export const isServerEvent = (netMode: string | undefined): boolean => /executes on server/i.test(netMode ?? "");

export interface ServerUiOptions {
  /**
   * Whether this chain runs on the server, and why.
   *
   * Not simply "is this event a Server RPC": authority is inherited by whoever you call, so the
   * event that updates the widget usually declares nothing at all and runs on the server anyway
   * because something four calls back was a Server RPC. `via` carries that route so the report can
   * say which one.
   */
  authorityOf: (chain: SyncChain) => Promise<{ server: boolean; via?: string[] }>;
  /** Whether a cast target is a widget class. Answered from the class ancestry, not from its name. */
  isWidgetClass: (className: string) => Promise<boolean>;
}

/**
 * Server events that do UI work.
 *
 * The order matters for cost: candidate chains are found first from nodes that are already in hand,
 * and replication is only looked up for chains that actually touch a widget. Most graphs ask
 * nothing.
 */
export async function findServerSideUi(
  chains: SyncChain[],
  nodesById: Map<string, FlowNode>,
  options: ServerUiOptions
): Promise<SyncFinding[]> {
  const findings: SyncFinding[] = [];

  for (const chain of chains) {
    const touched: string[] = [];
    for (const id of chain.nodeIds) {
      const node = nodesById.get(id);
      const title = String(node?.title ?? "").trim();
      if (WIDGET_CALLS.test(title)) {
        touched.push(title);
        continue;
      }
      // The third copy of this parse. See classNameFromCastTitle: a cast to a class reference is
      // titled "Cast To W_Thing Class", and each copy that spelled the regex itself was asking about
      // a class name no class has.
      const cast = classNameFromCastTitle(title);
      if (cast && (await options.isWidgetClass(cast))) touched.push(title);
    }
    if (touched.length === 0) continue;

    const authority = await options.authorityOf(chain);
    if (!authority.server) continue;

    const unique = [...new Set(touched)];
    const route = authority.via && authority.via.length > 1 ? ` It runs there via ${authority.via.join(" -> ")}.` : "";
    findings.push({
      check: "server-event-touches-widget",
      severity: "error",
      message:
        `"${chain.entry}" runs on the server and does UI work (${unique.slice(0, 3).join(", ")}). A widget ` +
        `exists only on the machine that created it, so this updates the host's screen and nobody else's.` +
        route,
      fix:
        `Send the value, not the UI update. Replicate what changed and let each client update its own ` +
        `widget - a RepNotify is usually enough - or use a Client RPC to the owning player when only ` +
        `one person should see it. It looks correct when you host because the host is the server.`,
    });
  }

  return findings;
}

export interface RepNotifyVariable {
  name: string;
  repNotify?: string;
}

/**
 * RepNotify functions with nothing in them.
 *
 * `graphIsEmpty` is asked per notify function rather than passed a whole graph, so this stays a
 * pure decision that a test can drive without a bridge.
 */
export function findEmptyRepNotifies(
  variables: RepNotifyVariable[],
  graphIsEmpty: (functionName: string) => boolean | undefined
): SyncFinding[] {
  const findings: SyncFinding[] = [];
  for (const variable of variables) {
    const notify = variable.repNotify?.trim();
    if (!notify) continue;
    // undefined means the graph was not readable; that is not evidence of emptiness.
    if (graphIsEmpty(notify) !== true) continue;
    findings.push({
      check: "repnotify-does-nothing",
      severity: "warning",
      message:
        `${variable.name} is replicated with RepNotify, but ${notify} is empty. The value is sent to every ` +
        `client on every change and nothing reacts to it when it arrives.`,
      fix:
        `Marking it RepNotify says the clients need to do something when it changes, so pick one of two. ` +
        `Either build that something in ${notify} with unreal_build_graph - usually the UI or visual update ` +
        `that currently happens on the server, where only the host can see it - or drop it to plain ` +
        `replication with unreal_set_variable_replication mode "replicated". Both are real answers; which one ` +
        `depends on whether clients have anything to do when the value arrives.`,
    });
  }
  return findings;
}
