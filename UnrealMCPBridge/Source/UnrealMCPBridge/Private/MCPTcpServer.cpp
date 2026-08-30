#include "MCPTcpServer.h"
#include "Editor/EditorPerformanceSettings.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/App.h"
#include "Misc/Guid.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformProcess.h"
#include "HAL/FileManager.h"
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
/**
 * Per-connection state: raw socket, a BYTE receive buffer, and a pending-send buffer.
 *
 * The receive buffer holds bytes rather than TCHARs on purpose. It used to decode each recv() chunk
 * to text as it arrived, which corrupts any multi-byte UTF-8 sequence that happens to straddle a
 * chunk boundary - and the boundary is a TCP segment, not a tidy 8KB block, so any request past
 * roughly 1.4KB could hit it. An asset path with a non-ASCII character in it came back as garbage
 * and nothing downstream could tell. Bytes go in, and a line is decoded only once it is complete.
 */
class FMCPClientConnection
{
public:
	explicit FMCPClientConnection(FSocket* InSocket)
		: Socket(InSocket)
		, LastActivitySeconds(FPlatformTime::Seconds())
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

	/** Queue a reply. Draining is Tick's job, because one Send call is not guaranteed to take it all. */
	void QueueSend(const FString& Line)
	{
		FTCHARToUTF8 UTF8Str(*Line);
		SendBuffer.Append(reinterpret_cast<const uint8*>(UTF8Str.Get()), UTF8Str.Length());
	}

	/**
	 * Push as much of SendBuffer as the socket will take. Returns false if the peer is gone.
	 *
	 * The socket is non-blocking, so Send is entitled to accept only part of a large reply and
	 * report how much it took. That return value used to be ignored, which meant a big reply - a
	 * graph summary, a project search - was silently truncated. Because the only newline in a reply
	 * is the one terminating it, the client then never saw a complete line at all: it waited out its
	 * whole timeout and told the model the editor was busy and to retry, which reproduced the hang
	 * instead of reporting it. Anything not taken now stays buffered and goes out next tick.
	 */
	bool FlushSend()
	{
		while (SentBytes < SendBuffer.Num())
		{
			int32 BytesSent = 0;
			if (!Socket->Send(SendBuffer.GetData() + SentBytes, SendBuffer.Num() - SentBytes, BytesSent))
			{
				return false;
			}
			if (BytesSent <= 0)
			{
				// The send window is full. Keep the remainder and try again on the next tick.
				break;
			}
			SentBytes += BytesSent;
			LastActivitySeconds = FPlatformTime::Seconds();
		}

		if (SentBytes > 0 && SentBytes >= SendBuffer.Num())
		{
			SendBuffer.Reset();
			SentBytes = 0;
		}
		return true;
	}

	bool HasPendingSend() const { return SentBytes < SendBuffer.Num(); }

	FSocket* Socket = nullptr;
	TArray<uint8> RecvBuffer;
	TArray<uint8> SendBuffer;
	int32 SentBytes = 0;
	/** The peer performed an orderly close. Answer what is already buffered, then drop it. */
	bool bPeerClosed = false;
	/** Set to true once a line has been refused; the connection is finished after its reply drains. */
	bool bDropAfterFlush = false;
	double LastActivitySeconds = 0.0;
};

/**
 * The session token, and the file both halves read.
 *
 * Loopback is not a trust boundary. Refusing non-JSON lines closed the browser route into this port,
 * but any other process running as the same user - an npm postinstall script, a downloaded plugin, a
 * game mod, a second desktop session over RDP - can still open 127.0.0.1:8765 and speak the protocol
 * directly, and this bridge deletes assets and writes levels.
 *
 * The automated patch that raised this proposed an environment variable compared inside Dispatch.
 * The fatal flaw was not the comparison, it was the configuration: the MCP server had no concept of
 * the field, so setting the variable did not harden the bridge, it broke all 83 tools. Any scheme
 * where a human puts the same secret in two places has a state where it is on and broken, and that
 * is the state people actually reach.
 *
 * So the editor generates the token and writes it somewhere the client can find without being told:
 * a per-user, per-PORT file, because the port is the only thing a client knows before it has
 * connected to anything. Keying it by project would need a connection to learn the project, which
 * would need the token, and the bootstrap would not close.
 */
static FString MCPSessionTokenPath(int32 Port)
{
	return FPaths::Combine(
		FPlatformProcess::UserSettingsDir(),
		TEXT("UnrealMCPBridge"),
		FString::Printf(TEXT("session-%d.json"), Port));
}

