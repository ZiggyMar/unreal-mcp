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
	Result->SetStringField(TEXT("type"), Node->GetClass()->GetName());
	Result->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::FullTitle).ToString());
	Result->SetStringField(TEXT("comment"), Node->NodeComment);
	Result->SetBoolField(TEXT("enabled"), Node->IsNodeEnabled());

	TArray<TSharedPtr<FJsonValue>> PinArray;
	for (UEdGraphPin* Pin : Node->Pins)
	{
		if (!Pin)
		{
			continue;
		}
		TSharedRef<FJsonObject> PinEntry = MakeShared<FJsonObject>();
		PinEntry->SetStringField(TEXT("name"), Pin->PinName.ToString());
		PinEntry->SetStringField(TEXT("direction"), Pin->Direction == EGPD_Input ? TEXT("in") : TEXT("out"));
		PinEntry->SetStringField(TEXT("category"), Pin->PinType.PinCategory.ToString());
		if (Pin->PinType.PinSubCategoryObject.IsValid())
		{
			PinEntry->SetStringField(TEXT("subCategory"), Pin->PinType.PinSubCategoryObject->GetName());
		}
		PinEntry->SetStringField(TEXT("defaultValue"), Pin->DefaultValue);
		PinEntry->SetBoolField(TEXT("isArray"), Pin->PinType.IsArray());

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
	Result->SetArrayField(TEXT("pins"), PinArray);

	return MakeOkResponse(Result);
}

