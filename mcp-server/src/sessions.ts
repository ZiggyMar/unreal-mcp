/**
 * Does the way this project HOSTS a session match the way it SEARCHES for one?
 *
 * This check exists because of a real bug in a real game, two weeks before it was shown at an
 * event, and because finding it by hand took reading fourteen graphs.
 *
 * A multiplayer session is advertised either over LAN or through an online service (Steam, EOS).
 * A LAN-advertised session is invisible to a service query, and a service session is invisible to a
 * LAN query. The flag is one checkbox on each side, they live in different Blueprints, and nothing
 * in the engine ever complains: hosting succeeds, searching succeeds, the list is empty.
 *
 * The symptom people report is never "my LAN flags disagree". It is:
 *
 *   "sometimes a computer just can't host, and other times computers just can't find lobbies"
 *
 * ...because a project usually grows more than one host button. Whichever one the player pressed
 * decides whether anybody can see them, so the same build works and then does not, and it cannot be
 * reproduced on one machine - single-player testing never searches for anything.
 *
 * ## What it does NOT do
 *
 * It does not decide whether the game should be LAN or online; that is a design choice and this
 * cannot know it. It reports that the two halves disagree, which is never intentional.
 *
 * ## Why only live nodes
 *
 * Menus accumulate abandoned session code - the project this came from had two whole generations of
 * it, plus orphaned duplicates, 46 dead nodes in one button. Reporting flags on nodes that never run
 * would bury the one that does.
 */

export interface SessionNode {
  id: string;
  type: string;
  title: string;
  connectedPins?: Array<{ pin: string; direction: string; linkedTo?: Array<{ node: string; pin: string }> }>;
}

export interface SessionGraph {
  blueprint: string;
  path: string;
  graphName: string;
  nodes: SessionNode[];
  /** Ids reachable from an entry point. Nodes outside this are abandoned menu code. */
  liveNodeIds: Set<string>;
}

export interface SessionFinding {
  check: string;
  severity: string;
  message: string;
  fix: string;
}

/** Reads a node's pin defaults. Separate so this is testable without an editor. */
export type PinReader = (
  path: string,
  graphName: string,
  nodeId: string
) => Promise<Array<{ name?: string; defaultValue?: unknown }>>;

// Deliberately matched on what the node is called, across the plugins people actually use: the
// built-in session nodes, Advanced Sessions, and Kronos. A project mixing two of them is the normal
// case, not the exotic one.
const HOSTS = /^(create|host)\s+(kronos\s+match|session|advanced\s+session|game\s+session)/i;
const SEARCHES = /^(find|search)\s+(kronos\s+matches|sessions|advanced\s+sessions)/i;
const PARAMS = /params|settings/i;
const LAN_PIN = /^b?(is)?(use)?lan/i;

function truthy(value: unknown): boolean | undefined {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return undefined;
}

/** The LAN flag for one call: on the call itself, or on the params node feeding it. */
async function lanFlagFor(
  graph: SessionGraph,
  node: SessionNode,
  readPins: PinReader
): Promise<{ lan?: boolean; via: string }> {
  const own = await readPins(graph.path, graph.graphName, node.id).catch(() => []);
  const ownLan = own.find((p) => LAN_PIN.test(String(p.name ?? "")));
  // Only when the pin gave a DEFINITE answer.
  //
  // It used to return here whenever the pin merely existed. A wired pin has no usable default -
  // the bridge no longer sends one at all - so that returned undefined and stopped, skipping the
  // feeder search below, which is exactly the case the feeder search was written for. Finding the
  // pin is not the same as learning its value, and only one of those is worth stopping on.
  const ownValue = ownLan ? truthy(ownLan.defaultValue) : undefined;
  if (ownValue !== undefined) return { lan: ownValue, via: node.title };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const feeders = (node.connectedPins ?? [])
    .filter((p) => p.direction === "in")
    .flatMap((p) => (p.linkedTo ?? []).map((l) => byId.get(l.node)))
    .filter((n): n is SessionNode => !!n && PARAMS.test(n.title ?? ""));

  for (const feeder of feeders) {
    const pins = await readPins(graph.path, graph.graphName, feeder.id).catch(() => []);
    const lan = pins.find((p) => LAN_PIN.test(String(p.name ?? "")));
    if (lan) return { lan: truthy(lan.defaultValue), via: feeder.title };
  }
  // Params from a variable or a function pin. Real, and not something a literal check can answer.
  return { lan: undefined, via: "" };
}