/** 256 bits from two GUIDs. Long enough that guessing is not the attack worth worrying about. */
static FString MCPGenerateSessionToken()
{
	return FGuid::NewGuid().ToString(EGuidFormats::Digits) + FGuid::NewGuid().ToString(EGuidFormats::Digits);
}

/**
 * Compare without leaking where the mismatch was.
 *
 * Over loopback against an attacker who can already run code as this user, a timing side channel is
 * not the weak link and this is close to ceremony. It is here because the alternative is writing the
 * naive comparison and then having to argue that it is fine, which is a worse use of a reader's
 * attention than four lines.
 */
static bool MCPTokensMatch(const FString& A, const FString& B)
{
	if (A.Len() != B.Len() || A.Len() == 0)
	{
		return false;
	}
	uint32 Diff = 0;
	for (int32 i = 0; i < A.Len(); ++i)
	{
		Diff |= static_cast<uint32>(A[i]) ^ static_cast<uint32>(B[i]);
	}
	return Diff == 0;
}

/**
 * The largest single request this server will buffer before giving up on a peer.
 *
 * A request is one line, and the largest legitimate ones are whole-graph builds: comfortably under
 * a megabyte. Without a ceiling, a peer that opens a socket and never sends a newline makes the
 * editor allocate until it dies, which is a denial of service costing the attacker one connection.
 */
static constexpr int32 MCPMaxRequestBytes = 4 * 1024 * 1024;

/** Concurrent connections. The real client uses one at a time; this is only a runaway guard. */
static constexpr int32 MCPMaxClients = 32;

/** How long a silent connection may hold a slot. Long enough not to interrupt a slow human. */
static constexpr double MCPIdleTimeoutSeconds = 300.0;

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

	// -MCPBridgePort=<n>. This flag has been documented for a while - it is what the server's own
	// two-editors-open error tells you to use - and nothing has ever read it. The documented way to
	// run two editors side by side therefore did nothing at all: the second editor still tried 8765,
	// still lost the bind, and the agent still quietly edited the first project.
	int32 PortOverride = 0;
	if (FParse::Value(FCommandLine::Get(), TEXT("MCPBridgePort="), PortOverride))
	{
		if (PortOverride >= 1024 && PortOverride <= 65535)
		{
			UE_LOG(LogMCPBridge, Log, TEXT("UnrealMCPBridge: using port %d from -MCPBridgePort."), PortOverride);
			Port = PortOverride;
		}
		else
		{
			UE_LOG(LogMCPBridge, Warning,
				TEXT("UnrealMCPBridge: ignoring -MCPBridgePort=%d, which is outside 1024-65535. Using %d."),
				PortOverride, Port);
		}
	}

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

	// The token exists whether or not it is enforced, and the client sends it whenever it can read
	// one. That ordering is deliberate: enforcement can be switched on later without touching the
	// client, and switching it on cannot then discover that the other half was never wired up -
	// which is exactly how the original proposal would have failed.
	SessionToken = MCPGenerateSessionToken();
	bRequireAuth = FParse::Param(FCommandLine::Get(), TEXT("MCPRequireAuth"));

	SessionFilePath = MCPSessionTokenPath(ListenPort);
	TSharedRef<FJsonObject> Session = MakeShared<FJsonObject>();
	Session->SetNumberField(TEXT("port"), ListenPort);
	Session->SetStringField(TEXT("token"), SessionToken);
	Session->SetStringField(TEXT("project"), FApp::GetProjectName());
	Session->SetStringField(TEXT("projectFile"), FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath()));
	Session->SetNumberField(TEXT("pid"), static_cast<int32>(FPlatformProcess::GetCurrentProcessId()));

	FString SessionJson;
	TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> SessionWriter =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&SessionJson);
	FJsonSerializer::Serialize(Session, SessionWriter);

	if (FFileHelper::SaveStringToFile(SessionJson, *SessionFilePath))
	{
		UE_LOG(LogMCPBridge, Log,
			TEXT("UnrealMCPBridge: session token written to %s (auth %s). The MCP server reads this ")
			TEXT("file itself; there is nothing to configure."),
			*SessionFilePath, bRequireAuth ? TEXT("REQUIRED") : TEXT("offered but not enforced"));
	}
	else
	{
		// Not fatal while auth is opt-in, and it must be loud if it ever becomes required, because
		// a client that cannot read a token it is then asked for has no way to diagnose itself.
		SessionFilePath.Empty();
		UE_LOG(LogMCPBridge, Warning,
			TEXT("UnrealMCPBridge: could not write the session token file to %s. Clients will connect ")
			TEXT("without a token%s."),
			*MCPSessionTokenPath(ListenPort),
			bRequireAuth ? TEXT(", and -MCPRequireAuth will therefore refuse every one of them") : TEXT(""));
	}

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

	// Order matters, and it used to be wrong. Clients.Empty() ran first, while the listener thread
	// was still alive and still able to accept - so a connection arriving during shutdown could be
	// added to a container that had just been emptied, and then never cleaned up. Destroying the
	// listener joins its thread, which is what actually makes "no more producers" true; only then is
	// it safe to drain the handoff queue and drop the live connections.
	Listener.Reset();

	TSharedPtr<FMCPClientConnection> Pending;
	while (PendingClients.Dequeue(Pending))
	{
		Pending.Reset();
	}

	Clients.Empty();

	// A token file outlives its editor only to mislead the next client that reads it.
	if (!SessionFilePath.IsEmpty())
	{
		IFileManager::Get().Delete(*SessionFilePath, false, false, true);
		SessionFilePath.Empty();
	}
	SessionToken.Empty();
}

