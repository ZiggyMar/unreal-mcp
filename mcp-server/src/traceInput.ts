/**
 * "What happens when the player presses Escape?"
 *
 * The read-side question about input had no tool. `map_input_key` binds a key, `read_input_context`
 * reads one context, `find_references` finds referrers - the pieces were all there, and answering the
 * ordinary sentence took three chained calls plus knowing which chain to walk.
 *
 * That gap has a specific failure mode, and it happened here on a real project. Asked which menu
 * opens on Escape, the answer given was an asset called `WB_Pause` - found by listing files whose
 * name contained "pause" and picking the plausible one. The user's correction was blunt and correct:
 * *"You're assuming. What does the pause menu entail? You press escape. So when the player presses
 * escape, what menu shows up? And then you find THAT widget."*
 *
 * The real chain on that project runs Escape -> IA_OpenPause -> PC_Base, and `WB_Pause` was a
 * filename that pattern-matched. A model reaches for the filename because the filename is one cheap
 * call and the chain is several expensive ones. So the chain becomes one call.
 *
 * ## What it returns
 *
 * Key -> the contexts that bind it -> the actions they bind it to -> every Blueprint that handles
 * those actions -> what each handler actually does, in execution order.
 *
 * The last step is the one that answers the question, and it is why this returns chains rather than
 * a list of assets: "PC_Base handles it" is still an invitation to guess what PC_Base does.
 *
 * ## Split for testing
 *
 * The two selection rules - which action a key belongs to, and which chain belongs to an action - are
 * where the bugs live, and both are pure. They are tested against reply shapes rather than against a
 * running editor, the same way `inputChain` walks node shapes.
 */

import type { ExplainedChain, GraphExplanation } from "./explainGraph.js";

export interface BridgeLike {
  send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T>;
}

/** `read_input_context` groups its mappings by action name; each entry is a rendered mapping. */
export interface InputContextReply {
  context?: string;
  actions?: Record<string, string[]>;
}

/** One action a key resolves to, and where the binding lives. */
export interface ActionHit {
  action: string;
  /** Context names that bind this key to this action. More than one is normal and worth seeing. */
  contexts: string[];
  /** The mappings as the engine renders them, e.g. "Escape", "S (Negate)". */
  mappings: string[];
}

export interface HandlerTrace {
  /** Package path of the Blueprint that handles the action. */
  path: string;
  name: string;
  /** The event node's title, e.g. "EnhancedInputAction IA_OpenPause". */
  entry: string;
  entryId: string;
  /** What happens, in execution order. */
  steps: string[];
  truncated: boolean;
}

export interface ActionTrace {
  action: string;
  contexts: string[];
  mappings: string[];
  handlers: HandlerTrace[];
  /** Assets that reference the action but turned out to have no handler chain for it. */
  referencedByWithoutHandler: string[];
}

export interface InputTrace {
  key?: string;
  actions: ActionTrace[];
  notes: string[];
}

/**
 * The key half of a rendered mapping.
 *
 * `read_input_context` renders each mapping as the key followed by its modifiers in parentheses -
 * "Escape", "S (Negate)", "Gamepad_LeftStick_Y (SwizzleAxis, Negate)". Only the head is the key.
 */
export function keyOfMapping(mapping: string): string {
  const paren = mapping.indexOf("(");
  return (paren === -1 ? mapping : mapping.slice(0, paren)).trim();
}

/**
 * Which actions a key is bound to, across every context that was read.
 *
 * Compared case-insensitively and as a WHOLE key, never as a substring. Substring matching here is
 * actively harmful: "E" appears inside "Escape", "End", "Enter" and "Equals", so a substring rule
 * turns the most common interact key in Unreal into a match for half the keyboard. The engine's key
 * names are exact tokens and are treated as such.
 */
export function actionsForKey(
  contexts: Array<{ context: string; reply: InputContextReply }>,
  key: string
): ActionHit[] {
  const want = key.trim().toLowerCase();
  const byAction = new Map<string, ActionHit>();

  for (const { context, reply } of contexts) {
    const actions = reply.actions ?? {};
    for (const action of Object.keys(actions)) {
      const mappings = actions[action] ?? [];
      const hits = mappings.filter((m) => keyOfMapping(m).toLowerCase() === want);
      if (hits.length === 0) continue;

      const existing = byAction.get(action);
      if (existing) {
        if (!existing.contexts.includes(context)) existing.contexts.push(context);
        for (const h of hits) if (!existing.mappings.includes(h)) existing.mappings.push(h);
      } else {
        byAction.set(action, { action, contexts: [context], mappings: [...hits] });
      }
    }
  }

  return [...byAction.values()];
}

