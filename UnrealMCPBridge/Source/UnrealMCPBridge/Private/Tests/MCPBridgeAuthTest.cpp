/**
 * Bridge-side tests for the session token: missing, wrong, and valid.
 *
 * The client half of this feature has tests, including one that stands up a socket and asserts the
 * token is genuinely on the wire. The bridge half had none, because the bridge cannot be run without
 * an Unreal build, so the only thing anyone could say about it was that it looked right. That is the
 * gap this file closes, and it closes it by driving the REAL FMCPTcpServer over a REAL socket rather
 * than by testing a comparison function in isolation: the defect that made the original proposal
 * unmergeable was not a wrong comparison, it was two halves that were never connected, and a test
 * of the comparison alone would have passed just as happily.
 *
 * Why every step is a latent command. The server does its work on the game thread, in a FTSTicker
 * callback. A test that sends a request and then blocks waiting for the reply deadlocks: the thread
 * it is blocking is the thread that would have answered it. So each exchange is a state machine
 * whose Update returns false until the reply arrives, which yields the frame back and lets the
 * server tick. This is the single easiest thing to get wrong here, and it is invisible until run.
 *
 * Run these with:
 *   UnrealEditor-Cmd <project> -ExecCmds="Automation RunTests UnrealMCPBridge; Quit" -unattended -nullrhi
 * or, against every configured engine at once, `npm run test:bridge` in mcp-server/.
 */

#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

#include "MCPTcpServer.h"

#include "Dom/JsonObject.h"
#include "HAL/FileManager.h"
#include "HAL/PlatformProcess.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "SocketSubsystem.h"
#include "Sockets.h"
#include "Interfaces/IPv4/IPv4Address.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPBridgeAuthTest, Log, All);

namespace MCPBridgeAuthTest
{
	/** Ports to try. The editor running the test already owns 8765, so this stays well clear of it. */
	static constexpr int32 FirstPort = 18760;
	static constexpr int32 LastPort = 18790;

	/** Long enough for a slow editor frame, short enough that a hung test fails rather than hangs. */
	static constexpr double ReplyTimeoutSeconds = 15.0;

	/** Named rather than sizeof'd, so nothing narrows on the way into FSocket::Recv's int32. */
	static constexpr int32 ReadBufferBytes = 4096;

	/**
	 * How long to wait before accepting that a reply is not coming.
	 *
	 * Shorter than the timeout above because it is spent on purpose. Proving a reply arrived can
	 * wait as long as the editor needs; proving one did not is a fixed cost paid every run, and an
	 * orderly close is usually noticed long before this expires anyway.
	 */
	static constexpr double SilenceTimeoutSeconds = 3.0;

	/**
	 * A running bridge, a socket connected to it, and the token it wrote.
	 *
	 * The session file goes under the project's Intermediate directory, never the real per-user one.
	 * A test that wrote to the developer's own session file would delete it again on teardown and
	 * leave a running editor unable to be talked to, which is a rude way to find out a test ran.
	 */
	struct FFixture
	{
		TSharedPtr<FMCPTcpServer> Server;
		FSocket* Socket = nullptr;
		FString SessionFilePath;
		FString Token;
		int32 Port = 0;

		~FFixture()
		{
			Shutdown();
		}

		void Shutdown()
		{
			if (Socket)
			{
				Socket->Close();
				ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->DestroySocket(Socket);
				Socket = nullptr;
			}
			if (Server.IsValid())
			{
				Server->Stop();
				Server.Reset();
			}
			if (!SessionFilePath.IsEmpty())
			{
				IFileManager::Get().Delete(*SessionFilePath, false, true, true);
				SessionFilePath.Empty();
			}
		}
	};

