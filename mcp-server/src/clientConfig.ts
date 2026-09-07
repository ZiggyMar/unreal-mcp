/**
 * Writing the client config file instead of printing it.
 *
 * `--print-config` already removes the interesting half of the problem: absolute paths, the right
 * node binary, no hand-typed JSON. What it leaves behind is the boring half, and the boring half is
 * where people actually get stuck - knowing *which* file, creating `.cursor/` because it does not
 * exist yet, and merging the entry into an `mcpServers` block that already has three other servers
 * in it without breaking the ones that were there.
 *
 * Epic's 5.8 plugin solves exactly this with `ModelContextProtocol.GenerateClientConfig`, and the
 * shape of their solution is worth copying rather than inventing: one entry name, per-client
 * descriptors for where the file lives and what the root key is called, JSON upsert that preserves
 * existing entries, and TOML written once because TOML cannot be safely upserted without a real
 * parser. Their file locations are also now the de-facto correct ones, since they are what Epic
 * tells every UE developer to expect.
 *
 * Two deliberate differences:
 *
 * 1. Epic's server lives inside the editor process, so their entry is a `url`. Ours is a separate
 *    Node process, so ours is `command`/`args`/`env`. The file locations and root keys are the
 *    same; only the entry body differs.
 *
 * 2. Epic writes into the project or workspace root. We default to the current working directory,
 *    because this server is not installed into a UE project and has no `FPaths::ProjectDir()` to
 *    ask. `--dir` overrides it, and Claude Desktop is special-cased because its config is global,
 *    not per-project.
 *
 * Nothing here overwrites a file wholesale. A malformed existing JSON file is the one case that
 * cannot be merged, and it is reported as a refusal rather than silently replaced - Epic overwrites
 * in that case, and losing somebody's other MCP servers to a stray comma is not a good trade.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** The name the server is registered under, in every client. One name, so docs can be literal. */
export const SERVER_ENTRY_NAME = "unreal";

/** Built from a char code so no editor, shell or heredoc between here and disk can eat it. */
const NL = String.fromCharCode(10);

export type ClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "gemini" | "codex";

interface ClientDescriptor {
  /** Path relative to the base directory, or absolute for globally-configured clients. */
  relativePath: string;
  /** The object under which server entries live. Epic's `ServersRootKey`. */
  serversRootKey: string;
  /** TOML has no safe upsert without a parser, so it is written once and never touched again. */
  isToml?: boolean;
  /** True when the file is a global, per-user config rather than one that sits beside a project. */
  isGlobal?: boolean;
  /** Shown after writing, so the user knows what they are looking at. */
  note?: string;
}

const DESCRIPTORS: Record<ClientId, ClientDescriptor> = {
  "claude-code": {
    relativePath: ".mcp.json",
    serversRootKey: "mcpServers",
    note: "project-scoped; Claude Code picks it up when started in this directory",
  },
  "claude-desktop": {
    relativePath: claudeDesktopConfigPath(),
    serversRootKey: "mcpServers",
    isGlobal: true,
    note: "global; FULLY QUIT Claude Desktop and reopen it - closing the window is not enough",
  },
  cursor: { relativePath: join(".cursor", "mcp.json"), serversRootKey: "mcpServers" },
  vscode: { relativePath: join(".vscode", "mcp.json"), serversRootKey: "servers" },
  gemini: { relativePath: join(".gemini", "settings.json"), serversRootKey: "mcpServers" },
  codex: {
    relativePath: join(".codex", "config.toml"),
    serversRootKey: "mcp_servers",
    isToml: true,
    note: "TOML is written once and never modified; edit it by hand to change it",
  },
};

export const CLIENT_IDS = Object.keys(DESCRIPTORS) as ClientId[];

/**
 * Claude Desktop's config is per-user, not per-project, and the location is platform-specific.
 * `%APPDATA%` is preferred over a constructed path on Windows because a redirected AppData is a
 * real thing on managed machines.
 */
function claudeDesktopConfigPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface WriteResult {
  client: ClientId;
  path: string;
  /** "written" is a new file, "merged" kept existing entries, "skipped" left the file alone. */
  status: "written" | "merged" | "skipped" | "failed";
  reason?: string;
}

/**
 * Upsert one client's config. Existing sibling servers survive; only our own entry is replaced.
 */
