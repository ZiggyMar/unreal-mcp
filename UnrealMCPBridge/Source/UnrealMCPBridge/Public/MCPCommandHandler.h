#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraphPin.h"

/**
 * Dispatches a single decoded JSON-RPC-style request to the appropriate
 * Blueprint introspection or edit command and returns a JSON response object.
