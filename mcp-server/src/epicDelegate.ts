/**
 * Calling Epic's first-party MCP server instead of reimplementing it.
 *
 * ## Why delegate rather than build
 *
 * UE 5.8 ships `ModelContextProtocol`, and behind it 27 toolset plugins carrying roughly 800 tool
 * functions: Niagara, PCG, Gameplay Ability System, StateTree, MVVM, Sequencer, Chaos Cloth,
 * MetaHuman, Data Registry, Gameplay Tags, Game Features, Live Coding, semantic asset search, and
 * Slate UI driving for editor surfaces that have no scripting API at all. See
 * `docs/EPIC_58_TEARDOWN.md`.
 *
 * None of that is work this project should redo. It is Epic's own engine surface, maintained by the
 * people who ship the engine, already running inside the same editor process. Reimplementing even a
 * tenth of it would be a permanent maintenance debt against a moving target, and would still be
 * worse than the original.
 *
 * ## Why it costs nothing when unused
 *
 * The obvious way to expose 800 tools is to advertise 800 tools, and that is precisely what this
 * project may not do - tool definitions are paid for on every request, before the user's message is
 * read. So the whole surface is ONE tool, and it mirrors the three meta-tools Epic's own Tool Search
 * mode uses: list the toolsets, describe one, call into it. The catalog is pulled on demand and
 * never stands in the context window.
 *
 * It also lives in a deferred tool group, so in `core` and `lazy` it is registered and switched off
 * until something asks for it. Nobody who never touches Niagara pays a byte for Niagara.
 *
 * ## What this is honest about
 *
 * Epic's plugin is **Experimental**. Epic say its APIs and data formats may change at any time, it
 * is opt-in, and it does not auto-start. So the common case at runtime is that it is simply not
 * there, and the failure has to be fast and legible rather than a hang: the connect probe uses a
 * short timeout, and a refusal explains the three clicks that fix it instead of reporting a socket
 * error.
 *
 * This does not wrap, validate, or improve Epic's tools. Their schemas and their errors are passed
 * through as they are. Anything else would be this project putting words in Epic's mouth, and the
 * whole point of delegating is that they are the authority on their own surface.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Epic's documented defaults. Overridable because the port is an editor preference. */
export const EPIC_DEFAULT_HOST = "127.0.0.1";
export const EPIC_DEFAULT_PORT = 8000;
export const EPIC_DEFAULT_PATH = "/mcp";

/**
 * Short, because the answer is nearly always "not running" and the caller should learn that in a
 * moment rather than in a minute. A dead port refuses immediately; this bounds the case where
 * something else is listening on 8000 and never speaks MCP.
 */
const PROBE_TIMEOUT_MS = 2_500;

/**
 * Long, because a delegated call runs on the editor's game thread behind however many other tool
 * calls are queued, and Epic's server executes them serially. A Niagara compile is not a fast
 * operation and timing it out early would leave the editor mid-work.
 */
const CALL_TIMEOUT_MS = 120_000;

export interface EpicTarget {
  host: string;
  port: number;
  path: string;
}

export function epicTargetFromEnv(env: NodeJS.ProcessEnv = process.env): EpicTarget {
  const port = Number(env.UNREAL_MCP_EPIC_PORT);
  return {
    host: env.UNREAL_MCP_EPIC_HOST || EPIC_DEFAULT_HOST,
    port: Number.isFinite(port) && port > 0 ? port : EPIC_DEFAULT_PORT,
    path: env.UNREAL_MCP_EPIC_PATH || EPIC_DEFAULT_PATH,
  };
}

export function epicUrl(target: EpicTarget): string {
  return `http://${target.host}:${target.port}${target.path}`;
}

/**
 * What to tell someone whose editor is not answering.
 *
 * Deliberately the enable steps rather than the socket error. "connect ECONNREFUSED 127.0.0.1:8000"
 * is true and useless: the reader does not know that 8000 is Epic's plugin, that the plugin is
 * opt-in, or that it does not start by itself.
 */
export const ENABLE_HINT =
  "Epic's Unreal MCP plugin is not answering. It is Experimental, opt-in, and does not start by " +
  "itself. In the editor: Edit > Plugins, enable `Unreal MCP` and `All Toolsets`, restart, then run " +
  "`ModelContextProtocol.StartServer` in the console (or tick Auto Start Server in Editor " +
  "Preferences). It listens on 127.0.0.1:8000/mcp; set UNREAL_MCP_EPIC_PORT if you changed the port.";

