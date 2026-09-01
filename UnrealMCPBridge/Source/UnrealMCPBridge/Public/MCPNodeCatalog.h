#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/** One parameter (or the return value) of a Blueprint-callable function. */
struct FMCPCatalogParam
{
	FString Name;
	FString Type;
	FString DefaultValue;
	bool bIsReturn = false;
	bool bIsOutput = false;
};

/**
 * One Blueprint-callable function, as the engine actually reflects it. Every field here
 * comes from real reflection data on the installed engine version, never from a hardcoded
 * table, so it is correct for whatever version is running.
 */
struct FMCPCatalogFunction
{
	FString Name;           // UFunction name as add_node expects it, e.g. "PrintString"
	FString DisplayName;    // Editor-facing name, e.g. "Print String"
	FString OwnerClass;     // Short class name, e.g. "KismetSystemLibrary"
	FString OwnerClassPath; // Full path for add_node's className, e.g. "/Script/Engine.KismetSystemLibrary"
	FString Category;       // Blueprint category metadata, if any
	FString Tooltip;        // First line of the tooltip metadata, truncated
	FString Keywords;       // Search keywords metadata, if any
	bool bPure = false;
	bool bStatic = false;
	TArray<FMCPCatalogParam> Params;

	// The name split into lowercase words, computed once when the catalog is built.
	//
	// Searching used to compare raw strings, which meant the separator decided the answer: a model
	// asking for "Array Length" - what the editor puts on the node - missed Array_Length entirely,
	// because a space is not an underscore. Words make the two spellings the same question.
	TArray<FString> NameWords;    // "Array_Length" -> ["array", "length"]
	TArray<FString> DisplayWords; // "Print String" -> ["print", "string"]
};

/**
 * Searchable catalog of every Blueprint-callable function the running editor exposes,
 * built by walking UClass/UFunction reflection data directly.
 *
 * The problem this exists to solve: a model writing Blueprint logic does not reliably know
 * a given engine version's exact function names, pin names, or signatures, and no amount of
 * general training fixes that. Reading the engine's own reflection data sidesteps the
 * question entirely.
 *
 * Unlike FMCPProjectIndex this needs no on-disk cache. Building it is a pure reflection
 * walk over already-loaded classes and loads no assets, so a rebuild is cheap enough to do
 * lazily once per session. It is also why there is no incremental-update path here: the
 * catalog is rebuilt on demand rather than kept in sync.
 *
 * Runs entirely on the game thread, like everything else in this plugin.
 */
class FMCPNodeCatalog
{
public:
	static void Initialize();
	static void Shutdown();
	static FMCPNodeCatalog& Get();

	// Builds the catalog if it has not been built yet this session. Cheap to call repeatedly.
	void EnsureBuilt();

	// Forces a full reflection rescan, replacing Functions.
	void RebuildFull();

	// Ranked search over function names, display names, owning class, and keywords.
	// Ordering is exact, then prefix, then contains, matching search_project's convention.
	// Returns compact hit objects; never returns the whole catalog.
	TArray<TSharedPtr<FJsonValue>> Search(const FString& Query, int32 MaxResults) const;

	// Full signature for one function. ClassNameOrPath may be empty to search every class,
	// in which case the first exact name match wins. Returns null if not found.
	TSharedPtr<FJsonObject> FindSignature(const FString& FunctionName, const FString& ClassNameOrPath) const;

	// Near-miss suggestions for a name that did not resolve, so add_node can fail with a
	// usable hint instead of a dead end. Case-insensitive prefix/substring/edit-distance.
	TArray<TSharedPtr<FJsonValue>> SuggestSimilar(const FString& FunctionName, int32 MaxResults) const;

	int32 GetFunctionCount() const { return Functions.Num(); }
	bool IsBuilt() const { return bBuilt; }

private:
	FMCPNodeCatalog() = default;

	static bool ShouldIncludeFunction(const UFunction* Func);
	static FMCPCatalogFunction MakeEntry(const UFunction* Func, const UClass* OwnerClass);
	static TSharedRef<FJsonObject> FunctionToJson(const FMCPCatalogFunction& Fn, bool bIncludeParams);

	TArray<FMCPCatalogFunction> Functions;
	bool bBuilt = false;

	static FMCPNodeCatalog* Instance;
};
