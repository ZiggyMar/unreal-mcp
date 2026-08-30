/**
 * The shared secret that proves a client is allowed to drive the editor.
 *
 * Why there is one at all. Dropping non-JSON lines (MCPTcpServer.cpp) closed the browser route into
 * this port, and that was the urgent half. What it does not address is that loopback is not a trust
 * boundary: any other process running as the same user - an npm postinstall script, a downloaded
 * plugin, a game mod, a second desktop session over RDP - can open 127.0.0.1:8765 and speak the
 * protocol directly. The bridge is write-capable (delete_asset, spawn_actor, set_class_default,
 * save_level), so "only local processes can reach it" is not the reassurance it sounds like.
 *
 * Why it is a file rather than an environment variable. The automated patch that raised this
 * proposed comparing an env var inside the dispatcher, and the fatal flaw was not the comparison but
 * the configuration: the MCP server had no concept of the field, so setting the variable did not
 * harden the bridge, it broke every call. Any scheme where the user has to put the same secret in
 * two places has a state where it is on and broken, and that state is the one people actually hit.
 *
 * So the editor generates the token and writes it; this reads the same file. There is nothing to
 * configure, which means there is nothing to configure wrongly.
 *
 * The file is keyed by PORT rather than by project, because the port is the only thing a client
 * knows before it has connected to anything. Keying it by project would need a connection to
 * discover the project, which needs the token: the bootstrap would not close.
 */

import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface SessionFile {
  port: number;
  token: string;
  project?: string;
  projectFile?: string;
  pid?: number;
}

/**
 * Where the editor writes the session file, in the order this will look.
 *
 * These mirror what UE's FPlatformProcess::UserSettingsDir() returns per platform. They are a list
 * rather than one path because getting this wrong is silent - the client would simply never find a
 * token and every call would fail unauthenticated - so it tries the plausible locations and the
 * bridge logs the exact path it used for the case where none of them match.
 */
export function sessionFileCandidates(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.UNREAL_MCP_SESSION_FILE;
  if (explicit && explicit.trim().length > 0) return [explicit.trim()];

  const name = `session-${port}.json`;
  const dirs: string[] = [];
  const home = homedir();

  switch (platform()) {
    case "win32":
      if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "UnrealMCPBridge"));
      dirs.push(join(home, "AppData", "Local", "UnrealMCPBridge"));
      break;
    case "darwin":
      dirs.push(join(home, "Library", "Application Support", "UnrealMCPBridge"));
      break;
    default:
      dirs.push(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "UnrealMCPBridge"));
      break;
  }

  return dirs.map((dir) => join(dir, name));
}

/**
 * Read the token for a port, or null if there is not one to read.
 *
 * Null is a normal answer, not an error. A plugin build older than this feature writes no file, and
 * an editor that has not started one either; in both cases the right behaviour is to connect without
 * a token and let the bridge decide whether it minds. Failing here instead would mean this file
 * could break every existing installation on the day it shipped.
 */
export function readSessionToken(
  port: number,
  env: NodeJS.ProcessEnv = process.env
): { token: string; path: string } | null {
  for (const path of sessionFileCandidates(port, env)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let parsed: SessionFile;
    try {
      parsed = JSON.parse(raw) as SessionFile;
    } catch {
      // A half-written file is a real possibility: the editor writes it at startup and a client can
      // read it mid-write. Skipping is right, and the next call will find it complete.
      continue;
    }
    if (typeof parsed.token !== "string" || parsed.token.length === 0) continue;
    // A file left behind by an editor on a different port would authenticate against nothing.
    if (typeof parsed.port === "number" && parsed.port !== port) continue;
    return { token: parsed.token, path };
  }
  return null;
}

/**
 * Caches the token for a port, since it is read on every request and changes only when the editor
 * restarts. `forget` exists so a rejected request can force a re-read rather than failing forever
 * against a token that was rotated underneath it.
 */
export class SessionTokenCache {
  private readonly cache = new Map<number, { token: string; path: string } | null>();

  get(port: number, env: NodeJS.ProcessEnv = process.env): { token: string; path: string } | null {
    if (!this.cache.has(port)) {
      this.cache.set(port, readSessionToken(port, env));
    }
    return this.cache.get(port) ?? null;
  }

  forget(port: number): void {
    this.cache.delete(port);
  }
}
