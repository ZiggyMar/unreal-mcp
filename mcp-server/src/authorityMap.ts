/**
 * Where a piece of Blueprint logic actually runs, when the answer is in a different Blueprint.
 *
 * The checks that read an event's replication mode only see authority that the event declares for
 * itself. That misses the shape that produced the bug this was written for:
 *
 *     BP_Player.TraceInteract          Executes On Server
 *       -> Interacted                  interface message
 *          BP_FireWall.Interacted      a plain function
 *            -> StartRepair            a plain custom event
 *              -> Set Timer by Event   bound to...
 *                -> UpdateRepairTimer  a plain custom event - which updates a widget
 *
 * Every unit after the first declares no replication at all, and every one of them runs on the
 * server, because authority is inherited by whoever you call. A repair ring pushed into a widget at
 * the end of that chain fills on the host and nowhere else.
 *
 * ## Backwards, not forwards
 *
 * Reading every event's replication would cost a bridge call per event across the whole project -
 * thousands. So the walk runs the other way: start from the few units that do something suspicious,
 * walk BACK through their callers, and ask about replication only for the units actually met. The
 * firewall answer costs four questions.
 *
 * ## What it deliberately does not resolve
 *
 * An interface message goes to every Blueprint that implements it, and which one is on the other end
 * is a runtime fact. This treats any implementer as a possible caller, which is the safe direction:
 * it can suggest authority that a particular instance would not have, and it will not miss one.
 *
 * `Create Event` bindings are not followed - the bound function's name is not in the node - so a
 * timer set that way is invisible here. Direct delegate bindings, which is what the editor produces
 * when you drag off a custom event, are followed.
 */

import type { FlowNode } from "./execFlow.js";

export interface AuthorityUnit {
  /** `Blueprint::Name` - a function graph, or a custom event in the event graph. */
  key: string;
  blueprint: string;
  name: string;
  /** The entry node, so its replication can be read only if it is ever reached. */
  entryId: string;
  /**
   * The entry node's type.
   *
   * Only a custom event can be a Server RPC. A function has no replication mode, and an overridden
   * engine event (BeginPlay, Tick) cannot be one either - so asking the editor about those is a
   * bridge call whose answer is known in advance. On a real project that distinction is the
   * difference between a few dozen questions and several thousand.
   */
  entryType?: string;
  /** Nodes belonging to this unit. */
  nodes: FlowNode[];
}

const clean = (title: string | undefined) => String(title ?? "").replace(/\s+/g, " ").trim();

/**
 * Who calls whom, keyed by callee. Built from nodes that are already in hand: no bridge calls.
 */
export function buildCallers(units: AuthorityUnit[]): Map<string, Set<string>> {
  const callers = new Map<string, Set<string>>();
  const add = (callee: string, caller: string) => {
    if (callee === caller) return;
    const set = callers.get(callee) ?? new Set<string>();
    set.add(caller);
    callers.set(callee, set);
  };

  const byName = new Map<string, AuthorityUnit[]>();
  const byBlueprintAndName = new Map<string, AuthorityUnit>();
  for (const unit of units) {
    const list = byName.get(unit.name) ?? [];
    list.push(unit);
    byName.set(unit.name, list);
    byBlueprintAndName.set(`${unit.blueprint}::${unit.name}`, unit);
  }

  // Which unit each node belongs to, for resolving delegate bindings.
  const unitOfNode = new Map<string, AuthorityUnit>();
  for (const unit of units) for (const node of unit.nodes) unitOfNode.set(node.id, unit);

  for (const unit of units) {
    for (const node of unit.nodes) {
      const name = clean(node.title);
      if (!name) continue;

      if (node.type === "K2Node_Message") {
        // An interface call reaches every implementation of that name, anywhere in the project.
        for (const target of byName.get(name) ?? []) add(target.key, unit.key);
        continue;
      }

      const sameBlueprint = byBlueprintAndName.get(`${unit.blueprint}::${name}`);
      if (sameBlueprint) add(sameBlueprint.key, unit.key);
    }

    // A custom event bound straight into a timer or a delegate runs wherever the binder runs. The
    // link lives on the event's OutputDelegate pin, pointing at the node that consumed it.
    for (const node of unit.nodes) {
      if (node.type !== "K2Node_CustomEvent") continue;
      const bound = byBlueprintAndName.get(`${unit.blueprint}::${clean(node.title)}`);
      if (!bound) continue;
      for (const pin of node.connectedPins ?? []) {
        if (pin.direction !== "out" || !/delegate/i.test(pin.pin)) continue;
        for (const link of pin.linkedTo ?? []) {
          const consumer = unitOfNode.get(link.node);
          if (consumer) add(bound.key, consumer.key);
        }
      }
    }
  }

  return callers;
}

export interface AuthorityResult {
  server: boolean;
  /** The route that gives it server authority, nearest cause last. */
  via: string[];
}

/**
 * Does this unit run on the server - itself, or because of who calls it?
 *
 * `isServerRpc` is asked at most once per unit met, and only for units on a path back from the one
 * being asked about.
 */
export async function resolveServerAuthority(
  startKey: string,
  units: Map<string, AuthorityUnit>,
  callers: Map<string, Set<string>>,
  isServerRpc: (unit: AuthorityUnit) => Promise<boolean>,
  maxVisits = 60
): Promise<AuthorityResult> {
  const seen = new Set<string>([startKey]);
  let frontier: Array<{ key: string; path: string[] }> = [{ key: startKey, path: [] }];
  let visits = 0;

  while (frontier.length > 0 && visits < maxVisits) {
    const next: Array<{ key: string; path: string[] }> = [];
    for (const { key, path } of frontier) {
      const unit = units.get(key);
      if (!unit) continue;
      visits += 1;
      if (await isServerRpc(unit)) {
        return { server: true, via: [`${unit.name} (Executes On Server)`, ...path] };
      }
      for (const caller of callers.get(key) ?? []) {
        if (seen.has(caller)) continue;
        seen.add(caller);
        next.push({ key: caller, path: [unit.name, ...path] });
      }
    }
    frontier = next;
  }

  return { server: false, via: [] };
}
