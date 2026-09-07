/**
 * The other half of the round trip: DSL text back into a graph.
 *
 * `decompileGraph` is only a pretty printer unless what it emits can be handed back, so this parses
 * the same S-expressions and lowers them to exactly what `unreal_build_graph` already takes -
 * `{nodes, connections, pinDefaults}`. That target is deliberate. `build_graph` is already atomic,
 * already resolves refs, already compiles, and already answers a wrong function name with
 * `didYouMean` instead of a dead end. None of that needed rebuilding; it needed a front end.
 *
 * ## What this is and is not
 *
 * It is a lowering pass, not a compiler with a type system. It does not know whether `PrintString`
 * exists, what pins it has, or whether the value you passed to `:InString` is a string - the engine
 * knows all three, and `build_graph` already asks it and reports back. Duplicating that here would
 * mean a second, worse copy of the truth that drifts from the first.
 *
 * So the errors raised here are only the ones the engine cannot raise: syntax that is not
 * S-expressions, a bind that nothing defines, a continuation in a place where it cannot attach. Get
 * past those and the engine has the final say, which is the correct division.
 *
 * ## Exec wiring
 *
 * Statements in a body run in order, so each one's `then` wires to the next one's `execute`. A form
 * that ends the flow - `if`, or any node with named continuations - consumes the rest of its body
 * into its branches, exactly as the reader emits it.
 */

export interface BuildNode {
  ref: string;
  nodeType: "Event" | "CustomEvent" | "CallFunction" | "VariableGet" | "VariableSet" | "Branch" | "Sequence" | "Cast" | "Macro" | "CallParent";
  eventName?: string;
  functionName?: string;
  variableName?: string;
  targetClass?: string;
  macroName?: string;
  pure?: boolean;
}

export interface BuildConnection {
  from: string;
  to: string;
}

export interface BuildPinDefault {
  node: string;
  pin: string;
  value: string;
}

export interface CompiledGraph {
  nodes: BuildNode[];
  connections: BuildConnection[];
  pinDefaults: BuildPinDefault[];
  /** Graph names named by `(fn ...)` blocks, so the caller knows what must already exist. */
  functionGraphs: string[];
}

export class DslError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line !== undefined ? `line ${line}: ${message}` : message);
    this.name = "DslError";
  }
}

// --- Reader ---------------------------------------------------------------------------------

type Atom = { kind: "atom"; value: string; quoted: boolean; line: number };
type List = { kind: "list"; items: Form[]; line: number };
type Form = Atom | List;

/**
 * Tokenise and parse. Comments run to end of line, strings are JSON strings so escaping is somebody
 * else's solved problem, and everything else is an atom.
 */
export function parseDsl(source: string): Form[] {
  const forms: Form[] = [];
  const stack: List[] = [];
  let i = 0;
  let line = 1;

  const push = (form: Form) => {
    if (stack.length === 0) forms.push(form);
    else stack[stack.length - 1].items.push(form);
  };

  while (i < source.length) {
    const c = source[i];

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === ";") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      const list: List = { kind: "list", items: [], line };
      stack.push(list);
      i++;
      continue;
    }
    if (c === ")") {
      const done = stack.pop();
      if (!done) throw new DslError("unbalanced ')'", line);
      push(done);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          out += source[j] + source[j + 1];
          j += 2;
          continue;
        }
        out += source[j];
        j++;
      }
      if (j >= source.length) throw new DslError("unterminated string", line);
      push({ kind: "atom", value: JSON.parse(`"${out}"`), quoted: true, line });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && !/[\s()";]/.test(source[j])) j++;
    push({ kind: "atom", value: source.slice(i, j), quoted: false, line });
    i = j;
  }

  if (stack.length > 0) throw new DslError("unbalanced '(' - a form was never closed", stack[stack.length - 1].line);
  return forms;
}

const isAtom = (f: Form | undefined): f is Atom => f?.kind === "atom";
const isList = (f: Form | undefined): f is List => f?.kind === "list";
const head = (f: List): string => (isAtom(f.items[0]) ? f.items[0].value : "");
/** `(:PinName ...)` - a named execution continuation rather than a call. */
const isContinuation = (f: Form): f is List => isList(f) && head(f).startsWith(":");

/**
 * Engine events versus custom ones.
 *
 * `Event` and `CustomEvent` are different node types and picking the wrong one fails in a confusing
 * way: asking for a CustomEvent called BeginPlay produces a second, never-called BeginPlay sitting
 * next to the real one. There is no way to tell them apart from the name alone, so the well-known
 * engine events are listed and everything else is assumed custom - which is the safe direction,
 * because a custom event with an engine name is a mistake either way.
 */
