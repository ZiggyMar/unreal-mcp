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
  /**
   * Where a replicated custom event actually runs, straight from its function flags.
   *
   * Absent for an ordinary custom event, and absent from every reply produced by a plugin binary
   * older than this field - which is why the naming heuristics below are kept rather than replaced.
   */
  runsOn?: "server" | "all" | "owningClient";
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

/**
 * How many nodes each graph holds, so an empty RepNotify can be told from a full one.
 *
 * Keyed by graph name. A graph missing from the map was not read rather than empty, and the
 * difference matters: reporting "does nothing" about a handler nobody looked at would be the
 * confident wrong answer this project keeps finding.
 */
export type GraphSizes = Map<string, number>;

/**
 * A replicated variable whose RepNotify does nothing, or does not exist.
 *
 * This is the quiet half of the replication family. The variable replicates, the notify fires on
 * every client exactly as designed, and the handler is empty - so the value arrives and nothing
 * reacts to it. Nothing errors, nothing warns, and the symptom is "the UI does not update" long
 * after anyone is looking at replication.
 *
 * Found by hand in a real project before this existed: OnRep_PlayerWhoPlacedName, an event with
 * nothing wired to it, on a variable that replicates correctly. The name was arriving and the
 * nameplate never changed.
 *
 * Only for variables the author explicitly gave a RepNotify. Asking for one where none was
 * requested is a style opinion, and this file is for defects.
 */
function reviewRepNotifies(variables: MpVariable[], graphSizes: GraphSizes, nodes: MpNode[]): MpFinding[] {
  const findings: MpFinding[] = [];

  // Which variables this Blueprint touches at all, by the name on the node.
  //
  // An empty RepNotify on a variable the Blueprint uses is one thing; an empty RepNotify on a
  // variable nothing reads or writes is a stronger and much easier answer - the whole variable is
  // dead, and replicating it is paying network for a value nobody looks at. Found on a real ping
  // actor: CurrentDistanceMeters, replicated, with a RepNotify, zero writes and zero reads, while
  // the distance it was meant to carry is recomputed locally every tick.
  const touched = new Set<string>();
  for (const node of nodes) {
    if (!/K2Node_Variable(Get|Set)/.test(node.type ?? "")) {
      continue;
    }
    const name = (node.title ?? "").replace(/^(Get|Set)\s+/i, "").split("\n")[0].trim();
    if (name) {
      touched.add(name.toLowerCase());
    }
  }

  for (const variable of variables) {
    const handler = (variable.repNotify ?? "").trim();
    if (!handler) {
      continue;
    }
    if (!graphSizes.has(handler)) {
      // Not read is not the same as not there. Say nothing.
      continue;
    }
    // One node is the entry alone: the event exists on the canvas with nothing attached.
    if ((graphSizes.get(handler) ?? 0) > 1) {
      continue;
    }
    // Nothing in this Blueprint reads or writes it either, so there is no value to react TO. That
    // is a different, easier finding: delete it rather than wire it.
    const unused = !touched.has(variable.name.toLowerCase());
    findings.push({
      check: "repnotify-does-nothing",
      severity: "warning",
      variable: variable.name,
      message: unused
        ? `"${variable.name}" replicates with RepNotify "${handler}", "${handler}" is empty, and ` +
          `nothing in this Blueprint reads or writes the variable at all.`
        : `"${variable.name}" replicates with RepNotify "${handler}", and "${handler}" is empty - ` +
          `the event is on the canvas with nothing wired to it.`,
      observed: unused
        ? `${handler} has no nodes after its entry, and no Get or Set for ${variable.name} appears in this Blueprint.`
        : `${handler} has no nodes after its entry.`,
      fix: unused
        ? `Dead state: it is replicated across the network, notified on arrival, and read by nobody. ` +
          `Check nothing outside this Blueprint reads it - find_references - then delete the ` +
          `variable. If something DOES need it, the missing piece is the write, not the handler.`
        : `The value arrives on every client and nothing reacts to it. It does not error, does not ` +
          `warn, and surfaces much later as "the display never updates", by which point nobody is ` +
          `looking at replication. Either wire ${handler} to whatever should respond to the new ` +
          `value, or drop the RepNotify and replicate plainly if nothing needs to react.`,
    });
  }
  return findings;
}

