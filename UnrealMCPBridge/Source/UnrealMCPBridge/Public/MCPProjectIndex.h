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

	/**
	 * True for a Custom Event, which is callable by name exactly like a function but lives in the
	 * event graph rather than in FunctionGraphs.
	 *
	 * Kept as a flag rather than a separate list because to a caller searching for "the thing named
	 * X" these are the same question - and the distinction still has to be reported, since one has a
	 * graph you can open by name and the other is a node inside a bigger one.
	 */
	bool bIsCustomEvent = false;
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

	/**
	 * "error", "warning", "dirty" or "upToDate" - EBlueprintStatus in words.
	 *
	 * Recorded here because the index already loads every Blueprint, so asking costs nothing, and
	 * because project_health described itself as answering "what does not compile" while reporting
	 * only graph sizes. Fifteen broken Blueprints were invisible to every tool here and perfectly
	 * visible to the person, who got a dialog listing them the moment they pressed Play.
	 */
	FString CompileStatus;
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

	// Cheap top-level summary: counts + top-level folder breakdown + parent-class breakdown.
	TSharedRef<FJsonObject> GetOverview() const;

	// Project-wide health scan: the worst offenders by the measures that actually cost frames or
	// make a project unmaintainable. Reads the histograms the index already keeps, so it costs
	// nothing beyond what a rebuild already paid for.
	TSharedRef<FJsonObject> GetHealthReport(int32 MaxPerCategory) const;

	/**
	 * Names of Blueprints whose last compile failed, capped.
	 *
	 * Answered from the index rather than TObjectIterator because that iterator only sees LOADED
	 * objects, and on a freshly started editor almost nothing is loaded - so the first version of
	 * this check found zero broken Blueprints in a project with fifteen, and was reliable-looking
	 * and useless. The index loads every Blueprint under /Game by construction, which is exactly the
	 * set the editor's own Play dialog complains about.
	 */
	TArray<FString> GetBlueprintsWithErrors(int32 Max) const;

	int32 GetIndexedBlueprintCount() const { return Entries.Num(); }

private:
	FMCPProjectIndex() = default;

	void IndexBlueprintByPath(const FString& ObjectPath);
	void SaveToDisk() const;
	bool LoadFromDisk();
	static FString GetIndexFilePath();
	static bool IsBlueprintAsset(const FAssetData& AssetData);

	void OnAssetAdded(const FAssetData& AssetData);
	void OnAssetRemoved(const FAssetData& AssetData);
	void OnAssetRenamed(const FAssetData& AssetData, const FString& OldObjectPath);
	void OnAssetUpdated(const FAssetData& AssetData);
	void OnFilesLoaded();

	TMap<FString, FMCPIndexBlueprint> Entries;
	bool bBuilt = false;
	bool bAssetRegistryStillScanning = false;
	/**
	 * An asset changed before anything had asked for the index, so the snapshot on disk is behind.
	 *
	 * The callbacks below all begin `if (!bBuilt) return;`, and EnsureBuilt is lazy - nothing builds
	 * the index until a tool needs it. Every change in that window was therefore dropped, and the
	 * next EnsureBuilt loaded a cache that predated it. Observed: ten Blueprints deleted from a real
	 * project stayed in get_project_overview afterwards, listed under a folder that no longer had
	 * anything in it.
	 */
	bool bCacheStale = false;

	FDelegateHandle OnAssetAddedHandle;
	FDelegateHandle OnAssetRemovedHandle;
	FDelegateHandle OnAssetRenamedHandle;
	FDelegateHandle OnAssetUpdatedHandle;
	FDelegateHandle OnFilesLoadedHandle;

	static FMCPProjectIndex* Instance;
};