	/** Read the token back out of the file the server just wrote, which tests the write path too. */
	static bool ReadTokenFromSessionFile(const FString& Path, FString& OutToken)
	{
		FString Raw;
		if (!FFileHelper::LoadFileToString(Raw, *Path))
		{
			return false;
		}
		TSharedPtr<FJsonObject> Parsed;
		TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Raw);
		if (!FJsonSerializer::Deserialize(Reader, Parsed) || !Parsed.IsValid())
		{
			return false;
		}
		return Parsed->TryGetStringField(TEXT("token"), OutToken) && !OutToken.IsEmpty();
	}

	/**
	 * Start a bridge on the first free port in the range, with auth forced on or off.
	 *
	 * The port is found by trying rather than asked for, because a developer machine may well have
	 * something on any given one, and a test that fails for that reason teaches nobody anything.
	 */
	static TSharedPtr<FFixture> StartBridge(FAutomationTestBase& Test, bool bRequireAuth)
	{
		TSharedPtr<FFixture> Fixture = MakeShared<FFixture>();

		for (int32 Port = FirstPort; Port <= LastPort; ++Port)
		{
			FMCPServerOptions Options;
			Options.Port = Port;
			Options.bAllowCommandLineOverrides = false;
			Options.bRequireAuth = bRequireAuth;
			Options.SessionFilePath = FPaths::Combine(
				FPaths::ProjectIntermediateDir(),
				TEXT("MCPBridgeAuthTest"),
				FString::Printf(TEXT("session-%d.json"), Port));

			TSharedPtr<FMCPTcpServer> Server = MakeShared<FMCPTcpServer>();
			if (Server->Start(Options))
			{
				Fixture->Server = Server;
				Fixture->Port = Port;
				Fixture->SessionFilePath = Options.SessionFilePath.GetValue();
				break;
			}
			Server->Stop();
		}

		if (!Fixture->Server.IsValid())
		{
			Test.AddError(FString::Printf(
				TEXT("Could not bind any port between %d and %d, so nothing could be tested."), FirstPort, LastPort));
			return nullptr;
		}

		if (!ReadTokenFromSessionFile(Fixture->SessionFilePath, Fixture->Token))
		{
			Test.AddError(FString::Printf(
				TEXT("The bridge started but wrote no readable session file at %s. Every client depends on that ")
				TEXT("file, so there is nothing further worth checking."),
				*Fixture->SessionFilePath));
			return nullptr;
		}

		ISocketSubsystem* Sockets = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
		Fixture->Socket = Sockets->CreateSocket(NAME_Stream, TEXT("MCPBridgeAuthTestClient"), false);
		if (!Fixture->Socket)
		{
			Test.AddError(TEXT("Could not create a client socket."));
			return nullptr;
		}

		TSharedRef<FInternetAddr> Address = Sockets->CreateInternetAddr();
		bool bAddressValid = false;
		Address->SetIp(TEXT("127.0.0.1"), bAddressValid);
		Address->SetPort(Fixture->Port);
		if (!bAddressValid || !Fixture->Socket->Connect(*Address))
		{
			Test.AddError(FString::Printf(TEXT("Could not connect to the bridge on 127.0.0.1:%d."), Fixture->Port));
			return nullptr;
		}
		// Non-blocking from here on: the reply is polled from a latent command so the game thread,
		// which is the thread that produces the reply, is never held.
		Fixture->Socket->SetNonBlocking(true);

		return Fixture;
	}

	/** Serialise a request line, optionally carrying a token. */
	static FString MakeRequestLine(const FString& Id, const FString& Cmd, const FString* AuthToken)
	{
		TSharedRef<FJsonObject> Request = MakeShared<FJsonObject>();
		Request->SetStringField(TEXT("id"), Id);
		Request->SetStringField(TEXT("cmd"), Cmd);
		Request->SetObjectField(TEXT("params"), MakeShared<FJsonObject>());
		if (AuthToken)
		{
			Request->SetStringField(TEXT("auth_token"), *AuthToken);
		}

		FString Line;
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Line);
		FJsonSerializer::Serialize(Request, Writer);
		Line.AppendChar(TEXT('\n'));
		return Line;
	}

	/**
	 * One request, one reply, one set of assertions, spread across as many frames as it takes.
	 *
	 * `bExpectNoReply` inverts the timeout: for the case where the bridge is supposed to have hung up,
	 * silence is the passing result and a reply is the failure.
	 */
	struct FExchange
	{
		FAutomationTestBase* Test = nullptr;
		TSharedPtr<FFixture> Fixture;
		FString What;
		FString RequestLine;
		bool bExpectNoReply = false;
		TFunction<void(const TSharedPtr<FJsonObject>&)> Verify;

		bool bSent = false;
		double Deadline = 0.0;
		/**
		 * Bytes, not characters, for the same reason the server buffers bytes: a reply can arrive in
		 * more than one segment, and decoding each piece as it lands corrupts any multi-byte sequence
		 * that straddles the boundary. It would almost certainly never bite a reply this small, and
		 * writing the bug into the test for the code that documents the bug is still not on.
		 */
		TArray<uint8> Received;

		/** Returns true when this exchange is finished, which is what a latent command's Update means. */
		bool Tick()
		{
			if (!Fixture.IsValid() || !Fixture->Socket)
			{
				return true;
			}

			if (!bSent)
			{
				FTCHARToUTF8 Utf8(*RequestLine);
				int32 BytesSent = 0;
				if (!Fixture->Socket->Send(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length(), BytesSent) ||
					BytesSent != Utf8.Length())
				{
					// A send that fails on a connection the bridge has already dropped is not a test
					// failure, it is the result the drop test is looking for. The peer is entitled to
					// have gone away between the refusal and this write, and whether the failure
					// surfaces here or as silence below is a timing detail of the local TCP stack.
					if (!bExpectNoReply)
					{
						Test->AddError(FString::Printf(TEXT("%s: could not put the request on the wire."), *What));
					}
					return true;
				}
				bSent = true;
				Deadline = FPlatformTime::Seconds() + (bExpectNoReply ? SilenceTimeoutSeconds : ReplyTimeoutSeconds);
				return false;
			}

			uint8 Buffer[ReadBufferBytes];
			int32 BytesRead = 0;
			bool bPeerClosed = false;
			while (true)
			{
				if (!Fixture->Socket->Recv(Buffer, ReadBufferBytes, BytesRead))
				{
					// Recv reports an orderly close the same way it reports an error, and on a
					// loopback socket that has just been hung up on, the former is what this is.
					bPeerClosed = true;
					break;
				}
				if (BytesRead <= 0)
				{
					break;
				}
				Received.Append(Buffer, BytesRead);
			}

			// The drop is the result here, so say so as soon as it is visible rather than sitting
			// out the whole silence budget to reach the same conclusion.
			if (bExpectNoReply && bPeerClosed && Received.Num() == 0)
			{
				return true;
			}

			int32 NewlineIndex = INDEX_NONE;
			for (int32 Index = 0; Index < Received.Num(); ++Index)
			{
				if (Received[Index] == static_cast<uint8>('\n'))
				{
					NewlineIndex = Index;
					break;
				}
			}

			if (NewlineIndex != INDEX_NONE)
			{
				FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Received.GetData()), NewlineIndex);
				const FString Line(Converter.Length(), Converter.Get());

				if (bExpectNoReply)
				{
					Test->AddError(FString::Printf(
						TEXT("%s: expected the bridge to have dropped the connection, but it answered with %s"),
						*What, *Line));
					return true;
				}

				TSharedPtr<FJsonObject> Response;
				TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(Line);
				if (!FJsonSerializer::Deserialize(Reader, Response) || !Response.IsValid())
				{
					Test->AddError(FString::Printf(TEXT("%s: the reply was not JSON: %s"), *What, *Line));
					return true;
				}
				Verify(Response);
				return true;
			}

			if (FPlatformTime::Seconds() > Deadline)
			{
				if (!bExpectNoReply)
				{
					Test->AddError(FString::Printf(
						TEXT("%s: no reply within %.0f seconds."), *What, ReplyTimeoutSeconds));
				}
				return true;
			}

			if (bPeerClosed)
			{
				// Closed, but something partial arrived and never completed a line. Nothing more is
				// coming, so waiting out the deadline would only make the failure slower.
				Test->AddError(FString::Printf(
					TEXT("%s: the connection closed after a partial reply of %d byte(s)."), *What, Received.Num()));
				return true;
			}

			return false;
		}
	};
}