export function reviewMultiplayer(nodes: MpNode[], variables: MpVariable[], graphSizes?: GraphSizes): MpFinding[] {
  const findings: MpFinding[] = [];
  const byId = new Map(nodes.map((node) => [node.id, node]));

  // `runsOn` first, the name second.
  //
  // These three lists decide two things: whether this Blueprint is networked at all - and a "no"
  // skips every multiplayer check below it - and which events to walk forward from looking for a
  // server writing unreplicated state or touching a widget. Both were decided by whether the author
  // happened to put "Server" or "Multicast" in the event's name.
  //
  // They frequently do not. BP_Player alone has FireWeapon, HealthRegen, EnergyRegen and
  // TraceInteract, all reported by the engine as Executes On Server and none of them saying so.
  // Every one was invisible to the walk, so anything they wrote unreplicated or touched on a widget
  // was never looked for. Unlike the cast fix, which removed a false positive, this direction adds
  // the findings that were missing.
  //
  // The name test stays as the fallback: a plugin binary older than the runsOn field sends no field,
  // and a guess from the name beats no check at all.
  const runsOnOr = (node: MpNode, mode: MpNode["runsOn"], byName: RegExp) =>
    isCustomEvent(node) && (node.runsOn ? node.runsOn === mode : byName.test(node.title ?? ""));

  const serverEvents = nodes.filter((node) => runsOnOr(node, "server", SERVER_EVENT));
  const multicastEvents = nodes.filter((node) => runsOnOr(node, "all", MULTICAST_EVENT));
  const clientEvents = nodes.filter((node) => runsOnOr(node, "owningClient", CLIENT_EVENT));
  const anyReplicated = variables.some((variable) => variable.replicated);

  // Nothing here applies to a single-player Blueprint, and a warning that fires on every one of
  // them would be ignored on all of them.
  // Before the single-player bail-out on purpose: a variable carrying a RepNotify is networked by
  // definition, and gating this behind "does the Blueprint have a server event" would silence the
  // check on exactly the Blueprints that only replicate state - which is most of the UI.
  if (graphSizes) {
    findings.push(...reviewRepNotifies(variables, graphSizes, nodes));
  }

  const networked =
    serverEvents.length > 0 || multicastEvents.length > 0 || clientEvents.length > 0 || anyReplicated;
  if (!networked) return findings;

  // Which variables this Blueprint READS, as opposed to merely writing.
  //
  // Needed to tell two different defects apart below. Kept separate from reviewRepNotifies' `touched`
  // set, which deliberately mixes Get and Set - that check asks whether a variable is used at all,
  // this one asks whether anything looks at what the server writes.
  const readVariables = new Set<string>();
  for (const node of nodes) {
    if (!/K2Node_VariableGet/.test(node.type ?? "")) continue;
    const name = (node.title ?? "").replace(/^Get\s+/i, "").split("\n")[0].trim();
    if (name) readVariables.add(name.toLowerCase());
  }

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

    // Two defects wear this shape, and they have opposite remedies.
    //
    // If something reads the variable, the server's write never reaches it and the answer is to
    // replicate. If NOTHING reads it, replicating would pay network for a value nobody looks at -
    // the variable is dead, and the answer is to delete it or find the read that was meant to exist.
    // Found on this project: BP_Player's CanRegenHealth is written twice by server events and read
    // nowhere, in the Blueprint or in the other 338. Reported as a replication bug it invites
    // exactly the wrong fix.
    //
    // Hedged to this Blueprint on purpose - these nodes are all this check can see, and a widget in
    // another asset reading the variable would be invisible here. Saying which question is still
    // open beats guessing at its answer.
    const neverRead = !readVariables.has(variable.toLowerCase());
    findings.push({
      check: "server-writes-unreplicated",
      severity: "warning",
      variable,
      message: neverRead
        ? `"${event}" runs on the server and sets "${variable}", which is not replicated - and nothing ` +
          `in this Blueprint reads it either. The server changes a value no client receives and no ` +
          `graph here looks at.`
        : `"${event}" runs on the server and sets "${variable}", which is not replicated. ` +
          `The server will change its own copy and no client will ever see it.`,
      observed,
      fix: neverRead
        ? `Check first whether anything reads it at all: unreal_trace_variable on "${variable}" covers ` +
          `the whole project, and this check can only see one Blueprint. If nothing reads it, the ` +
          `variable is dead - remove it with unreal_remove_variable, or wire up the read that was ` +
          `meant to exist. Replicating it would pay network for a value nobody looks at.`
        : `unreal_set_variable_replication on "${variable}" with mode "replicated" - or "repnotify" if clients need to react to the change rather than just read it. ` +
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
  //   2. Downstream of a custom event the engine says executes on the server - `runsOn: "server"`,
  //      read from the event's own function flags.
  //   3. Downstream of a custom event NAMED as a server RPC, which is what (2) used to be on its
  //      own. Kept, because a plugin binary older than the runsOn field emits no such field and
  //      falling back to the name is better than falling back to nothing.
  //
  // (2) exists because (3) only ever caught events whose authors happened to say "Server" in the
  // name. Measured on a real project: of thirteen flagged cast sites, four were on chains rooted at
  // KillPlayer, SpawnPlayer, AddPlayerToList and CE_Server_RequestPurchase - all four "Executes On
  // Server", and only the last one spelled it. The other three were reported as the audit's most
  // expensive defect, at 100 points each, for code that is correct.
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
    } else if (isCustomEvent(node) && (node.runsOn === "server" || SERVER_EVENT.test(node.title ?? ""))) {
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