/**
 * The chains in one Blueprint that actually hang off this input action.
 *
 * An Enhanced Input event is titled with the action in it, and matching on the action NAME rather
 * than on the node type is deliberate: the same Blueprint routinely handles several actions, and
 * "every input event in PC_Base" is not the question that was asked. Whole-word again, so IA_Open
 * does not claim IA_OpenPause's chains.
 */
export function chainsForAction(explanation: GraphExplanation, action: string): ExplainedChain[] {
  const want = action.trim().toLowerCase();
  if (want === "") return [];
  return (explanation.chains ?? []).filter((chain) => {
    const entry = (chain.entry ?? "").toLowerCase();
    // Word boundary on both sides, so IA_Open does not match IA_OpenPause.
    const at = entry.indexOf(want);
    if (at === -1) return false;
    const before = at === 0 ? "" : entry[at - 1];
    const after = entry[at + want.length] ?? "";
    const isWordChar = (c: string) => c !== "" && /[a-z0-9_]/.test(c);
    return !isWordChar(before) && !isWordChar(after);
  });
}

/**
 * Render the trace as the sentence a person would say.
 *
 * Prose by default follows what `map_system` and `explain_graph` both measured: the structured form
 * is the same facts with the field names repeated once per row, at several times the tokens. A
 * caller that needs exact paths asks for the structure.
 */
export function describeTrace(trace: InputTrace): string {
  const lines: string[] = [];
  const head = trace.key ? `Pressing ${trace.key}` : "That action";

  if (trace.actions.length === 0) {
    lines.push(`${head} is not bound to any Input Action in the contexts that were read.`);
    for (const note of trace.notes) lines.push(note);
    return lines.join("\n");
  }

  for (const a of trace.actions) {
    const where = a.contexts.length > 0 ? ` (bound in ${a.contexts.join(", ")})` : "";
    lines.push(`${head} fires ${a.action}${where}.`);

    if (a.handlers.length === 0) {
      lines.push(
        `  Nothing handles it. ${
          a.referencedByWithoutHandler.length > 0
            ? `Referenced by ${a.referencedByWithoutHandler.join(", ")}, but none of them has an event for it.`
            : "No asset references the action at all."
        }`
      );
      continue;
    }

    for (const h of a.handlers) {
      lines.push(`  ${h.name} - ${h.entry}`);
      const steps = h.steps.length > 0 ? h.steps.join(" -> ") : "(the event runs into nothing)";
      lines.push(`    ${steps}${h.truncated ? " ..." : ""}`);
    }
  }

  for (const note of trace.notes) lines.push(note);
  return lines.join("\n");
}

/** Reading every referrer's graph is the expensive half, so it is capped and the cap is reported. */
const DEFAULT_MAX_HANDLERS = 6;

/** A Blueprint with more graphs than this is pathological; reading them all would cost more than it finds. */
const MAX_GRAPHS_PER_BLUEPRINT = 6;

interface AssetRow {
  name?: string;
  path?: string;
  assetName?: string;
  package?: string;
  assetClass?: string;
}

const rowName = (r: AssetRow): string => r.name ?? r.assetName ?? "";
const rowPath = (r: AssetRow): string => r.path ?? r.package ?? "";

/**
 * Graphs that can hold an input event, named as this Blueprint actually spells them.
 *
 * Input events live in an ubergraph, and "EventGraph" is only the DEFAULT name for one - a project
 * that split its events across several, or renamed the first, has them elsewhere. Reading the default
 * name and stopping produces "nothing handles this key", which is the most confidently wrong answer
 * this tool can give.
 *
 * Falls back to the default name when the graph list cannot be read, so a bridge that does not answer
 * degrades to the old single-graph behaviour rather than to no answer at all.
 */
export async function eventGraphNames(bridge: BridgeLike, path: string): Promise<string[]> {
  try {
    const listed = await bridge.send<{ graphs?: Array<{ name?: string; kind?: string }> }>(
      "list_blueprint_graphs",
      { path }
    );
    // The reply marks delegate graphs with `kind` and nothing else, so function graphs look like
    // ubergraphs here. Rather than guess which is which, read them all and drop only what CANNOT
    // hold an input event: a delegate graph is a bound event's body, and the construction script runs
    // at spawn. Reading a function graph that has no input event costs a call and returns no chains,
    // which is cheap and honest; guessing wrong costs the whole answer.
    const names = (listed.graphs ?? [])
      .filter((g) => g.name && !g.kind && g.name !== "UserConstructionScript")
      .map((g) => g.name as string);
    if (names.length === 0) return ["EventGraph"];
    // Put the conventional name first so the common case answers on the first read.
    names.sort((a, b) => Number(b === "EventGraph") - Number(a === "EventGraph"));
    return names.slice(0, MAX_GRAPHS_PER_BLUEPRINT);
  } catch {
    return ["EventGraph"];
  }
}

/**
 * Trace a key (or an action directly) to the Blueprints that handle it and what they do.
 *
 * `explain` is injected rather than imported so the orchestration can be tested without dragging in
 * the graph explainer's own behaviour - a test here should fail for reasons about tracing.
 */
export async function traceInput(
  bridge: BridgeLike,
  options: { key?: string; action?: string; maxHandlers?: number },
  explain: (summary: unknown, opts: { match?: string }) => GraphExplanation
): Promise<InputTrace> {
  const maxHandlers = options.maxHandlers ?? DEFAULT_MAX_HANDLERS;
  const notes: string[] = [];
  let hits: ActionHit[] = [];

  if (options.key) {
    const listed = await bridge.send<{ assets?: AssetRow[] }>("list_assets", {
      className: "InputMappingContext",
      maxResults: 100,
    });
    const contexts: Array<{ context: string; reply: InputContextReply }> = [];
    for (const ctx of listed.assets ?? []) {
      const path = rowPath(ctx);
      if (!path) continue;
      try {
        const reply = await bridge.send<InputContextReply>("read_input_context", { path });
        contexts.push({ context: reply.context ?? rowName(ctx), reply });
      } catch {
        // One unreadable context must not sink the trace; it is named instead.
        notes.push(`Could not read ${rowName(ctx) || path}.`);
      }
    }
    if (contexts.length === 0) {
      notes.push("No InputMappingContext assets were readable, so no key bindings could be resolved.");
    }
    hits = actionsForKey(contexts, options.key);
  } else if (options.action) {
    hits = [{ action: options.action, contexts: [], mappings: [] }];
  }

  const actionAssets = await bridge.send<{ assets?: AssetRow[] }>("list_assets", {
    className: "InputAction",
    maxResults: 300,
  });

  const actions: ActionTrace[] = [];
  for (const hit of hits) {
    const asset = (actionAssets.assets ?? []).find(
      (a) => rowName(a).toLowerCase() === hit.action.toLowerCase()
    );
    const trace: ActionTrace = {
      action: hit.action,
      contexts: hit.contexts,
      mappings: hit.mappings,
      handlers: [],
      referencedByWithoutHandler: [],
    };

    if (!asset || !rowPath(asset)) {
      notes.push(`${hit.action} is bound but its asset was not found, so its handlers are unknown.`);
      actions.push(trace);
      continue;
    }

    const refs = await bridge.send<{ referencedBy?: AssetRow[] }>("find_references", {
      path: rowPath(asset),
      direction: "referencedBy",
      maxResults: 100,
    });

    // Mapping contexts reference the action too - that is the binding, not a handler.
    const candidates = (refs.referencedBy ?? []).filter(
      (r) => !/InputMappingContext/i.test(r.assetClass ?? "")
    );

    let read = 0;
    for (const cand of candidates) {
      const path = rowPath(cand);
      if (!path) continue;
      if (read >= maxHandlers) {
        notes.push(
          `Stopped after reading ${maxHandlers} of ${candidates.length} referrers of ${hit.action}; raise maxHandlers to see the rest.`
        );
        break;
      }
      read++;
      try {
        // Every event graph, not just the one called "EventGraph".
        //
        // A Blueprint can hold several, and input events live in whichever one somebody put them in.
        // Reading only the default name finds nothing in a project that split its graphs up, and
        // "nothing handles this key" is the most confidently wrong answer this tool can give.
        const chains: ExplainedChain[] = [];
        for (const graphName of await eventGraphNames(bridge, path)) {
          const summary = await bridge.send("read_blueprint_graph_summary", { path, graphName });
          chains.push(...chainsForAction(explain(summary, { match: hit.action }), hit.action));
        }

        if (chains.length === 0) {
          trace.referencedByWithoutHandler.push(rowName(cand) || path);
          continue;
        }
        for (const chain of chains) {
          trace.handlers.push({
            path,
            name: rowName(cand) || path,
            entry: chain.entry,
            entryId: chain.entryId,
            steps: chain.steps ?? [],
            truncated: Boolean(chain.truncated),
          });
        }
      } catch {
        // A referrer with no EventGraph (a widget, a data asset) is ordinary, not an error.
        trace.referencedByWithoutHandler.push(rowName(cand) || path);
      }
    }

    actions.push(trace);
  }

  return { key: options.key, actions, notes };
}
