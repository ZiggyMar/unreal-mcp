/**
 * One call that answers "why isn't this working?".
 *
 * Setup friction is the single largest category of complaint about Unreal MCP servers, and the
 * one most people never get past. The reports all look the same: something is refused or silent,
 * and the user has no way to tell which of five or six independent things is wrong. The usual
 * answer is a troubleshooting page, which requires the user to already suspect the right cause.
 *
 * This is the other answer: run every check in order, report all of them, and name the one thing
 * to do next. It is written so that the failure case is the useful case, so it never throws and
 * never stops at the first problem it can still see past.
 *
 * It runs entirely on existing bridge commands, so it works against a plugin build that predates
 * it.
 */

import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeLike } from "./autoLayout.js";
import type { FindNodeResult, GetProjectOverviewResult, PingResult } from "./types.js";

/** The bridge protocol this server was written against. */
const EXPECTED_PROTOCOL_VERSION = 1;
/** A ping slower than this means the editor's game thread is under load. */
const SLOW_PING_MS = 1500;

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it. Present whenever status is not "ok". */
  remedy?: string;
}

export interface DoctorReport {
  verdict: "ready" | "degraded" | "not_connected";
  host: string;
  port: number;
  checks: DoctorCheck[];
  /** The single most useful thing to do next. */
  nextAction: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Newest modification time across the plugin's C++ sources, or 0 when they are not there.
 *
 * Zero is a real answer and means "cannot tell", not "up to date". An installed copy of this server
 * has no UnrealMCPBridge sources beside it, and reporting a freshness verdict from their absence
 * would be inventing one.
 *
 * Injected into runDoctor rather than called from it, so the module keeps its property of touching
 * nothing but the bridge, and so the check is testable without a filesystem that happens to look
 * right.
 */
export function newestSourceMs(root?: string): number {
  const dir = root ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "UnrealMCPBridge", "Source");
  let newest = 0;
  const walk = (at: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(cpp|h|cs)$/i.test(entry.name)) {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          /* a file that vanished mid-walk is not a freshness signal */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Commands the doctor pokes to find out whether the plugin is older than this server.
 *
 * Exported so a test can hold it against the bridge's actual command list. This list is maintained
 * by hand and it has gone stale twice: once missing set_variable_replication and watch_runtime while
 * reporting everything implemented, and again missing six more after a session that added the
 * console, Enhanced Input and live coding. Both times the doctor was confidently wrong in the one
 * place somebody looks when nothing works.
 *
 * Every probe must be SAFE TO SEND WITH NO PARAMETERS - which is why this is a chosen list and not
 * every command. Sending `delete_asset` to find out whether it exists would be a poor way to ask.
 */
export const FEATURE_PROBE_LIST: Array<{ cmd: string; feature: string }> = [
    { cmd: "list_variables", feature: "reading a Blueprint's variables" },
    { cmd: "create_data_table", feature: "Data Tables" },
    { cmd: "save_asset", feature: "saving anything that is not a Blueprint" },
    { cmd: "set_variable_replication", feature: "changing a variable's replication" },
    { cmd: "watch_runtime", feature: "watching values change during Play-In-Editor" },
    { cmd: "run_console_command", feature: "the console - ce, Ke, cheats, cvars, stat" },
    { cmd: "read_level_sequence", feature: "reading what a Level Sequence animates" },
    { cmd: "read_timeline", feature: "reading a Blueprint Timeline's length, tracks and curves" },
  { cmd: "read_input_context", feature: "reading Enhanced Input key bindings" },
    { cmd: "map_input_key", feature: "binding a key to an Input Action" },
    { cmd: "unmap_input_key", feature: "removing a key binding" },
    { cmd: "live_coding_status", feature: "hot-reloading C++ into the running editor" },
    // rename_asset and duplicate_asset both refuse a request with no `path` before they touch
    // anything, which is what makes them safe to probe: the reply distinguishes "this command does
    // not exist" from "you did not give it a path", and only the first is what this is asking.
    { cmd: "rename_asset", feature: "renaming or moving an asset with its references fixed up" },
    { cmd: "duplicate_asset", feature: "copying an asset" },
    { cmd: "rename_variable", feature: "renaming a variable and rebinding the nodes that read it" },
    { cmd: "rename_function", feature: "renaming a function and moving any RepNotify binding with it" },
    { cmd: "deduplicate_anim_transitions", feature: "removing state-machine transitions that duplicate another exactly" },
    { cmd: "remove_variable", feature: "removing a variable" },
    { cmd: "rename_component", feature: "renaming a component" },
    { cmd: "remove_component", feature: "removing a component" },
    { cmd: "remove_function", feature: "removing a function" },
    // Safe to probe for the same reason as the two above: it refuses a request with no `path` or
    // `assetClass` before it looks for a factory, so the reply tells "this command does not exist"
    // apart from "you did not give it a class".
    { cmd: "create_asset", feature: "creating any asset the New Asset menu can create" },
    // Safe to probe: it refuses a request with no path/variableName/type before it touches the
    // Blueprint, so the reply separates "this command does not exist" from "you gave it nothing".
    { cmd: "set_variable_type", feature: "changing a variable's type without losing the nodes that use it" },
    // Safe to probe: with no inputAction it refuses on the missing parameter before it looks for a
    // running game, so the reply separates "this command does not exist" from "nothing is playing".
    { cmd: "press_input", feature: "pressing an input action in a running game, so a change can be exercised" },
    // Both refuse on a missing parameter before they look for a running game, so the reply separates
    // "this command does not exist" from "nothing is playing".
    { cmd: "pie_actors", feature: "seeing where things are in a running game" },
    { cmd: "teleport_actor", feature: "positioning actors mid-game, so a two-player interaction can be reproduced" },
    { cmd: "live_coding_compile", feature: "hot-reloading C++ into the running editor" },
  ];

export async function runDoctor(
  bridge: BridgeLike,
  connection: { host: string; port: number; expectedProject?: string },
  now: () => number = () => Date.now(),
  /**
   * Injected so this module keeps its property of touching nothing but the bridge, and so the
   * freshness check can be tested without a source tree that happens to look right.
   */
  newestSource: () => number = newestSourceMs
): Promise<DoctorReport> {
  const expectedProject = connection.expectedProject;
  const checks: DoctorCheck[] = [];

  // 1. Can we reach the plugin at all? Everything else is meaningless until this passes, so this
  //    is the only check that short-circuits the rest.
  const started = now();
  let ping: PingResult | undefined;
  try {
    ping = await bridge.send<PingResult>("ping", {});
  } catch (err) {
    checks.push({
      name: "bridge reachable",
      status: "fail",
      detail: "No answer from the editor bridge. Everything below depends on this, so nothing else was checked.",
      // The client's own error already contains the ordered checklist; do not paraphrase it.
      remedy: message(err),
    });
    return {
      verdict: "not_connected",
      host: connection.host,
      port: connection.port,
      checks,
      nextAction:
        "Nothing else can be checked until the editor is reachable. Work through the remedy on the " +
        "'bridge reachable' check, then run this again.",
    };
  }
  const latencyMs = now() - started;
  const project = (ping as PingResult & { project?: string; projectFile?: string; engineVersion?: string }).project;
  const projectFile = (ping as PingResult & { projectFile?: string }).projectFile;
  const engineVersion = (ping as PingResult & { engineVersion?: string }).engineVersion;
  checks.push({
    name: "bridge reachable",
    status: "ok",
    detail:
      `${ping.plugin ?? "UnrealMCPBridge"} answered at ${connection.host}:${connection.port} in ${latencyMs}ms` +
      `${project ? `, editing project "${project}"${engineVersion ? ` on UE ${engineVersion}` : ""}` : ""}.`,
  });

  // WHICH project. Only one editor can hold the port, so with two open, every call silently goes
  // to whichever won the race. An agent told to work on project A can spend an entire session
  // editing project B with no symptom until someone notices the damage. Naming the project on
  // every diagnosis is the cheapest possible defence.
  if (!project) {
    checks.push({
      name: "which project",
      status: "warn",
      detail: "This plugin build does not report which project it has open.",
      remedy:
        "Update the plugin. Without it there is no way to tell whether you are connected to the project you mean, " +
        "and with two editors open only one of them owns this port.",
    });
  } else if (expectedProject && project.toLowerCase() !== expectedProject.toLowerCase()) {
    checks.push({
      name: "which project",
      status: "fail",
      detail: `Connected to "${project}", but UNREAL_MCP_EXPECT_PROJECT is set to "${expectedProject}".`,
      remedy:
        `You are about to edit the WRONG PROJECT. This happens when a second editor is open: only one can hold ` +
        `port ${connection.port}, and every call goes to that one. Close the other editor, or run each on its own ` +
        `port with -MCPBridgePort=<n> and UNREAL_MCP_BRIDGE_PORT. Do not make any edits until this reports the ` +
        `project you intend.` + (projectFile ? ` Currently connected to: ${projectFile}` : ""),
    });
  } else {
    checks.push({
      name: "which project",
      status: "ok",
      detail: `"${project}"${projectFile ? ` (${projectFile})` : ""}.`,
    });
  }

  // 2. Does the loaded plugin speak the protocol this server was written against?
  const protocol = ping.protocolVersion;
  if (protocol === EXPECTED_PROTOCOL_VERSION) {
    checks.push({
      name: "protocol version",
      status: "ok",
      detail: `Plugin and server both speak protocol ${protocol}.`,
    });
  } else {
    const older = typeof protocol === "number" && protocol < EXPECTED_PROTOCOL_VERSION;
    checks.push({
      name: "protocol version",
      status: "warn",
      detail: `Plugin reports protocol ${protocol}, this server expects ${EXPECTED_PROTOCOL_VERSION}.`,
      remedy: older
        ? "The plugin in your project is older than this MCP server. Replace Plugins/UnrealMCPBridge/ with the " +
          "build matching this server and restart the editor. Newer tools will fail with unknown_cmd until you do."
        : "The plugin is newer than this MCP server. Update the server (git pull && npm install && npm run build) " +
          "so it exposes everything the plugin implements.",
    });
  }

  // 2a-bis. Does the plugin actually implement what this server calls?
  //
  // The protocol number above catches nothing on its own: it has been 1 since the beginning, while
  // the bridge has gained more than twenty commands. A plugin downloaded months ago therefore
  // passes every check here and then fails on the first tool that needs one of them, with
  // `unknown_cmd` and no explanation of why.
  //
  // That is not hypothetical - the README's own "easiest path" points at a prebuilt release, which
  // is exactly how someone ends up with a current server and an old plugin.
  //
  // So probe. Each of these is called with no arguments, which every one of them rejects with
  // `missing_param` before doing any work, so the probe is free and safe. `unknown_cmd` back means
  // the command is genuinely absent.
  const FEATURE_PROBES = FEATURE_PROBE_LIST;

  const missing: string[] = [];
  for (const probe of FEATURE_PROBES) {
    try {
      await bridge.send(probe.cmd, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unknown_cmd/i.test(message)) missing.push(`${probe.cmd} (${probe.feature})`);
    }
  }
  if (missing.length === 0) {
    checks.push({
      name: "plugin features",
      status: "ok",
      // Says HOW MANY, because the sentence without a number was actively misleading. This list is
      // maintained by hand, it went stale, and the editor it was run against was missing
      // watch_runtime and set_variable_replication while this line reported everything implemented.
      // "Every command this server probes for" was true and useless.
      detail:
        `${FEATURE_PROBES.length} probed commands are all implemented. That is a sample, not the ` +
        `whole surface - "plugin freshness" is what catches a plugin missing something newer.`,
    });
  } else {
    checks.push({
      name: "plugin features",
      status: "fail",
      // "At least", and the sample size, for the same reason the ok branch says it: this list is
      // hand-maintained and it has now gone stale twice. Saying "missing 2" when the probe list
      // covers 11 of 84 bridge commands states a precision it does not have - the editor this ran
      // against was missing eight, and a reader told "2" would think six features were fine.
      detail:
        `At least ${missing.length} of the ${FEATURE_PROBES.length} probed commands are missing from this ` +
        `plugin: ${missing.join(", ")}. The probe list is a sample, so there may be more - ` +
        `"plugin freshness" below answers that for every command at once.`,
      remedy:
        "The plugin in your project is older than this MCP server - most likely a prebuilt release " +
        "downloaded before these were added. Copy the UnrealMCPBridge folder from this checkout into " +
        "your project's Plugins/ directory, let the editor rebuild it, and restart. Until then the " +
        "affected tools fail with unknown_cmd and nothing explains why.",
    });
  }

  // 2a. Is the running plugin built from the source on disk?
  //
  // The check that would have made the last two days shorter. A hand-maintained probe list catches
  // the commands somebody remembered to add to it; this catches every command at once, because a
  // plugin older than the source is missing all of them by definition.
  //
  // The failure it names is quiet and common. The C++ half arrives only through
  // `npm run build:engines`, into the projects listed in build-targets.json, and an editor keeps
  // answering perfectly on whatever binary it loaded at launch. Nothing is broken, so nothing says
  // so - until a tool returns unknown_cmd and the reason is a rebuild nobody knew was needed.
  //
  // Best effort, and silent when it cannot tell: an installed copy has no C++ sources beside it, and
  // a plugin old enough not to report pluginBuiltAt predates the field rather than being stale.
  {
    const stamp = (ping as PingResult & { pluginBuiltAt?: string }).pluginBuiltAt;
    const built = typeof stamp === "string" ? Date.parse(stamp) : NaN;
    const newestSourceTime = newestSource();
    if (!Number.isNaN(built) && newestSourceTime > 0) {
      if (newestSourceTime > built) {
        checks.push({
          name: "plugin freshness",
          status: "warn",
          detail: `The running plugin was built ${stamp}, and the C++ source on disk is newer.`,
          remedy:
            "Every bridge command added since that build answers unknown_cmd, and nothing else looks " +
            "wrong. Close the editor, run `npm run build:engines`, reopen - and check that " +
            "build-targets.json lists the project you actually have open, because a project that is " +
            "not a target never receives anything.",
        });
      } else {
        checks.push({
          name: "plugin freshness",
          status: "ok",
          detail: "The running plugin is built from the current C++ source.",
        });
      }
    }
  }

  // 2b. Source control, because it decides whether a save can succeed at all.
  const scEnabled = (ping as PingResult & { sourceControlEnabled?: boolean }).sourceControlEnabled;
  const scAvailable = (ping as PingResult & { sourceControlAvailable?: boolean }).sourceControlAvailable;
  if (scEnabled === undefined) {
    // An older plugin: not worth reporting as a problem.
  } else if (!scEnabled) {
    checks.push({
      name: "source control",
      status: "ok",
      detail: "Not enabled for this project, so saving is never blocked by a checkout.",
    });
  } else if (scAvailable) {
    checks.push({
      name: "source control",
      status: "ok",
      detail: "Enabled and connected; files are checked out automatically when saving.",
    });
  } else {
    checks.push({
      name: "source control",
      status: "warn",
      detail: "Enabled for this project but not currently connected.",
      remedy:
        "Saves will fail on any file that is not already checked out, because an un-checked-out file is " +
        "read-only on disk. Reconnect source control in the editor before making changes you intend to keep - " +
        "edits stay live in the editor either way, but they cannot be written.",
    });
  }

  // 3. Is the editor responsive, or is it grinding?
  if (latencyMs > SLOW_PING_MS) {
    checks.push({
      name: "editor responsive",
      status: "warn",
      detail: `Ping took ${latencyMs}ms, which is slow for a loopback call.`,
      remedy:
        "The editor's game thread is busy: a compile, an import, a shader build, or a modal dialog waiting on a " +
        "human. Expect slow tool calls until it settles. Nothing is misconfigured.",
    });
  } else {
    checks.push({ name: "editor responsive", status: "ok", detail: `Ping round trip ${latencyMs}ms.` });
  }

  // 4. Is the project index usable? An empty or still-scanning index gives wrong answers rather
  //    than errors, which is far worse than a clean failure.
  try {
    const overview = await bridge.send<GetProjectOverviewResult>("get_project_overview", {});
    if (overview.assetRegistryStillScanning) {
      checks.push({
        name: "project index",
        status: "warn",
        detail: `The AssetRegistry is still scanning; ${overview.blueprintCount} Blueprints indexed so far.`,
        remedy:
          "Wait for the editor to finish scanning before trusting search or overview results. Until it does, " +
          "unreal_search_project and unreal_find_references can report that something does not exist when it does.",
      });
    } else if (overview.blueprintCount === 0) {
      checks.push({
        name: "project index",
        status: "warn",
        detail: "The index contains no Blueprints.",
        remedy:
          "Either the open project genuinely has no Blueprints under /Game, or the editor has a different project " +
          "open than you think. Check the editor's title bar against the project you meant to edit.",
      });
    } else {
      checks.push({
        name: "project index",
        status: "ok",
        detail:
          `${overview.blueprintCount} Blueprints, ${overview.totalFunctions} functions, ` +
          `${overview.totalVariables} variables indexed.`,
      });
    }
  } catch (err) {
    checks.push({
      name: "project index",
      status: "fail",
      detail: `get_project_overview failed: ${message(err)}`,
      remedy:
        "Reads of individual Blueprints may still work. If this persists, close the editor, delete " +
        "Saved/UnrealMCPBridge/index.json in your project, and reopen so the index rebuilds from scratch.",
    });
  }

  // 5. Does live reflection work? This is what stops a model inventing function names, so a
  //    project where it is broken will produce confident nonsense rather than errors.
  try {
    const found = await bridge.send<FindNodeResult>("find_node", { query: "Print String" });
    if ((found.catalogSize ?? 0) > 0) {
      checks.push({
        name: "node catalog",
        status: "ok",
        detail: `${found.catalogSize} Blueprint-callable functions readable from the running engine.`,
      });
    } else {
      checks.push({
        name: "node catalog",
        status: "warn",
        detail: "The node catalog is empty.",
        remedy:
          "unreal_find_node and unreal_add_node's didYouMean suggestions will not work, so the model has no " +
          "ground truth for function names. Restart the editor; the catalog builds lazily on first use.",
      });
    }
  } catch (err) {
    checks.push({
      name: "node catalog",
      status: "warn",
      detail: `find_node failed: ${message(err)}`,
      remedy:
        "Authoring will still work, but without verified function names. If the error is unknown_cmd, the loaded " +
        "plugin predates the node catalog and should be updated.",
    });
  }

  // 6. Is PIE running? Edits made during PIE act on the editor world, not the running one, which
  //    reliably reads as "the tool did nothing".
  try {
    const pie = await bridge.send<{ running: boolean }>("pie_status", {});
    if (pie.running) {
      checks.push({
        name: "play-in-editor",
        status: "warn",
        detail: "A PIE session is currently running.",
        remedy:
          "Stop it with unreal_stop_pie before editing. Blueprint writes during PIE apply to the editor world, " +
          "not the running one, so they look like they had no effect.",
      });
    } else {
      checks.push({ name: "play-in-editor", status: "ok", detail: "Not running; the editor world is editable." });
    }
  } catch {
    // pie_status is the newest command here; its absence is not worth reporting as a problem.
    checks.push({
      name: "play-in-editor",
      status: "ok",
      detail: "Not reported by this plugin build.",
    });
  }

  const failed = checks.filter((check) => check.status === "fail");
  const warned = checks.filter((check) => check.status === "warn");
  const verdict: DoctorReport["verdict"] = failed.length > 0 || warned.length > 0 ? "degraded" : "ready";
  const worst = failed[0] ?? warned[0];

  return {
    verdict,
    host: connection.host,
    port: connection.port,
    checks,
    nextAction: worst
      ? `${worst.name}: ${worst.remedy ?? worst.detail}`
      : // The healthy answer says what to do next, which is nothing.
        //
        // This tool takes no arguments, which makes it the easiest thing in the world to emit when
        // a model has finished its work and has not realised it. Measured: a 7B completed a task
        // in two calls and then called doctor until the step limit stopped it. In a benchmark that
        // is wasted budget; in a real client there is no step limit.
        //
        // A diagnostic that reports "all fine" and stops there invites being asked again. Saying
        // outright that a healthy result is not a reason to keep going costs nothing when
        // something is actually wrong, because then this branch never runs.
        //
        // Honest caveat: this did NOT measurably reduce the loop when it was tried - the 7B still
        // used its whole step budget. It is kept because the sentence is true and useful to any
        // reader, not because it fixed anything. The loop is a model behaviour this tool surface
        // has not yet found a lever on.
        "Everything checks out. The editor is reachable, indexed, and ready to be edited. " +
        "Nothing here needs fixing, so calling this again will return the same answer - if your " +
        "task is finished, stop and report what you did.",
  };
}

const MARK: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]" };

/** Plain-text rendering, for `unreal-mcp-server --doctor` run directly in a terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `unreal-mcp doctor: ${report.verdict.toUpperCase().replace("_", " ")}`,
    `bridge target ${report.host}:${report.port}`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.name}: ${check.detail}`);
    if (check.remedy) {
      for (const line of check.remedy.split("\n")) {
        lines.push(`        ${line}`);
      }
    }
  }
  lines.push("", `Next: ${report.nextAction}`);
  return lines.join("\n");
}
