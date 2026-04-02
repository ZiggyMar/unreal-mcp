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
 * Milestone 3 commands (project-wide index): search_project, find_references,
 * get_project_overview. Backed by FMCPProjectIndex (see MCPProjectIndex.h), not by
 * enumerating/loading assets ad hoc on every call.
 *
 * All handlers run on the game thread (FMCPTcpServer ticks via FTSTicker), so they
 * may call directly into Editor/Kismet2/AssetRegistry/EdGraph APIs with no thread
 * marshaling.
 */
class FMCPCommandHandler
{
public:
	static TSharedRef<FJsonObject> Dispatch(const TSharedRef<FJsonObject>& Request);

private:
	// --- Milestone 1: read-only ---
	static TSharedRef<FJsonObject> HandlePing(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListBlueprints(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListBlueprintGraphs(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleReadBlueprintGraphSummary(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleReadBlueprintNodeDetail(const TSharedPtr<FJsonObject>& Params);

	// --- Milestone 2: write/edit ---
	static TSharedRef<FJsonObject> HandleCreateBlueprint(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAddNode(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleConnectPins(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetPinDefaultValue(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleRemoveNode(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAddVariable(const TSharedPtr<FJsonObject>& Params);