const ENGINE_EVENTS = new Set(
  [
    "ReceiveBeginPlay", "BeginPlay", "EventBeginPlay",
    "ReceiveTick", "Tick", "EventTick",
    "ReceiveEndPlay", "EndPlay", "EventEndPlay",
    "ReceiveActorBeginOverlap", "ActorBeginOverlap",
    "ReceiveActorEndOverlap", "ActorEndOverlap",
    "ReceiveHit", "Hit",
    "ReceiveAnyDamage", "AnyDamage",
    "ReceivePossessed", "Possessed",
    "ReceiveDestroyed", "Destroyed",
    "Construction", "UserConstructionScript",
  ].map((n) => n.toLowerCase())
);

// --- Lowering -------------------------------------------------------------------------------

interface Lower {
  nodes: BuildNode[];
  connections: BuildConnection[];
  pinDefaults: BuildPinDefault[];
  functionGraphs: string[];
  binds: Map<string, string>;
  counter: number;
}

function newRef(ctx: Lower, hint: string): string {
  const clean = hint.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "n";
  return `${clean}${++ctx.counter}`;
}

/**
 * The exec output pin that continues the flow, per node type. Everything else is a continuation
 * the author has to name, which is why the reader writes them out.
 */
function thenPin(node: BuildNode): string {
  return node.nodeType === "Event" || node.nodeType === "CustomEvent" ? "then" : "then";
}

/** Resolve a data expression to something that can be wired or defaulted. */
type Value = { kind: "literal"; text: string } | { kind: "pin"; ref: string; pin: string };

function lowerExpression(form: Form, ctx: Lower): Value {
  if (isAtom(form)) {
    if (form.quoted) return { kind: "literal", text: form.value };
    if (/^-?\d+(\.\d+)?$/.test(form.value) || form.value === "true" || form.value === "false") {
      return { kind: "literal", text: form.value };
    }
    if (form.value === "self") {
      const ref = newRef(ctx, "self");
      ctx.nodes.push({ ref, nodeType: "VariableGet", variableName: "self" });
      return { kind: "pin", ref, pin: "self" };
    }
    // A bare word is either a bind made earlier or a Blueprint variable read.
    const bound = ctx.binds.get(form.value);
    if (bound) return { kind: "pin", ref: bound, pin: "ReturnValue" };
    const ref = newRef(ctx, form.value);
    ctx.nodes.push({ ref, nodeType: "VariableGet", variableName: form.value });
    return { kind: "pin", ref, pin: form.value };
  }

  // A parenthesised expression is a pure call: (GetActorLocation :Target x)
  const name = head(form);
  if (!name) throw new DslError("empty expression", form.line);
  const ref = newRef(ctx, name);
  ctx.nodes.push({ ref, nodeType: "CallFunction", functionName: name, pure: true });
  applyArguments(form, 1, ref, ctx);
  return { kind: "pin", ref, pin: "ReturnValue" };
}

/** Wire or default every `:Pin value` pair in a form, starting at item `from`. */
function applyArguments(form: List, from: number, ref: string, ctx: Lower): void {
  for (let i = from; i < form.items.length; i++) {
    const item = form.items[i];
    if (isContinuation(item)) continue;
    if (!isAtom(item) || !item.value.startsWith(":") || item.quoted) continue;
    const pin = item.value.slice(1);
    const valueForm = form.items[i + 1];
    if (!valueForm) throw new DslError(`:${pin} has no value`, item.line);
    i++;
    const value = lowerExpression(valueForm, ctx);
    if (value.kind === "literal") ctx.pinDefaults.push({ node: ref, pin, value: value.text });
    else ctx.connections.push({ from: `${value.ref}.${value.pin}`, to: `${ref}.${pin}` });
  }
}