bool FMCPTcpServer::HandleConnectionAccepted(FSocket* NewSocket, const FIPv4Endpoint& Endpoint)
{
	// Only ever accept loopback connections.
	if (Endpoint.Address != FIPv4Address(127, 0, 0, 1))
	{
		return false;
	}

	NewSocket->SetNonBlocking(true);

	// Hand off to the game thread rather than touching Clients here: this runs on FTcpListener's
	// thread, and Clients belongs to Tick. The queue is single-producer/single-consumer, which is
	// exactly the shape of this handoff, and it never blocks the accept path.
	PendingClients.Enqueue(MakeShared<FMCPClientConnection>(NewSocket));
	UE_LOG(LogMCPBridge, Verbose, TEXT("UnrealMCPBridge: client connected from %s"), *Endpoint.ToString());
	return true;
}

bool FMCPTcpServer::Tick(float DeltaTime)
{
	// Adopt anything the listener thread accepted since the last tick.
	//
	// HandleConnectionAccepted runs on FTcpListener's own thread, and it used to Add straight into
	// Clients while this loop was iterating and removing from it. That is a plain data race on a
	// TArray: a reallocation on the listener thread while the game thread holds an element reference
	// is a crash, and an intermittent one, which is the worst kind to be handed by a bug report.
	TSharedPtr<FMCPClientConnection> Adopted;
	while (PendingClients.Dequeue(Adopted))
	{
		if (Clients.Num() >= MCPMaxClients)
		{
			// Say why, rather than dropping the socket and letting the client guess. A bare close
			// surfaces as ECONNRESET, which the Node client reports as "the editor closed or
			// crashed" - a badly wrong diagnosis for "you opened too many connections".
			Adopted->QueueSend(
				TEXT("{\"ok\":false,\"error\":\"too_many_connections\",\"detail\":\"The bridge is already ")
				TEXT("holding its maximum concurrent connections. This normally means a client is opening ")
				TEXT("sockets without closing them.\"}\n"));
			Adopted->FlushSend();
			UE_LOG(LogMCPBridge, Warning,
				TEXT("UnrealMCPBridge: refused a connection; already at the %d-connection limit."), MCPMaxClients);
			continue;
		}
		Clients.Add(Adopted);
	}
	Adopted.Reset();

	const double Now = FPlatformTime::Seconds();

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
			Clients.RemoveAt(i);
			continue;
		}

		// Anything the socket would not take last time goes out now.
		if (!Client.FlushSend())
		{
			Clients.RemoveAt(i);
			continue;
		}

		// A refused connection stays only long enough to deliver the reason.
		if (Client.bDropAfterFlush && !Client.HasPendingSend())
		{
			Clients.RemoveAt(i);
			continue;
		}

		// An orderly close from the peer, once anything still buffered has been answered and sent.
		if (Client.bPeerClosed && !Client.HasPendingSend())
		{
			Clients.RemoveAt(i);
			continue;
		}

		// A half-open connection - the peer vanished without a FIN, which loopback does not prevent -
		// would otherwise hold its slot until the editor closed.
		if (Now - Client.LastActivitySeconds > MCPIdleTimeoutSeconds && !Client.HasPendingSend())
		{
			UE_LOG(LogMCPBridge, Verbose,
				TEXT("UnrealMCPBridge: dropping a connection idle for more than %.0f seconds."),
				MCPIdleTimeoutSeconds);
			Clients.RemoveAt(i);
			continue;
		}
	}
	return true; // keep ticking
}

