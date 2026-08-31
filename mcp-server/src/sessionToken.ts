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
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export interface SessionFile {
  port: number;
  token: string;
  project?: string;
  projectFile?: string;
  pid?: number;
}

/** A token and the file it came from. `path` exists so a failure can name it. */
export interface SessionTokenSource {
  token: string;
  path: string;
}

/**
 * The per-user settings directories the editor's session file could plausibly sit under.
 *
 * This is the hand-mirroring of UE's `FPlatformProcess::UserSettingsDir()`, and it is the single
 * most likely thing in this feature to be wrong, because nothing on the Node side can check it: the
 * value is decided by engine source that is not readable without an Epic account and not observable
 * without a build. Getting it wrong is silent - the client finds no token, and once the bridge
 * enforces one, every call fails with nothing to point at.
 *
 * Two things are done about that. First, this returns BOTH the bare settings root and its `Epic`
 * subdirectory on every platform, because UE's own editor config lands in
 * `~/Library/Application Support/Epic/UnrealEngine/` on macOS but `%LOCALAPPDATA%/UnrealEngine/` on
 * Windows, which is what an `Epic` segment present on some platforms and absent on others looks
 * like from the outside. Covering both costs two extra `stat` calls on a path that runs once per
 * process. Second, and the part that actually closes it: when the bridge refuses a request it names
 * the file it wrote, and `bridgeClient.ts` reads that path and retries. A guess being wrong then
 * costs one extra round trip instead of the whole integration.
 *
 * `scripts/run-automation.mjs` is what turns the guess into an answer, on a machine with an engine.
 */
export function sessionSettingsRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  // Home comes from the environment first, falling back to the OS, which is what `os.homedir()`
  // itself does. Reading it this way is not a test hook bolted on: it is what makes every function
  // in this file a pure function of (port, env), and that is the only reason the platform branches
  // below can be checked on a machine that is not running that platform.
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const bare: string[] = [];

  switch (platform()) {
    case "win32":
      if (env.LOCALAPPDATA) bare.push(env.LOCALAPPDATA);
      bare.push(join(home, "AppData", "Local"));
      break;
    case "darwin":
      bare.push(join(home, "Library", "Application Support"));
      break;
    default:
      bare.push(env.XDG_CONFIG_HOME ?? join(home, ".config"));
      break;
  }

  // Order is a guess at which is likelier per platform, and affects nothing but how many paths get
  // stat'ed before the right one. Correctness comes from trying all of them.
  const epicFirst = platform() !== "win32";
  const all = bare.flatMap((root) => (epicFirst ? [join(root, "Epic"), root] : [root, join(root, "Epic")]));
  return [...new Set(all)];
}

/**
 * Where the editor writes the session file, in the order this will look.
 *
 * A list rather than one path because getting it wrong is silent; see `sessionSettingsRoots`.
 */
export function sessionFileCandidates(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.UNREAL_MCP_SESSION_FILE;
  if (explicit && explicit.trim().length > 0) return [explicit.trim()];

  const name = `session-${port}.json`;
  return sessionSettingsRoots(env).map((dir) => join(dir, "UnrealMCPBridge", name));
}

/**
 * Whether a path the BRIDGE named is one this client is willing to read.
 *
 * The bridge's `unauthorized` reply carries the session file it wrote, so a wrong guess above
 * self-corrects. That hint arrives from a peer this client has not authenticated, which is the
 * whole reason it is being sent, so it cannot be followed blindly: a hostile process squatting the
 * port could otherwise name any file the user can read and have its `token` field read out and
 * handed straight back over the same socket.
 *
 * So the hint may only disambiguate among plausible locations, never point somewhere new. It has to
 * be absolute, be named exactly `session-<port>.json`, and live under one of the settings roots
 * above. What is left reachable is a file with this exact name, inside the user's own application
 * settings tree, containing JSON with a `token` string, which is essentially only the bridge's own
 * file. A symlink planted under that tree would defeat this, but planting one requires write access
 * to the settings directory, and anyone with that can simply write a token file instead: it is not
 * a capability this check is what stands between them and.
 *
 * `resolve` normalises `..` before the prefix test, so a traversal out of a settings root fails.
 */
export function isAcceptableSessionPath(
  path: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (typeof path !== "string" || path.length === 0) return false;

  // An explicit override is the user's own decision and outranks every guess, including this one.
  const explicit = env.UNREAL_MCP_SESSION_FILE;
  if (explicit && explicit.trim().length > 0) return resolve(path) === resolve(explicit.trim());

  if (!isAbsolute(path)) return false;
  if (basename(path) !== `session-${port}.json`) return false;

  const resolved = resolve(path);
  return sessionSettingsRoots(env).some((root) => {
    const prefix = resolve(root) + sep;
    return resolved.startsWith(prefix);
  });
}

/**
 * Read one specific session file, or null if it is not a usable one for this port.
 *
 * Null is a normal answer at every step here, not an error. A plugin build older than this feature
 * writes no file, an editor that has not started writes none either, and a file caught mid-write
 * parses as nothing. In all three cases the right behaviour is to carry on without a token and let
 * the bridge decide whether it minds.
 */
export function readSessionTokenAt(path: string, port: number): SessionTokenSource | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: SessionFile;
  try {
    parsed = JSON.parse(raw) as SessionFile;
  } catch {
    // A half-written file is a real possibility: the editor writes it at startup and a client can
    // read it mid-write. Skipping is right, and the next call will find it complete.
    return null;
  }

  if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
  // A file left behind by an editor on a different port would authenticate against nothing.
  if (typeof parsed.port === "number" && parsed.port !== port) return null;
  return { token: parsed.token, path };
}

/**
 * Read the token for a port from the first candidate that has one, or null if none does.
 *
 * Failing here rather than returning null would mean this file broke every existing installation on
 * the day it shipped, since a bridge that predates the feature writes nothing for it to find.
 */
export function readSessionToken(
  port: number,
  env: NodeJS.ProcessEnv = process.env
): SessionTokenSource | null {
  for (const path of sessionFileCandidates(port, env)) {
    const found = readSessionTokenAt(path, port);
    if (found) return found;
  }
  return null;
}

/**
 * Caches the token for a port, since it is read on every request and changes only when the editor
 * restarts. `forget` exists so a rejected request can force a re-read rather than failing forever
 * against a token that was rotated underneath it, and `remember` so a token found by following the
 * bridge's own hint does not have to be rediscovered on every later call.
 */
export class SessionTokenCache {
  private readonly cache = new Map<number, SessionTokenSource | null>();

  get(port: number, env: NodeJS.ProcessEnv = process.env): SessionTokenSource | null {
    if (!this.cache.has(port)) {
      this.cache.set(port, readSessionToken(port, env));
    }
    return this.cache.get(port) ?? null;
  }

  forget(port: number): void {
    this.cache.delete(port);
  }

  remember(port: number, source: SessionTokenSource): void {
    this.cache.set(port, source);
  }
}
