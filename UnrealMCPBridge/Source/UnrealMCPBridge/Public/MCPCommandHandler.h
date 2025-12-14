#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "EdGraph/EdGraphPin.h"

/**
 * Dispatches a single decoded JSON-RPC-style request to the appropriate
 * Blueprint introspection or edit command and returns a JSON response object.
 *
 * Request shape:  { "id": <any>, "cmd": "<name>", "params": { ... } }
 * Response shape: { "id": <any>, "ok": true, "result": { ... } }
 *              or { "id": <any>, "ok": false, "error": "<message>" }
 *
 * Milestone 1 commands (read-only): ping, list_blueprints, list_blueprint_graphs,
