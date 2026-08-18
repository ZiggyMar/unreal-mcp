/**
 * The bugs that only appear when a second player connects.
 *
 * Multiplayer mistakes survive every other check in this project. They compile. They review clean.
 * They behave perfectly in the editor with one player. Then two people join and the game is subtly,
 * expensively wrong, and the cause is somewhere nobody thinks to look because nothing ever flagged
 * it.
 *
 * The one this catches is the most common of them by a distance: **a server RPC that sets a
 * variable nobody replicated.** The server changes its own copy, every client keeps the old value
 * forever, and the symptom is "it works for the host". A person who has hit it once recognises it
 * instantly and a person who has not can lose a day.
 *
 * Conservative in the same way as the rest of the review. It only speaks when the Blueprint is
 * demonstrably networked - if there is no server or multicast event anywhere, none of this is
 * relevant and saying so would be noise on every single-player project.
 */

export interface MpVariable {
  name: string;
  replicated?: boolean;
  repNotify?: string;
}

export interface MpNode {
  id: string;
  type: string;
  title: string;
  connectedPins?: Array<{
    pin: string;
    direction: string;
    linkedTo?: Array<{ node: string; pin: string }>;
  }>;
}

export interface MpFinding {
  check: string;
  severity: "warning" | "info";
  message: string;
  fix: string;
  variable?: string;
}

/** Naming conventions that mean "this runs somewhere else". Unreal itself has no other marker. */
const SERVER_EVENT = /^(server|sv)[_\s]/i;
const MULTICAST_EVENT = /^(multicast|netmulticast|all)[_\s]/i;
const CLIENT_EVENT = /^(client|owning)[_\s]/i;

const isCustomEvent = (node: MpNode) => /K2Node_CustomEvent/.test(node.type);

/** The variable a Set node writes, from its title: "Set bVacuumOn" -> "bVacuumOn". */
function assignedVariable(node: MpNode): string | undefined {
  if (!/K2Node_VariableSet/.test(node.type)) return undefined;
  const match = /^SET\s+(.+)$/i.exec((node.title ?? "").trim());
  return match ? match[1].trim() : undefined;
}

export function reviewMultiplayer(nodes: MpNode[], variables: MpVariable[]): MpFinding[] {
  const findings: MpFinding[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const serverEvents = nodes.filter((node) => isCustomEvent(node) && SERVER_EVENT.test(node.title ?? ""));
  const multicastEvents = nodes.filter((node) => isCustomEvent(node) && MULTICAST_EVENT.test(node.title ?? ""));
  const clientEvents = nodes.filter((node) => isCustomEvent(node) && CLIENT_EVENT.test(node.title ?? ""));
  const anyReplicated = variables.some((variable) => variable.replicated);

  // Nothing here applies to a single-player Blueprint, and a warning that fires on every one of
  // them would be ignored on all of them.
  const networked =
    serverEvents.length > 0 || multicastEvents.length > 0 || clientEvents.length > 0 || anyReplicated;
  if (!networked) return findings;

  // Walk execution forward from each server event and collect what it writes.
  const execTargets = (node: MpNode): MpNode[] => {
    const out: MpNode[] = [];
    for (const pin of node.connectedPins ?? []) {
      if (pin.direction !== "out") continue;
      for (const link of pin.linkedTo ?? []) {
        if (!/^(execute|exec|then|in)$/i.test(link.pin)) continue;
        const target = byId.get(link.node);
        if (target) out.push(target);
      }
    }
    return out;
  };

  const replicationOf = new Map(variables.map((variable) => [variable.name.toLowerCase(), variable]));
  const offenders = new Map<string, string>(); // variable -> the server event that writes it

  for (const event of serverEvents) {
    const seen = new Set<string>([event.id]);
    const queue = execTargets(event);
    while (queue.length > 0) {
      const node = queue.pop();
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      queue.push(...execTargets(node));

      const written = assignedVariable(node);
      if (!written) continue;
      const variable = replicationOf.get(written.toLowerCase());
      // Unknown variables are inherited or from a component; saying nothing beats guessing.
      if (!variable || variable.replicated) continue;
      if (!offenders.has(written)) offenders.set(written, event.title ?? "a server event");
    }
  }

  for (const [variable, event] of offenders) {
    findings.push({
      check: "server-writes-unreplicated",
      severity: "warning",
      variable,
      message:
        `"${event}" runs on the server and sets "${variable}", which is not replicated. ` +
        `The server will change its own copy and no client will ever see it.`,
      fix:
        `Mark "${variable}" as Replicated (or RepNotify if clients need to react to the change). ` +
        `Until then this works for whoever is hosting and silently does nothing for everyone else.`,
    });
  }

  // A replicated variable is set somewhere, but nothing in this Blueprint runs on the server.
  // Clients writing replicated state is the mirror image of the bug above: the value is changed
  // locally and then overwritten by the next update from the server.
  if (anyReplicated && serverEvents.length === 0) {
    const writes = nodes
      .map(assignedVariable)
      .filter((name): name is string => Boolean(name))
      .filter((name) => replicationOf.get(name.toLowerCase())?.replicated);
    if (writes.length > 0) {
      findings.push({
        check: "replicated-set-without-server-event",
        severity: "info",
        message:
          `Replicated variable(s) ${[...new Set(writes)].join(", ")} are set in this Blueprint, but it has ` +
          `no server event.`,
        fix:
          "Replicated state should be changed on the server. If this runs on a client, the value will be " +
          "overwritten by the next update from the server. Route the change through a Server_ custom event, " +
          "or check Switch Has Authority before setting it.",
      });
    }
  }

  return findings;
}