export function writeClientConfig(client: ClientId, entry: ServerEntry, baseDir: string): WriteResult {
  const d = DESCRIPTORS[client];
  const path = d.isGlobal ? d.relativePath : resolve(baseDir, d.relativePath);

  try {
    if (d.isToml) return writeTomlConfig(client, path, d, entry);
    return writeJsonConfig(client, path, d, entry);
  } catch (err) {
    return { client, path, status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}


/**
 * Does this parse once comments and trailing commas are removed?
 *
 * Only used to choose the wording of a refusal - nothing is ever written from the stripped text,
 * so the crude scanner below cannot corrupt anything. It respects string literals, because a URL
 * with "//" in it is not a comment and misreading one would put this on the wrong branch.
 */
function looksLikeJsonc(text: string): boolean {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== NL) i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  try {
    JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
    return true;
  } catch {
    return false;
  }
}

function writeJsonConfig(
  client: ClientId,
  path: string,
  d: ClientDescriptor,
  entry: ServerEntry
): WriteResult {
  let root: Record<string, unknown> = {};
  let merged = false;

  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    // An empty file is not malformed, it is just empty, and treating it as a refusal would be
    // obstructive for a client that touches the file on first run.
    if (existing.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch {
        // Two very different situations look identical to JSON.parse, and telling a user their
        // working config is "malformed" when it is a documented format is worse than not writing.
        //
        // VS Code reads .vscode/mcp.json as JSONC and Gemini does the same with settings.json, so
        // comments and trailing commas are legal there and common in a file people hand-edit. This
        // still will not write it - round-tripping through JSON.parse would silently delete every
        // comment they had - but it says which case it is and hands over the entry to paste.
        const jsonc = looksLikeJsonc(existing);
        return {
          client,
          path,
          status: "skipped",
          reason: jsonc
            ? "this file has comments or trailing commas, which its client allows and this cannot " +
              "rewrite without deleting them. Add this inside its \"" +
              d.serversRootKey +
              '" object by hand:' + NL +
              `  "${SERVER_ENTRY_NAME}": ${JSON.stringify(entry, null, 2).split(NL).join(NL + "  ")}`
            : "existing file is not valid JSON; refusing to overwrite it, because it may contain " +
              "other MCP servers. Fix the syntax and re-run, or add the entry by hand.",
        };
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
        merged = true;
      }
    }
  }

  const existingServers = root[d.serversRootKey];
  const servers: Record<string, unknown> =
    existingServers && typeof existingServers === "object" && !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)
      : {};

  servers[SERVER_ENTRY_NAME] = entry;
  root[d.serversRootKey] = servers;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");

  return { client, path, status: merged ? "merged" : "written", reason: d.note };
}

/**
 * Codex, following Epic: written once. Upserting TOML correctly needs a parser, and a wrong
 * upsert corrupts a file the user cannot easily repair, so the safe answer is to not try.
 */
function writeTomlConfig(
  client: ClientId,
  path: string,
  d: ClientDescriptor,
  entry: ServerEntry
): WriteResult {
  if (existsSync(path)) {
    return {
      client,
      path,
      status: "skipped",
      reason:
        `TOML cannot be safely merged. Add this by hand under [${d.serversRootKey}.${SERVER_ENTRY_NAME}]:\n` +
        tomlBody(d, entry),
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, tomlBody(d, entry), "utf8");
  return { client, path, status: "written", reason: d.note };
}

function tomlBody(d: ClientDescriptor, entry: ServerEntry): string {
  const env = Object.entries(entry.env)
    .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
    .join(", ");
  return (
    `[${d.serversRootKey}.${SERVER_ENTRY_NAME}]\n` +
    `command = ${JSON.stringify(entry.command)}\n` +
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]\n` +
    `env = { ${env} }\n`
  );
}

/**
 * Write every *project-scoped* client at once. Epic's `WriteAllClientConfigurations`.
 *
 * Claude Desktop is deliberately excluded from the sweep and has to be named with `--client`.
 * Every other file here lands inside a directory the user pointed at, so a wrong guess costs
 * nothing; Claude Desktop's config is global and shared with every other project on the machine,
 * and editing that as a side effect of "set up this folder" is not something to do unasked.
 */
export function writeAllClientConfigs(entry: ServerEntry, baseDir: string): WriteResult[] {
  return CLIENT_IDS.filter((c) => !DESCRIPTORS[c].isGlobal).map((c) => writeClientConfig(c, entry, baseDir));
}

/** One block of terminal output, so the caller does not have to know the result shape. */
export function formatWriteResults(results: WriteResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const verb =
      r.status === "written"
        ? "wrote"
        : r.status === "merged"
          ? "updated"
          : r.status === "skipped"
            ? "SKIPPED"
            : "FAILED";
    lines.push(`${verb.padEnd(8)} ${r.client.padEnd(15)} ${r.path}`);
    if (r.reason) {
      for (const l of r.reason.split("\n")) lines.push(`         ${l}`);
    }
  }
  const changed = results.filter((r) => r.status === "written" || r.status === "merged").length;
  lines.push("");
  lines.push(
    `${changed}/${results.length} configuration${results.length === 1 ? "" : "s"} in place. ` +
      `Restart the client so it picks the server up.`
  );
  return lines.join("\n");
}