export interface SessionReview {
  hosts: Array<{ where: string; lan?: boolean }>;
  searches: Array<{ where: string; lan?: boolean }>;
  findings: SessionFinding[];
}

export async function reviewSessions(graphs: SessionGraph[], readPins: PinReader): Promise<SessionReview> {
  const hosts: Array<{ where: string; lan?: boolean }> = [];
  const searches: Array<{ where: string; lan?: boolean }> = [];

  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const title = String(node.title ?? "").trim();
      const isHost = HOSTS.test(title);
      const isSearch = SEARCHES.test(title);
      if (!isHost && !isSearch) continue;
      if (!graph.liveNodeIds.has(node.id)) continue;
      const { lan } = await lanFlagFor(graph, node, readPins);
      (isHost ? hosts : searches).push({ where: `${graph.blueprint} (${title})`, lan });
    }
  }

  const findings: SessionFinding[] = [];
  const hostLan = new Set(hosts.map((h) => h.lan).filter((v) => v !== undefined));
  const searchLan = new Set(searches.map((s) => s.lan).filter((v) => v !== undefined));

  // The one that empties the lobby list: hosting one way, looking the other.
  const crossed = [...hostLan].some((h) => [...searchLan].some((s) => h !== s));
  if (crossed) {
    const lanHosts = hosts.filter((h) => h.lan === true).map((h) => h.where);
    const netHosts = hosts.filter((h) => h.lan === false).map((h) => h.where);
    const lanSearch = searches.filter((s) => s.lan === true).map((s) => s.where);
    const netSearch = searches.filter((s) => s.lan === false).map((s) => s.where);
    findings.push({
      check: "session-lan-mismatch",
      severity: "error",
      message:
        `Hosting and searching disagree about LAN, so a lobby can be created and still never appear in ` +
        `the list. LAN hosts: ${lanHosts.join(", ") || "none"}. Online hosts: ${netHosts.join(", ") || "none"}. ` +
        `LAN searches: ${lanSearch.join(", ") || "none"}. Online searches: ${netSearch.join(", ") || "none"}.`,
      fix:
        `Pick one and make both sides read it. The reliable shape is a single bUseLAN variable on the ` +
        `GameInstance, with one function that builds host params and one that builds search params, both ` +
        `reading it - so the two can never drift apart again.`,
    });
  }

  // More than one live host button, each with its own literal settings, is how they drift.
  if (hostLan.size > 1) {
    findings.push({
      check: "session-host-paths-disagree",
      severity: "warning",
      message:
        `${hosts.length} live host path(s) exist and they are not configured the same: ` +
        hosts.map((h) => `${h.where} LAN=${h.lan ?? "?"}`).join("; ") +
        `. Which one the player pressed decides whether anyone can see the lobby.`,
      fix:
        `Have every host button call one shared function instead of each building its own params, ` +
        `then delete the copies. Duplicated literals in menus drift silently - nothing recompiles when ` +
        `they disagree.`,
    });
  }

  if (hosts.length > 0 && searches.length === 0) {
    findings.push({
      check: "session-host-without-search",
      severity: "warning",
      message: `The project hosts sessions (${hosts.length} live path(s)) but nothing live ever searches for one.`,
      fix: `If players are meant to find each other in-game, wire a search. If they join by invite only, ignore this.`,
    });
  }

  return { hosts, searches, findings };
}