DEFINE_LATENT_AUTOMATION_COMMAND_ONE_PARAMETER(
	FMCPRunExchange, TSharedPtr<MCPBridgeAuthTest::FExchange>, Exchange);

bool FMCPRunExchange::Update()
{
	return Exchange.IsValid() ? Exchange->Tick() : true;
}

DEFINE_LATENT_AUTOMATION_COMMAND_ONE_PARAMETER(
	FMCPShutdownFixture, TSharedPtr<MCPBridgeAuthTest::FFixture>, Fixture);

bool FMCPShutdownFixture::Update()
{
	if (Fixture.IsValid())
	{
		Fixture->Shutdown();
	}
	return true;
}

/**
 * The flag expression is kept to two enumerators on purpose.
 *
 * EAutomationTestFlags became an enum class, and the combined application-context mask was moved to
 * a separately named constant when that happened. Which spelling a given engine version wants is
 * exactly the kind of thing this file cannot check for itself, so it uses only the two enumerators
 * that have been stable across the change.
 */
#define MCP_BRIDGE_TEST_FLAGS (EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPBridgeAuthMissingTokenTest, "UnrealMCPBridge.Auth.MissingToken", MCP_BRIDGE_TEST_FLAGS)

bool FMCPBridgeAuthMissingTokenTest::RunTest(const FString& Parameters)
{
	TSharedPtr<MCPBridgeAuthTest::FFixture> Fixture = MCPBridgeAuthTest::StartBridge(*this, true);
	if (!Fixture.IsValid())
	{
		return false;
	}

	TSharedPtr<MCPBridgeAuthTest::FExchange> Exchange = MakeShared<MCPBridgeAuthTest::FExchange>();
	Exchange->Test = this;
	Exchange->Fixture = Fixture;
	Exchange->What = TEXT("a request with no auth_token");
	Exchange->RequestLine = MCPBridgeAuthTest::MakeRequestLine(TEXT("missing-1"), TEXT("ping"), nullptr);
	Exchange->Verify = [this](const TSharedPtr<FJsonObject>& Response)
	{
		bool bOk = true;
		Response->TryGetBoolField(TEXT("ok"), bOk);
		TestFalse(TEXT("a tokenless request is refused when auth is required"), bOk);

		FString Error;
		Response->TryGetStringField(TEXT("error"), Error);
		TestEqual(TEXT("and refused as unauthorized specifically"), Error, FString(TEXT("unauthorized")));

		// The id echo was one of the three concrete defects in the patch that first proposed this.
		FString Id;
		Response->TryGetStringField(TEXT("id"), Id);
		TestEqual(TEXT("the request id is echoed, as the other guard sites do"), Id, FString(TEXT("missing-1")));

		// The whole self-correction path on the client depends on this field being present.
		FString SessionFile;
		Response->TryGetStringField(TEXT("session_file"), SessionFile);
		TestTrue(TEXT("the refusal names the session file the client should have read"), !SessionFile.IsEmpty());
	};

	ADD_LATENT_AUTOMATION_COMMAND(FMCPRunExchange(Exchange));
	ADD_LATENT_AUTOMATION_COMMAND(FMCPShutdownFixture(Fixture));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPBridgeAuthWrongTokenTest, "UnrealMCPBridge.Auth.WrongToken", MCP_BRIDGE_TEST_FLAGS)

