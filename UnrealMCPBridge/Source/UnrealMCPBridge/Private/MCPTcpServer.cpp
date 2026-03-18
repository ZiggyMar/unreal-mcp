#include "MCPTcpServer.h"
#include "MCPCommandHandler.h"

#include "Sockets.h"
#include "SocketSubsystem.h"
#include "Common/TcpListener.h"
#include "Common/TcpSocketBuilder.h"
#include "Interfaces/IPv4/IPv4Address.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPBridge, Log, All);

/** Per-connection state: raw socket + a line-buffering receive buffer. */
class FMCPClientConnection
{
public:
	explicit FMCPClientConnection(FSocket* InSocket)
		: Socket(InSocket)
	{
	}

	~FMCPClientConnection()
	{
		if (Socket)
		{
			Socket->Close();
			ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(Socket);
			Socket = nullptr;
		}
	}

	bool IsConnected() const
	{
		return Socket != nullptr && Socket->GetConnectionState() == SCS_Connected;
	}

	FSocket* Socket = nullptr;
	FString RecvBuffer;
};

FMCPTcpServer::FMCPTcpServer() = default;

FMCPTcpServer::~FMCPTcpServer()
{
	Stop();
}

bool FMCPTcpServer::Start(int32 Port)
{
	if (Listener.IsValid())
	{
		return true;
	}

	ListenPort = Port;

	// Bind to loopback only. This bridge must never be reachable off-machine.
	FIPv4Endpoint Endpoint(FIPv4Address(127, 0, 0, 1), static_cast<uint16>(Port));

	Listener = MakeUnique<FTcpListener>(Endpoint);
	Listener->OnConnectionAccepted().BindRaw(this, &FMCPTcpServer::HandleConnectionAccepted);

	if (!Listener->IsActive())
	{
		UE_LOG(LogMCPBridge, Error, TEXT("UnrealMCPBridge: failed to bind TCP listener on 127.0.0.1:%d"), Port);
		Listener.Reset();
		return false;
	}

	TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FMCPTcpServer::Tick));

	UE_LOG(LogMCPBridge, Log, TEXT("UnrealMCPBridge: listening on 127.0.0.1:%d"), Port);
	return true;
}

void FMCPTcpServer::Stop()
{
	if (TickHandle.IsValid())
	{
		FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
		TickHandle.Reset();
	}

	Clients.Empty();
	Listener.Reset();
}

bool FMCPTcpServer::HandleConnectionAccepted(FSocket* NewSocket, const FIPv4Endpoint& Endpoint)
{
	// Only ever accept loopback connections.
	if (Endpoint.Address != FIPv4Address(127, 0, 0, 1))
	{
		return false;
	}

	NewSocket->SetNonBlocking(true);
	Clients.Add(MakeShared<FMCPClientConnection>(NewSocket));
	UE_LOG(LogMCPBridge, Verbose, TEXT("UnrealMCPBridge: client connected from %s"), *Endpoint.ToString());
	return true;
}

bool FMCPTcpServer::Tick(float DeltaTime)
{
	for (int32 i = Clients.Num() - 1; i >= 0; --i)
	{
		FMCPClientConnection& Client = *Clients[i];
		if (!Client.IsConnected())
		{
			Clients.RemoveAt(i);
			continue;
		}
		ProcessClientSocket(Client);
	}
	return true; // keep ticking
}

