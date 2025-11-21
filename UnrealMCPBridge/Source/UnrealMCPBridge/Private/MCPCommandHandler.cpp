#include "MCPCommandHandler.h"
#include "MCPProjectIndex.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/AssetData.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "EdGraph/EdGraphSchema.h"
#include "EdGraphSchema_K2.h"
#include "K2Node_Event.h"
#include "K2Node_CustomEvent.h"
#include "K2Node_CallFunction.h"
#include "K2Node_VariableGet.h"
#include "K2Node_VariableSet.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Logging/TokenizedMessage.h"
#include "Dom/JsonValue.h"
#include "Modules/ModuleManager.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"
#include "Misc/PackageName.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPCommandHandler, Log, All);

namespace
{
	TSharedRef<FJsonObject> MakeOkResponse(const TSharedPtr<FJsonObject>& Result)
	{
		TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("ok"), true);
		Response->SetObjectField(TEXT("result"), Result);
		return Response;
	}

	TSharedRef<FJsonObject> MakeErrorResponse(const FString& Message)
	{
		TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("ok"), false);
		Response->SetStringField(TEXT("error"), Message);
		return Response;
	}

	// Stable-ish node id: index within the graph's Nodes array, as a string.
	// Sufficient for a single-session read/detail/edit round trip; not persisted.
	FString MakeNodeId(int32 Index)
	{
		return FString::Printf(TEXT("n%d"), Index);
	}

	// Saves a Blueprint's package to disk in place. Used by create_blueprint (when
	// save=true, the default) and save_blueprint.
	bool SaveBlueprintPackage(UBlueprint* Blueprint, FString& OutError)
	{
		if (!Blueprint)
		{
			OutError = TEXT("null_blueprint");
			return false;
		}

		UPackage* Package = Blueprint->GetOutermost();
		Package->MarkPackageDirty();

		const FString PackageFileName = FPackageName::LongPackageNameToFilename(
			Package->GetName(), FPackageName::GetAssetPackageExtension());

		FSavePackageArgs SaveArgs;
		SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;

		const bool bSaved = UPackage::SavePackage(Package, Blueprint, *PackageFileName, SaveArgs);
		if (!bSaved)
		{
			OutError = FString::Printf(TEXT("save_failed: %s"), *PackageFileName);
		}
		return bSaved;
	}
}

UBlueprint* FMCPCommandHandler::LoadBlueprintByPath(const FString& Path, FString& OutError)
{
	UObject* Asset = StaticLoadObject(UBlueprint::StaticClass(), nullptr, *Path);
	UBlueprint* Blueprint = Cast<UBlueprint>(Asset);
	if (!Blueprint)
	{
		OutError = FString::Printf(TEXT("blueprint_not_found: %s"), *Path);
	}
	return Blueprint;
}

UEdGraph* FMCPCommandHandler::FindGraphByName(UBlueprint* Blueprint, const FString& GraphName, FString& OutError)
{
	TArray<UEdGraph*> AllGraphs;
	Blueprint->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		if (Graph && Graph->GetName() == GraphName)
		{
			return Graph;
		}
	}
	OutError = FString::Printf(TEXT("graph_not_found: %s"), *GraphName);
	return nullptr;
}

UEdGraphNode* FMCPCommandHandler::FindNodeById(UEdGraph* Graph, const FString& NodeId, FString& OutError)
{
	int32 NodeIndex = INDEX_NONE;
	if (NodeId.StartsWith(TEXT("n")))
	{
		LexFromString(NodeIndex, *NodeId.Mid(1));
	}
	if (!Graph->Nodes.IsValidIndex(NodeIndex))
	{
		OutError = FString::Printf(TEXT("node_not_found: %s"), *NodeId);
		return nullptr;
	}
	return Graph->Nodes[NodeIndex];
}

UClass* FMCPCommandHandler::ResolveClassByName(const FString& ClassName, FString& OutError)
{