/** Statement forms that are not calls. */
function lowerStatement(form: Form, ctx: Lower): { ref: string; node: BuildNode } {
  if (!isList(form)) throw new DslError(`expected a statement, got "${isAtom(form) ? form.value : "?"}"`, form.line);
  const kind = head(form);
  const nameForm = form.items[1];
  const nameOf = () => {
    if (!isAtom(nameForm)) throw new DslError(`(${kind} ...) needs a name`, form.line);
    return nameForm.value;
  };

  if (kind === "set") {
    const variableName = nameOf();
    const ref = newRef(ctx, variableName);
    const node: BuildNode = { ref, nodeType: "VariableSet", variableName };
    ctx.nodes.push(node);
    const valueForm = form.items[2];
    if (valueForm) {
      const value = lowerExpression(valueForm, ctx);
      if (value.kind === "literal") ctx.pinDefaults.push({ node: ref, pin: variableName, value: value.text });
      else ctx.connections.push({ from: `${value.ref}.${value.pin}`, to: `${ref}.${variableName}` });
    }
    return { ref, node };
  }

  if (kind === "super") {
    const functionName = nameOf();
    const ref = newRef(ctx, functionName);
    const node: BuildNode = { ref, nodeType: "CallParent", functionName };
    ctx.nodes.push(node);
    return { ref, node };
  }

  if (kind === "cast") {
    const targetClass = nameOf();
    const ref = newRef(ctx, targetClass);
    const node: BuildNode = { ref, nodeType: "Cast", targetClass };
    ctx.nodes.push(node);
    applyArguments(form, 2, ref, ctx);
    return { ref, node };
  }

  if (kind === "macro") {
    const macroName = nameOf();
    const ref = newRef(ctx, macroName);
    const node: BuildNode = { ref, nodeType: "Macro", macroName };
    ctx.nodes.push(node);
    applyArguments(form, 2, ref, ctx);
    return { ref, node };
  }

  if (kind === "call") {
    const functionName = nameOf();
    const ref = newRef(ctx, functionName);
    const node: BuildNode = { ref, nodeType: "CallFunction", functionName };
    ctx.nodes.push(node);
    applyArguments(form, 2, ref, ctx);
    return { ref, node };
  }

  throw new DslError(`unknown statement "(${kind} ...)"`, form.line);
}

/**
 * Lower a body - a run of statements - and return the entry and exit of its execution chain.
 *
 * `exit` is undefined when the body ends in something that terminates the flow (a branch, or a node
 * whose outputs are all named continuations). The caller must not wire anything after it, and this
 * is how that is communicated rather than by wiring into a pin that does not exist.
 */
function lowerBody(items: Form[], ctx: Lower): { entry?: string; exit?: string } {
  let entry: string | undefined;
  let previousExit: string | undefined;
  let terminated = false;

  for (const form of items) {
    if (terminated) throw new DslError("statements after a form that ends the flow are unreachable", form.line);
    if (!isList(form)) throw new DslError("a body contains statements, not bare values", form.line);

    const kind = head(form);

    // (bind name <statement> [continuations...])
    let bindName: string | undefined;
    let stmtForm: List = form;
    if (kind === "bind") {
      const nameAtom = form.items[1];
      if (!isAtom(nameAtom)) throw new DslError("(bind ...) needs a name", form.line);
      bindName = nameAtom.value;
      const inner = form.items[2];
      if (!isList(inner)) throw new DslError("(bind name <statement>) needs a statement", form.line);
      // Continuations written on the bind form belong to the bound statement.
      stmtForm = { kind: "list", items: [...inner.items, ...form.items.slice(3)], line: inner.line };
    }

    const stmtKind = head(stmtForm);
    let selfEntry: string;
    let selfExit: string | undefined;

    if (stmtKind === "if") {
      const condForm = stmtForm.items[1];
      if (!condForm) throw new DslError("(if ...) needs a condition", stmtForm.line);
      const ref = newRef(ctx, "branch");
      ctx.nodes.push({ ref, nodeType: "Branch" });
      const cond = lowerExpression(condForm, ctx);
      if (cond.kind === "literal") ctx.pinDefaults.push({ node: ref, pin: "Condition", value: cond.text });
      else ctx.connections.push({ from: `${cond.ref}.${cond.pin}`, to: `${ref}.Condition` });

      const elseForm = stmtForm.items.find((f) => isList(f) && head(f) === "else") as List | undefined;
      const thenForms = stmtForm.items.slice(2).filter((f) => f !== elseForm);

      const thenBody = lowerBody(thenForms, ctx);
      if (thenBody.entry) ctx.connections.push({ from: `${ref}.then`, to: `${thenBody.entry}.execute` });
      if (elseForm) {
        const elseBody = lowerBody(elseForm.items.slice(1), ctx);
        if (elseBody.entry) ctx.connections.push({ from: `${ref}.else`, to: `${elseBody.entry}.execute` });
      }
      selfEntry = ref;
      selfExit = undefined; // both sides were wired; nothing follows a branch
      terminated = true;
    } else {
      const { ref } = lowerStatement(stmtForm, ctx);
      selfEntry = ref;

      const continuations = stmtForm.items.filter(isContinuation);
      if (continuations.length > 0) {
        for (const cont of continuations) {
          const pin = head(cont).slice(1);
          const body = lowerBody(cont.items.slice(1), ctx);
          if (body.entry) ctx.connections.push({ from: `${ref}.${pin}`, to: `${body.entry}.execute` });
        }
        selfExit = undefined;
        terminated = true;
      } else {
        selfExit = ref;
      }
    }

    if (bindName) ctx.binds.set(bindName, selfEntry);
    if (!entry) entry = selfEntry;
    if (previousExit) ctx.connections.push({ from: `${previousExit}.then`, to: `${selfEntry}.execute` });
    previousExit = selfExit;
  }

  return { entry, exit: previousExit };
}

