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
	if (ClassName.IsEmpty())
	{
		OutError = TEXT("empty_class_name");
		return nullptr;
	}

	// Full path form, e.g. "/Script/Engine.Actor" or "/Game/BP_Base.BP_Base_C".
	if (ClassName.StartsWith(TEXT("/")))
	{
		UClass* Found = LoadObject<UClass>(nullptr, *ClassName);
		if (!Found)
		{
			OutError = FString::Printf(TEXT("class_not_found: %s"), *ClassName);
		}
		return Found;
	}

	// Short name form ("Actor", "Pawn", "ActorComponent"): try native prefixes, then bare name.
	static const TCHAR* Prefixes[] = { TEXT("A"), TEXT("U"), TEXT("") };
	for (const TCHAR* Prefix : Prefixes)
	{
		const FString Candidate = FString(Prefix) + ClassName;
		if (UClass* Found = FindFirstObject<UClass>(*Candidate, EFindFirstObjectOptions::None, ELogVerbosity::NoLogging))
		{
			return Found;
		}
	}

	OutError = FString::Printf(
		TEXT("class_not_found: %s (tried short name and A/U prefixes; try a full path like /Script/Engine.%s)"),
		*ClassName, *ClassName);
	return nullptr;
}

bool FMCPCommandHandler::ResolvePinType(const FString& TypeStr, FEdGraphPinType& OutType, FString& OutError)
{
	OutType.PinSubCategory = NAME_None;
	OutType.PinSubCategoryObject = nullptr;
	OutType.ContainerType = EPinContainerType::None;
	OutType.bIsReference = false;

	const FString Lower = TypeStr.ToLower();

	if (Lower == TEXT("bool") || Lower == TEXT("boolean"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Boolean;
	}
	else if (Lower == TEXT("byte"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Byte;
	}
	else if (Lower == TEXT("int") || Lower == TEXT("int32") || Lower == TEXT("integer"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Int;
	}
	else if (Lower == TEXT("int64"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Int64;
	}
	else if (Lower == TEXT("float"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Real;
		OutType.PinSubCategory = UEdGraphSchema_K2::PC_Float;
	}
	else if (Lower == TEXT("double") || Lower == TEXT("real"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Real;
		OutType.PinSubCategory = UEdGraphSchema_K2::PC_Double;
	}
	else if (Lower == TEXT("string"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_String;
	}
	else if (Lower == TEXT("name"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Name;
	}
	else if (Lower == TEXT("text"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Text;
	}
	else if (Lower == TEXT("vector"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Struct;
		OutType.PinSubCategoryObject = FindObject<UScriptStruct>(nullptr, TEXT("/Script/CoreUObject.Vector"));
	}
	else if (Lower == TEXT("rotator"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Struct;
		OutType.PinSubCategoryObject = FindObject<UScriptStruct>(nullptr, TEXT("/Script/CoreUObject.Rotator"));
	}
	else if (Lower == TEXT("transform"))
	{
		OutType.PinCategory = UEdGraphSchema_K2::PC_Struct;
		OutType.PinSubCategoryObject = FindObject<UScriptStruct>(nullptr, TEXT("/Script/CoreUObject.Transform"));
	}
	else if (Lower.StartsWith(TEXT("object:")))
	{
		const FString ClassName = TypeStr.Mid(7);
		FString ClassError;
		UClass* Class = ResolveClassByName(ClassName, ClassError);
		if (!Class)
		{
			OutError = ClassError;
			return false;
		}
		OutType.PinCategory = UEdGraphSchema_K2::PC_Object;
		OutType.PinSubCategoryObject = Class;
	}
	else if (Lower.StartsWith(TEXT("class:")))
	{
		const FString ClassName = TypeStr.Mid(6);
		FString ClassError;
		UClass* Class = ResolveClassByName(ClassName, ClassError);
		if (!Class)
		{
			OutError = ClassError;
			return false;
		}
		OutType.PinCategory = UEdGraphSchema_K2::PC_Class;
		OutType.PinSubCategoryObject = Class;
	}
	else
	{
		OutError = FString::Printf(
			TEXT("unknown_type: %s (supported: bool, byte, int, int64, float, double, string, name, text, ")
			TEXT("vector, rotator, transform, object:<Class>, class:<Class>)"),
			*TypeStr);
		return false;
	}

	const bool bNeedsSubCategoryObject =
		OutType.PinCategory == UEdGraphSchema_K2::PC_Struct ||
		OutType.PinCategory == UEdGraphSchema_K2::PC_Object ||
		OutType.PinCategory == UEdGraphSchema_K2::PC_Class;
	if (bNeedsSubCategoryObject && !OutType.PinSubCategoryObject.IsValid())
	{
		OutError = FString::Printf(TEXT("type_resolution_failed: %s"), *TypeStr);
		return false;
	}

	return true;
}

TSharedRef<FJsonObject> FMCPCommandHandler::Dispatch(const TSharedRef<FJsonObject>& Request)
{
	const FString Cmd = Request->GetStringField(TEXT("cmd"));
	const TSharedPtr<FJsonObject>* ParamsPtr = nullptr;
	TSharedPtr<FJsonObject> Params;
	if (Request->TryGetObjectField(TEXT("params"), ParamsPtr))
	{
		Params = *ParamsPtr;
	}

	TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();

	if (Cmd == TEXT("ping"))
	{
		Response = HandlePing(Params);
	}
	else if (Cmd == TEXT("list_blueprints"))
	{
		Response = HandleListBlueprints(Params);
	}
	else if (Cmd == TEXT("list_blueprint_graphs"))
	{
		Response = HandleListBlueprintGraphs(Params);
	}
	else if (Cmd == TEXT("read_blueprint_graph_summary"))
	{
		Response = HandleReadBlueprintGraphSummary(Params);
	}
	else if (Cmd == TEXT("read_blueprint_node_detail"))
	{
		Response = HandleReadBlueprintNodeDetail(Params);
	}
	else if (Cmd == TEXT("create_blueprint"))
	{
		Response = HandleCreateBlueprint(Params);
	}
	else if (Cmd == TEXT("add_node"))
	{
		Response = HandleAddNode(Params);
	}
	else if (Cmd == TEXT("connect_pins"))
	{
		Response = HandleConnectPins(Params);
	}
	else if (Cmd == TEXT("set_pin_default_value"))
	{
		Response = HandleSetPinDefaultValue(Params);
	}
	else if (Cmd == TEXT("remove_node"))
	{
		Response = HandleRemoveNode(Params);
	}
	else if (Cmd == TEXT("add_variable"))
	{
		Response = HandleAddVariable(Params);
	}
	else if (Cmd == TEXT("compile_blueprint"))
	{
		Response = HandleCompileBlueprint(Params);
	}
	else if (Cmd == TEXT("save_blueprint"))
	{
		Response = HandleSaveBlueprint(Params);
	}
	else if (Cmd == TEXT("search_project"))
	{
		Response = HandleSearchProject(Params);
	}
	else if (Cmd == TEXT("find_references"))
	{
		Response = HandleFindReferences(Params);
	}
	else if (Cmd == TEXT("get_project_overview"))
	{
		Response = HandleGetProjectOverview(Params);
	}
	else
	{
		Response = MakeErrorResponse(FString::Printf(TEXT("unknown_cmd: %s"), *Cmd));
	}

	// Echo the request id back so the client can correlate async-ish pipelines.
	TSharedPtr<FJsonValue> IdValue = Request->TryGetField(TEXT("id"));
	if (IdValue.IsValid())
	{
		Response->SetField(TEXT("id"), IdValue);
	}

	return Response;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandlePing(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("status"), TEXT("ok"));
	Result->SetStringField(TEXT("plugin"), TEXT("UnrealMCPBridge"));
	Result->SetNumberField(TEXT("protocolVersion"), 1);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListBlueprints(const TSharedPtr<FJsonObject>& Params)
{
	FString PathFilter;
	if (Params.IsValid())
	{
		Params->TryGetStringField(TEXT("pathPrefix"), PathFilter);
	}

	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

	FARFilter Filter;
	Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
	Filter.bRecursiveClasses = true;
	if (!PathFilter.IsEmpty())
	{
		Filter.PackagePaths.Add(FName(*PathFilter));
		Filter.bRecursivePaths = true;
	}
	else
	{
		Filter.PackagePaths.Add(FName(TEXT("/Game")));
		Filter.bRecursivePaths = true;
	}

	TArray<FAssetData> Assets;
	AssetRegistry.GetAssets(Filter, Assets);

	TArray<TSharedPtr<FJsonValue>> BlueprintArray;
	for (const FAssetData& Asset : Assets)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Asset.AssetName.ToString());
		Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());

		FString ParentClass;
		if (Asset.GetTagValue(FName(TEXT("ParentClass")), ParentClass))
		{
			// Tag value is usually a full object path like "/Script/Engine.Actor", so trim to short name.
			int32 DotIndex;
			if (ParentClass.FindLastChar(TEXT('.'), DotIndex))
			{
				ParentClass = ParentClass.Mid(DotIndex + 1);
			}
			Entry->SetStringField(TEXT("parentClass"), ParentClass);
		}
		else
		{
			Entry->SetStringField(TEXT("parentClass"), TEXT("Unknown"));
		}

		BlueprintArray.Add(MakeShared<FJsonValueObject>(Entry));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("blueprints"), BlueprintArray);
	Result->SetNumberField(TEXT("count"), BlueprintArray.Num());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListBlueprintGraphs(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return MakeErrorResponse(TEXT("missing_param: path"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	TArray<UEdGraph*> AllGraphs;
	Blueprint->GetAllGraphs(AllGraphs);

	TArray<TSharedPtr<FJsonValue>> GraphArray;
	for (UEdGraph* Graph : AllGraphs)
	{
		if (!Graph)
		{
			continue;
		}
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Graph->GetName());
		Entry->SetNumberField(TEXT("nodeCount"), Graph->Nodes.Num());
		GraphArray.Add(MakeShared<FJsonValueObject>(Entry));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Path);
	Result->SetArrayField(TEXT("graphs"), GraphArray);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleReadBlueprintGraphSummary(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName))
	{
		return MakeErrorResponse(TEXT("missing_param: path and graphName are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FString GraphError;
	UEdGraph* TargetGraph = FindGraphByName(Blueprint, GraphName, GraphError);
	if (!TargetGraph)
	{
		return MakeErrorResponse(GraphError);
	}

	TArray<TSharedPtr<FJsonValue>> NodeArray;
	for (int32 i = 0; i < TargetGraph->Nodes.Num(); ++i)
	{
		UEdGraphNode* Node = TargetGraph->Nodes[i];
		if (!Node)
		{
			continue;
		}

		TSharedRef<FJsonObject> NodeEntry = MakeShared<FJsonObject>();
		NodeEntry->SetStringField(TEXT("id"), MakeNodeId(i));
		NodeEntry->SetStringField(TEXT("type"), Node->GetClass()->GetName());
		NodeEntry->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());

		// Compact pin connection summary: for each pin, who it connects to (node index + pin name).
		TArray<TSharedPtr<FJsonValue>> PinArray;
		for (UEdGraphPin* Pin : Node->Pins)
		{
			if (!Pin || Pin->LinkedTo.Num() == 0)
			{
				continue; // omit unconnected pins entirely to keep this compact
			}
			TSharedRef<FJsonObject> PinEntry = MakeShared<FJsonObject>();
			PinEntry->SetStringField(TEXT("pin"), Pin->PinName.ToString());
			PinEntry->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("in") : TEXT("out"));

			TArray<TSharedPtr<FJsonValue>> Links;
			for (UEdGraphPin* Linked : Pin->LinkedTo)
			{
				if (!Linked || !Linked->GetOwningNode())
				{
					continue;
				}
				int32 LinkedIndex = TargetGraph->Nodes.IndexOfByKey(Linked->GetOwningNode());
				TSharedRef<FJsonObject> LinkEntry = MakeShared<FJsonObject>();
				LinkEntry->SetStringField(TEXT("node"), LinkedIndex != INDEX_NONE ? MakeNodeId(LinkedIndex) : TEXT("?"));
				LinkEntry->SetStringField(TEXT("pin"), Linked->PinName.ToString());
				Links.Add(MakeShared<FJsonValueObject>(LinkEntry));
			}
			PinEntry->SetArrayField(TEXT("linkedTo"), Links);
			PinArray.Add(MakeShared<FJsonValueObject>(PinEntry));
		}
		NodeEntry->SetArrayField(TEXT("connectedPins"), PinArray);

		NodeArray.Add(MakeShared<FJsonValueObject>(NodeEntry));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Path);
	Result->SetStringField(TEXT("graphName"), GraphName);
	Result->SetArrayField(TEXT("nodes"), NodeArray);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleReadBlueprintNodeDetail(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName, NodeId;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName) ||
		!Params->TryGetStringField(TEXT("nodeId"), NodeId))
	{
		return MakeErrorResponse(TEXT("missing_param: path, graphName and nodeId are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FString GraphError;
	UEdGraph* TargetGraph = FindGraphByName(Blueprint, GraphName, GraphError);
	if (!TargetGraph)
	{
		return MakeErrorResponse(GraphError);
	}

	FString NodeError;
	UEdGraphNode* Node = FindNodeById(TargetGraph, NodeId, NodeError);
	if (!Node)
	{
		return MakeErrorResponse(NodeError);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("id"), NodeId);
