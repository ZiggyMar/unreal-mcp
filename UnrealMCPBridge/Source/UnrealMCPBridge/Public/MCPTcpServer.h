#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"

class FSocket;
class FTcpListener;
class FInternetAddr;

/**
 * Minimal single-threaded, line-delimited JSON TCP server.
 * Listens on localhost only. Accepts one request per line, writes one JSON
 * response per line (newline-terminated) back on the same connection.
 *
 * Runs entirely on the game thread via FTSTicker so command handlers can
 * safely call into UE Editor / AssetRegistry / Kismet2 APIs without any
