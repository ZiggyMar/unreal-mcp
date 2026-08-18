/**
 * A whole Blueprint in one call.
 *
 * Benchmarking said this plainly: both a 7B and a 14B fail the same four-step task in the same way.
 * They complete step one, declare the task finished, and then repeat their first successful call
 * even when told exactly what is missing. Doubling the parameters changed nothing, so it is not a
 * capacity problem — it is that a small model cannot hold a plan across turns.
 *
 * You cannot fix that from inside a tool. What you can do is stop requiring it. If the failure is
 * "cannot reliably make four calls in sequence", then the answer is a call that does all four, and
 * a model that manages exactly one successful tool call finishes a whole feature.
 *
 * That is the entire justification for this being one big call rather than a tidy set of small
 * ones. Everything here is available separately; this is the same work with the sequencing moved
 * from the model, which is bad at it, to the server, which cannot get it wrong.
 *
 * Order matters and is fixed deliberately: variables and components exist before any graph
 * references them, handlers are built after that, and the compile happens once at the end rather
 * than after every step.
 */

import type { BridgeLike } from "./autoLayout.js";
import { autoLayoutGraph } from "./autoLayout.js";
import { addEventHandler, type HandlerAction } from "./eventHandler.js";
import { reviewBlueprint } from "./review.js";

export interface ScaffoldVariable {
  name: string;
  type: string;
  defaultValue?: string;
}

export interface ScaffoldComponent {
  componentClass: string;
  name: string;
  parent?: string;
  properties?: Record<string, string>;
}

export interface ScaffoldHandler {
  event: string;
  actions: HandlerAction[];
}

export interface ScaffoldSpec {
  packagePath: string;
  parentClass: string;
  variables?: ScaffoldVariable[];
  components?: ScaffoldComponent[];
  handlers?: ScaffoldHandler[];
  save?: boolean;
}

export interface ScaffoldResult {
  path: string;
  created: boolean;
  variablesAdded: string[];
  componentsAdded: string[];
  handlersBuilt: string[];
  compiled?: unknown;
  review?: { score: number; nextAction: string };
  saved: boolean;
  /** Steps that failed, with what went wrong. The rest still happened. */
  failures: Array<{ step: string; error: string }>;
  summary: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function scaffoldBlueprint(bridge: BridgeLike, spec: ScaffoldSpec): Promise<ScaffoldResult> {
  const objectPath = `${spec.packagePath}.${spec.packagePath.slice(spec.packagePath.lastIndexOf("/") + 1)}`;
  const result: ScaffoldResult = {
    path: objectPath,
    created: false,
    variablesAdded: [],
    componentsAdded: [],
    handlersBuilt: [],
    saved: false,
    failures: [],
    summary: "",
  };

  // --- the Blueprint itself ---------------------------------------------------------------------
  // Save is deferred to the end: saving an empty Blueprint and then saving it again is two disk
  // writes for one asset, and a failure in between leaves a saved-but-empty asset on disk.
  await bridge.send("create_blueprint", {
    packagePath: spec.packagePath,
    parentClass: spec.parentClass,
    save: false,
  });
  result.created = true;

  // --- state before behaviour --------------------------------------------------------------------
  for (const variable of spec.variables ?? []) {
    try {
      await bridge.send("add_variable", {
        path: objectPath,
        variableName: variable.name,
        type: variable.type,
        defaultValue: variable.defaultValue,
      });
      result.variablesAdded.push(variable.name);
    } catch (err) {
      // One bad variable should not cost the caller the whole feature; it is reported and the rest
      // proceeds, because a partially built Blueprint you can see is more useful than nothing.
      result.failures.push({ step: `variable ${variable.name}`, error: message(err) });
    }
  }

  for (const component of spec.components ?? []) {
    try {
      await bridge.send("add_component", {
        path: objectPath,
        componentClass: component.componentClass,
        name: component.name,
        parent: component.parent,
      });
      result.componentsAdded.push(component.name);
      for (const [property, value] of Object.entries(component.properties ?? {})) {
        try {
          await bridge.send("set_component_property", {
            path: objectPath,
            component: component.name,
            property,
            value,
          });
        } catch (err) {
          result.failures.push({ step: `${component.name}.${property}`, error: message(err) });
        }
      }
    } catch (err) {
      result.failures.push({ step: `component ${component.name}`, error: message(err) });
    }
  }

  // --- behaviour ---------------------------------------------------------------------------------
  for (const handler of spec.handlers ?? []) {
    try {
      // Compile once at the end rather than per handler: compiling a Blueprint is the expensive
      // part, and doing it three times to build three handlers is three times the wait.
      const built = await addEventHandler(bridge, objectPath, "EventGraph", handler.event, handler.actions, {
        compile: false,
      });
      result.handlersBuilt.push(built.event);
    } catch (err) {
      result.failures.push({ step: `handler ${handler.event}`, error: message(err) });
    }
  }

  // --- make it readable, then check it ------------------------------------------------------------
  if ((spec.handlers ?? []).length > 0) {
    try {
      await autoLayoutGraph(bridge, objectPath, "EventGraph", { addCommentBoxes: true });
    } catch (err) {
      result.failures.push({ step: "layout", error: message(err) });
    }
  }

  try {
    result.compiled = await bridge.send("compile_blueprint", { path: objectPath });
  } catch (err) {
    result.failures.push({ step: "compile", error: message(err) });
  }

  try {
    const review = await reviewBlueprint(bridge, objectPath);
    result.review = { score: review.score, nextAction: review.nextAction };
  } catch (err) {
    result.failures.push({ step: "review", error: message(err) });
  }

  if (spec.save !== false) {
    try {
      await bridge.send("save_blueprint", { path: objectPath });
      result.saved = true;
    } catch (err) {
      result.failures.push({ step: "save", error: message(err) });
    }
  }

  const parts = [
    `${result.variablesAdded.length} variable(s)`,
    `${result.componentsAdded.length} component(s)`,
    `${result.handlersBuilt.length} handler(s)`,
  ];
  result.summary =
    `Built ${objectPath} with ${parts.join(", ")}` +
    `${result.saved ? ", saved" : ""}` +
    `${result.failures.length > 0 ? `. ${result.failures.length} step(s) failed - see failures.` : "."}`;

  return result;
}
