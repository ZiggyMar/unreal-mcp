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
};

