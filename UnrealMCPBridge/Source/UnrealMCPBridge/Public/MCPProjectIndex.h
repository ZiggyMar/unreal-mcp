#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FAssetData;

struct FMCPIndexParam
{
	FString Name;
	FString Type;
};

struct FMCPIndexFunction
{
	FString Name;
	FString ReturnType;
	TArray<FMCPIndexParam> Params;
};

struct FMCPIndexVariable
{
	FString Name;
	FString Type;
	FString Category;
};

struct FMCPIndexGraph
{
	FString Name;
	int32 NodeCount = 0;
	TMap<FString, int32> NodeTypeHistogram;
};

struct FMCPIndexBlueprint
{
	FString Path;
	FString Name;
	FString ParentClass;
	TArray<FString> Interfaces;
	TArray<FMCPIndexFunction> Functions;
	TArray<FMCPIndexVariable> Variables;
	TArray<FMCPIndexGraph> Graphs;
};

/**
 * Project-wide, incrementally-updated index of Blueprint structure (functions,
 * variables, graphs, node-type histograms). Backs search_project / find_references /
 * get_project_overview so a model can orient itself and find things without
 * enumerating and loading every Blueprint asset on every request. The whole point
 * is avoiding the "re-explain the project every conversation" cost.
 *
 * Owned as a singleton by FUnrealMCPBridgeModule (Initialize/Shutdown called from
 * StartupModule/ShutdownModule). Persisted to Saved/UnrealMCPBridge/index.json so a
 * fresh editor session can skip a full rebuild. Kept fresh after that via
 * IAssetRegistry's OnAssetAdded/Removed/Renamed/Updated delegates (no polling).
 *
 * Runs entirely on the game thread (same as everything else in this plugin): both the
 * TCP server's tick and the AssetRegistry's delegates fire on the game thread, so no
 * locking is needed around Entries.
 */
class FMCPProjectIndex
{
public:
	static void Initialize();
	static void Shutdown();
	static FMCPProjectIndex& Get();

	// Builds the index if it hasn't been built yet this session: loads the on-disk
	// cache if present, otherwise does a full AssetRegistry scan + per-Blueprint load.
	// Cheap to call repeatedly: a no-op once built.
	void EnsureBuilt();

	// Forces a full rescan of every Blueprint in the AssetRegistry, replacing Entries.
	void RebuildFull();

	// Case-insensitive substring search across blueprint/function/variable names and
	// parent-class names. Returns compact {kind, path, name, context} hit objects,
	// capped at MaxResults.
	TArray<TSharedPtr<FJsonValue>> Search(const FString& Query, int32 MaxResults) const;
