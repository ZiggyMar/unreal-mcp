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
 * read_blueprint_graph_summary, read_blueprint_node_detail.
 *
 * Milestone 2 commands (write/edit): create_blueprint, add_node, connect_pins,
 * set_pin_default_value, remove_node, add_variable, compile_blueprint, save_blueprint.
 *
