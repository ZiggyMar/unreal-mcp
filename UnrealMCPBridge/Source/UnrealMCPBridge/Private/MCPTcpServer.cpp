#include "MCPTcpServer.h"
#include "Editor/EditorPerformanceSettings.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/App.h"
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

/**
 * Stop the editor throttling itself into uselessness while an agent is driving it.
 *
 * "Use Less CPU when in Background" (bThrottleCPUWhenNotForeground) defaults to ON, and it does
 * exactly what it says: when the editor is not the foreground application, its tick rate collapses.
 *
 * That is a sensible default for a person, and precisely wrong here, because an agent ALWAYS drives
 * a backgrounded editor - the human is in a chat client, not in Unreal. Every command then waits for
 * the next slow tick before it is even read.
 *
 * Measured before this existed: `ping` answered in 8ms while every other command took ~333ms, on
 * both engine versions and both projects. That is not work, it is a 3Hz tick. Over a 339-Blueprint
 * audit it was the entire runtime.
 *
 * Opt out with -MCPKeepEditorThrottle if you would rather have the CPU back; the setting is only
 * changed in memory, so nothing is written to the user's config either way.
 */
static void DisableBackgroundThrottlingForAgentUse()
{
	if (FParse::Param(FCommandLine::Get(), TEXT("MCPKeepEditorThrottle")))
	{
		UE_LOG(LogMCPBridge, Log,
			TEXT("UnrealMCPBridge: leaving editor background throttling alone (-MCPKeepEditorThrottle). ")
			TEXT("Expect roughly 300ms per command while the editor is not the foreground window."));
		return;
	}

	UEditorPerformanceSettings* Settings = GetMutableDefault<UEditorPerformanceSettings>();
	if (!Settings || !Settings->bThrottleCPUWhenNotForeground)
	{
		return;
	}

	Settings->bThrottleCPUWhenNotForeground = false;
	// PostEditChange rather than a config write: this is a runtime decision for this session, not a
	// change to what the user chose.
	Settings->PostEditChange();
	UE_LOG(LogMCPBridge, Log,
		TEXT("UnrealMCPBridge: disabled \"Use Less CPU when in Background\" for this session. An agent ")
		TEXT("drives a backgrounded editor, and that setting costs about 300ms on every command. ")
		TEXT("Nothing was written to your config; use -MCPKeepEditorThrottle to keep the throttle."));
}

bool FMCPTcpServer::Start(int32 Port)
{
	DisableBackgroundThrottlingForAgentUse();

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
		// Almost always a second editor already holding the port. That case is dangerous rather than
		// merely inconvenient: this editor's bridge stays silent, every MCP call goes to the OTHER
		// editor, and an agent told to work on this project edits a different one without any
		// symptom until someone notices the damage. So say exactly that, loudly.
		UE_LOG(LogMCPBridge, Error,
			TEXT("UnrealMCPBridge: FAILED to bind 127.0.0.1:%d. Another program is already using that port, ")
			TEXT("and it is most likely a SECOND UNREAL EDITOR with this plugin enabled. ")
			TEXT("This editor's bridge is NOT running: any AI tool connecting to port %d is talking to that ")
			TEXT("other editor, and edits meant for this project ('%s') will land in that one instead. ")
			TEXT("Close the other editor, or give this one a different port with -MCPBridgePort=<n> and point ")
			TEXT("the MCP server at it with UNREAL_MCP_BRIDGE_PORT."),
			Port, Port, FApp::GetProjectName());
		Listener.Reset();
		return false;
	}

	TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FMCPTcpServer::Tick));

	UE_LOG(LogMCPBridge, Log, TEXT("UnrealMCPBridge: listening on 127.0.0.1:%d for project '%s'"),
		Port, FApp::GetProjectName());
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
		if (!ProcessClientSocket(Client))
		{
			// The connection asked to be closed - malformed framing, or an oversized line. The
			// destructor closes and destroys the socket.
			Clients.RemoveAt(i);
			continue;
		}
	}
	return true; // keep ticking
}

/**
 * The largest single request this server will buffer before giving up on a peer.
 *
 * A request is one line, and the largest legitimate ones are whole-graph builds: comfortably under
 * a megabyte. Without a ceiling, a peer that opens a socket and never sends a newline makes the
 * editor allocate until it dies, which is a denial of service costing the attacker one connection.
 */
static constexpr int32 MCPMaxRequestBytes = 4 * 1024 * 1024;