bool FMCPTcpServer::ProcessClientSocket(FMCPClientConnection& Client)
{
	// Read until the socket is empty.
	//
	// Recv on a non-blocking socket returns true with BytesRead == 0 when there is simply nothing
	// to read, and returns false for an orderly peer close as well as for a hard error. That is the
	// only reliable end-of-stream signal available here. The previous loop gated on HasPendingData,
	// which cannot distinguish "nothing to read yet" from "the peer hung up", so a client that
	// disconnected mid-session kept its slot until the editor was closed.
	TArray<uint8> Chunk;
	Chunk.SetNumUninitialized(8192);
	while (true)
	{
		int32 BytesRead = 0;
		if (!Client.Socket->Recv(Chunk.GetData(), Chunk.Num(), BytesRead))
		{
			Client.bPeerClosed = true;
			break;
		}
		if (BytesRead <= 0)
		{
			break;
		}
		Client.RecvBuffer.Append(Chunk.GetData(), BytesRead);
		Client.LastActivitySeconds = FPlatformTime::Seconds();
	}

	// A peer that never sends a newline must not be able to grow this without limit.
	if (Client.RecvBuffer.Num() > MCPMaxRequestBytes)
	{
		UE_LOG(LogMCPBridge, Warning,
			TEXT("UnrealMCPBridge: dropping a connection that sent %d bytes with no newline (limit %d). ")
			TEXT("A request is a single line of JSON; nothing legitimate reaches this size."),
			Client.RecvBuffer.Num(), MCPMaxRequestBytes);
		return false;
	}

	// Process complete newline-terminated requests.
	//
	// The scan is over BYTES and each line is decoded only once it is whole. Decoding every arriving
	// chunk instead - which is what this did - mangles any multi-byte UTF-8 sequence that straddles
	// a chunk boundary, and the boundary is a TCP segment rather than a tidy block, so a request
	// much past a kilobyte could hit it. The result was corrupted characters in asset paths, with
	// nothing downstream able to notice.
	while (true)
	{
		int32 NewlineIndex = INDEX_NONE;
		for (int32 i = 0; i < Client.RecvBuffer.Num(); ++i)
		{
			if (Client.RecvBuffer[i] == static_cast<uint8>('\n'))
			{
				NewlineIndex = i;
				break;
			}
		}
		if (NewlineIndex == INDEX_NONE)
		{
			break;
		}

		FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Client.RecvBuffer.GetData()), NewlineIndex);
		FString Line(Converter.Length(), Converter.Get());
		Client.RecvBuffer.RemoveAt(0, NewlineIndex + 1);

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
			FString ProvidedToken;
			RequestObj->TryGetStringField(TEXT("auth_token"), ProvidedToken);

			if (bRequireAuth && !MCPTokensMatch(ProvidedToken, SessionToken))
			{
				// Logged, because an unexplained refusal is the least diagnosable failure this
				// server can produce, and the original proposal for this feature logged nothing.
				UE_LOG(LogMCPBridge, Warning,
					TEXT("UnrealMCPBridge: refused an unauthorized request (%s). The expected token is in %s."),
					ProvidedToken.IsEmpty() ? TEXT("no auth_token supplied") : TEXT("auth_token did not match"),
					SessionFilePath.IsEmpty() ? TEXT("(no session file was written)") : *SessionFilePath);

				Response->SetBoolField(TEXT("ok"), false);
				Response->SetStringField(TEXT("error"), TEXT("unauthorized"));
				Response->SetStringField(TEXT("detail"),
					TEXT("This editor was launched with -MCPRequireAuth. The MCP server reads the token ")
					TEXT("from the session file this bridge writes at startup; if it cannot, the editor's ")
					TEXT("Output Log names the exact path on the line beginning 'session token written to'."));

				// Echo the id, exactly as the two existing guard sites do. Returning without it
				// breaks the response contract, and was one of the concrete defects in the patch
				// that proposed this feature.
				TSharedPtr<FJsonValue> IdValue = RequestObj->TryGetField(TEXT("id"));
				if (IdValue.IsValid())
				{
					Response->SetField(TEXT("id"), IdValue);
				}
				bDropConnection = true;
			}
			else
			{
				Response = FMCPCommandHandler::Dispatch(RequestObj.ToSharedRef());
			}
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

		// Queued rather than sent here: the socket is non-blocking and may take only part of a large
		// reply. Tick drains whatever is left. The diagnosis is written before the hang-up, so a
		// human pointing the wrong tool at this port is told what the port is rather than just
		// having the connection close on them.
		Client.QueueSend(OutStr);

		if (bDropConnection)
		{
			UE_LOG(LogMCPBridge, Warning,
				TEXT("UnrealMCPBridge: closing a connection that sent a line which is not JSON. ")
				TEXT("If this was a browser, a page tried to reach the bridge and was refused."));
			Client.bDropAfterFlush = true;
			return true;
		}
	}

	return true;
}

