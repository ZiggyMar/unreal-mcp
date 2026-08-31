import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  isAcceptableSessionPath,
  readSessionTokenAt,
  sessionFileCandidates,
  SessionTokenCache,
  type SessionTokenSource,
} from "./sessionToken.js";

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
 * Raised by `sendOnce` when the bridge refused the call but named a session file worth reading.
 *
 * Carried as a distinct type rather than a flag on the client because `sendOnce` is a `new Promise`
 * whose only channel back out is its rejection, and because it makes the retry impossible to
 * trigger by accident: nothing else in this file constructs one.
 */
class RetryWithSessionFile extends Error {
  constructor(readonly source: SessionTokenSource) {
    super(`retrying with the session token the bridge named at ${source.path}`);
    this.name = "RetryWithSessionFile";
  }
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
export class UnrealBridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutOverrideMs?: number;
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

  /**
   * Send one command, and give the bridge exactly one chance to correct where the token lives.
   *
   * `sessionToken.ts` guesses at UE's per-platform settings directory, and that guess cannot be
   * checked from here. When it is wrong the bridge refuses the call and names the file it actually
   * wrote; this reads that file and sends the command again. The retry terminates by construction
   * rather than by a counter: the second attempt only asks for another one if the bridge names a
   * DIFFERENT path than the one just used, and it will not, because it only ever names its own.
   */
  async send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T> {
    try {
      return await this.sendOnce<T>(cmd, params);
    } catch (err) {
      if (!(err instanceof RetryWithSessionFile)) throw err;
      this.tokens.remember(this.port, err.source);
      return await this.sendOnce<T>(cmd, params);
    }
  }

  private async sendOnce<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T> {
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
        fail(
          new Error(
            `The UnrealMCPBridge plugin accepted the connection but did not answer '${cmd}' within ` +
              `${describeSeconds(timeoutMs)}. The connection is fine; the editor's game thread is busy or blocked. ` +
              `Usually one of:\n` +
              `  - A long operation genuinely still running (a big compile, the first project-index build, a level load). ` +
              `Wait and retry the same call rather than assuming it failed.\n` +
              `  - A modal dialog open in the editor, which halts the game thread until a human clicks it.\n` +
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
            const extras = Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
            if (typeof parsed.error === "string" && parsed.error.startsWith("unauthorized")) {
              // Most likely the editor restarted and issued a new token. Drop the cached one so the next
              // call re-reads the file, and name the file that was used: a token mismatch is otherwise
              // the least diagnosable failure in the whole system.
              this.tokens.forget(this.port);

              // The bridge names the file it wrote. Following that is what makes a wrong guess at
              // UE's settings directory cost one round trip instead of the whole integration, and
              // isAcceptableSessionPath is what stops an unauthenticated peer turning the hint into
              // a file-read primitive. Only worth doing for a path other than the one just tried.
              const hinted = typeof context.session_file === "string" ? context.session_file.trim() : "";
              if (hinted && hinted !== session?.path && isAcceptableSessionPath(hinted, this.port)) {
                const found = readSessionTokenAt(hinted, this.port);
                if (found) {
                  fail(new RetryWithSessionFile(found));
                  return;
                }
              }

              // Four distinct situations reach this point and they need four different sentences.
              // Collapsing them loses the diagnosis, and a refusal nobody can diagnose is the worst
              // failure this client can report.
              let hintNote: string;
              if (!hinted) {
                hintNote =
                  "The bridge did not say where its token is, which means it is a build older than this feature.";
              } else if (hinted === session?.path) {
                hintNote =
                  `The bridge confirms its token is in ${hinted}, which is the file this call read. ` +
                  "The two disagree on the contents, which is what an editor restart looks like from here.";
              } else if (!isAcceptableSessionPath(hinted, this.port)) {
                hintNote =
                  `The bridge says its token is in ${hinted}, which is outside every settings directory this ` +
                  "client reads from, so it was ignored. If that is genuinely where the editor wrote it, set " +
                  "UNREAL_MCP_SESSION_FILE to that path.";
              } else {
                hintNote = `The bridge says its token is in ${hinted}, but that file could not be read.`;
              }

              const searched = sessionFileCandidates(this.port);
              fail(
                new Error(
                  "The UnrealMCPBridge rejected this call as unauthorized. " +
                    (session
                      ? `The token used came from ${session.path}. `
                      : "No session token file was found for this port. ") +
                    "That usually means the editor restarted since the last call. The stale token has been " +
                    "discarded, so calling again normally succeeds; if it does not, run unreal_doctor.\n" +
                    `Looked in:\n${searched.map((path) => `  - ${path}`).join("\n")}\n` +
                    hintNote
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
