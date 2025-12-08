#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"

class FSocket;
class FTcpListener;
class FInternetAddr;

/**
 * Minimal single-threaded, line-delimited JSON TCP server.
