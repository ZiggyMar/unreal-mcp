#include "UnrealMCPBridgeModule.h"
#include "MCPTcpServer.h"
#include "MCPProjectIndex.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPBridgeModule, Log, All);

static const int32 GMCPBridgePort = 8765;

void FUnrealMCPBridgeModule::StartupModule()
{
	// Registers AssetRegistry delegates immediately (cheap) but defers the potentially
	// expensive full scan/load-every-blueprint work to the first search_project /
	// get_project_overview call (see FMCPProjectIndex::EnsureBuilt).
	FMCPProjectIndex::Initialize();

	TcpServer = MakeShared<FMCPTcpServer>();
	if (!TcpServer->Start(GMCPBridgePort))
