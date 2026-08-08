#include "UnrealMCPBridgeModule.h"
#include "MCPTcpServer.h"
#include "MCPProjectIndex.h"
#include "MCPNodeCatalog.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPBridgeModule, Log, All);

static const int32 GMCPBridgePort = 8765;

void FUnrealMCPBridgeModule::StartupModule()
{
	// Registers AssetRegistry delegates immediately (cheap) but defers the potentially
	// expensive full scan/load-every-blueprint work to the first search_project /
	// get_project_overview call (see FMCPProjectIndex::EnsureBuilt).
	FMCPProjectIndex::Initialize();

	// Same deferral rationale: allocating the singleton is free, and the reflection walk
	// that actually fills it waits for the first find_node / get_node_signature call.
	FMCPNodeCatalog::Initialize();

	TcpServer = MakeShared<FMCPTcpServer>();
	if (!TcpServer->Start(GMCPBridgePort))
	{
		UE_LOG(LogMCPBridgeModule, Error, TEXT("UnrealMCPBridge failed to start TCP server on port %d"), GMCPBridgePort);
	}
}

void FUnrealMCPBridgeModule::ShutdownModule()
{
	if (TcpServer.IsValid())
	{
		TcpServer->Stop();
		TcpServer.Reset();
	}

	FMCPNodeCatalog::Shutdown();
	FMCPProjectIndex::Shutdown();
}

IMPLEMENT_MODULE(FUnrealMCPBridgeModule, UnrealMCPBridge)