bool FMCPBridgeAuthWrongTokenTest::RunTest(const FString& Parameters)
{
	TSharedPtr<MCPBridgeAuthTest::FFixture> Fixture = MCPBridgeAuthTest::StartBridge(*this, true);
	if (!Fixture.IsValid())
	{
		return false;
	}

	// The same LENGTH as the real token, so this exercises the comparison loop rather than the early
	// length check. A wrong token that is also the wrong length proves much less than it looks.
	FString WrongToken = Fixture->Token;
	const TCHAR First = WrongToken[0];
	WrongToken[0] = (First == TEXT('a')) ? TEXT('b') : TEXT('a');

	TSharedPtr<MCPBridgeAuthTest::FExchange> Exchange = MakeShared<MCPBridgeAuthTest::FExchange>();
	Exchange->Test = this;
	Exchange->Fixture = Fixture;
	Exchange->What = TEXT("a request with a wrong token of the right length");
	Exchange->RequestLine = MCPBridgeAuthTest::MakeRequestLine(TEXT("wrong-1"), TEXT("ping"), &WrongToken);
	Exchange->Verify = [this](const TSharedPtr<FJsonObject>& Response)
	{
		bool bOk = true;
		Response->TryGetBoolField(TEXT("ok"), bOk);
		TestFalse(TEXT("a token that differs by one character is refused"), bOk);

		FString Error;
		Response->TryGetStringField(TEXT("error"), Error);
		TestEqual(TEXT("and refused as unauthorized"), Error, FString(TEXT("unauthorized")));

		FString Id;
		Response->TryGetStringField(TEXT("id"), Id);
		TestEqual(TEXT("the request id is echoed"), Id, FString(TEXT("wrong-1")));
	};

	ADD_LATENT_AUTOMATION_COMMAND(FMCPRunExchange(Exchange));
	ADD_LATENT_AUTOMATION_COMMAND(FMCPShutdownFixture(Fixture));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPBridgeAuthValidTokenTest, "UnrealMCPBridge.Auth.ValidToken", MCP_BRIDGE_TEST_FLAGS)