export interface EpicToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * One connection, reused.
 *
 * Reconnecting per call would pay the initialize handshake every time, and the handshake is the
 * expensive part of a small call. A connection that has gone away is detected on use and dropped,
 * because the editor being closed and reopened between two calls is the normal case here, not an
 * exceptional one.
 */
export class EpicClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  /** Whether the far end is in Tool Search mode. Undefined until asked; cleared with the connection. */
  private toolSearch: boolean | undefined;

  constructor(private readonly target: EpicTarget) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client(
        { name: "unreal-mcp-delegate", version: "1.0.0" },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(new URL(epicUrl(this.target)));
      await client.connect(transport, { timeout: PROBE_TIMEOUT_MS });
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** Drop the cached connection so the next call reconnects. */
  private reset(): void {
    const stale = this.client;
    this.client = undefined;
    // Cleared with the connection: a restarted editor is exactly when the setting may have changed.
    this.toolSearch = undefined;
    // Closing is best-effort: the usual reason we are here is that the far end already went away.
    void stale?.close().catch(() => {});
  }

  /**
   * Is it there? Never throws - "no" is an answer, not a failure.
   *
   * This is what makes the tool safe to call speculatively: a model that does not know whether the
   * plugin is enabled can ask, cheaply, and be told what to do about it.
   */
  async status(): Promise<{ reachable: boolean; url: string; tools?: number; hint?: string; error?: string }> {
    const url = epicUrl(this.target);
    try {
      const client = await this.connect();
      const listed = await client.listTools({}, { timeout: PROBE_TIMEOUT_MS });
      return { reachable: true, url, tools: listed.tools?.length ?? 0 };
    } catch (err) {
      this.reset();
      return {
        reachable: false,
        url,
        hint: ENABLE_HINT,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * The tools Epic's server advertises right now.
   *
   * With Tool Search mode on - Epic's default - this is three meta-tools rather than eight hundred,
   * which is the point: the catalog is reachable without being resident.
   */
  async listTools(): Promise<EpicToolInfo[]> {
    const client = await this.withRetry();
    const listed = await client.listTools({}, { timeout: CALL_TIMEOUT_MS });
    return (listed.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** Call one of Epic's tools. Its result is returned as-is. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.withRetry();
    return client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  }

  /**
   * Is Tool Search mode on - i.e. does the server expose `call_tool` rather than its tools directly?
   *
   * Cached, because the first version asked with a fresh `listTools()` before EVERY delegated call:
   * two round trips to the editor's game thread where one would do, on the path whose entire reason
   * for existing is that round trips are expensive.
   *
   * It is cached on the connection rather than forever. Epic's server broadcasts
   * notifications/tools/list_changed when the mode or the toolset set changes, but only into an
   * already-open tools/call stream, so we would usually miss it - and the setting is a user
   * preference they can flip in Editor Preferences at any time. Tying the answer to the connection
   * means reconnecting re-asks, and reconnecting is what happens when the editor is restarted, which
   * is when it would actually have changed.
   */
  async usesToolSearch(): Promise<boolean> {
    if (this.toolSearch !== undefined) return this.toolSearch;
    const advertised = await this.listTools();
    this.toolSearch = advertised.some((t) => t.name === EPIC_META.callTool);
    return this.toolSearch;
  }

  /**
   * Connect, and if the cached connection was dead, drop it and try once more.
   *
   * The editor gets closed and reopened constantly during development, which invalidates the
   * session without anything telling us. One retry turns "your second call of the day fails" into
   * something nobody notices.
   */
  private async withRetry(): Promise<Client> {
    try {
      return await this.connect();
    } catch (first) {
      this.reset();
      try {
        return await this.connect();
      } catch {
        throw new Error(`${ENABLE_HINT} (${first instanceof Error ? first.message : String(first)})`);
      }
    }
  }
}

/**
 * Epic's own meta-tool names, used when Tool Search mode is on.
 *
 * Named here rather than typed by the caller because they are Epic's contract, not ours, and a
 * typo in one of them produces "unknown tool" from a server the user cannot debug.
 */
export const EPIC_META = {
  listToolsets: "list_toolsets",
  describeToolset: "describe_toolset",
  callTool: "call_tool",
} as const;
