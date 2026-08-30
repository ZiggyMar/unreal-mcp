# Session authentication, and the one thing about it nobody has checked

The bridge listens on loopback and is write-capable (`delete_asset`, `spawn_actor`,
`set_class_default`, `save_level`). Loopback is not a trust boundary: any process running as the same
user can open `127.0.0.1:8765` and speak the protocol. So the editor generates a 256-bit token at
startup, writes it to a per-user file, and the MCP server reads that same file. There is nothing to
configure, which is the point. See the module comments in
`UnrealMCPBridge/Source/UnrealMCPBridge/Private/MCPTcpServer.cpp` and
`mcp-server/src/sessionToken.ts` for why it is a file rather than an environment variable, and why
it is keyed by port rather than by project.

Enforcement is opt-in behind `-MCPRequireAuth` and is **off by default**. The token is always
generated and always sent, so turning enforcement on is a launch flag rather than a code change.

## The gap this document exists for

The editor writes the session file to
`FPlatformProcess::UserSettingsDir()/UnrealMCPBridge/session-<port>.json`. The MCP server has to find
that file without being told where it is, so `mcp-server/src/sessionToken.ts` mirrors UE's
per-platform settings directory by hand.

Nothing on the Node side can check that mirroring. The value comes from engine source, which needs an
Epic account to read and a build to observe. If the mirroring is wrong, the failure is silent: the
client finds no token, sends none, and while enforcement is off nothing at all goes wrong. It becomes
total the first time someone launches with `-MCPRequireAuth`, and the cause is a path nobody has ever
seen printed.

Three things address it, in increasing order of how much they actually settle:

1. **The client searches both shapes.** `sessionFileCandidates()` returns the bare settings root and
   its `Epic` subdirectory. UE's own editor config lands in
   `~/Library/Application Support/Epic/UnrealEngine/` on macOS but `%LOCALAPPDATA%/UnrealEngine/` on
   Windows, which is what a path segment that exists on some platforms and not others looks like from
   the outside. Covering both costs two `stat` calls. This is a hedge, not an answer.
2. **A wrong guess self-corrects.** When the bridge refuses a request it names the file it wrote, in
   a `session_file` field on the `unauthorized` reply. The client reads that path and retries once.
   The hint arrives from a peer that has not authenticated, so `isAcceptableSessionPath()` will only
   follow a path named `session-<port>.json` inside a known settings directory: the hint may
   disambiguate among plausible locations, never point somewhere new. Without that restriction a
   process squatting the port could name any file the user can read and have its `token` field handed
   straight back over the same socket.
3. **`npm run test:bridge` answers it outright**, on a machine that has an engine. See below.

`unreal_doctor` also reports which paths were searched and which one matched, so the state is
inspectable in one command rather than by reading source.

## Running the bridge-side tests

`UnrealMCPBridge/Source/UnrealMCPBridge/Private/Tests/MCPBridgeAuthTest.cpp` drives a real
`FMCPTcpServer` over a real socket with a token read out of the file the server just wrote. It covers
a missing token, a wrong token of the right length, a valid token, the request-`id` echo on refusal,
the connection being dropped after a refusal, and enforcement being off. A seventh test prints the
unoverridden session file path so it can be compared against what the client searches.

Against every engine in `mcp-server/build-targets.json`:

```bash
cd mcp-server
npm run build
npm run test:bridge          # or: npm run test:bridge -- --only 5.6
```

That script fails loudly if the path the bridge writes is not one the client searches, printing both
sides. It is not part of `npm test`, because `npm test` runs in CI and CI has no engine.

Or directly, for one engine:

```bash
UnrealEditor-Cmd <project>.uproject -ExecCmds="Automation RunTests UnrealMCPBridge; Quit" \
  -unattended -nopause -nullrhi -stdout -fullstdoutlogoutput
```

## What is verified, and what is not

Reported separately and explicitly, per `STYLEGUIDE.md`.

| Part | State |
|---|---|
| `sessionToken.ts` candidate paths, allow-list, cache | Verified. Unit tested, including a hermetic fake home so the platform branches are exercised off their own platform. |
| `bridgeClient.ts` retry on a named session file | Verified. Tested against a socket that scripts the refusal, asserting the retry happens, carries the right token, happens exactly once, and does not happen at all for a path outside the settings roots. |
| `doctor.ts` session token check | Verified. Unit tested for both the found and not-found cases. |
| `run-automation.mjs` log parsing and path comparison | Verified. Unit tested against log fixtures, including the mismatch it exists to catch. |
| `run-automation.mjs` launching an editor | **Unverified.** Never run: no engine was available. |
| `MCPTcpServer.cpp` / `.h` changes | **Compiled: no.** Hand-checked for brace balance, declaration order and API shape only. |
| `MCPBridgeAuthTest.cpp` | **Compiled: no. Run: no.** Written to be run by someone with an engine. |
| Where `FPlatformProcess::UserSettingsDir()` actually points on 5.6 and 5.8 | **Still unknown.** This is the question `npm run test:bridge` exists to answer. |

## Turning enforcement on

`-MCPRequireAuth` should stay off by default until `npm run test:bridge` has passed against both
engine versions. A fail-closed control that is wrong takes the whole integration down with it, and
until that command has been run on a real build there is no evidence it is right. When it has, the
flip is a one-line change to the default of `bRequireAuth`, and should ship with a
`-MCPNoRequireAuth` escape hatch so the decision stays reversible at launch rather than at rebuild.