/**
 * Compile DSL text into a `unreal_build_graph` payload.
 *
 * One block per call site: an `(event ...)` block builds into the graph you name, and a `(fn ...)`
 * block names a function graph that must already exist - this does not create function graphs,
 * because `unreal_create_function` does and doing it in two places is how they diverge.
 */
export function compileDsl(source: string): CompiledGraph {
  const forms = parseDsl(source);
  const ctx: Lower = {
    nodes: [],
    connections: [],
    pinDefaults: [],
    functionGraphs: [],
    binds: new Map(),
    counter: 0,
  };

  if (forms.length === 0) throw new DslError("nothing to build: the source is empty");

  for (const form of forms) {
    if (!isList(form)) throw new DslError("the top level holds (event ...) or (fn ...) blocks", form.line);
    const kind = head(form);
    const nameAtom = form.items[1];
    if (!isAtom(nameAtom)) throw new DslError(`(${kind} ...) needs a name`, form.line);
    const name = nameAtom.value;

    if (kind !== "event" && kind !== "fn") {
      throw new DslError(`the top level holds (event ...) or (fn ...) blocks, not "(${kind} ...)"`, form.line);
    }

    if (kind === "fn") {
      // Refused rather than half-done, and this is worth being precise about because the first
      // version of it WAS half-done: it lowered the body and then wired nothing to the function's
      // entry node, leaving every statement orphaned in the graph. That compiles - to nothing. A
      // function that silently does not run is far worse than one that was never written, and the
      // reader emits `(fn ...)` for any function graph, so a round trip would have produced exactly
      // that.
      //
      // Supporting it needs the entry node's id, which the DSL text does not carry: a function graph
      // already HAS its K2Node_FunctionEntry, so the writer must attach to that node rather than
      // create one. build_graph accepts an existing node id in place of a ref, so the mechanism is
      // there; the DSL has no way to name it yet.
      throw new DslError(
        `(fn ${name} ...) cannot be written back yet. A function graph already has its entry node, ` +
          `and this cannot name it, so the body would be built unattached and never run. ` +
          `Build into the function with unreal_build_graph graphName:"${name}" and wire the first ` +
          `statement to the existing entry node by its id (read it with unreal_read_blueprint_summary). ` +
          `Reading a function as DSL works; only writing one back does not.`,
        form.line
      );
    }

    const ref = newRef(ctx, name);
    ctx.nodes.push({
      ref,
      nodeType: ENGINE_EVENTS.has(name.toLowerCase()) ? "Event" : "CustomEvent",
      eventName: name,
    });
    const body = lowerBody(form.items.slice(2), ctx);
    if (body.entry) ctx.connections.push({ from: `${ref}.then`, to: `${body.entry}.execute` });
  }

  // A bind that nothing defines is the one error worth catching here, because it produces a wire to
  // a ref that does not exist and the engine's version of that message is not actionable.
  const refs = new Set(ctx.nodes.map((n) => n.ref));
  for (const c of ctx.connections) {
    const from = c.from.split(".")[0];
    const to = c.to.split(".")[0];
    if (!refs.has(from)) throw new DslError(`connection from unknown node "${from}"`);
    if (!refs.has(to)) throw new DslError(`connection to unknown node "${to}"`);
  }

  return {
    nodes: ctx.nodes,
    connections: ctx.connections,
    pinDefaults: ctx.pinDefaults,
    functionGraphs: ctx.functionGraphs,
  };
}

/** Kept exported so the wiring rule has one home if event/function exec pins ever differ. */
export { thenPin };
