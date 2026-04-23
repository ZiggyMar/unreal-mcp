#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

class FMCPTcpServer;

/**
 * Editor module for the Unreal MCP Bridge plugin.
 * Owns the lifetime of the local TCP listener used to serve MCP bridge requests.
 */
class FUnrealMCPBridgeModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

private:
