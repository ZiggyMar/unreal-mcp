/**
 * A Blueprint graph as code.
 *
 * ## Why
 *
 * Everything else this server does to a graph treats it as a wiring diagram: nodes with ids, pins,
 * and a list of links between them. That is what the engine stores, and it is the wrong shape for
 * both ends of the job.
 *
 * For reading, a wiring diagram makes the model reconstruct control flow itself - it has to notice
 * that node `A1B2...` is a Branch, find which of its two exec outputs each downstream chain hangs
 * off, and hold that in its head while it does the same for the next one. `explainGraph` dodges this
 * by flattening to prose, which is cheap and readable but deliberately lossy: it cannot tell you
 * what the condition was or what literal got printed.
 *
 * For writing, it means describing an `if` as five nodes and four wires, and getting any one of them
 * wrong produces a graph that compiles and does the wrong thing.
 *
 * Code has neither problem. Control flow is written as control flow, literals are visible, and the
 * same text reads and writes - so "add a null check before the cast" is an edit to two lines rather
 * than a re-derivation of the node graph.
 *
 * ## Where the shape comes from
 *
 * Epic's 5.8 first-party MCP plugin ships exactly this idea in `blueprint_dsl.py`: an S-expression
 * IDL with a real round trip (`read_graph_dsl` / `write_graph_dsl`). The shape is theirs and it is
 * better than what we had, so it is taken deliberately: S-expressions, `:PinName value` keyword
 * arguments, and `(:ExecOutput ...)` sub-lists for nodes with more than one execution output.
 *
 * What is NOT taken is their vocabulary. Epic names nodes by their toolset-registry type ids
 * (`Development|PrintString`), which only mean something inside their registry. This emits the
 * vocabulary our own writer already speaks - `call`, `get`, `set`, `cast`, `event` - so the text
 * that comes out of a read is text `unreal_build_graph` can be handed back. A round trip that only
 * goes one way is a pretty printer, not a DSL.
 *
 * ## What it does not do
 *
 * This is the read half. It is honest about its limits rather than guessing:
 *
 * - Pin literals are only present if the caller asked the bridge for them (`withPinValues`).
 *   Without them a call renders with its arguments missing, and `decompileGraph` says so in
 *   `warnings` rather than emitting code that looks complete and is not.
 * - Loop macros render as macro calls with named continuations, not as `(for ...)`. A ForLoop in a
 *   Blueprint is a macro instance, and pattern-matching it into a `for` would be a guess that is
 *   wrong for every custom macro that happens to have a Body pin.
 * - Anything unrecognised degrades to the general node-call form with its exec outputs as named
 *   continuations. That is still valid DSL and still says what is connected to what.
 * - Function graphs read as `(fn ...)` but cannot be written back. A function graph already owns its
 *   entry node and the text has no way to name it, so building one would leave the body unattached -
 *   a function that compiles and never runs. The writer refuses rather than doing that quietly.
 */

import { EXEC_INPUT, isKnot, type FlowNode } from "./execFlow.js";

export interface DslPinLink {
  node: string;
  pin: string;
}

export interface DslPin {
  pin: string;
  direction: string;
  linkedTo?: DslPinLink[];
  /** Literal on an unconnected input pin. Only present when the read asked for defaults. */
  value?: string;
  /** Pin category for `value`, so a literal can be quoted correctly. */
  ty?: string;
}

export interface DslNode extends FlowNode {
  id: string;
  type: string;
  title?: string;
  connectedPins?: DslPin[];
  /**
   * Literals on unwired input pins, as the bridge sends them: `{ pinName: value }`, present only
   * when the summary was read `withPinValues`. Deliberately not per-pin objects - the bridge omits
   * wired pins, exec pins and empty values, so this is already only the pins that carry an argument.
   */
  values?: Record<string, string>;
}

export interface DslGraph {
  path?: string;
  graphName?: string;
  nodes: DslNode[];
}

export interface DecompiledGraph {
  /** The graph as DSL text. */
  code: string;
  /** Things the reader could not represent faithfully. Empty is the good case. */
  warnings: string[];
  /** Nodes reached from an entry point. */
  covered: number;
  /** Nodes in the graph that no entry point reaches - orphans, or logic wired to nothing. */
  orphaned: number;
}

/** Node classes whose exec output continues a chain rather than naming a branch of it. */
const THEN_PINS = /^(then|out|exec|completed)$/i;

/** Pins that carry plumbing rather than an argument worth writing down. */
const NOISE_PINS = /^(self|execute|exec|then|in|out|__worldcontext)$/i;