// =============================== Milestone 2 ===============================

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateBlueprint(const TSharedPtr<FJsonObject>& Params)
{
	FString PackagePath, ParentClassName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("packagePath"), PackagePath) ||
		!Params->TryGetStringField(TEXT("parentClass"), ParentClassName))
	{
		return MakeErrorResponse(TEXT("missing_param: packagePath and parentClass are required"));
	}

	bool bSave = true;
	if (Params->HasField(TEXT("save")))
	{
		bSave = Params->GetBoolField(TEXT("save"));
	}

	if (FPackageName::DoesPackageExist(PackagePath))
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_already_exists: %s"), *PackagePath));
	}

	FString ClassError;
	UClass* ParentClass = ResolveClassByName(ParentClassName, ClassError);
	if (!ParentClass)
	{
		return MakeErrorResponse(ClassError);
	}

	if (!FKismetEditorUtilities::CanCreateBlueprintOfClass(ParentClass))
	{
		return MakeErrorResponse(FString::Printf(TEXT("class_not_blueprintable: %s"), *ParentClass->GetName()));
	}

	const FString AssetName = FPackageName::GetShortName(PackagePath);
	UPackage* Package = CreatePackage(*PackagePath);
	if (!Package)
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_creation_failed: %s"), *PackagePath));
	}

	UBlueprint* NewBlueprint = FKismetEditorUtilities::CreateBlueprint(
		ParentClass,
		Package,
		FName(*AssetName),
		BPTYPE_Normal,
		UBlueprint::StaticClass(),
		UBlueprintGeneratedClass::StaticClass(),
		FName("MCPBridge"));

	if (!NewBlueprint)
	{
		return MakeErrorResponse(TEXT("create_blueprint_failed"));
	}

	FAssetRegistryModule::AssetCreated(NewBlueprint);
	Package->MarkPackageDirty();

	bool bSaved = false;
	FString SaveError;
	if (bSave)
	{
		bSaved = SaveBlueprintPackage(NewBlueprint, SaveError);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), NewBlueprint->GetPathName());
	Result->SetStringField(TEXT("name"), AssetName);
	Result->SetStringField(TEXT("parentClass"), ParentClass->GetName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	if (bSave && !bSaved)
	{
		Result->SetStringField(TEXT("saveError"), SaveError);
	}
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleAddNode(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName, NodeType;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName) ||
		!Params->TryGetStringField(TEXT("nodeType"), NodeType))
	{
		return MakeErrorResponse(TEXT("missing_param: path, graphName and nodeType are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FString GraphError;
	UEdGraph* Graph = FindGraphByName(Blueprint, GraphName, GraphError);
	if (!Graph)
	{
		return MakeErrorResponse(GraphError);
	}

	double PosX = 0.0;
	double PosY = 0.0;
	if (Params->HasField(TEXT("x")))
	{
		PosX = Params->GetNumberField(TEXT("x"));
	}
	if (Params->HasField(TEXT("y")))
	{
		PosY = Params->GetNumberField(TEXT("y"));
	}

	UEdGraphNode* NewNode = nullptr;

	if (NodeType == TEXT("Event"))
	{
		FString EventName;
		if (!Params->TryGetStringField(TEXT("eventName"), EventName))
		{
			return MakeErrorResponse(TEXT("missing_param: eventName is required for nodeType=Event"));
		}
		UClass* ParentClass = Blueprint->ParentClass;
		UFunction* EventFunc = ParentClass ? ParentClass->FindFunctionByName(FName(*EventName)) : nullptr;
		if (!EventFunc)
		{
			return MakeErrorResponse(FString::Printf(TEXT("event_function_not_found: %s on %s"),
				*EventName, ParentClass ? *ParentClass->GetName() : TEXT("(no parent class)")));
		}

		// An override event node for a given function is unique per graph. The real Blueprint
		// editor focuses the existing node rather than creating a duplicate when you re-add the
		// same event. This matters even on a freshly-created Blueprint: new Actor-derived
		// Blueprints can already come with pre-populated stub event nodes (e.g. BeginPlay/Tick),
		// so a naive unconditional-create duplicates them on the very first add_node call.
		for (UEdGraphNode* ExistingNode : Graph->Nodes)
		{
			UK2Node_Event* ExistingEvent = Cast<UK2Node_Event>(ExistingNode);
			if (ExistingEvent && ExistingEvent->bOverrideFunction && ExistingEvent->EventReference.GetMemberName() == FName(*EventName))
			{
				const int32 ExistingIndex = Graph->Nodes.IndexOfByKey(ExistingEvent);
				TSharedRef<FJsonObject> ExistingResult = MakeShared<FJsonObject>();
				ExistingResult->SetStringField(TEXT("id"), ExistingIndex != INDEX_NONE ? MakeNodeId(ExistingIndex) : TEXT("?"));
				ExistingResult->SetStringField(TEXT("type"), ExistingEvent->GetClass()->GetName());
				ExistingResult->SetStringField(TEXT("title"), ExistingEvent->GetNodeTitle(ENodeTitleType::ListView).ToString());
				ExistingResult->SetBoolField(TEXT("alreadyExisted"), true);
				return MakeOkResponse(ExistingResult);
			}
		}

		UK2Node_Event* EventNode = NewObject<UK2Node_Event>(Graph);
		EventNode->EventReference.SetExternalMember(FName(*EventName), ParentClass);
		EventNode->bOverrideFunction = true;
		NewNode = EventNode;
	}
	else if (NodeType == TEXT("CustomEvent"))
	{
		FString EventName;
		if (!Params->TryGetStringField(TEXT("eventName"), EventName))
		{
			return MakeErrorResponse(TEXT("missing_param: eventName is required for nodeType=CustomEvent"));
		}
		UK2Node_CustomEvent* CustomEventNode = NewObject<UK2Node_CustomEvent>(Graph);
		CustomEventNode->CustomFunctionName = FBlueprintEditorUtils::FindUniqueKismetName(Blueprint, EventName);
		NewNode = CustomEventNode;
	}
	else if (NodeType == TEXT("CallFunction"))
	{
		FString FunctionName, ClassName;
		Params->TryGetStringField(TEXT("functionName"), FunctionName);
		Params->TryGetStringField(TEXT("className"), ClassName);
		if (FunctionName.IsEmpty())
		{
			return MakeErrorResponse(TEXT("missing_param: functionName is required for nodeType=CallFunction"));
		}

		UClass* OwnerClass = Blueprint->ParentClass;
		if (!ClassName.IsEmpty())
		{
			FString ClassError;
			OwnerClass = ResolveClassByName(ClassName, ClassError);
			if (!OwnerClass)
			{
				return MakeErrorResponse(ClassError);
			}
		}
		else if (Blueprint->GeneratedClass)
		{
			OwnerClass = Blueprint->GeneratedClass;
		}

		UFunction* Function = OwnerClass ? OwnerClass->FindFunctionByName(FName(*FunctionName)) : nullptr;
		if (!Function)
		{
			return MakeErrorResponse(FString::Printf(TEXT("function_not_found: %s on %s"),
				*FunctionName, OwnerClass ? *OwnerClass->GetName() : TEXT("(no class)")));
		}

		UK2Node_CallFunction* CallNode = NewObject<UK2Node_CallFunction>(Graph);
		CallNode->SetFromFunction(Function);
		NewNode = CallNode;
	}
	else if (NodeType == TEXT("VariableGet") || NodeType == TEXT("VariableSet"))
	{
		FString VariableName;
		if (!Params->TryGetStringField(TEXT("variableName"), VariableName))
		{
			return MakeErrorResponse(FString::Printf(TEXT("missing_param: variableName is required for nodeType=%s"), *NodeType));
		}

		const FName VarFName(*VariableName);
		bool bFoundVar = false;
		for (const FBPVariableDescription& ExistingVar : Blueprint->NewVariables)
		{
			if (ExistingVar.VarName == VarFName)
			{
				bFoundVar = true;
				break;
			}
		}
		if (!bFoundVar)
		{
			return MakeErrorResponse(FString::Printf(
				TEXT("variable_not_found: %s (only this Blueprint's own variables are supported, not inherited ones)"),
				*VariableName));
		}

		if (NodeType == TEXT("VariableGet"))
		{
			UK2Node_VariableGet* GetNode = NewObject<UK2Node_VariableGet>(Graph);
			GetNode->VariableReference.SetSelfMember(VarFName);
			NewNode = GetNode;
		}
		else
		{
			UK2Node_VariableSet* SetNode = NewObject<UK2Node_VariableSet>(Graph);
			SetNode->VariableReference.SetSelfMember(VarFName);
			NewNode = SetNode;
		}
	}
	else
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("unknown_node_type: %s (expected Event, CustomEvent, CallFunction, VariableGet, VariableSet)"), *NodeType));
	}

	NewNode->NodePosX = PosX;
	NewNode->NodePosY = PosY;
	Graph->AddNode(NewNode, /*bIsUserAction=*/true, /*bSelectNewNode=*/false);
	NewNode->CreateNewGuid();
	NewNode->PostPlacedNewNode();
	NewNode->AllocateDefaultPins();

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	const int32 NewIndex = Graph->Nodes.IndexOfByKey(NewNode);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("id"), NewIndex != INDEX_NONE ? MakeNodeId(NewIndex) : TEXT("?"));
	Result->SetStringField(TEXT("type"), NewNode->GetClass()->GetName());
	Result->SetStringField(TEXT("title"), NewNode->GetNodeTitle(ENodeTitleType::ListView).ToString());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleConnectPins(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName, SourceNodeId, SourcePinName, TargetNodeId, TargetPinName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName) ||
		!Params->TryGetStringField(TEXT("sourceNodeId"), SourceNodeId) ||
		!Params->TryGetStringField(TEXT("sourcePin"), SourcePinName) ||
		!Params->TryGetStringField(TEXT("targetNodeId"), TargetNodeId) ||
		!Params->TryGetStringField(TEXT("targetPin"), TargetPinName))
	{
		return MakeErrorResponse(TEXT("missing_param: path, graphName, sourceNodeId, sourcePin, targetNodeId, targetPin are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FString GraphError;
	UEdGraph* Graph = FindGraphByName(Blueprint, GraphName, GraphError);
	if (!Graph)
	{
		return MakeErrorResponse(GraphError);
	}

	FString NodeError;
	UEdGraphNode* SourceNode = FindNodeById(Graph, SourceNodeId, NodeError);
	if (!SourceNode)
	{
		return MakeErrorResponse(NodeError);
	}
	UEdGraphNode* TargetNode = FindNodeById(Graph, TargetNodeId, NodeError);
	if (!TargetNode)
	{
		return MakeErrorResponse(NodeError);
	}

	UEdGraphPin* SourcePin = SourceNode->FindPin(FName(*SourcePinName), EGPD_Output);
	if (!SourcePin)
	{
		return MakeErrorResponse(FString::Printf(TEXT("pin_not_found: output pin '%s' on node %s"), *SourcePinName, *SourceNodeId));
	}

	UEdGraphPin* TargetPin = TargetNode->FindPin(FName(*TargetPinName), EGPD_Input);
	if (!TargetPin)
	{
		return MakeErrorResponse(FString::Printf(TEXT("pin_not_found: input pin '%s' on node %s"), *TargetPinName, *TargetNodeId));
	}

	const UEdGraphSchema* Schema = Graph->GetSchema();
	const FPinConnectionResponse ConnectResponse = Schema->CanCreateConnection(SourcePin, TargetPin);
	if (ConnectResponse.Response == CONNECT_RESPONSE_DISALLOW)
	{
		return MakeErrorResponse(FString::Printf(TEXT("incompatible_pins: %s"), *ConnectResponse.Message.ToString()));
	}

	const bool bConnected = Schema->TryCreateConnection(SourcePin, TargetPin);
	if (!bConnected)
	{
		return MakeErrorResponse(TEXT("connect_failed"));
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("connected"), true);
	if (!ConnectResponse.Message.IsEmpty())
	{
		Result->SetStringField(TEXT("note"), ConnectResponse.Message.ToString());
	}
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSetPinDefaultValue(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName, NodeId, PinName, Value;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName) ||
		!Params->TryGetStringField(TEXT("nodeId"), NodeId) ||
		!Params->TryGetStringField(TEXT("pinName"), PinName) ||
		!Params->TryGetStringField(TEXT("value"), Value))
	{
		return MakeErrorResponse(TEXT("missing_param: path, graphName, nodeId, pinName, value are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FString GraphError;
	UEdGraph* Graph = FindGraphByName(Blueprint, GraphName, GraphError);
	if (!Graph)
	{
		return MakeErrorResponse(GraphError);
	}

	FString NodeError;
	UEdGraphNode* Node = FindNodeById(Graph, NodeId, NodeError);
	if (!Node)
	{
		return MakeErrorResponse(NodeError);
	}

	UEdGraphPin* Pin = Node->FindPin(FName(*PinName), EGPD_Input);
	if (!Pin)
	{
		return MakeErrorResponse(FString::Printf(TEXT("pin_not_found: input pin '%s' on node %s"), *PinName, *NodeId));
	}