bool FMCPBridgeAuthValidTokenTest::RunTest(const FString& Parameters)
{
	TSharedPtr<MCPBridgeAuthTest::FFixture> Fixture = MCPBridgeAuthTest::StartBridge(*this, true);
	if (!Fixture.IsValid())
	{
		return false;
	}

	TSharedPtr<MCPBridgeAuthTest::FExchange> Exchange = MakeShared<MCPBridgeAuthTest::FExchange>();
	Exchange->Test = this;
	Exchange->Fixture = Fixture;
	Exchange->What = TEXT("a request carrying the token from the session file");
	Exchange->RequestLine = MCPBridgeAuthTest::MakeRequestLine(TEXT("valid-1"), TEXT("ping"), &Fixture->Token);
	Exchange->Verify = [this](const TSharedPtr<FJsonObject>& Response)
	{
		bool bOk = false;
		Response->TryGetBoolField(TEXT("ok"), bOk);
		// This is the claim the original patch could not have made: the token the editor wrote to
		// the file is the token that opens the door, with nothing in between having been configured.
		TestTrue(TEXT("the token from the session file is accepted"), bOk);

		FString Id;
		Response->TryGetStringField(TEXT("id"), Id);
		TestEqual(TEXT("the request id is echoed"), Id, FString(TEXT("valid-1")));
	};

	ADD_LATENT_AUTOMATION_COMMAND(FMCPRunExchange(Exchange));
	ADD_LATENT_AUTOMATION_COMMAND(FMCPShutdownFixture(Fixture));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPBridgeAuthRefusalClosesTest, "UnrealMCPBridge.Auth.RefusalClosesConnection", MCP_BRIDGE_TEST_FLAGS)

