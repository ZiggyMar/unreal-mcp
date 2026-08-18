/**
 * A whole UMG widget in one call.
 *
 * The same argument as `scaffold.ts`, applied to the half of the game the player actually looks
 * at. Building a widget step by step is create, then add, then add, then set, then compile, then
 * save, and a small model reliably completes the first step and stops — which is exactly the
 * failure that made `unreal_scaffold_blueprint` exist.
 *
 * This was measured before it was written rather than assumed. Asked to build a HUD with a label
 * and a button, a local 7B failed 3/3 through the step-by-step tools: it worked out that it needed
 * the `ui` group and enabled it correctly, created the widget, and then never assembled it. The
 * Blueprint tasks, which have a composite, pass 5/5 in a single call.
 *
 * It also makes UMG reachable from the `minimal` profile at all. That profile carries one tool per
 * job and had none for widgets, so the smallest and most reliable configuration simply could not
 * build a user interface.
 */

import type { BridgeLike } from "./autoLayout.js";

export interface ScaffoldWidgetChild {
  widgetClass: string;
  name: string;
  /** Panel to nest inside. Defaults to the root. */
  parent?: string;
  properties?: Record<string, string>;
}

export interface ScaffoldWidgetSpec {
  packagePath: string;
  parentClass?: string;
  rootWidget?: string;
  widgets?: ScaffoldWidgetChild[];
  save?: boolean;
}

export interface ScaffoldWidgetResult {
  path: string;
  created: boolean;
  widgetsAdded: string[];
  propertiesSet: string[];
  compiled?: unknown;
  saved: boolean;
  failures: Array<{ step: string; error: string }>;
  complete: boolean;
  summary: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function scaffoldWidget(
  bridge: BridgeLike,
  spec: ScaffoldWidgetSpec
): Promise<ScaffoldWidgetResult> {
  const assetName = spec.packagePath.slice(spec.packagePath.lastIndexOf("/") + 1);
  const objectPath = `${spec.packagePath}.${assetName}`;
  const result: ScaffoldWidgetResult = {
    path: objectPath,
    created: false,
    widgetsAdded: [],
    propertiesSet: [],
    saved: false,
    failures: [],
    complete: false,
    summary: "",
  };

  // Saving is deferred to the end for the same reason as the Blueprint scaffold: an empty widget
  // written to disk and then written again is two disk writes for one asset.
  await bridge.send("create_widget_blueprint", {
    packagePath: spec.packagePath,
    parentClass: spec.parentClass,
    rootWidget: spec.rootWidget,
    save: false,
  });
  result.created = true;

  // Added in the order given, so a panel declared before its children exists by the time they name
  // it as a parent. That ordering is the caller's to express and cheap to get right; reordering it
  // here would silently disagree with a layout the caller intended.
  for (const widget of spec.widgets ?? []) {
    try {
      await bridge.send("add_widget", {
        path: objectPath,
        widgetClass: widget.widgetClass,
        name: widget.name,
        parent: widget.parent,
      });
      result.widgetsAdded.push(widget.name);

      for (const [property, value] of Object.entries(widget.properties ?? {})) {
        try {
          await bridge.send("set_widget_property", {
            path: objectPath,
            widgetName: widget.name,
            property,
            value,
          });
          result.propertiesSet.push(`${widget.name}.${property}`);
        } catch (err) {
          result.failures.push({ step: `${widget.name}.${property}`, error: message(err) });
        }
      }
    } catch (err) {
      // One bad widget should not cost the caller the whole screen; the rest still gets built.
      result.failures.push({ step: `widget ${widget.name}`, error: message(err) });
    }
  }

  try {
    result.compiled = await bridge.send("compile_blueprint", { path: objectPath });
  } catch (err) {
    result.failures.push({ step: "compile", error: message(err) });
  }

  if (spec.save !== false) {
    try {
      await bridge.send("save_blueprint", { path: objectPath });
      result.saved = true;
    } catch (err) {
      result.failures.push({ step: "save", error: message(err) });
    }
  }

  result.complete = result.failures.length === 0;
  result.summary =
    `Built widget ${objectPath} with ${result.widgetsAdded.length} widget(s)` +
    `${result.propertiesSet.length > 0 ? `, ${result.propertiesSet.length} property/properties set` : ""}` +
    `${result.saved ? ", saved" : ""}` +
    `${
      result.failures.length > 0
        ? `. ${result.failures.length} step(s) failed - see failures, then fix only those.`
        : ". Complete; nothing further is needed."
    }`;

  return result;
}
