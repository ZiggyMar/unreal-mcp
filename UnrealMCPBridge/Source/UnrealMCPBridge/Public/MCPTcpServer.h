#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Containers/Queue.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"

class FSocket;
class FTcpListener;
class FInternetAddr;

/**
 * How to start the bridge, for the cases where the command line is not the answer.
 *
 * The editor starts one server, on a fixed port, configured by launch flags, and every field here
 * is unset for it. A test starts several, on ports it has to be free to choose, with authentication
 * forced on and a token file that must not be the real user's, and cannot express any of that
 * through FCommandLine. The alternative to this struct is a test that either edits the process
 * command line or writes over the developer's own session file, and neither belongs anywhere near
 * an automation run.
 */
struct FMCPServerOptions
{
	int32 Port = 8765;

	/**
	 * True for the editor: -MCPBridgePort and -MCPRequireAuth are read and win.
	 * False for a test, whose chosen port and auth setting must not be moved by whatever flags the
	 * editor running the test happened to be launched with.
	 */
	bool bAllowCommandLineOverrides = true;

	/** Consulted only when bAllowCommandLineOverrides is false; otherwise -MCPRequireAuth decides. */
	bool bRequireAuth = false;

	/** Empty means DefaultSessionFilePath(Port). Set by a test to stay out of the real user settings directory. */
	FString SessionFilePath;
};

/**
 * Minimal single-threaded, line-delimited JSON TCP server.
 * Listens on localhost only. Accepts one request per line, writes one JSON
 * response per line (newline-terminated) back on the same connection.
 *
 * Runs entirely on the game thread via FTSTicker so command handlers can
 * safely call into UE Editor / AssetRegistry / Kismet2 APIs without any
 * cross-thread synchronization.
 */
class FMCPTcpServer : public TSharedFromThis<FMCPTcpServer>
{
public:
	FMCPTcpServer();
	~FMCPTcpServer();

	bool Start(const FMCPServerOptions& Options);
	/** The editor's path: a port, and everything else from the command line. */
	bool Start(int32 Port);
	void Stop();

	/**
	 * Where this bridge writes its session file for a given port, with nothing overridden.
	 *
	 * Public because it is the one value in this feature that cannot be checked from the Node side:
	 * it is whatever FPlatformProcess::UserSettingsDir() returns on this platform and engine
	 * version, and mcp-server/src/sessionToken.ts has to mirror that by hand. An automation test
	 * logs this so scripts/run-automation.mjs can compare it against the paths the client actually
	 * searches, which turns "we think the mirroring is right" into something a machine reports.
	 */
	static FString DefaultSessionFilePath(int32 Port);

private:
	bool HandleConnectionAccepted(FSocket* NewSocket, const FIPv4Endpoint& Endpoint);
	bool Tick(float DeltaTime);
	/** Returns false when the connection must be dropped rather than read from again. */
	bool ProcessClientSocket(class FMCPClientConnection& Client);

	TUniquePtr<FTcpListener> Listener;
	TArray<TSharedPtr<class FMCPClientConnection>> Clients;
	/**
	 * Connections accepted on the listener thread, waiting to be adopted by Tick.
	 *
	 * Single-producer (FTcpListener's thread) / single-consumer (the game thread), which is exactly
	 * the shape of this handoff. Clients itself is touched only by Tick, so there is no shared
	 * container left to race on.
	 */
	TQueue<TSharedPtr<class FMCPClientConnection>, EQueueMode::Spsc> PendingClients;
	FTSTicker::FDelegateHandle TickHandle;
	int32 ListenPort = 0;

	/** Per-session secret, written to SessionFilePath so the MCP server can read it without being told. */
	FString SessionToken;
	FString SessionFilePath;
	/**
	 * -MCPRequireAuth. Off by default, deliberately and temporarily.
	 *
	 * The token is always generated and always offered, so turning enforcement on is a launch flag
	 * rather than a code change, and cannot then discover that the client half was never wired up.
	 * It stays off by default until the mechanism has been exercised against a real editor build,
	 * because a fail-closed control that is wrong takes the whole integration down with it.
	 */
	bool bRequireAuth = false;
};

