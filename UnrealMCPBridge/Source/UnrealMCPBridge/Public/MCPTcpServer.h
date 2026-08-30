#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Containers/Queue.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"

class FSocket;
class FTcpListener;
class FInternetAddr;

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

	bool Start(int32 Port);
	void Stop();

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

