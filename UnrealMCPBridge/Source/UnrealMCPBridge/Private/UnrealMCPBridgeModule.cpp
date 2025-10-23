#include "UnrealMCPBridgeModule.h"
#include "MCPTcpServer.h"
#include "MCPProjectIndex.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPBridgeModule, Log, All);

static const int32 GMCPBridgePort = 8765;
