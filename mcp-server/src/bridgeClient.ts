import { isWrite } from "./journal.js";
import { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { SessionTokenCache } from "./sessionToken.js";
import { rankContextSuggestions } from "./didYouMean.js";

export interface BridgeRequest {
  cmd: string;
  params?: Record<string, unknown>;
}

export interface BridgeResponse<T = unknown> {
  id?: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface BridgeClientOptions {
  host?: string;
  port?: number;
  /** Milliseconds to wait for a response before rejecting. Overrides the per-command defaults. */
  timeoutMs?: number;
  /**
   * Refuse every command that changes anything, before it is sent.
   *
   * The profiles decide what a model is HANDED; this decides what it can DO. They are different
   * questions and only the first had an answer: a model on any profile can call unreal_enable_tools
   * and turn the writes back on, which is correct behaviour for a session that is meant to build and
   * exactly wrong for one that is meant to look.
   *
   * The set of commands that change nothing is not guessed here. It is READ_ONLY_COMMANDS in
   * journal.ts - 38 commands, each read out of its C++ handler and confirmed to touch nothing, with
   * check:journal failing if a read-named command drifts out of it. That list already had to be
   * exactly right, because the session change log is built from its complement.
   */
  readOnly?: boolean;
}

/**
 * Timeout policy, deliberately inverted.
 *
 * The obvious design is a short default with a list of slow exceptions. That is what this file had,
 * and it failed the moment new commands were added: the UMG and struct commands inherited an 8s
 * budget, and add_widget recompiles the Widget Blueprint, so live verification hit a spurious
 * timeout on a call that was working fine. Worse, the timeout aborted mid-sequence and invalidated
 * two later checks, which is exactly the "a timeout is not a rollback" failure this client warns
 * callers about.
 *
 * So the list is the other way round now: CHEAP READS are enumerated, and everything else - every
 * write, every command added in future - gets a generous budget by default. A new command can no
 * longer silently inherit a timeout too short for what it does. The cost of being wrong in this
 * direction is waiting longer for a genuinely hung editor; the cost of being wrong in the other is
 * reporting failure for work that succeeded.
 */

/** Commands that only read already-loaded state and answer in milliseconds. */
const FAST_READ_TIMEOUT_MS = 15_000;
const FAST_READS = new Set([
  "ping",
  "list_blueprints",
  "list_blueprint_graphs",
  "read_blueprint_graph_summary",
  "read_blueprint_node_detail",
  "list_components",
  "list_widgets",
  "list_struct_fields",
  "list_enum_entries",
  "list_assets",
  "pie_status",
  "organize_graph",
]);

/** Anything that mutates an asset: most of these recompile the Blueprint before returning. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Commands that can take far longer still, because their cost is the editor's cost for the same
 * operation: a cold project-index or node-catalog build, a level load, a compile of a large asset.
 */
const SLOW_COMMANDS_MS: Record<string, number> = {
  compile_blueprint: 180_000,
  build_graph: 180_000,
  refresh_blueprint: 180_000,
  get_project_overview: 180_000,
  search_project: 180_000,
  find_references: 180_000,
  find_node: 180_000,
  get_node_signature: 180_000,
  create_level: 180_000,
  open_level: 180_000,
  save_level: 180_000,
};

function timeoutForCommand(cmd: string): number {
  if (SLOW_COMMANDS_MS[cmd] !== undefined) return SLOW_COMMANDS_MS[cmd];
  if (FAST_READS.has(cmd)) return FAST_READ_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

function describeSeconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
}

/**
 * Thin client for the UnrealMCPBridge editor plugin's local TCP protocol:
 * one line of JSON in, one line of JSON out, per request, on a fresh
 * connection. The bridge is single-threaded on the Unreal game thread, so
 * we keep this dead simple rather than pooling/pipelining connections.
 *
 * Every failure path here is written to answer the caller's real next question ("what do I do
 * about it?"), because the model reading the error is the one that has to act on it, and a bare
 * `ECONNREFUSED` gives it nothing to act on.
 */
/**
 * Expand a package path to the object path the engine sometimes insists on.
 *
 * Unreal writes an asset's object path as `/Game/Folder/BP_Thing.BP_Thing` - the name twice. Across a
 * listing of 339 Blueprints that repetition is 1,466 tokens of nothing, and dropping it was declined
 * once for a good reason: five tools were verified to accept the shorter form, and five of
 * eighty-eight is not evidence about the other eighty-three.
 *
 * So the other eighty-three were checked, by auditing how the bridge resolves a path rather than by
 * sampling tools. Twenty-three sites go through LoadBlueprintByPath, eight through StaticLoadObject
 * and fourteen through LoadObject, all of which take either form. TEN DO NOT: six FindObject, three
 * StaticFindObject, and one GetAssetByObjectPath, which keys the asset registry by object path and
 * would simply miss.
 *
 * Rather than fix ten C++ sites and wait for an editor restart to benefit, the expansion happens
 * here - the one place every command crosses into the bridge. Replies can now carry the short form
 * and a caller can paste it into anything, because by the time it arrives it is long again.
 *
 * Only paths that are unambiguously UE asset paths are touched: a leading slash, no backslash or
 * drive letter, and no dot already in the last segment. compile_cpp takes a FILESYSTEM path in a
 * parameter also called `path`, and rewriting that would break it.
 */
export function toObjectPath(value: string): string {
  if (value.includes("\\") || /^[A-Za-z]:/.test(value)) return value;

  let path = value;

  // /Content/ is the folder on disk; /Game/ is the path the engine uses for the same place. It is
  // the single most common thing to get wrong about an Unreal path, and a model that has looked at
  // the filesystem - or read a .uproject - has seen the wrong one of the two. Only a LEADING
  // /Content/ is rewritten, so a project with its own /Game/Content/ folder is untouched.
  if (/^\/Content\//i.test(path)) path = `/Game/${path.slice("/Content/".length)}`;

  if (!path.startsWith("/")) return value;

  // A trailing slash reads as a folder and means the same asset.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const lastSlash = path.lastIndexOf("/");
  const leaf = path.slice(lastSlash + 1);
  if (!leaf) return path === value ? value : path;

  if (leaf.includes(".")) {
    // The _C form: /Game/Dir/BP_Thing.BP_Thing_C is the generated CLASS, and every tool here works
    // on the ASSET. It matters because parentClass comes back as "BP_ShopUpgrade_C" - so a model
    // that reads a Blueprint, sees its parent, and asks to inspect that parent writes exactly this.
    //
    // The test is that the object name is the asset name plus _C, not merely that it ends in _C: an
    // asset genuinely called Foo_C has the object path /Game/Foo_C.Foo_C, whose object name equals
    // the asset name and is correctly left alone.
    const dot = leaf.indexOf(".");
    const assetName = leaf.slice(0, dot);
    const objectName = leaf.slice(dot + 1);
    if (objectName === `${assetName}_C`) {
      return `${path.slice(0, lastSlash + 1)}${assetName}.${assetName}`;
    }
    return path;
  }

  return `${path}.${leaf}`;
}

/** Every parameter that carries an asset path, so the expansion reaches all of them. */
const PATH_PARAMS = ["path", "assetPath", "targetPath", "parentClass", "actorClass"];

/** Apply toObjectPath to the path-shaped parameters of one request, leaving everything else alone. */
export function expandPathParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!params) return params;
  let changed = false;
  const out: Record<string, unknown> = { ...params };
  for (const key of PATH_PARAMS) {
    const value = out[key];
    if (typeof value === "string") {
      const expanded = toObjectPath(value);
      if (expanded !== value) {
        out[key] = expanded;
        changed = true;
      }
    }
  }
  // `paths` is the plural form on delete_asset, and it is the one place a caller passes several.
  if (Array.isArray(out.paths)) {
    const list = out.paths as unknown[];
    const expanded = list.map((p) => (typeof p === "string" ? toObjectPath(p) : p));
    if (expanded.some((p, i) => p !== list[i])) {
      out.paths = expanded;
      changed = true;
    }
  }
  return changed ? out : params;
}

/**
 * Name the modal dialog that is blocking the editor, when there is one and the platform will say.
 *
 * A timeout past the connect means the game thread is blocked, and the reply used to list four
 * things it might be. One of them - a modal dialog - is by far the commonest and is the only one a
 * caller can do nothing about without being told, because the dialog is behind the editor window and
 * nobody is looking at the editor.
 *
 * Windows will sometimes simply say. An editor sitting on its normal window is titled
 * "<Project> - Unreal Editor"; an editor showing a modal that OWNS the main window is titled after
 * the modal, so "Restore Packages" IS the answer. Half an hour went into working that one out by
 * hand, which is exactly the kind of half hour this file exists to prevent.
 *
 * It does not catch every case, and saying so matters more than the feature does. A save prompt
 * raised from inside the editor (InternalPromptForCheckoutAndSave, which is what blocks when
 * something tries to save an Engine template map) leaves the main window title unchanged, and this
 * returns null for it. So a null here means "no dialog owns the main window", NOT "no dialog is
 * open" - which is why the generic line is still printed when this finds nothing.
 *
 * Best effort in every direction: only on win32, only on a path that has already spent its whole
 * timeout so the cost of spawning a shell does not matter, and every failure returns null rather
 * than turning a diagnosable timeout into an undiagnosable crash.
 */
/** What has the editor's window, when it is not the editor itself. */
export interface ForegroundWindow {
  kind: "pie" | "dialog" | "recovery";
  title: string;
}

/**
 * Decide what a non-editor window is, from its title.
 *
 * Separated out and exported because this is where the bug was, and shelling out to PowerShell to
 * test a string comparison would be silly.
 *
 * The rule used to be "the ordinary editor window ends in Unreal Editor; anything else is a dialog",
 * which is wrong about the single most common other window: the Play-In-Editor game. It produced
 * "a modal dialog titled \"AVS Preview [NetMode: Client 1]\" IS OPEN... it halts the game thread
 * until a human clicks it" while nothing was blocked and the game was simply running. A reader
 * following that hunts for a dialog that does not exist, or asks someone to dismiss their own game.
 */
export function classifyEditorWindows(titles: string[]): ForegroundWindow | null {
  const foreign = titles.filter((t) => !/Unreal Editor$/.test(t));
  // A PIE window carries its net mode, or is the standalone "<Project> Preview". Checked before
  // the dialog case so the running game is never mistaken for something to click.
  const pie = foreign.find((t) => /\[NetMode:|\bPreview\b/.test(t));
  if (pie) {
    return { kind: "pie", title: pie };
  }
  // The crash-recovery prompt, separated from "some dialog" because it is the one blocking dialog
  // with a permanent fix rather than a click. It appears at startup after any unclean shutdown -
  // which for an agent-driven editor means after every kill - and it blocks the game thread before
  // the first command is ever served, so the bridge looks dead rather than blocked.
  const recovery = foreign.find((t) => /^Restore Packages$/i.test(t));
  if (recovery) {
    return { kind: "recovery", title: recovery };
  }
  return foreign.length > 0 ? { kind: "dialog", title: foreign[0] } : null;
}

function blockingDialogTitle(): ForegroundWindow | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Process -Name UnrealEditor -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }",
      ],
      // Short on purpose. This is a HINT appended to an error the caller is already waiting on, and
      // it runs after a timeout has just elapsed. Five seconds of PowerShell to improve the wording
      // of a failure is five seconds the caller spends learning nothing - and on a loaded machine it
      // pushed the whole reply past a client's own 15s budget, turning a clean tool error into a
      // protocol-level timeout. Better to lose the hint than the error.
      { timeout: 1500, encoding: "utf8", windowsHide: true }
    );
    return classifyEditorWindows(
      String(out)
        .split(/\r?\n/)
        .map((t) => t.trim())
        .filter(Boolean)
    );
  } catch {
    return null;
  }
}