bool FMCPTcpServer::ProcessClientSocket(FMCPClientConnection& Client)
{
	uint32 PendingSize = 0;
	while (Client.Socket->HasPendingData(PendingSize) && PendingSize > 0)
	{
		TArray<uint8> Buffer;
		Buffer.SetNumUninitialized(FMath::Min(PendingSize, 8192u));

		int32 BytesRead = 0;
		if (!Client.Socket->Recv(Buffer.GetData(), Buffer.Num(), BytesRead) || BytesRead <= 0)
		{
			break;
		}

		FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Buffer.GetData()), BytesRead);
		Client.RecvBuffer.AppendChars(Converter.Get(), Converter.Length());
	}

	// A peer that never sends a newline must not be able to grow this without limit.
	if (Client.RecvBuffer.Len() > MCPMaxRequestBytes)
	{
		UE_LOG(LogMCPBridge, Warning,
			TEXT("UnrealMCPBridge: dropping a connection that sent %d bytes with no newline (limit %d). ")
			TEXT("A request is a single line of JSON; nothing legitimate reaches this size."),
			Client.RecvBuffer.Len(), MCPMaxRequestBytes);
		return false;
	}

	// Process complete newline-terminated requests.
	int32 NewlineIndex;
	while (Client.RecvBuffer.FindChar(TEXT('\n'), NewlineIndex))
	{
		FString Line = Client.RecvBuffer.Left(NewlineIndex);
		Client.RecvBuffer.RightChopInline(NewlineIndex + 1);
		Line.TrimStartAndEndInline();
		if (Line.IsEmpty())
		{
			continue;
		}

		TSharedPtr<FJsonObject> RequestObj;
		TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Line);
		TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
		bool bDropConnection = false;

		if (FJsonSerializer::Deserialize(Reader, RequestObj) && RequestObj.IsValid())
		{
			Response = FMCPCommandHandler::Dispatch(RequestObj.ToSharedRef());
		}
		else
		{
			// A line that is not JSON ends the connection. This is a security boundary, not tidiness.
			//
			// The protocol is newline-delimited JSON on a plain TCP port, and a web page can open
			// that port. A cross-origin POST with Content-Type: text/plain is CORS-safelisted, so it
			// is sent with no preflight and no consent from any site the user happens to be reading:
			//
			//     fetch("http://127.0.0.1:8765/", { method: "POST", mode: "no-cors",
			//       headers: { "Content-Type": "text/plain" },
			//       body: a newline, then {"cmd":"delete_asset","params":{...}}, then a newline })
			//
			// The browser writes an HTTP request line, then headers, then that body, all down the
			// same socket. While a bad line was merely answered and skipped, the request line and
			// every header were discarded as invalid_json in turn - and then the body parsed as a
			// perfectly good command and RAN. Same-origin policy stops the page reading the reply,
			// which is no comfort at all when the commands on offer include deleting assets.
			//
			// Hanging up on the first unparseable line closes that off completely, because every
			// HTTP request begins with a request line that is not JSON. It costs a legitimate client
			// nothing: the only thing that speaks this protocol sends whole JSON objects, one per
			// line, and has no reason to send anything else.
			Response->SetBoolField(TEXT("ok"), false);
			Response->SetStringField(TEXT("error"), TEXT("invalid_json"));
			Response->SetStringField(TEXT("detail"),
				TEXT("This port speaks newline-delimited JSON, one object per line, and closes the ")
				TEXT("connection on anything else. If you are a browser or an HTTP client, you are ")
				TEXT("not talking to a web server."));
			bDropConnection = true;
		}

		FString OutStr;
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&OutStr);
		FJsonSerializer::Serialize(Response, Writer);
		OutStr.AppendChar(TEXT('\n'));

		FTCHARToUTF8 UTF8Str(*OutStr);
		int32 BytesSent = 0;
		Client.Socket->Send(reinterpret_cast<const uint8*>(UTF8Str.Get()), UTF8Str.Length(), BytesSent);

		if (bDropConnection)
		{
			// The diagnosis is written first, so a human pointing the wrong tool at this port still
			// gets told what the port is, and only then hung up on.
			UE_LOG(LogMCPBridge, Warning,
				TEXT("UnrealMCPBridge: closing a connection that sent a line which is not JSON. ")
				TEXT("If this was a browser, a page tried to reach the bridge and was refused."));
			return false;
		}
	}

	return true;
}

