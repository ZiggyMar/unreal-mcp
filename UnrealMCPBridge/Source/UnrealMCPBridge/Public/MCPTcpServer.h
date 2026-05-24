#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
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
	void ProcessClientSocket(class FMCPClientConnection& Client);

	TUniquePtr<FTcpListener> Listener;
	TArray<TSharedPtr<class FMCPClientConnection>> Clients;