export class UnrealBridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutOverrideMs?: number;
  private readonly readOnly: boolean = false;
  /**
   * Read from the file the editor writes at startup, so there is nothing for anyone to configure.
   * Absent is a normal state - an older plugin build writes no file - and the bridge decides
   * whether it minds, which is what stops this breaking every existing install on the day it ships.
   */
  private readonly tokens = new SessionTokenCache();

  constructor(options: BridgeClientOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8765;
    this.timeoutOverrideMs = options.timeoutMs;
    this.readOnly = options.readOnly === true;
  }

  private notConnectedHelp(reason: string): string {
    return (
      `Could not reach the UnrealMCPBridge plugin at ${this.host}:${this.port} (${reason}). ` +
      `Nothing was sent, so nothing in the project changed. Check, in this order:\n` +
      `  1. The Unreal Editor is running, with the project you mean to edit open.\n` +
      `  2. That project has the plugin at Plugins/UnrealMCPBridge/, and Edit > Plugins shows ` +
      `"UnrealMCPBridge" enabled. Enabling it needs an editor restart.\n` +
      `  3. The editor's Output Log contains "UnrealMCPBridge: listening on 127.0.0.1:${this.port}". ` +
      `If it names a different port, set UNREAL_MCP_BRIDGE_PORT in this server's MCP client config to match.\n` +
      `  4. No modal dialog is blocking the editor's main thread (a compile-error popup, an asset ` +
      `save prompt, or the "plugin built for a different engine version" dialog on startup).\n` +
      `Re-run unreal_ping once you have changed something; it is the cheapest way to confirm the fix.`
    );
  }

  async send<T = unknown>(cmd: string, rawParams?: Record<string, unknown>): Promise<T> {
    // Refused before anything is sent, so "nothing was changed" is a fact rather than a hope. The
    // same choke point the path expansion and the change journal use.
    if (this.readOnly && isWrite(cmd)) {
      throw new Error(
        `read_only_session: "${cmd}" changes the project and this session is read-only, so nothing ` +
          `was sent. Reads are unaffected - list, read, find, describe, search, and every audit and ` +
          `review built on them all work normally. If this session is meant to make changes, start ` +
          `the server without UNREAL_MCP_READONLY set.`
      );
    }

    // Every command crosses here, which is why the path expansion lives here and nowhere else.
    const params = expandPathParams(rawParams);
    const id = randomUUID();
    const session = this.tokens.get(this.port);
    const requestLine =
      JSON.stringify(
        session ? { id, cmd, params: params ?? {}, auth_token: session.token } : { id, cmd, params: params ?? {} }
      ) + "\n";
    const timeoutMs = this.timeoutOverrideMs ?? timeoutForCommand(cmd);

    return await new Promise<T>((resolve, reject) => {
      const socket = new Socket();
      let buffer = "";
      // A StringDecoder, not chunk.toString("utf8") per chunk.
      //
      // Bridge replies routinely run to tens of kilobytes - a graph summary, a project search, an
      // actor list - so they arrive as several TCP segments, and a segment boundary lands wherever
      // it lands. Decoding each chunk on its own turns any multi-byte character split across that
      // boundary into U+FFFD, which meant a model could read back a mangled asset name and then
      // reason from it, with nothing anywhere able to notice. StringDecoder holds the partial
      // sequence until its remaining bytes arrive.
      const decoder = new StringDecoder("utf8");
      let settled = false;
      let connected = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      const succeed = (value: T) => {
        if (settled) return;
        settled = true;
        socket.end();
        resolve(value);
      };

      socket.setTimeout(timeoutMs);

      socket.on("timeout", () => {
        if (!connected) {
          fail(new Error(this.notConnectedHelp(`no response to the connection attempt within ${describeSeconds(timeoutMs)}`)));
          return;
        }
        // We connected, so the bridge exists and the plugin is loaded. A silent socket past this
        // point means the editor's game thread is busy or blocked, not that anything is misconfigured.
        const dialogTitle = blockingDialogTitle();
        fail(
          new Error(
            `The UnrealMCPBridge plugin accepted the connection but did not answer '${cmd}' within ` +
              `${describeSeconds(timeoutMs)}. The connection is fine; the editor's game thread is busy or blocked. ` +
              `Usually one of:\n` +
              `  - A long operation genuinely still running (a big compile, the first project-index build, a level load). ` +
              `Wait and retry the same call rather than assuming it failed.\n` +
              (dialogTitle?.kind === "pie"
                ? `  - THE GAME IS RUNNING in Play-In-Editor ("${dialogTitle.title}"). The game thread is busy ` +
                  `running it, and a heavy read can exceed this timeout. Nothing is blocked and nothing needs ` +
                  `clicking. The runtime tools - pie_actors, watch_runtime, press_input, verify_runtime - are ` +
                  `built to work during PIE; heavy whole-Blueprint reads are better done after unreal_stop_pie.\n`
                : dialogTitle?.kind === "recovery"
                  ? `  - THE CRASH-RECOVERY PROMPT ("Restore Packages") IS OPEN. That is the whole answer. It ` +
                    `appears at startup after any unclean shutdown, and it blocks the game thread before the first ` +
                    `command is served, so the bridge looks dead rather than blocked. Someone has to dismiss this ` +
                    `one, but it never needs to happen again: launch the editor with -AutoDeclinePackageRecovery, ` +
                    `the engine's own switch for exactly this, and it is declined automatically from then on.\n`
                  : dialogTitle
                    ? `  - A modal dialog titled "${dialogTitle.title}" IS OPEN in the editor right now. That is almost ` +
                      `certainly the whole answer: it halts the game thread until a human clicks it.\n`
                    : `  - A modal dialog open in the editor, which halts the game thread until a human clicks it.\n`) +
              `  - The editor mid-PIE-transition. Call unreal_pie_status once the editor is responsive again.\n` +
              `IMPORTANT: a timeout is not a rollback. The operation may have completed, so read the current state ` +
              `(unreal_read_blueprint_summary, unreal_list_components, ...) before retrying a write, or you may apply it twice.`
          )
        );
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        switch (err.code) {
          case "ECONNREFUSED":
            fail(new Error(this.notConnectedHelp("connection refused: nothing is listening on that port")));
            return;
          case "ENOTFOUND":
          case "EAI_AGAIN":
            fail(
              new Error(
                `Could not resolve the bridge host "${this.host}". The bridge listens on loopback; ` +
                  `leave UNREAL_MCP_BRIDGE_HOST unset (or set it to 127.0.0.1) unless the editor runs on another machine.`
              )
            );
            return;
          case "ECONNRESET":
          case "EPIPE":
            fail(
              new Error(
                `The UnrealMCPBridge connection dropped mid-request on '${cmd}'. That usually means the editor closed, ` +
                  `crashed, or the project was reopened while this call was in flight. Confirm the editor is still up with ` +
                  `unreal_ping, then check the current state before retrying a write: a dropped connection does not tell ` +
                  `you whether the operation was applied.`
              )
            );
            return;
          case "ETIMEDOUT":
          case "EHOSTUNREACH":
            fail(new Error(this.notConnectedHelp(`the network layer reported ${err.code}`)));
            return;
          default:
            fail(new Error(`UnrealMCPBridge socket error on '${cmd}' (${err.code ?? "unknown"}): ${err.message}`));
        }
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        try {
          const parsed = JSON.parse(line) as BridgeResponse<T>;
          if (!parsed.ok) {
            // Keep every field the bridge attached to the failure, not just the message.
            //
            // The plugin answers a wrong function name with a didYouMean list of near-misses, a
            // wrong pin with the pins that do exist, and a blocked delete with the referencers
            // holding it. All of that was being thrown away here, because only `error` was read -
            // so the single most useful self-correction signal in the whole system had never once
            // reached a model. Found by testing a claim this project had been making in three
            // separate documents.
            const { ok: _ok, error: _error, id: _id, result: _result, ...context } = parsed as unknown as Record<string, unknown>;
            // Re-rank the near-misses before they go out. The plugin ranks by shared prefix, which
            // put SpawnActorFromClass third behind two unrelated functions called Spawn, and
            // answered ApplyRootMotionRadialForce with Apply. Here rather than in the C++ that
            // builds the list, for the reason engineTypes.ts records about the same choice: the
            // resolver is the tidier place and only reaches somebody who has rebuilt their plugin.
            //
            // This is the choke point every command's failure passes through, so get_node_signature,
            // add_node and build_graph are all fixed by the one call.
            const ranked = rankContextSuggestions(String(parsed.error ?? ""), context);
            const extras = Object.keys(ranked).length > 0 ? ` ${JSON.stringify(ranked)}` : "";
            if (typeof parsed.error === "string" && parsed.error.startsWith("unauthorized")) {
              // Most likely the editor restarted and issued a new token. Drop the cached one so the next
              // call re-reads the file, and name the file that was used: a token mismatch is otherwise
              // the least diagnosable failure in the whole system.
              this.tokens.forget(this.port);
              fail(
                new Error(
                  "The UnrealMCPBridge rejected this call as unauthorized. " +
                    (session
                      ? `The token used came from ${session.path}. `
                      : "No session token file was found for this port. ") +
                    "That usually means the editor restarted since the last call. The stale token has been " +
                    "discarded, so calling again normally succeeds; if it does not, run unreal_doctor."
                )
              );
              return;
            }
            fail(new Error(`${parsed.error ?? `UnrealMCPBridge returned an error for '${cmd}'`}${extras}`));
            return;
          }
          succeed(parsed.result as T);
        } catch (err) {
          // Non-JSON on the wire is its own diagnosis: an older plugin build, or something other
          // than the bridge listening on this port.
          const preview = line.length > 200 ? `${line.slice(0, 200)}...` : line;
          fail(
            new Error(
              `Could not parse the UnrealMCPBridge reply to '${cmd}' as JSON (${(err as Error).message}). ` +
                `Received: ${preview || "(empty line)"}\n` +
                `This means something other than the expected bridge protocol is on ${this.host}:${this.port}: ` +
                `either another program holds that port, or the loaded plugin build is older than this MCP server. ` +
                `Check the editor's Output Log for the port the bridge actually claimed.`
            )
          );
        }
      });

      socket.connect(this.port, this.host, () => {
        connected = true;
        socket.write(requestLine, "utf8");
      });
    });
  }
}
