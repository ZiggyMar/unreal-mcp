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
  /** The declared type, e.g. "Object", "float". Decides handle-versus-state; see the check below. */
  type?: string;
  /** For an object or class reference, what it points at, e.g. "BP_PingActor_C". */
  subType?: string;
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
  /**
   * What the Blueprint itself shows, separated from what the finding concludes.
   *
   * A check that sees one asset cannot settle a question that spans several, and saying so is more
   * useful than either guessing or going quiet. This carries the evidence so a reader can weigh it.
   */
  observed?: string;
}

/** Naming conventions that mean "this runs somewhere else". Unreal itself has no other marker. */
// Anchored at a word start rather than the string start, because real projects prefix their custom
// events - CE_Server_FinishedCutscene is a server event, and reading it as a client one produced a
// false positive on a real project. "Observer" is not matched: the prefix must end at an underscore.
const SERVER_EVENT = /(^|_)(server|sv)[_\s]/i;
const MULTICAST_EVENT = /(^|_)(multicast|netmulticast|all)[_\s]/i;
const CLIENT_EVENT = /(^|_)(client|owning)[_\s]/i;

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

  // Every node any server event can reach. Needed twice: to find what the server writes, and to
  // decide whether anything OUTSIDE the server ever reads it - which is what separates a real
  // replication bug from a scratch variable the server uses and nobody else looks at.
  const serverReachable = new Set<string>();
  for (const event of serverEvents) {
    const queue = [event];
    while (queue.length > 0) {
      const node = queue.pop();
      if (!node || serverReachable.has(node.id)) continue;
      serverReachable.add(node.id);
      queue.push(...execTargets(node));
    }
  }

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

  /** Every node that READS a variable. */
  const readsOf = (name: string): MpNode[] =>
    nodes.filter((node) => {
      const title = (node.title ?? "").trim();
      const got = /^GET\s+(.+)$/i.exec(title);
      return got ? got[1].trim().toLowerCase() === name.toLowerCase() : false;
    });

  /**
   * Is this read on the server?
   *
   * A Get node is pure data: it has no exec pins, so it is never itself reachable by walking
   * execution. Asking whether the GET is server-reachable therefore always answered "no", which
   * made the evidence say "a client reads this" about every variable in the project - confidently,
   * and wrongly. What decides it is where the value GOES: the node that consumes it.
   */
  const readIsOnServer = (getNode: MpNode): boolean => {
    const consumers: MpNode[] = [];
    for (const pin of getNode.connectedPins ?? []) {
      if (pin.direction !== "out") continue;
      for (const link of pin.linkedTo ?? []) {
        const target = byId.get(link.node);
        if (target) consumers.push(target);
      }
    }
    // A read that feeds nothing tells us nothing; treat it as server-side so it does not raise an
    // alarm on its own.
    if (consumers.length === 0) return true;
    return consumers.every((node) => serverReachable.has(node.id));
  };

  for (const [variable, event] of offenders) {
    // An object reference is not gameplay state, and this distinction was learned the hard way.
    // Measured on a real project: this check reported BP_Player setting "CurrentActivePing" as a
    // multiplayer bug. It is not one - CurrentActivePing holds a BP_PingActor, that Actor has
    // bReplicates true, so it replicates ITSELF and every client already sees the ping. The variable
    // is the server's handle for "which one is active", and replicating it would change nothing but
    // bandwidth. Reporting that at cost 100 sends a model to change code that is correct, which is
    // worse than saying nothing: the finding is confident, plausible and wrong.
    //
    // So a handle gets its own check, a much lower cost, and a message that names the fact which
    // decides it rather than asserting the conclusion.
    const declared = replicationOf.get(variable.toLowerCase());
    const type = `${declared?.type ?? ""}`.toLowerCase();
    const isHandle = type === "object" || type === "class" || type === "softobject" || type === "softclass";
    const referenced = declared?.subType;

    // What can be observed about the reads, WITHOUT pretending it settles the question.
    //
    // The first attempt at this suppressed the finding when nothing in the Blueprint read the
    // variable, or when every read was server-side. The existing tests caught that immediately, and
    // they were right: reads live in other Blueprints too. A HUD widget reading the player's value
    // on a client is exactly the bug this check exists for, and it would have been silenced by a
    // rule that only ever looked at one asset. Suppressing a real finding is far worse than
    // reporting a doubtful one, so this annotates instead.
    const reads = readsOf(variable);
    const observed =
      reads.length === 0
        ? `Nothing in this Blueprint reads "${variable}". It may still be read from a widget or ` +
          `another actor - if it is, on a client, this is the bug. If nothing anywhere reads it, ` +
          `it is left over and replicating it would send a value nobody looks at.`
        : reads.every(readIsOnServer)
          ? `Every read of "${variable}" in this Blueprint is also on the server, so it looks like ` +
            `working state inside a server call. Check whether a widget or another actor reads it ` +
            `on a client before changing anything.`
          : `"${variable}" is read outside the server chain in this Blueprint, so a client does ` +
            `read the value the server is changing. This one is worth fixing.`;

    if (isHandle) {
      findings.push({
        check: "server-writes-unreplicated-handle",
        severity: "info",
        variable,
        message:
          `"${event}" runs on the server and sets "${variable}", a reference to ` +
          `${referenced ?? "another object"} which is not itself replicated as a variable.`,
        fix:
          `This is only a bug if ${referenced ?? "the referenced class"} does not replicate on its own. ` +
          `Check with unreal_read_class_defaults: if \`replicates\` is true, clients already see the ` +
          `object and this variable is just the server's handle to it - leave it alone. If it is false, ` +
          `clients see nothing and either the Actor should replicate or this reference should.`,
      });
      continue;
    }

    findings.push({
      check: "server-writes-unreplicated",
      severity: "warning",
      variable,
      message:
        `"${event}" runs on the server and sets "${variable}", which is not replicated. ` +
        `The server will change its own copy and no client will ever see it.`,
      observed,
      fix:
        `unreal_set_variable_replication on "${variable}" with mode "replicated" - or "repnotify" if clients need to react to the change rather than just read it. ` +
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
/**
 * The class a "Cast To ..." node targets, taken from its title.
 *
 * Unreal titles a cast to a CLASS REFERENCE "Cast To BP_ShopUpgrade Class" rather than
 * "Cast To BP_ShopUpgrade", so the obvious `/^Cast To (.+)$/` captures a name with a word on the end
 * that is not part of it. Four such nodes exist across this project's 1,209 graphs - two to
 * BP_ShopUpgrade, one to BP_BaseEnemy, one to UserWidget - and every one of them was being looked up
 * under a name no class has. The audit asked describe_class for "BP_ShopUpgrade Class", got
 * class_not_found, and swallowed it.
 *
 * That matters beyond the wasted call: cast-to-server-only-class is the most expensive check in the
 * table, and a cast whose class cannot be resolved can never trigger it. The check was silently
 * blind to class casts.
 *
 * Lives here and is exported because three separate files had spelled this regex out for
 * themselves - audit.ts, clientSync.ts and this one. Every copy was asking about a class name no
 * class has, and fixing the first two still left the third reporting "BP_ShopUpgrade Class" as
 * unresolvable. That is what three copies of one parse buys: a fix that looks complete and is not.
 */
export function classNameFromCastTitle(title: string | undefined): string | undefined {
  const match = /^Cast To (.+)$/i.exec((title ?? "").trim());
  if (!match) return undefined;
  // Only the trailing word, and only when something precedes it: a class genuinely called "Class"
  // would be left alone.
  const name = match[1].trim().replace(/\s+Class$/i, "").trim();
  return name.length > 0 ? name : undefined;
}

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

  // Two things mean "this only runs on the server", and a cast to a server-only class is correct
  // under either. Both are DETECTED rather than assumed absent, which is the difference between a
  // check people act on and one they learn to ignore.
  //
  //   1. Downstream of the Authority branch of a Switch Has Authority.
  //   2. Downstream of a custom event named as a server RPC. A real project had
  //      CE_Server_FinishedCutscene casting to its GameMode, which is entirely correct and was
  //      reported as a bug until this existed.
  const serverGuarded = new Set<string>();
  const markDownstream = (start: MpNode, pin?: RegExp) => {
    const queue = execTargets(start, pin);
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || serverGuarded.has(current.id)) continue;
      serverGuarded.add(current.id);
      queue.push(...execTargets(current));
    }
  };
  for (const node of nodes) {
    if (/Switch Has Authority|SwitchHasAuthority/i.test(node.title ?? "")) {
      markDownstream(node, /^authority$/i);
    } else if (isCustomEvent(node) && SERVER_EVENT.test(node.title ?? "")) {
      markDownstream(node);
    }
  }

  // Which entry points reach each node.
  //
  // "This Blueprint casts to a GameMode" is true and hard to act on. "The chain starting at
  // KillPlayerClient casts to a GameMode" tells you where to look and, more usefully, whether the
  // chain plausibly runs on a client at all - which is the whole question.
  const ENTRY_TYPES = /K2Node_(Event|CustomEvent|Input[A-Za-z]*Event|FunctionEntry|Timeline)/;
  const reachedBy = new Map<string, Set<string>>();
  for (const entry of nodes.filter((node) => ENTRY_TYPES.test(node.type))) {
    const seen = new Set<string>([entry.id]);
    const queue = execTargets(entry);
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || seen.has(current.id)) continue;
      seen.add(current.id);
      const entrySet = reachedBy.get(current.id) ?? new Set<string>();
      entrySet.add((entry.title ?? "").trim() || entry.type);
      reachedBy.set(current.id, entrySet);
      queue.push(...execTargets(current));
    }
  }

  const findings: MpFinding[] = [];
  const alreadyReported = new Set<string>();
  for (const node of nodes) {
    if (!/K2Node_DynamicCast/.test(node.type)) continue;
    if (serverGuarded.has(node.id)) continue;
    const target = classNameFromCastTitle(node.title);
    if (!target) continue;
    if (!isServerOnlyClass(target)) continue;
    if (alreadyReported.has(target)) continue;
    alreadyReported.add(target);

    const entries = [...(reachedBy.get(node.id) ?? [])];
    const from =
      entries.length > 0
        ? ` It is reached from ${entries.slice(0, 3).join(", ")}${entries.length > 3 ? ` and ${entries.length - 3} more` : ""}.`
        : "";

    findings.push({
      check: "cast-to-server-only-class",
      severity: "warning",
      variable: target,
      message:
        `This casts to ${target}, which is a GameMode and therefore exists only on the server. ` +
        `On every client the cast fails and nothing after it runs.${from}`,
      fix:
        `Put whatever this needs on the GameState instead, which is replicated to clients, or guard ` +
        `the cast with Switch Has Authority if the work genuinely belongs on the server. It will look ` +
        `correct when hosting and do nothing for everyone else.`,
    });
  }
  return findings;
}