/**
 * Unreal node titles are display strings and frequently multi-line - "Set Actor Location" arrives
 * with "Target is Actor" on a second line. Only the first line names the thing.
 */
function shortTitle(node: DslNode): string {
  const raw = (node.title ?? node.type ?? "Node").split("\n")[0].trim();
  return raw.length > 0 ? raw : node.type;
}

/**
 * A symbol usable as a bare token in the DSL, or a quoted string if it cannot be.
 *
 * Spaces are removed rather than escaped. Unreal derives a node's display title from the function
 * name by inserting spaces at the case boundaries - `PrintString` is shown as "Print String" - and
 * the summary only carries the title. Removing the spaces recovers the name the writer needs, and a
 * name that survives the round trip is worth more than one that reproduces the editor's label. Where
 * that guess is wrong the writer says so, because it resolves names through the node catalog and
 * answers a miss with didYouMean rather than silently building the wrong node.
 */
function symbol(name: string): string {
  const squashed = name.replace(/\s+/g, "");
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(squashed)) return squashed;
  return JSON.stringify(name);
}

/**
 * The class a cast targets. "Cast To BP_Door" is a title, not a name; `BP_Door` is what the writer
 * needs and what a reader wants to see.
 */
function castTarget(title: string): string {
  const match = /^Cast\s+To\s+(.+)$/i.exec(title.trim());
  return symbol(match ? match[1] : title);
}

/**
 * Render a pin literal.
 *
 * Quoting is decided by SHAPE, not by declared type, because the summary does not carry pin types -
 * it sends `values: { pinName: "text" }` and nothing else. So a string whose text happens to be
 * "true" renders as the bare token `true` and reads like a boolean.
 *
 * That is a display ambiguity and not a correctness one, which is the reason it is acceptable here:
 * the write half turns every literal back into a `pinDefaults` entry, whose value is a string that
 * the engine parses against the real pin type. Both spellings survive the round trip identically.
 * If pin types ever appear in the summary, pass them as `ty` and this gets it exactly right.
 */
function literal(value: string, ty?: string): string {
  const t = (ty ?? "").toLowerCase();
  if (t === "boolean") return value.toLowerCase() === "true" ? "true" : "false";
  if (t === "int" || t === "int64" || t === "byte" || t === "real" || t === "float" || t === "double") {
    return Number.isFinite(Number(value)) ? value : JSON.stringify(value);
  }
  if (!t) {
    // No declared type: fall back to shape.
    if (value === "true" || value === "false") return value;
    if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  }
  // Structs arrive as engine-formatted text like "(X=0.0,Y=0.0,Z=0.0)". There is no useful
  // decomposition here, so it is passed through as a quoted string exactly as the engine wrote it.
  return JSON.stringify(value);
}

interface Ctx {
  byId: Map<string, DslNode>;
  warnings: string[];
  /** Nodes already emitted as a statement, and the name they were bound to if any. */
  bound: Map<string, string>;
  visited: Set<string>;
  /** Guards a pure-expression cycle, which the editor permits through knots. */
  expanding: Set<string>;
  reached: Set<string>;
  budget: { steps: number };
}

/** Does this node sit in the execution flow, or is it a pure data node? */
function isImpure(node: DslNode): boolean {
  return (node.connectedPins ?? []).some((p) => EXEC_INPUT.test(p.pin) && p.direction === "in");
}

/**
 * Follow a link through any number of reroute knots to the node that actually matters.
 *
 * `keep` is the direction to carry on in, and getting it wrong is not a cosmetic bug: following a
 * knot's INPUT links while tracing execution forwards walks back up the wire to the node you just
 * came from, which reads as a one-step infinite loop. Tracing execution forwards leaves a knot by
 * its outputs ("out"); tracing a data value backwards to its producer leaves by its inputs ("in").
 */
function resolve(
  link: DslPinLink,
  ctx: Ctx,
  keep: "in" | "out",
  seen = new Set<string>()
): { node: DslNode; pin: string } | undefined {
  const node = ctx.byId.get(link.node);
  if (!node) return undefined;
  if (!isKnot(node)) return { node, pin: link.pin };
  if (seen.has(node.id)) return undefined;
  seen.add(node.id);
  for (const pin of node.connectedPins ?? []) {
    if (pin.direction !== keep) continue;
    for (const inner of pin.linkedTo ?? []) {
      const found = resolve(inner, ctx, keep, seen);
      if (found) return found;
    }
  }
  return undefined;
}

/** The exec outputs of a node, as [pinName, targets]. */
function execOutputs(node: DslNode, ctx: Ctx): Array<{ pin: string; targets: DslNode[] }> {
  const out: Array<{ pin: string; targets: DslNode[] }> = [];
  for (const pin of node.connectedPins ?? []) {
    if (pin.direction !== "out") continue;
    const targets: DslNode[] = [];
    for (const link of pin.linkedTo ?? []) {
      const found = resolve(link, ctx, "out");
      if (found && EXEC_INPUT.test(found.pin)) targets.push(found.node);
    }
    if (targets.length > 0) out.push({ pin: pin.pin, targets });
  }
  return out;
}

/**
 * The value flowing into a data input pin, as an expression.
 *
 * A pure node is inlined - that is what makes the output read like code rather than like a node
 * list. An impure node cannot be inlined, because it has a position in the execution order that
 * inlining would silently move; it is referenced by the name it was bound to at that position.
 */
function expression(pin: DslPin, ctx: Ctx): string | undefined {
  const link = (pin.linkedTo ?? [])[0];
  if (!link) {
    return pin.value !== undefined ? literal(pin.value, pin.ty) : undefined;
  }
  const found = resolve(link, ctx, "in");
  if (!found) return undefined;
  const src = found.node;

  if (isImpure(src)) {
    const name = ctx.bound.get(src.id);
    if (name) return name;
    // Reached before the statement that produces it - a graph can legally do this through a
    // variable, but rendering a name that is never bound would produce code that does not
    // round-trip, so it is named as a node instead and flagged.
    ctx.warnings.push(`value from "${shortTitle(src)}" is used before its statement; shown as @${src.id.slice(0, 6)}`);
    return `@${src.id.slice(0, 6)}`;
  }

  if (ctx.expanding.has(src.id)) return `@${src.id.slice(0, 6)}`;
  ctx.expanding.add(src.id);
  try {
    return pureExpression(src, found.pin, ctx);
  } finally {
    ctx.expanding.delete(src.id);
  }
}

function pureExpression(node: DslNode, _outPin: string, ctx: Ctx): string {
  ctx.reached.add(node.id);
  const title = shortTitle(node);

  if (node.type === "K2Node_VariableGet") return symbol(title);
  if (node.type === "K2Node_Self") return "self";

  const args = argumentList(node, ctx);
  if (node.type === "K2Node_CallFunction" || node.type === "K2Node_CallArrayFunction") {
    return args.length > 0 ? `(${symbol(title)} ${args.join(" ")})` : `(${symbol(title)})`;
  }
  return args.length > 0 ? `(${symbol(title)} ${args.join(" ")})` : `(${symbol(title)})`;
}

/**
 * The data arguments of a node, as `:PinName value` pairs.
 *
 * Keyword form is used throughout rather than positional, because pin order in the engine is not
 * stable across engine versions and a positional argument that silently shifts by one is the worst
 * possible failure here.
 */
function argumentList(node: DslNode, ctx: Ctx): string[] {
  const args: string[] = [];
  for (const pin of node.connectedPins ?? []) {
    if (pin.direction !== "in") continue;
    if (NOISE_PINS.test(pin.pin)) continue;
    const value = expression(pin, ctx);
    if (value === undefined) continue;
    args.push(`:${symbol(pin.pin)} ${value}`);
  }
  // Unwired inputs carrying a literal arrive separately, in `values`, because the pin list only
  // holds pins that are connected to something. They are the arguments nobody wired - which is most
  // of the interesting ones: the string being printed, the delay in seconds, the class to spawn.
  for (const [pinName, raw] of Object.entries(node.values ?? {})) {
    if (NOISE_PINS.test(pinName)) continue;
    args.push(`:${symbol(pinName)} ${literal(raw)}`);
  }
  return args;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}

/**
 * Walk one execution chain, emitting statements.
 *
 * `visited` is per-chain rather than global: a node genuinely reached from two different branches
 * is real and should be written twice, but a node reached twice through a cycle must stop.
 */
