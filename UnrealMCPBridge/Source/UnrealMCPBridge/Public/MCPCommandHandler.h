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
	static TSharedRef<FJsonObject> HandleCompileBlueprint(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSaveBlueprint(const TSharedPtr<FJsonObject>& Params);

	// --- Milestone 3: project-wide index ---
	static TSharedRef<FJsonObject> HandleSearchProject(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleFindReferences(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleGetProjectOverview(const TSharedPtr<FJsonObject>& Params);

	// --- Milestone 5: node/function ground-truth catalog ---
	static TSharedRef<FJsonObject> HandleFindNode(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleGetNodeSignature(const TSharedPtr<FJsonObject>& Params);

	// --- Milestone 7 groundwork: functions and graph organization ---
	static TSharedRef<FJsonObject> HandleCreateFunction(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleOrganizeGraph(const TSharedPtr<FJsonObject>& Params);

	// --- Batch: many nodes/wires/defaults in one atomic transaction ---
	static TSharedRef<FJsonObject> HandleBuildGraph(const TSharedPtr<FJsonObject>& Params);

	// --- Assets, levels, project settings, PIE (challenge tooling, part A) ---
	static TSharedRef<FJsonObject> HandleListAssets(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateLevel(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetGameSettings(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleDescribeClass(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListInputMappings(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleGetGameSettings(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAddInputMapping(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleStartPie(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleStopPie(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandlePieStatus(const TSharedPtr<FJsonObject>& Params);

	// --- Level editing: open, populate, save ---
	static TSharedRef<FJsonObject> HandleOpenLevel(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSpawnActor(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSaveLevel(const TSharedPtr<FJsonObject>& Params);

	// --- Brownfield repair: refresh nodes after a C++ change ---
	static TSharedRef<FJsonObject> HandleRefreshBlueprint(const TSharedPtr<FJsonObject>& Params);

	// --- Asset management: delete with reference safety ---
	static TSharedRef<FJsonObject> HandleDeleteAsset(const TSharedPtr<FJsonObject>& Params);

	// --- Components and class defaults (challenge tooling, part B) ---
	static TSharedRef<FJsonObject> HandleAddComponent(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListVariables(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListComponents(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetComponentProperty(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateWidgetBlueprint(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAddWidget(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListWidgets(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetWidgetProperty(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleReadAssetProperties(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleReadClassDefaults(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetAssetProperty(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSaveAsset(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateDataTable(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAddDataTableRow(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetDataTableRow(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleRemoveDataTableRow(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleTakeScreenshot(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListDataTableRows(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateStruct(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAddStructField(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListStructFields(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateEnum(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListEnumEntries(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateMaterial(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleCreateMaterialInstance(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetMaterialParameter(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListMaterialParameters(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleListActors(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetActorProperty(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleDeleteActor(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleUndoHistory(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleProjectHealth(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleAssetStatus(const TSharedPtr<FJsonObject>& Params);
	static TSharedRef<FJsonObject> HandleSetClassDefault(const TSharedPtr<FJsonObject>& Params);

	// Shared core of add_node and build_graph. When bOpenTransaction is false the caller
	// must already hold a transaction and have decided how failures roll back.
	static TSharedRef<FJsonObject> AddNodeCore(class UBlueprint* Blueprint, class UEdGraph* Graph,
		const TSharedPtr<FJsonObject>& Params, bool bOpenTransaction);

	// --- Shared lookup helpers ---

	// Loads a Blueprint asset given a package/object path (e.g. "/Game/Blueprints/BP_Foo.BP_Foo").
	static class UBlueprint* LoadBlueprintByPath(const FString& Path, FString& OutError);

	// Finds one of a Blueprint's graphs (event graph, function, macro, ...) by name.
	static class UEdGraph* FindGraphByName(class UBlueprint* Blueprint, const FString& GraphName, FString& OutError);

	// Resolves a node id (as produced by read_blueprint_graph_summary / add_node, "n<index>")
	// back to a node within a specific graph. Not stable across editor sessions or edits.
	static class UEdGraphNode* FindNodeById(class UEdGraph* Graph, const FString& NodeId, FString& OutError);

	// Resolves a class by short name ("Actor", "Pawn") or full path ("/Script/Engine.Actor",
	// "/Game/BP_Base.BP_Base_C"). Tries A-/U- native prefixes for short names.
	static UClass* ResolveClassByName(const FString& ClassName, FString& OutError);

	// Resolves a UWidget subclass by name, rejecting non-widget and abstract classes with a
	// message that lists the widget classes a caller most likely wanted.
	static UClass* ResolveWidgetClass(const FString& ClassName, FString& OutError);

	// Loads a Widget Blueprint specifically, failing with what was found instead when the path
	// points at an ordinary Blueprint.
	static class UWidgetBlueprint* LoadWidgetBlueprint(const FString& Path, FString& OutError);

	// Resolves a struct by short asset name, full path, or engine name. Covers both native
	// engine structs and the project's own UUserDefinedStruct assets.
	static UScriptStruct* ResolveStructByName(const FString& Name, FString& OutError);

	// Resolves an enum the same way, for enum:<Name> variable types.
	static UEnum* ResolveEnumByName(const FString& Name, FString& OutError);

	// Parses a compact type descriptor (see add_variable / set_pin_default_value docs in
	// mcp-server) into an FEdGraphPinType: bool, byte, int, int64, float, double, string,
	// name, text, vector, rotator, transform, object:<Class>, class:<Class>.
	static bool ResolvePinType(const FString& TypeStr, struct FEdGraphPinType& OutType, FString& OutError);
};

