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

/**
 * Casting to something that only exists on the server.
 *
 * A GameMode exists on the server and nowhere else. A PlayerController, a Pawn, a GameState and a
 * widget all exist on clients too - so a cast to the GameMode from any of them fails on every
 * machine that is not the host. It fails *silently*: the chain stops, nothing logs, and every node
 * after the cast never runs.
 *
 * Found in a real project 24 times across 18 Blueprints, including the player's death sequence,
 * where the failure meant no spectator, a vacuum that never ended, a timer never cleared and a
 * widget never closed - for everyone except the host. Single-player testing cannot see it.
 *
 * Two things stop this being noise:
 *
 *   - A GameMode casting to a GameMode is fine, because the owner is server-only too.
 *   - A cast behind `Switch Has Authority` is fine, because it only runs on the server by
 *     construction. That guard is detected rather than assumed.
 */
export function findServerOnlyCasts(
  nodes: MpNode[],
  isServerOnlyClass: (className: string) => boolean,
  ownerIsServerOnly: boolean
): MpFinding[] {
  if (ownerIsServerOnly) return [];

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const execTargets = (node: MpNode, onlyPin?: RegExp): MpNode[] => {
    const out: MpNode[] = [];
    for (const pin of node.connectedPins ?? []) {
      if (pin.direction !== "out") continue;
      if (onlyPin && !onlyPin.test(pin.pin)) continue;
      for (const link of pin.linkedTo ?? []) {
        if (!/^(execute|exec|then|in)$/i.test(link.pin)) continue;
        const target = byId.get(link.node);
        if (target) out.push(target);
      }
    }
    return out;
  };

  // Everything downstream of the Authority branch of a Switch Has Authority runs only on the
  // server, so a cast in there is correct rather than broken.
  const serverGuarded = new Set<string>();
  for (const node of nodes) {
    if (!/Switch Has Authority|SwitchHasAuthority/i.test(node.title ?? "")) continue;
    const queue = execTargets(node, /^authority$/i);
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || serverGuarded.has(current.id)) continue;
      serverGuarded.add(current.id);
      queue.push(...execTargets(current));
    }
  }

  const findings: MpFinding[] = [];
  const alreadyReported = new Set<string>();
  for (const node of nodes) {
    if (!/K2Node_DynamicCast/.test(node.type)) continue;
    if (serverGuarded.has(node.id)) continue;
    const match = /^Cast To (.+)$/i.exec((node.title ?? "").trim());
    if (!match) continue;
    const target = match[1].trim();
    if (!isServerOnlyClass(target)) continue;
    if (alreadyReported.has(target)) continue;
    alreadyReported.add(target);

    findings.push({
      check: "cast-to-server-only-class",
      severity: "warning",
      variable: target,
      message:
        `This casts to ${target}, which is a GameMode and therefore exists only on the server. ` +
        `On every client the cast fails and nothing after it runs.`,
      fix:
        `Put whatever this needs on the GameState instead, which is replicated to clients, or guard ` +
        `the cast with Switch Has Authority if the work genuinely belongs on the server. It will look ` +
        `correct when hosting and do nothing for everyone else.`,
    });
  }
  return findings;
}