function walk(node: DslNode | undefined, ctx: Ctx, depth: number, visited: Set<string>): string[] {
  const lines: string[] = [];
  let current = node;

  while (current) {
    if (visited.has(current.id)) {
      lines.push(`${indent(depth)}; loops back to ${shortTitle(current)}`);
      return lines;
    }
    if (ctx.budget.steps-- <= 0) {
      lines.push(`${indent(depth)}; ...truncated`);
      ctx.warnings.push("graph is larger than the step budget; output is truncated");
      return lines;
    }
    visited.add(current.id);
    ctx.reached.add(current.id);

    const title = shortTitle(current);
    const outputs = execOutputs(current, ctx);

    // --- Branch: the one node worth rendering as real syntax. --------------------------------
    if (current.type === "K2Node_IfThenElse") {
      const condPin = (current.connectedPins ?? []).find((p) => p.direction === "in" && /^condition$/i.test(p.pin));
      const cond = condPin ? (expression(condPin, ctx) ?? "?") : "?";
      const thenBranch = outputs.find((o) => /^then$/i.test(o.pin));
      const elseBranch = outputs.find((o) => /^else$/i.test(o.pin));

      lines.push(`${indent(depth)}(if ${cond}`);
      for (const t of thenBranch?.targets ?? []) lines.push(...walk(t, ctx, depth + 1, new Set(visited)));
      if (elseBranch && elseBranch.targets.length > 0) {
        lines.push(`${indent(depth + 1)}(else`);
        for (const t of elseBranch.targets) lines.push(...walk(t, ctx, depth + 2, new Set(visited)));
        lines.push(`${indent(depth + 1)})`);
      }
      lines.push(`${indent(depth)})`);
      return lines; // a branch ends the linear chain; both sides were just written
    }

    // --- Statement forms ---------------------------------------------------------------------
    let head: string;
    if (current.type === "K2Node_VariableSet") {
      // The value is wired in, or it is a literal - and a literal is not in the pin list at all,
      // it is in `values`. Missing the second case renders every constant assignment as `(set x ?)`,
      // which then round-trips into a read of a variable called "?".
      const valuePin = (current.connectedPins ?? []).find((p) => p.direction === "in" && !NOISE_PINS.test(p.pin));
      const literalEntry = Object.entries(current.values ?? {}).find(([pin]) => !NOISE_PINS.test(pin));
      const value = valuePin
        ? (expression(valuePin, ctx) ?? "?")
        : literalEntry
          ? literal(literalEntry[1])
          : "?";
      head = `(set ${symbol(title)} ${value})`;
    } else if (current.type === "K2Node_CallParentFunction") {
      head = `(super ${symbol(title)})`;
    } else if (current.type === "K2Node_MacroInstance") {
      const args = argumentList(current, ctx);
      head = `(macro ${symbol(title)}${args.length ? " " + args.join(" ") : ""})`;
    } else if (current.type === "K2Node_DynamicCast") {
      const args = argumentList(current, ctx);
      head = `(cast ${castTarget(title)}${args.length ? " " + args.join(" ") : ""})`;
    } else {
      const args = argumentList(current, ctx);
      head = `(call ${symbol(title)}${args.length ? " " + args.join(" ") : ""})`;
    }

    // A node whose output is read later has to be named, or the reference has nothing to point at.
    const producesValue = (current.connectedPins ?? []).some(
      (p) => p.direction === "out" && !THEN_PINS.test(p.pin) && (p.linkedTo ?? []).length > 0
    );
    let bindName: string | undefined;
    if (producesValue && current.type !== "K2Node_VariableSet") {
      bindName = `v${ctx.bound.size + 1}`;
      ctx.bound.set(current.id, bindName);
    }

    // Named continuations, for anything with more than one way out.
    const continuations = outputs.filter((o) => !THEN_PINS.test(o.pin));
    const straightOn = outputs.find((o) => THEN_PINS.test(o.pin));

    if (continuations.length > 0) {
      const open = bindName ? `${indent(depth)}(bind ${bindName} ${head}` : `${indent(depth)}${head.slice(0, -1)}`;
      lines.push(open);
      const bodyDepth = depth + 1;
      if (straightOn) {
        lines.push(`${indent(bodyDepth)}(:${symbol(straightOn.pin)}`);
        for (const t of straightOn.targets) lines.push(...walk(t, ctx, bodyDepth + 1, new Set(visited)));
        lines.push(`${indent(bodyDepth)})`);
      }
      for (const cont of continuations) {
        lines.push(`${indent(bodyDepth)}(:${symbol(cont.pin)}`);
        for (const t of cont.targets) lines.push(...walk(t, ctx, bodyDepth + 1, new Set(visited)));
        lines.push(`${indent(bodyDepth)})`);
      }
      lines.push(`${indent(depth)})`);
      return lines; // continuations consume the rest of the flow
    }

    lines.push(bindName ? `${indent(depth)}(bind ${bindName} ${head})` : `${indent(depth)}${head}`);

    const next = straightOn?.targets ?? [];
    if (next.length === 0) return lines;
    if (next.length > 1) {
      // One exec pin wired to several nodes runs them in order, which is legal and rare.
      for (const t of next) lines.push(...walk(t, ctx, depth, new Set(visited)));
      return lines;
    }
    current = next[0];
  }

  return lines;
}

