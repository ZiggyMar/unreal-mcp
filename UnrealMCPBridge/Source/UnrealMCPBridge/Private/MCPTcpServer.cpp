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