bool FMCPBridgeAuthRefusalClosesTest::RunTest(const FString& Parameters)
{
	TSharedPtr<MCPBridgeAuthTest::FFixture> Fixture = MCPBridgeAuthTest::StartBridge(*this, true);
	if (!Fixture.IsValid())
	{
		return false;
	}

	// A refused connection is finished once its reply has drained. If it were not, a caller could sit
	// on one socket and guess tokens on it indefinitely, which is the cheapest possible way to attack
	// this and the reason the refusal path sets bDropAfterFlush.
	TSharedPtr<MCPBridgeAuthTest::FExchange> Refused = MakeShared<MCPBridgeAuthTest::FExchange>();
	Refused->Test = this;
	Refused->Fixture = Fixture;
	Refused->What = TEXT("the first, refused request");
	Refused->RequestLine = MCPBridgeAuthTest::MakeRequestLine(TEXT("closes-1"), TEXT("ping"), nullptr);
	Refused->Verify = [this](const TSharedPtr<FJsonObject>& Response)
	{
		bool bOk = true;
		Response->TryGetBoolField(TEXT("ok"), bOk);
		TestFalse(TEXT("refused, as the setup requires"), bOk);
	};

	TSharedPtr<MCPBridgeAuthTest::FExchange> AfterRefusal = MakeShared<MCPBridgeAuthTest::FExchange>();
	AfterRefusal->Test = this;
	AfterRefusal->Fixture = Fixture;
	AfterRefusal->What = TEXT("a second request on the same connection, now carrying a valid token");
	AfterRefusal->RequestLine = MCPBridgeAuthTest::MakeRequestLine(TEXT("closes-2"), TEXT("ping"), &Fixture->Token);
	AfterRefusal->bExpectNoReply = true;
	AfterRefusal->Verify = [](const TSharedPtr<FJsonObject>&) {};

	ADD_LATENT_AUTOMATION_COMMAND(FMCPRunExchange(Refused));
	ADD_LATENT_AUTOMATION_COMMAND(FMCPRunExchange(AfterRefusal));
	ADD_LATENT_AUTOMATION_COMMAND(FMCPShutdownFixture(Fixture));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPBridgeAuthDisabledTest, "UnrealMCPBridge.Auth.Disabled", MCP_BRIDGE_TEST_FLAGS)

bool FMCPBridgeAuthDisabledTest::RunTest(const FString& Parameters)
{
	// The default, and the state every existing installation is in. A token is still generated and
	// still written; what must not happen is a tokenless client being refused, because that would
	// break every one of them on the day this shipped.
	TSharedPtr<MCPBridgeAuthTest::FFixture> Fixture = MCPBridgeAuthTest::StartBridge(*this, false);
	if (!Fixture.IsValid())
	{
		return false;
	}

	TSharedPtr<MCPBridgeAuthTest::FExchange> Exchange = MakeShared<MCPBridgeAuthTest::FExchange>();
	Exchange->Test = this;
	Exchange->Fixture = Fixture;
	Exchange->What = TEXT("a tokenless request with enforcement off");
	Exchange->RequestLine = MCPBridgeAuthTest::MakeRequestLine(TEXT("off-1"), TEXT("ping"), nullptr);
	Exchange->Verify = [this](const TSharedPtr<FJsonObject>& Response)
	{
		bool bOk = false;
		Response->TryGetBoolField(TEXT("ok"), bOk);
		TestTrue(TEXT("with auth off, a client that sends no token is served as it always was"), bOk);
	};

	ADD_LATENT_AUTOMATION_COMMAND(FMCPRunExchange(Exchange));
	ADD_LATENT_AUTOMATION_COMMAND(FMCPShutdownFixture(Fixture));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPBridgeSessionPathTest, "UnrealMCPBridge.SessionPath", MCP_BRIDGE_TEST_FLAGS)

bool FMCPBridgeSessionPathTest::RunTest(const FString& Parameters)
{
	// The one question this repository could not answer about its own auth: does
	// FPlatformProcess::UserSettingsDir() resolve to somewhere mcp-server/src/sessionToken.ts looks?
	// The C++ cannot answer it, because it does not know what the client searches, and the client
	// cannot answer it, because it has no engine. So the engine half prints its answer in a form a
	// machine can read, and scripts/run-automation.mjs compares the two. Note the deliberate use of
	// the UNOVERRIDDEN path: the fixtures above redirect theirs, and would prove nothing here.
	const FString Path = FMCPTcpServer::DefaultSessionFilePath(8765);
	TestTrue(TEXT("the bridge can name a session file path at all"), !Path.IsEmpty());

	UE_LOG(LogMCPBridgeAuthTest, Display, TEXT("MCPSessionPathProbe: %s"), *Path);
	AddInfo(FString::Printf(TEXT("MCPSessionPathProbe: %s"), *Path));
	return true;
}

#undef MCP_BRIDGE_TEST_FLAGS

#endif // WITH_DEV_AUTOMATION_TESTS