const ENTRY_TYPES = new Set([
  "K2Node_Event",
  "K2Node_CustomEvent",
  "K2Node_FunctionEntry",
  "K2Node_InputAction",
  "K2Node_InputKey",
  "K2Node_InputAxisEvent",
  "K2Node_ComponentBoundEvent",
  "K2Node_ActorBoundEvent",
  "K2Node_EnhancedInputAction",
]);

/**
 * Decompile a graph summary into DSL text.
 *
 * Pass a summary read with `includeDefaults` if you want literals; without them the code is
 * structurally correct but arguments are missing, and that is reported rather than hidden.
 */
export function decompileGraph(graph: DslGraph, options: { maxSteps?: number } = {}): DecompiledGraph {
  const byId = new Map<string, DslNode>();
  for (const node of graph.nodes ?? []) byId.set(node.id, node);

  const ctx: Ctx = {
    byId,
    warnings: [],
    bound: new Map(),
    visited: new Set(),
    expanding: new Set(),
    reached: new Set(),
    budget: { steps: options.maxSteps ?? 400 },
  };

  const entries = (graph.nodes ?? []).filter((n) => {
    if (ENTRY_TYPES.has(n.type)) return true;
    if (isKnot(n)) return false;
    // A node with exec out and nothing wired into its exec in is also an entry: that is what a
    // detached chain looks like, and silently dropping it would under-report the graph.
    const hasExecOut = (n.connectedPins ?? []).some((p) => p.direction === "out" && THEN_PINS.test(p.pin));
    const hasExecIn = (n.connectedPins ?? []).some((p) => p.direction === "in" && EXEC_INPUT.test(p.pin));
    return hasExecOut && !hasExecIn;
  });

  const blocks: string[] = [];
  for (const entry of entries) {
    ctx.reached.add(entry.id);
    const title = shortTitle(entry);
    const keyword = entry.type === "K2Node_FunctionEntry" ? "fn" : "event";
    const body = execOutputs(entry, ctx).flatMap((o) => o.targets.flatMap((t) => walk(t, ctx, 1, new Set())));
    blocks.push(`(${keyword} ${symbol(title)}\n${body.length > 0 ? body.join("\n") : "  ; nothing wired"})`);
  }

  const nonKnot = (graph.nodes ?? []).filter((n) => !isKnot(n));
  const orphaned = nonKnot.filter((n) => !ctx.reached.has(n.id)).length;

  const anyLiterals = (graph.nodes ?? []).some(
    (n) => Object.keys(n.values ?? {}).length > 0 || (n.connectedPins ?? []).some((p) => p.value !== undefined)
  );
  if (!anyLiterals && nonKnot.length > 0) {
    ctx.warnings.push(
      "no pin literals were present, so call arguments are missing. Read the graph with withPinValues " +
        "to get them."
    );
  }
  if (entries.length === 0 && nonKnot.length > 0) {
    ctx.warnings.push("no entry point found; the graph has nodes but nothing that starts execution");
  }

  return {
    code: blocks.join("\n\n"),
    warnings: ctx.warnings,
    covered: ctx.reached.size,
    orphaned,
  };
}

/** The grammar, for a model that has not seen this before. Epic's `get_graph_dsl_docs`. */
export const DSL_GRAMMAR = `Blueprint graph DSL (S-expressions). One graph = one or more blocks.

BLOCKS
  (event Name  stmt ...)        an event graph entry - BeginPlay, a custom event, an input action
  (fn Name  stmt ...)           a function graph entry - READ ONLY. build_graph refuses these,
                                because a function graph already has its entry node and this cannot
                                name it, so the body would be built unattached and never run.

STATEMENTS
  (call Name :Pin value ...)    call a function or a node; arguments are always keyword form
  (set Var value)               set a Blueprint variable
  (super Name)                  call the parent class implementation
  (cast Name :Pin value ...)    a dynamic cast; its outcomes are named continuations
  (macro Name :Pin value ...)   a macro instance - ForLoop, ForEach, DoOnce, Gate
  (bind v (call ...))           name a call's output so a later statement can use it
  (if cond
    stmt ...
    (else stmt ...))            a Branch

CONTINUATIONS
  A node with more than one execution output writes each as a sub-list whose head starts with ":".

  (cast BP_Door :Object hit
    (:then   (call PrintString :InString "it is a door"))
    (:Cast Failed))

EXPRESSIONS
  literal      1  3.14  "text"  true  false
  variable     MyVar              a bare word is a variable read
  self         the owning object
  call         (FunctionName :Pin value ...)   a pure node, inlined where it is used
  @abc123      a value whose producing statement could not be named; read the node by that id

COMMENTS
  ; to end of line. The reader emits these for loops back and truncation.`;
