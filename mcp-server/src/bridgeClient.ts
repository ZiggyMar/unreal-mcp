import { Socket } from "node:net";
import { randomUUID } from "node:crypto";

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

/** Default for a read or a single small write: the bridge answers these in milliseconds. */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Commands that legitimately take longer than the default, with why.
 *
 * The bridge runs on Unreal's game thread, so its wall-clock cost is the editor's real cost for
 * the same operation. A Blueprint compile on a large asset, the first project-index build, a level
 * load, or a PIE start can all take tens of seconds on a real project. Timing those out at a flat
 * few seconds is one of the most common ways an MCP integration looks broken when it is merely
 * working: the caller sees a timeout, assumes the connection died, and retries an operation that
 * was in fact about to succeed (or, worse, already succeeded).
 */
const COMMAND_TIMEOUTS_MS: Record<string, number> = {
  // Compilation and bulk graph authoring: cost scales with the Blueprint.
  compile_blueprint: 120_000,
  build_graph: 120_000,
  refresh_blueprint: 120_000,
  create_blueprint: 60_000,
  create_function: 60_000,
  save_blueprint: 60_000,
  delete_asset: 60_000,
  // First call builds the whole project index (or the engine-wide node catalog) from cold.
  get_project_overview: 180_000,
  search_project: 180_000,
  find_references: 180_000,
  find_node: 120_000,
  get_node_signature: 120_000,
  // Level and world work: loading and saving a map is disk-bound.
  create_level: 180_000,
  open_level: 180_000,
  save_level: 180_000,
  spawn_actor: 60_000,
  // Component and CDO writes recompile the Blueprint.
  add_component: 60_000,
  set_component_property: 60_000,
  set_class_default: 60_000,
  // PIE: start_pie only requests a session (it begins next tick), but stopping tears down a world.
  start_pie: 60_000,
  stop_pie: 60_000,
};

function timeoutForCommand(cmd: string): number {
  return COMMAND_TIMEOUTS_MS[cmd] ?? DEFAULT_TIMEOUT_MS;
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
export class UnrealBridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutOverrideMs?: number;

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

  async send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    const requestLine = JSON.stringify({ id, cmd, params: params ?? {} }) + "\n";
    const timeoutMs = this.timeoutOverrideMs ?? timeoutForCommand(cmd);

    return await new Promise<T>((resolve, reject) => {
      const socket = new Socket();
      let buffer = "";
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
        buffer += chunk.toString("utf8");
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          return;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        try {
          const parsed = JSON.parse(line) as BridgeResponse<T>;
          if (!parsed.ok) {
            fail(new Error(parsed.error ?? `UnrealMCPBridge returned an error for '${cmd}'`));
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
