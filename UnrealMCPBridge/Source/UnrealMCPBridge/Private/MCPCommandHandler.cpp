#include "MCPCommandHandler.h"
#include "MCPProjectIndex.h"
#include "MCPNodeCatalog.h"

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
#include "K2Node_IfThenElse.h"
#include "K2Node_ExecutionSequence.h"
#include "K2Node_DynamicCast.h"
#include "K2Node_MacroInstance.h"
#include "K2Node_FunctionEntry.h"
#include "K2Node_FunctionResult.h"
#include "K2Node_InputKey.h"
#include "K2Node_InputAxisEvent.h"
#include "K2Node_Self.h"
#include "EdGraphNode_Comment.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "Factories/WorldFactory.h"
#include "Engine/World.h"
#include "GameFramework/WorldSettings.h"
#include "GameMapsSettings.h"
#include "GameFramework/InputSettings.h"
#include "Settings/LevelEditorPlaySettings.h"
#include "Editor.h"
#include "Engine/SimpleConstructionScript.h"
#include "Engine/SCS_Node.h"
#include "InputCoreTypes.h"
#include "FileHelpers.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "WidgetBlueprint.h"
#include "Blueprint/WidgetBlueprintGeneratedClass.h"
#include "Blueprint/WidgetTree.h"
#include "Blueprint/UserWidget.h"
#include "Components/Widget.h"
#include "Components/PanelWidget.h"
#include "Components/PanelSlot.h"
#include "Components/CanvasPanel.h"
#include "Kismet2/StructureEditorUtils.h"
// StructureEditorUtils only forward-declares FStructVariableDescription; its definition lives here,
// at the same path on both 5.6 and 5.8.
#include "UserDefinedStructure/UserDefinedStructEditorData.h"
#include "Kismet2/EnumEditorUtils.h"
// StructUtils/ is the portable path: 5.6 still ships an Engine/UserDefinedStruct.h shim, 5.8 does
// not, so the obvious include compiles on the older engine and fails on the newer one.
#include "StructUtils/UserDefinedStruct.h"
#include "Engine/UserDefinedEnum.h"
#include "ObjectTools.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Logging/TokenizedMessage.h"
#include "ScopedTransaction.h"
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

	// Node id: the node's own FGuid. UEdGraphNode::NodeGuid is a UPROPERTY, so it is
	// serialized with the asset, and Epic's stated purpose for it is uniquely identifying
	// a node. That makes it stable across editor restarts and, critically, unaffected by
	// removing other nodes in the same graph. The previous scheme was the node's index
	// into UEdGraph::Nodes, which silently invalidated every later id on any removal.
	FString MakeNodeId(const UEdGraphNode* Node)
	{
		return (Node && Node->NodeGuid.IsValid())
			? Node->NodeGuid.ToString(EGuidFormats::Digits)
			: FString(TEXT("?"));
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
	if (!Graph)
	{
		OutError = TEXT("null_graph");
		return nullptr;
	}

	// Current form: the node's persistent GUID.
	FGuid ParsedGuid;
	if (FGuid::ParseExact(NodeId, EGuidFormats::Digits, ParsedGuid))
	{
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (Node && Node->NodeGuid == ParsedGuid)
			{
				return Node;
			}
		}
		OutError = FString::Printf(TEXT("node_not_found: %s"), *NodeId);
		return nullptr;
	}

	// Legacy form ("n<index>"), still accepted for one release so callers holding ids
	// issued by an older build keep working. Indices shift on removal, which is exactly
	// why ids moved to GUIDs; do not emit this form for anything new.
	if (NodeId.StartsWith(TEXT("n")))
	{
		int32 NodeIndex = INDEX_NONE;
		LexFromString(NodeIndex, *NodeId.Mid(1));
		if (Graph->Nodes.IsValidIndex(NodeIndex))
		{
			return Graph->Nodes[NodeIndex];
		}
	}

	OutError = FString::Printf(TEXT("node_not_found: %s"), *NodeId);
	return nullptr;
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
	else if (Lower.StartsWith(TEXT("struct:")))
	{
		const FString StructName = TypeStr.Mid(7);
		FString StructError;
		UScriptStruct* Struct = ResolveStructByName(StructName, StructError);
		if (!Struct)
		{
			OutError = StructError;
			return false;
		}
		OutType.PinCategory = UEdGraphSchema_K2::PC_Struct;
		OutType.PinSubCategoryObject = Struct;
	}
	else if (Lower.StartsWith(TEXT("enum:")))
	{
		const FString EnumName = TypeStr.Mid(5);
		FString EnumError;
		UEnum* Enum = ResolveEnumByName(EnumName, EnumError);
		if (!Enum)
		{
			OutError = EnumError;
			return false;
		}
		// Blueprint enum values are byte-typed with the UEnum as the subcategory object; the
		// schema maps PC_Enum onto PC_Byte anyway, so this is the form the editor itself produces.
		OutType.PinCategory = UEdGraphSchema_K2::PC_Byte;
		OutType.PinSubCategoryObject = Enum;
	}
	else
	{
		OutError = FString::Printf(
			TEXT("unknown_type: %s (supported: bool, byte, int, int64, float, double, string, name, text, ")
			TEXT("vector, rotator, transform, object:<Class>, class:<Class>, struct:<Struct>, enum:<Enum>)"),
			*TypeStr);
		return false;
	}

	// PC_Byte is deliberately absent here: a plain "byte" has no subcategory object, and an
	// "enum:<Name>" byte already had its object resolved above or returned an error.
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
	else if (Cmd == TEXT("find_node"))
	{
		Response = HandleFindNode(Params);
	}
	else if (Cmd == TEXT("get_node_signature"))
	{
		Response = HandleGetNodeSignature(Params);
	}
	else if (Cmd == TEXT("create_function"))
	{
		Response = HandleCreateFunction(Params);
	}
	else if (Cmd == TEXT("organize_graph"))
	{
		Response = HandleOrganizeGraph(Params);
	}
	else if (Cmd == TEXT("build_graph"))
	{
		Response = HandleBuildGraph(Params);
	}
	else if (Cmd == TEXT("list_assets"))
	{
		Response = HandleListAssets(Params);
	}
	else if (Cmd == TEXT("create_level"))
	{
		Response = HandleCreateLevel(Params);
	}
	else if (Cmd == TEXT("set_game_settings"))
	{
		Response = HandleSetGameSettings(Params);
	}
	else if (Cmd == TEXT("add_input_mapping"))
	{
		Response = HandleAddInputMapping(Params);
	}
	else if (Cmd == TEXT("start_pie"))
	{
		Response = HandleStartPie(Params);
	}
	else if (Cmd == TEXT("stop_pie"))
	{
		Response = HandleStopPie(Params);
	}
	else if (Cmd == TEXT("pie_status"))
	{
		Response = HandlePieStatus(Params);
	}
	else if (Cmd == TEXT("refresh_blueprint"))
	{
		Response = HandleRefreshBlueprint(Params);
	}
	else if (Cmd == TEXT("delete_asset"))
	{
		Response = HandleDeleteAsset(Params);
	}
	else if (Cmd == TEXT("open_level"))
	{
		Response = HandleOpenLevel(Params);
	}
	else if (Cmd == TEXT("spawn_actor"))
	{
		Response = HandleSpawnActor(Params);
	}
	else if (Cmd == TEXT("save_level"))
	{
		Response = HandleSaveLevel(Params);
	}
	else if (Cmd == TEXT("add_component"))
	{
		Response = HandleAddComponent(Params);
	}
	else if (Cmd == TEXT("list_components"))
	{
		Response = HandleListComponents(Params);
	}
	else if (Cmd == TEXT("set_component_property"))
	{
		Response = HandleSetComponentProperty(Params);
	}
	else if (Cmd == TEXT("set_class_default"))
	{
		Response = HandleSetClassDefault(Params);
	}
	else if (Cmd == TEXT("create_widget_blueprint"))
	{
		Response = HandleCreateWidgetBlueprint(Params);
	}
	else if (Cmd == TEXT("add_widget"))
	{
		Response = HandleAddWidget(Params);
	}
	else if (Cmd == TEXT("list_widgets"))
	{
		Response = HandleListWidgets(Params);
	}
	else if (Cmd == TEXT("set_widget_property"))
	{
		Response = HandleSetWidgetProperty(Params);
	}
	else if (Cmd == TEXT("create_struct"))
	{
		Response = HandleCreateStruct(Params);
	}
	else if (Cmd == TEXT("add_struct_field"))
	{
		Response = HandleAddStructField(Params);
	}
	else if (Cmd == TEXT("list_struct_fields"))
	{
		Response = HandleListStructFields(Params);
	}
	else if (Cmd == TEXT("create_enum"))
	{
		Response = HandleCreateEnum(Params);
	}
	else if (Cmd == TEXT("list_enum_entries"))
	{
		Response = HandleListEnumEntries(Params);
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
		NodeEntry->SetStringField(TEXT("id"), MakeNodeId(Node));
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
				TSharedRef<FJsonObject> LinkEntry = MakeShared<FJsonObject>();
				LinkEntry->SetStringField(TEXT("node"), MakeNodeId(Linked->GetOwningNode()));
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
	// Echo the canonical GUID rather than whatever form the caller passed, so a caller
	// still using a legacy "n<index>" id gets the stable one back and migrates naturally.
	Result->SetStringField(TEXT("id"), MakeNodeId(Node));
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
			TSharedRef<FJsonObject> LinkEntry = MakeShared<FJsonObject>();
			LinkEntry->SetStringField(TEXT("node"), MakeNodeId(Linked->GetOwningNode()));
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
	FString Path, GraphName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName))
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

	return AddNodeCore(Blueprint, Graph, Params, /*bOpenTransaction=*/true);
}

// The type-dispatching core of add_node, shared with build_graph. When the caller already
// holds a transaction (the batch path), bOpenTransaction is false so this does not nest one.
TSharedRef<FJsonObject> FMCPCommandHandler::AddNodeCore(UBlueprint* Blueprint, UEdGraph* Graph, const TSharedPtr<FJsonObject>& Params, bool bOpenTransaction)
{
	FString NodeType;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("nodeType"), NodeType))
	{
		return MakeErrorResponse(TEXT("missing_param: nodeType is required"));
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
				TSharedRef<FJsonObject> ExistingResult = MakeShared<FJsonObject>();
				ExistingResult->SetStringField(TEXT("id"), MakeNodeId(ExistingEvent));
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

		// Multiplayer RPCs: netMode Server/Multicast/Client plus reliable, the same flags
		// the details panel's Replicates dropdown sets. Without these a "multiplayer"
		// graph is single-player logic wearing a costume.
		FString NetMode;
		if (Params->TryGetStringField(TEXT("netMode"), NetMode) && !NetMode.IsEmpty())
		{
			if (NetMode == TEXT("Server"))
			{
				CustomEventNode->FunctionFlags |= FUNC_Net | FUNC_NetServer;
			}
			else if (NetMode == TEXT("Multicast"))
			{
				CustomEventNode->FunctionFlags |= FUNC_Net | FUNC_NetMulticast;
			}
			else if (NetMode == TEXT("Client"))
			{
				CustomEventNode->FunctionFlags |= FUNC_Net | FUNC_NetClient;
			}
			else
			{
				return MakeErrorResponse(FString::Printf(TEXT("unknown_netMode: %s (expected Server, Multicast, Client)"), *NetMode));
			}
			bool bReliable = false;
			Params->TryGetBoolField(TEXT("reliable"), bReliable);
			if (bReliable)
			{
				CustomEventNode->FunctionFlags |= FUNC_NetReliable;
			}
		}
		NewNode = CustomEventNode;
	}
	else if (NodeType == TEXT("InputKey"))
	{
		FString KeyName;
		if (!Params->TryGetStringField(TEXT("key"), KeyName))
		{
			return MakeErrorResponse(TEXT("missing_param: key is required for nodeType=InputKey (e.g. F, SpaceBar, LeftMouseButton)"));
		}
		const FKey Key(*KeyName);
		if (!Key.IsValid())
		{
			return MakeErrorResponse(FString::Printf(TEXT("unknown_key: %s"), *KeyName));
		}
		UK2Node_InputKey* InputNode = NewObject<UK2Node_InputKey>(Graph);
		InputNode->InputKey = Key;
		NewNode = InputNode;
	}
	else if (NodeType == TEXT("Self"))
	{
		// A reference to the owning instance, for comparisons and passing self around.
		NewNode = NewObject<UK2Node_Self>(Graph);
	}
	else if (NodeType == TEXT("InputAxis"))
	{
		FString AxisName;
		if (!Params->TryGetStringField(TEXT("axisName"), AxisName))
		{
			return MakeErrorResponse(TEXT("missing_param: axisName is required for nodeType=InputAxis (add the mapping first via add_input_mapping)"));
		}
		UK2Node_InputAxisEvent* AxisNode = NewObject<UK2Node_InputAxisEvent>(Graph);
		AxisNode->Initialize(FName(*AxisName));
		NewNode = AxisNode;
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

		UClass* OwnerClass = nullptr;
		UFunction* Function = nullptr;
		if (!ClassName.IsEmpty())
		{
			FString ClassError;
			OwnerClass = ResolveClassByName(ClassName, ClassError);
			if (!OwnerClass)
			{
				return MakeErrorResponse(ClassError);
			}
			Function = OwnerClass->FindFunctionByName(FName(*FunctionName));
		}
		else
		{
			// No class given: this Blueprint's own surface first, then its parent chain.
			// The skeleton class matters specifically for functions created this session
			// (e.g. via create_function) that have not been compiled into GeneratedClass
			// yet. The skeleton is regenerated on every structural change, which is
			// exactly how the editor's own My Blueprint panel resolves uncompiled
			// functions, so checking it makes "create a function, then call it" work
			// without forcing a compile in between.
			UClass* Candidates[] = { Blueprint->GeneratedClass.Get(), Blueprint->SkeletonGeneratedClass.Get(), Blueprint->ParentClass.Get() };
			for (UClass* Candidate : Candidates)
			{
				if (Candidate)
				{
					OwnerClass = Candidate;
					Function = Candidate->FindFunctionByName(FName(*FunctionName));
					if (Function)
					{
						break;
					}
				}
			}
		}
		if (!Function)
		{
			// A close-but-wrong function name is the most common way a caller fails here, and
			// a bare not-found gives it nothing to act on. Answer with near-misses from the
			// reflection catalog so the failure is self-correcting without the caller having
			// had to call find_node first.
			TSharedRef<FJsonObject> NotFound = MakeErrorResponse(FString::Printf(
				TEXT("function_not_found: %s on %s"),
				*FunctionName, OwnerClass ? *OwnerClass->GetName() : TEXT("(no class)")));

			FMCPNodeCatalog& Catalog = FMCPNodeCatalog::Get();
			Catalog.EnsureBuilt();
			TArray<TSharedPtr<FJsonValue>> Suggestions = Catalog.SuggestSimilar(FunctionName, 5);
			if (Suggestions.Num() > 0)
			{
				NotFound->SetArrayField(TEXT("didYouMean"), Suggestions);
			}
			return NotFound;
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
			// Not one of the Blueprint's own variables: fall back to inherited/native
			// properties, which is how "Mesh" or "CharacterMovement" on a Character are
			// read. SetSelfMember resolves against the whole class hierarchy at compile
			// time, so the node works the same either way.
			const UClass* LookupClass = Blueprint->SkeletonGeneratedClass
				? Blueprint->SkeletonGeneratedClass.Get()
				: Blueprint->ParentClass.Get();
			if (LookupClass && LookupClass->FindPropertyByName(VarFName))
			{
				bFoundVar = true;
			}
		}
		if (!bFoundVar)
		{
			return MakeErrorResponse(FString::Printf(
				TEXT("variable_not_found: %s (not a Blueprint variable, and no inherited property has that name)"),
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
	else if (NodeType == TEXT("Branch"))
	{
		// The graph-editor "Branch" node. Pins: execute, Condition (bool), then, else.
		NewNode = NewObject<UK2Node_IfThenElse>(Graph);
	}
	else if (NodeType == TEXT("Sequence"))
	{
		// Executes outputs in order. Allocates two output pins by default (then_0, then_1).
		NewNode = NewObject<UK2Node_ExecutionSequence>(Graph);
	}
	else if (NodeType == TEXT("Cast"))
	{
		FString TargetClassName;
		if (!Params->TryGetStringField(TEXT("targetClass"), TargetClassName))
		{
			return MakeErrorResponse(TEXT("missing_param: targetClass is required for nodeType=Cast"));
		}
		FString ClassError;
		UClass* TargetClass = ResolveClassByName(TargetClassName, ClassError);
		if (!TargetClass)
		{
			return MakeErrorResponse(ClassError);
		}

		UK2Node_DynamicCast* CastNode = NewObject<UK2Node_DynamicCast>(Graph);
		CastNode->TargetType = TargetClass;
		// Impure (with exec pins) by default, matching what the editor gives you when you
		// drag off an exec line; pass pure=true for the pure form.
		bool bPure = false;
		Params->TryGetBoolField(TEXT("pure"), bPure);
		CastNode->SetPurity(bPure);
		NewNode = CastNode;
	}
	else if (NodeType == TEXT("Macro"))
	{
		FString MacroName;
		if (!Params->TryGetStringField(TEXT("macroName"), MacroName))
		{
			return MakeErrorResponse(TEXT("missing_param: macroName is required for nodeType=Macro (e.g. ForEachLoop, WhileLoop, DoOnce, Gate, FlipFlop)"));
		}

		// The engine's standard macro library is where ForEachLoop/WhileLoop/etc live.
		// This is the same asset the editor's own right-click palette pulls them from.
		UBlueprint* MacroLib = LoadObject<UBlueprint>(nullptr, TEXT("/Engine/EditorBlueprintResources/StandardMacros.StandardMacros"));
		if (!MacroLib)
		{
			return MakeErrorResponse(TEXT("standard_macro_library_not_found: /Engine/EditorBlueprintResources/StandardMacros"));
		}

		UEdGraph* MacroGraph = nullptr;
		TArray<FString> AvailableMacros;
		for (UEdGraph* Candidate : MacroLib->MacroGraphs)
		{
			if (!Candidate)
			{
				continue;
			}
			AvailableMacros.Add(Candidate->GetName());
			if (Candidate->GetName().Equals(MacroName, ESearchCase::IgnoreCase))
			{
				MacroGraph = Candidate;
			}
		}
		if (!MacroGraph)
		{
			// List what actually exists, in the same spirit as add_node's didYouMean:
			// the caller should never have to guess at engine-defined names.
			return MakeErrorResponse(FString::Printf(TEXT("macro_not_found: %s (available: %s)"),
				*MacroName, *FString::Join(AvailableMacros, TEXT(", "))));
		}

		UK2Node_MacroInstance* MacroNode = NewObject<UK2Node_MacroInstance>(Graph);
		MacroNode->SetMacroGraph(MacroGraph);
		NewNode = MacroNode;
	}
	else
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("unknown_node_type: %s (expected Event, CustomEvent, CallFunction, VariableGet, VariableSet, Branch, Sequence, Cast, Macro, InputKey, InputAxis, Self)"), *NodeType));
	}

	// Everything above this point is validation that can bail out; nothing has been
	// mutated yet, so the transaction opens here and never wraps a no-op.
	// Modify() must be called inside the transaction and before the change, since that
	// is what snapshots the prior state into the undo buffer. The batch path opens one
	// transaction around the whole batch instead, so it can cancel the lot atomically.
	TUniquePtr<FScopedTransaction> Transaction;
	if (bOpenTransaction)
	{
		Transaction = MakeUnique<FScopedTransaction>(NSLOCTEXT("UnrealMCPBridge", "MCPAddNode", "MCP: Add Node"));
	}
	Graph->Modify();
	Blueprint->Modify();

	NewNode->NodePosX = PosX;
	NewNode->NodePosY = PosY;
	Graph->AddNode(NewNode, /*bIsUserAction=*/true, /*bSelectNewNode=*/false);
	NewNode->CreateNewGuid();
	NewNode->PostPlacedNewNode();
	NewNode->AllocateDefaultPins();

	// Optional comment, so a caller can annotate as it builds instead of needing a second
	// call per node. AGENT_WORKFLOW.md tells agents to do exactly that.
	FString Comment;
	if (Params->TryGetStringField(TEXT("comment"), Comment) && !Comment.IsEmpty())
	{
		NewNode->NodeComment = Comment;
		NewNode->bCommentBubbleVisible = true;
	}

	// Typed parameters on a CustomEvent (its data OUTPUT pins, since an event emits its
	// arguments into the graph). Added after AllocateDefaultPins so the exec pin exists
	// first, matching how the editor's details panel adds them.
	if (UK2Node_CustomEvent* AsCustomEvent = Cast<UK2Node_CustomEvent>(NewNode))
	{
		const TArray<TSharedPtr<FJsonValue>>* EventInputs = nullptr;
		if (Params->TryGetArrayField(TEXT("inputs"), EventInputs))
		{
			for (const TSharedPtr<FJsonValue>& Entry : *EventInputs)
			{
				const TSharedPtr<FJsonObject>* Obj = nullptr;
				FString PinName, TypeStr;
				if (!Entry.IsValid() || !Entry->TryGetObject(Obj) ||
					!(*Obj)->TryGetStringField(TEXT("name"), PinName) ||
					!(*Obj)->TryGetStringField(TEXT("type"), TypeStr))
				{
					return MakeErrorResponse(TEXT("bad_param: each CustomEvent input needs {name, type}"));
				}
				FEdGraphPinType PinType;
				FString TypeError;
				if (!ResolvePinType(TypeStr, PinType, TypeError))
				{
					return MakeErrorResponse(TypeError);
				}
				AsCustomEvent->CreateUserDefinedPin(FName(*PinName), PinType, EGPD_Output);
			}
		}
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("id"), MakeNodeId(NewNode));
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

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPConnectPins", "MCP: Connect Pins"));
	Graph->Modify();
	Blueprint->Modify();
	// Both endpoints change, since a link is recorded on each pin's owning node.
	SourceNode->Modify();
	TargetNode->Modify();

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

	if (Pin->LinkedTo.Num() > 0)
	{
		return MakeErrorResponse(TEXT("pin_is_connected: this pin already has a link; remove that connection before setting a literal default"));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSetPinDefault", "MCP: Set Pin Default Value"));
	Node->Modify();
	Blueprint->Modify();

	// Object/class pins store their default in DefaultObject, not DefaultValue, so an
	// asset reference ("/Game/X/SK_Foo.SK_Foo") must be resolved and set there. Writing
	// the string into DefaultValue silently produces a None pin.
	if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Object ||
		Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Class ||
		Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftObject ||
		Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftClass)
	{
		UObject* Loaded = LoadObject<UObject>(nullptr, *Value);
		if (!Loaded)
		{
			return MakeErrorResponse(FString::Printf(TEXT("asset_not_found: %s (object pins take a full asset path)"), *Value));
		}
		Pin->DefaultObject = Loaded;
	}
	else
	{
		Pin->DefaultValue = Value;
	}
	Node->PinDefaultValueChanged(Pin);

	FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("set"), true);
	Result->SetStringField(TEXT("pin"), PinName);
	Result->SetStringField(TEXT("value"), Pin->DefaultObject ? Pin->DefaultObject->GetPathName() : Pin->DefaultValue);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRemoveNode(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName, NodeId;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName) ||
		!Params->TryGetStringField(TEXT("nodeId"), NodeId))
	{
		return MakeErrorResponse(TEXT("missing_param: path, graphName, nodeId are required"));
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

	// Capture both before RemoveNode, since Node is not safe to dereference afterwards.
	const FString RemovedType = Node->GetClass()->GetName();
	const FString RemovedId = MakeNodeId(Node);

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPRemoveNode", "MCP: Remove Node"));
	Graph->Modify();
	Blueprint->Modify();
	Node->Modify();

	Node->BreakAllNodeLinks();
	FBlueprintEditorUtils::RemoveNode(Blueprint, Node, /*bDontRecompile=*/true);

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("removed"), true);
	Result->SetStringField(TEXT("id"), RemovedId);
	Result->SetStringField(TEXT("type"), RemovedType);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleAddVariable(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, VariableName, TypeStr;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("variableName"), VariableName) ||
		!Params->TryGetStringField(TEXT("type"), TypeStr))
	{
		return MakeErrorResponse(TEXT("missing_param: path, variableName, type are required"));
	}

	FString Category, DefaultValue;
	Params->TryGetStringField(TEXT("category"), Category);
	Params->TryGetStringField(TEXT("defaultValue"), DefaultValue);

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FEdGraphPinType PinType;
	FString TypeError;
	if (!ResolvePinType(TypeStr, PinType, TypeError))
	{
		return MakeErrorResponse(TypeError);
	}

	const FName VarFName(*VariableName);
	for (const FBPVariableDescription& ExistingVar : Blueprint->NewVariables)
	{
		if (ExistingVar.VarName == VarFName)
		{
			return MakeErrorResponse(FString::Printf(TEXT("variable_already_exists: %s"), *VariableName));
		}
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPAddVariable", "MCP: Add Variable"));
	Blueprint->Modify();

	const bool bAdded = FBlueprintEditorUtils::AddMemberVariable(Blueprint, VarFName, PinType, DefaultValue);
	if (!bAdded)
	{
		return MakeErrorResponse(FString::Printf(TEXT("add_variable_failed: %s"), *VariableName));
	}

	// Replication, the flags half of multiplayer state. repNotify also creates the
	// OnRep_<Name> function graph the same way the editor does, so the caller can
	// immediately build logic inside it.
	bool bReplicated = false, bRepNotify = false;
	Params->TryGetBoolField(TEXT("replicated"), bReplicated);
	Params->TryGetBoolField(TEXT("repNotify"), bRepNotify);
	if (bReplicated || bRepNotify)
	{
		const int32 VarIndex = FBlueprintEditorUtils::FindNewVariableIndex(Blueprint, VarFName);
		if (VarIndex == INDEX_NONE)
		{
			return MakeErrorResponse(TEXT("internal: variable added but not found for replication setup"));
		}
		Blueprint->NewVariables[VarIndex].PropertyFlags |= CPF_Net;
		if (bRepNotify)
		{
			const FName RepFuncName(*FString::Printf(TEXT("OnRep_%s"), *VariableName));
			UEdGraph* RepGraph = FBlueprintEditorUtils::CreateNewGraph(
				Blueprint, RepFuncName, UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
			FBlueprintEditorUtils::AddFunctionGraph<UClass>(Blueprint, RepGraph, /*bIsUserCreated=*/true, nullptr);
			Blueprint->NewVariables[VarIndex].PropertyFlags |= CPF_RepNotify;
			Blueprint->NewVariables[VarIndex].RepNotifyFunc = RepFuncName;
		}
		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	}

	if (!Category.IsEmpty())
	{
		FBlueprintEditorUtils::SetBlueprintVariableCategory(Blueprint, VarFName, nullptr, FText::FromString(Category));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("added"), true);
	Result->SetStringField(TEXT("name"), VariableName);
	Result->SetStringField(TEXT("type"), TypeStr);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCompileBlueprint(const TSharedPtr<FJsonObject>& Params)
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

	FCompilerResultsLog ResultsLog;
	FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::None, &ResultsLog);

	TArray<TSharedPtr<FJsonValue>> MessageArray;
	for (const TSharedRef<FTokenizedMessage>& Message : ResultsLog.Messages)
	{
		FString Severity;
		switch (Message->GetSeverity())
		{
		case EMessageSeverity::Error:
			Severity = TEXT("error");
			break;
		case EMessageSeverity::PerformanceWarning:
			Severity = TEXT("performance_warning");
			break;
		case EMessageSeverity::Warning:
			Severity = TEXT("warning");
			break;
		default:
			Severity = TEXT("info");
			break;
		}

		TSharedRef<FJsonObject> MsgEntry = MakeShared<FJsonObject>();
		MsgEntry->SetStringField(TEXT("severity"), Severity);
		MsgEntry->SetStringField(TEXT("text"), Message->ToText().ToString());
		MessageArray.Add(MakeShared<FJsonValueObject>(MsgEntry));
	}

	FString StatusStr;
	switch (Blueprint->Status)
	{
	case BS_UpToDate:
		StatusStr = TEXT("UpToDate");
		break;
	case BS_UpToDateWithWarnings:
		StatusStr = TEXT("UpToDateWithWarnings");
		break;
	case BS_Dirty:
		StatusStr = TEXT("Dirty");
		break;
	case BS_Error:
		StatusStr = TEXT("Error");
		break;
	case BS_BeingCreated:
		StatusStr = TEXT("BeingCreated");
		break;
	default:
		StatusStr = TEXT("Unknown");
		break;
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("errorCount"), ResultsLog.NumErrors);
	Result->SetNumberField(TEXT("warningCount"), ResultsLog.NumWarnings);
	Result->SetBoolField(TEXT("success"), ResultsLog.NumErrors == 0);
	Result->SetStringField(TEXT("status"), StatusStr);
	Result->SetArrayField(TEXT("messages"), MessageArray);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSaveBlueprint(const TSharedPtr<FJsonObject>& Params)
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

	FString SaveError;
	const bool bSaved = SaveBlueprintPackage(Blueprint, SaveError);
	if (!bSaved)
	{
		return MakeErrorResponse(SaveError);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("saved"), true);
	Result->SetStringField(TEXT("path"), Path);
	return MakeOkResponse(Result);
}

// =============================== Milestone 3 ===============================

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSearchProject(const TSharedPtr<FJsonObject>& Params)
{
	FString Query;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("query"), Query) || Query.IsEmpty())
	{
		return MakeErrorResponse(TEXT("missing_param: query"));
	}

	int32 MaxResults = 50;
	if (Params->HasField(TEXT("maxResults")))
	{
		MaxResults = static_cast<int32>(Params->GetNumberField(TEXT("maxResults")));
	}
	MaxResults = FMath::Clamp(MaxResults, 1, 500);

	FMCPProjectIndex::Get().EnsureBuilt();
	TArray<TSharedPtr<FJsonValue>> Hits = FMCPProjectIndex::Get().Search(Query, MaxResults);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("query"), Query);
	Result->SetArrayField(TEXT("hits"), Hits);
	Result->SetNumberField(TEXT("hitCount"), Hits.Num());
	Result->SetBoolField(TEXT("truncated"), Hits.Num() >= MaxResults);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleFindReferences(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return MakeErrorResponse(TEXT("missing_param: path"));
	}

	int32 MaxResults = 200;
	if (Params->HasField(TEXT("maxResults")))
	{
		MaxResults = static_cast<int32>(Params->GetNumberField(TEXT("maxResults")));
	}
	MaxResults = FMath::Clamp(MaxResults, 1, 2000);

	// Accept either a full object path ("/Game/X/BP_Foo.BP_Foo") or a bare package path
	// ("/Game/X/BP_Foo"), since GetReferencers/GetDependencies operate on package names.
	FString PackageName = Path;
	int32 DotIndex;
	if (PackageName.FindChar(TEXT('.'), DotIndex))
	{
		PackageName = PackageName.Left(DotIndex);
	}

	if (!FPackageName::DoesPackageExist(PackageName))
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_not_found: %s"), *PackageName));
	}

	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();

	TArray<FName> Referencers;
	AssetRegistry.GetReferencers(FName(*PackageName), Referencers);

	TArray<FName> Dependencies;
	AssetRegistry.GetDependencies(FName(*PackageName), Dependencies);

	auto BuildArray = [&AssetRegistry, MaxResults](const TArray<FName>& Names) -> TArray<TSharedPtr<FJsonValue>>
	{
		TArray<TSharedPtr<FJsonValue>> Arr;
		for (const FName& PkgName : Names)
		{
			if (Arr.Num() >= MaxResults)
			{
				break;
			}
			const FString PkgStr = PkgName.ToString();
			// Skip engine/script-internal packages to keep this focused on project content.
			if (PkgStr.StartsWith(TEXT("/Script/")))
			{
				continue;
			}

			TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("package"), PkgStr);

			TArray<FAssetData> AssetsInPackage;
			AssetRegistry.GetAssetsByPackageName(PkgName, AssetsInPackage);
			if (AssetsInPackage.Num() > 0)
			{
				Entry->SetStringField(TEXT("assetName"), AssetsInPackage[0].AssetName.ToString());
				Entry->SetStringField(TEXT("assetClass"), AssetsInPackage[0].AssetClassPath.GetAssetName().ToString());
			}
			Arr.Add(MakeShared<FJsonValueObject>(Entry));
		}
		return Arr;
	};

	TArray<TSharedPtr<FJsonValue>> ReferencerArray = BuildArray(Referencers);
	TArray<TSharedPtr<FJsonValue>> DependencyArray = BuildArray(Dependencies);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), PackageName);
	Result->SetArrayField(TEXT("referencedBy"), ReferencerArray);
	Result->SetNumberField(TEXT("referencedByCount"), Referencers.Num());
	Result->SetArrayField(TEXT("dependsOn"), DependencyArray);
	Result->SetNumberField(TEXT("dependsOnCount"), Dependencies.Num());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleGetProjectOverview(const TSharedPtr<FJsonObject>& Params)
{
	FMCPProjectIndex::Get().EnsureBuilt();
	TSharedRef<FJsonObject> Result = FMCPProjectIndex::Get().GetOverview();
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleFindNode(const TSharedPtr<FJsonObject>& Params)
{
	FString Query;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("query"), Query) || Query.IsEmpty())
	{
		return MakeErrorResponse(TEXT("missing_param: query is required"));
	}

	int32 MaxResults = 20;
	double MaxResultsRaw = 0.0;
	if (Params->TryGetNumberField(TEXT("maxResults"), MaxResultsRaw))
	{
		MaxResults = static_cast<int32>(MaxResultsRaw);
	}
	MaxResults = FMath::Clamp(MaxResults, 1, 100);

	FMCPNodeCatalog& Catalog = FMCPNodeCatalog::Get();
	Catalog.EnsureBuilt();

	TArray<TSharedPtr<FJsonValue>> Hits = Catalog.Search(Query, MaxResults);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("query"), Query);
	Result->SetArrayField(TEXT("hits"), Hits);
	Result->SetNumberField(TEXT("hitCount"), Hits.Num());
	// Reports the catalog size rather than ever returning the catalog itself. It runs to
	// tens of thousands of entries, so dumping it would defeat the point of this project.
	Result->SetNumberField(TEXT("catalogSize"), Catalog.GetFunctionCount());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleGetNodeSignature(const TSharedPtr<FJsonObject>& Params)
{
	FString FunctionName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("functionName"), FunctionName) || FunctionName.IsEmpty())
	{
		return MakeErrorResponse(TEXT("missing_param: functionName is required"));
	}

	FString ClassName;
	Params->TryGetStringField(TEXT("className"), ClassName);

	FMCPNodeCatalog& Catalog = FMCPNodeCatalog::Get();
	Catalog.EnsureBuilt();

	TSharedPtr<FJsonObject> Signature = Catalog.FindSignature(FunctionName, ClassName);
	if (!Signature.IsValid())
	{
		const FString ClassSuffix = ClassName.IsEmpty()
			? FString()
			: FString::Printf(TEXT(" on %s"), *ClassName);
		TSharedRef<FJsonObject> NotFound = MakeErrorResponse(FString::Printf(
			TEXT("node_signature_not_found: %s%s"), *FunctionName, *ClassSuffix));

		TArray<TSharedPtr<FJsonValue>> Suggestions = Catalog.SuggestSimilar(FunctionName, 5);
		if (Suggestions.Num() > 0)
		{
			NotFound->SetArrayField(TEXT("didYouMean"), Suggestions);
		}
		return NotFound;
	}

	return MakeOkResponse(Signature);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateFunction(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, FunctionName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("functionName"), FunctionName))
	{
		return MakeErrorResponse(TEXT("missing_param: path and functionName are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	// Reject a name that already exists as a graph rather than silently uniquifying:
	// a caller that asks for "HandleDamage" and gets "HandleDamage_0" would then wire
	// calls to the wrong name.
	TArray<UEdGraph*> AllGraphs;
	Blueprint->GetAllGraphs(AllGraphs);
	for (UEdGraph* Existing : AllGraphs)
	{
		if (Existing && Existing->GetName().Equals(FunctionName, ESearchCase::IgnoreCase))
		{
			return MakeErrorResponse(FString::Printf(TEXT("graph_already_exists: %s"), *FunctionName));
		}
	}

	// Parse inputs/outputs up front so a bad type string fails before anything mutates.
	struct FParsedPin
	{
		FString Name;
		FEdGraphPinType Type;
	};
	TArray<FParsedPin> Inputs, Outputs;
	auto ParsePinArray = [&Params](const TCHAR* Field, TArray<FParsedPin>& Out, FString& OutError) -> bool
	{
		const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
		if (!Params->TryGetArrayField(Field, Arr))
		{
			return true; // absent is fine
		}
		for (const TSharedPtr<FJsonValue>& Entry : *Arr)
		{
			const TSharedPtr<FJsonObject>* Obj = nullptr;
			FString Name, TypeStr;
			if (!Entry.IsValid() || !Entry->TryGetObject(Obj) ||
				!(*Obj)->TryGetStringField(TEXT("name"), Name) ||
				!(*Obj)->TryGetStringField(TEXT("type"), TypeStr))
			{
				OutError = FString::Printf(TEXT("bad_param: each %s entry needs {name, type}"), Field);
				return false;
			}
			FParsedPin Pin;
			Pin.Name = Name;
			if (!ResolvePinType(TypeStr, Pin.Type, OutError))
			{
				return false;
			}
			Out.Add(Pin);
		}
		return true;
	};

	FString ParseError;
	if (!ParsePinArray(TEXT("inputs"), Inputs, ParseError) || !ParsePinArray(TEXT("outputs"), Outputs, ParseError))
	{
		return MakeErrorResponse(ParseError);
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPCreateFunction", "MCP: Create Function"));
	Blueprint->Modify();

	UEdGraph* NewGraph = FBlueprintEditorUtils::CreateNewGraph(
		Blueprint, FName(*FunctionName), UEdGraph::StaticClass(), UEdGraphSchema_K2::StaticClass());
	FBlueprintEditorUtils::AddFunctionGraph<UClass>(Blueprint, NewGraph, /*bIsUserCreated=*/true, nullptr);

	TArray<UK2Node_FunctionEntry*> EntryNodes;
	NewGraph->GetNodesOfClass(EntryNodes);
	if (EntryNodes.Num() == 0)
	{
		return MakeErrorResponse(TEXT("internal: function graph created without an entry node"));
	}
	UK2Node_FunctionEntry* Entry = EntryNodes[0];

	// Function INPUTS are output pins on the entry node; function OUTPUTS are input pins
	// on the result node. Backwards at first glance, correct from the graph's perspective.
	for (const FParsedPin& In : Inputs)
	{
		Entry->CreateUserDefinedPin(FName(*In.Name), In.Type, EGPD_Output);
	}

	UK2Node_FunctionResult* ResultNode = nullptr;
	if (Outputs.Num() > 0)
	{
		ResultNode = FBlueprintEditorUtils::FindOrCreateFunctionResultNode(Entry);
		if (!ResultNode)
		{
			return MakeErrorResponse(TEXT("internal: could not create a function result node"));
		}
		ResultNode->NodePosX = Entry->NodePosX + 500;
		ResultNode->NodePosY = Entry->NodePosY;
		for (const FParsedPin& OutPin : Outputs)
		{
			ResultNode->CreateUserDefinedPin(FName(*OutPin.Name), OutPin.Type, EGPD_Input);
		}
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("graphName"), NewGraph->GetName());
	Result->SetStringField(TEXT("entryNodeId"), MakeNodeId(Entry));
	if (ResultNode)
	{
		Result->SetStringField(TEXT("resultNodeId"), MakeNodeId(ResultNode));
	}
	Result->SetNumberField(TEXT("inputCount"), Inputs.Num());
	Result->SetNumberField(TEXT("outputCount"), Outputs.Num());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleOrganizeGraph(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName, Action;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("graphName"), GraphName) ||
		!Params->TryGetStringField(TEXT("action"), Action))
	{
		return MakeErrorResponse(TEXT("missing_param: path, graphName, action are required"));
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

	if (Action == TEXT("set_node_comment"))
	{
		FString NodeId, Comment;
		if (!Params->TryGetStringField(TEXT("nodeId"), NodeId) ||
			!Params->TryGetStringField(TEXT("comment"), Comment))
		{
			return MakeErrorResponse(TEXT("missing_param: nodeId and comment are required for set_node_comment"));
		}
		FString NodeError;
		UEdGraphNode* Node = FindNodeById(Graph, NodeId, NodeError);
		if (!Node)
		{
			return MakeErrorResponse(NodeError);
		}

		const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSetComment", "MCP: Set Node Comment"));
		Node->Modify();
		Node->NodeComment = Comment;
		Node->bCommentBubbleVisible = !Comment.IsEmpty();
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("id"), MakeNodeId(Node));
		Result->SetStringField(TEXT("comment"), Comment);
		return MakeOkResponse(Result);
	}

	if (Action == TEXT("add_comment_box"))
	{
		FString Text;
		if (!Params->TryGetStringField(TEXT("text"), Text))
		{
			return MakeErrorResponse(TEXT("missing_param: text is required for add_comment_box"));
		}
		double X = 0, Y = 0, Width = 400, Height = 300;
		Params->TryGetNumberField(TEXT("x"), X);
		Params->TryGetNumberField(TEXT("y"), Y);
		Params->TryGetNumberField(TEXT("width"), Width);
		Params->TryGetNumberField(TEXT("height"), Height);

		const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPAddCommentBox", "MCP: Add Comment Box"));
		Graph->Modify();
		Blueprint->Modify();

		UEdGraphNode_Comment* CommentNode = NewObject<UEdGraphNode_Comment>(Graph);
		CommentNode->NodePosX = static_cast<int32>(X);
		CommentNode->NodePosY = static_cast<int32>(Y);
		CommentNode->NodeWidth = static_cast<int32>(Width);
		CommentNode->NodeHeight = static_cast<int32>(Height);
		Graph->AddNode(CommentNode, /*bIsUserAction=*/true, /*bSelectNewNode=*/false);
		CommentNode->CreateNewGuid();
		CommentNode->PostPlacedNewNode();
		CommentNode->AllocateDefaultPins();
		// AFTER PostPlacedNewNode, which resets NodeComment to the default "Comment"
		// text. Setting it earlier silently wiped the caller's text on every box; found
		// by the owner playtesting and noticing the boxes carried no information.
		CommentNode->NodeComment = Text;
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("id"), MakeNodeId(CommentNode));
		Result->SetStringField(TEXT("text"), Text);
		return MakeOkResponse(Result);
	}

	if (Action == TEXT("move_node"))
	{
		FString NodeId;
		double X = 0, Y = 0;
		if (!Params->TryGetStringField(TEXT("nodeId"), NodeId) ||
			!Params->TryGetNumberField(TEXT("x"), X) ||
			!Params->TryGetNumberField(TEXT("y"), Y))
		{
			return MakeErrorResponse(TEXT("missing_param: nodeId, x, y are required for move_node"));
		}
		FString NodeError;
		UEdGraphNode* Node = FindNodeById(Graph, NodeId, NodeError);
		if (!Node)
		{
			return MakeErrorResponse(NodeError);
		}

		const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPMoveNode", "MCP: Move Node"));
		Node->Modify();
		Node->NodePosX = static_cast<int32>(X);
		Node->NodePosY = static_cast<int32>(Y);
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);

		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetStringField(TEXT("id"), MakeNodeId(Node));
		Result->SetNumberField(TEXT("x"), Node->NodePosX);
		Result->SetNumberField(TEXT("y"), Node->NodePosY);
		return MakeOkResponse(Result);
	}

	return MakeErrorResponse(FString::Printf(
		TEXT("unknown_action: %s (expected set_node_comment, add_comment_box, move_node)"), *Action));
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleBuildGraph(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, GraphName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
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
	UEdGraph* Graph = FindGraphByName(Blueprint, GraphName, GraphError);
	if (!Graph)
	{
		return MakeErrorResponse(GraphError);
	}

	const TArray<TSharedPtr<FJsonValue>>* NodeSpecs = nullptr;
	const TArray<TSharedPtr<FJsonValue>>* Connections = nullptr;
	const TArray<TSharedPtr<FJsonValue>>* PinDefaults = nullptr;
	Params->TryGetArrayField(TEXT("nodes"), NodeSpecs);
	Params->TryGetArrayField(TEXT("connections"), Connections);
	Params->TryGetArrayField(TEXT("pinDefaults"), PinDefaults);
	if ((!NodeSpecs || NodeSpecs->Num() == 0) && (!Connections || Connections->Num() == 0) && (!PinDefaults || PinDefaults->Num() == 0))
	{
		return MakeErrorResponse(TEXT("empty_batch: provide at least one of nodes, connections, pinDefaults"));
	}

	TSharedRef<FJsonObject> NodesOut = MakeShared<FJsonObject>();
	int32 ConnectionsMade = 0;
	int32 DefaultsSet = 0;

	// The whole batch is atomic: any failure restores the graph to exactly its pre-call
	// state. A model that gets step 7 of 9 wrong retries the whole batch instead of
	// reasoning about which half survived, and a human gets the entire authored feature
	// as a single Ctrl+Z entry.
	//
	// Atomicity is implemented by hand rather than via FScopedTransaction::Cancel,
	// because (verified against EditorTransaction.cpp) Cancel only discards the undo
	// RECORD; it does not revert the mutations. So: snapshot which nodes pre-existed,
	// track links made and defaults changed, and on failure restore defaults, break the
	// links, and remove every node not in the snapshot (which also catches conversion
	// nodes the schema may have inserted), then cancel the now-empty transaction record.
	{
		FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPBuildGraph", "MCP: Build Graph"));
		Graph->Modify();
		Blueprint->Modify();

		TSet<UEdGraphNode*> PreexistingNodes;
		for (UEdGraphNode* Existing : Graph->Nodes)
		{
			PreexistingNodes.Add(Existing);
		}
		TArray<TPair<UEdGraphPin*, UEdGraphPin*>> MadeLinks;
		struct FSavedDefault
		{
			UEdGraphPin* Pin;
			FString OldValue;
		};
		TArray<FSavedDefault> SavedDefaults;

		auto RollbackBatch = [&]()
		{
			for (int32 i = SavedDefaults.Num() - 1; i >= 0; --i)
			{
				SavedDefaults[i].Pin->DefaultValue = SavedDefaults[i].OldValue;
			}
			for (const TPair<UEdGraphPin*, UEdGraphPin*>& Link : MadeLinks)
			{
				if (Link.Key && Link.Value)
				{
					Link.Key->BreakLinkTo(Link.Value);
				}
			}
			TArray<UEdGraphNode*> NodesSnapshot = Graph->Nodes;
			for (UEdGraphNode* Node : NodesSnapshot)
			{
				if (Node && !PreexistingNodes.Contains(Node))
				{
					Node->BreakAllNodeLinks();
					FBlueprintEditorUtils::RemoveNode(Blueprint, Node, /*bDontRecompile=*/true);
				}
			}
			FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
			// The mutations are reverted by hand above; Cancel only discards the empty
			// undo record so no "MCP: Build Graph" entry lingers in the history.
			Transaction.Cancel();
		};

		TMap<FString, UEdGraphNode*> RefMap;

		if (NodeSpecs)
		{
			for (int32 i = 0; i < NodeSpecs->Num(); ++i)
			{
				const TSharedPtr<FJsonObject>* SpecObj = nullptr;
				FString Ref;
				if (!(*NodeSpecs)[i].IsValid() || !(*NodeSpecs)[i]->TryGetObject(SpecObj) ||
					!(*SpecObj)->TryGetStringField(TEXT("ref"), Ref) || Ref.IsEmpty())
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("bad_node_spec at index %d: each node needs a non-empty ref"), i));
				}
				if (Ref.Contains(TEXT(".")) || RefMap.Contains(Ref))
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("bad_ref: '%s' (refs must be unique and contain no dots)"), *Ref));
				}

				TSharedRef<FJsonObject> NodeResponse = AddNodeCore(Blueprint, Graph, *SpecObj, /*bOpenTransaction=*/false);
				if (!NodeResponse->GetBoolField(TEXT("ok")))
				{
					// Cancel first, then surface which step failed plus any didYouMean the
					// inner error carried, so the retry can be correct on the first try.
					RollbackBatch();
					TSharedRef<FJsonObject> Failed = MakeErrorResponse(FString::Printf(
						TEXT("node_failed at ref '%s': %s"), *Ref, *NodeResponse->GetStringField(TEXT("error"))));
					Failed->SetStringField(TEXT("failedRef"), Ref);
					const TArray<TSharedPtr<FJsonValue>>* Suggestions = nullptr;
					if (NodeResponse->TryGetArrayField(TEXT("didYouMean"), Suggestions))
					{
						Failed->SetArrayField(TEXT("didYouMean"), *Suggestions);
					}
					return Failed;
				}

				const TSharedPtr<FJsonObject> NodeResult = NodeResponse->GetObjectField(TEXT("result"));
				FString NodeIdErr;
				UEdGraphNode* Node = FindNodeById(Graph, NodeResult->GetStringField(TEXT("id")), NodeIdErr);
				if (!Node)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("internal: created node not found for ref '%s'"), *Ref));
				}
				RefMap.Add(Ref, Node);
				NodesOut->SetObjectField(Ref, NodeResult);
			}
		}

		// Resolves "ref" (from this batch) or a node id (GUID / legacy) for nodes that
		// already existed, so a batch can extend a graph, not only start one.
		auto ResolveToken = [&RefMap, Graph](const FString& Token, FString& OutError) -> UEdGraphNode*
		{
			if (UEdGraphNode* const* Found = RefMap.Find(Token))
			{
				return *Found;
			}
			return FindNodeById(Graph, Token, OutError);
		};

		auto DescribePins = [](const UEdGraphNode* Node, EEdGraphPinDirection Direction) -> FString
		{
			TArray<FString> Names;
			for (const UEdGraphPin* Pin : Node->Pins)
			{
				if (Pin && Pin->Direction == Direction)
				{
					Names.Add(Pin->PinName.ToString());
				}
			}
			return FString::Join(Names, TEXT(", "));
		};

		if (Connections)
		{
			for (int32 i = 0; i < Connections->Num(); ++i)
			{
				const TSharedPtr<FJsonObject>* ConnObj = nullptr;
				FString From, To;
				if (!(*Connections)[i].IsValid() || !(*Connections)[i]->TryGetObject(ConnObj) ||
					!(*ConnObj)->TryGetStringField(TEXT("from"), From) ||
					!(*ConnObj)->TryGetStringField(TEXT("to"), To))
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("bad_connection at index %d: needs {from, to} as \"ref.pinName\""), i));
				}

				int32 FromDot, ToDot;
				if (!From.FindChar(TEXT('.'), FromDot) || !To.FindChar(TEXT('.'), ToDot))
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("bad_connection at index %d: '%s' -> '%s' (format is \"ref.pinName\")"), i, *From, *To));
				}

				FString TokenErr;
				UEdGraphNode* SourceNode = ResolveToken(From.Left(FromDot), TokenErr);
				if (!SourceNode)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("connection %d: source %s"), i, *TokenErr));
				}
				UEdGraphNode* TargetNode = ResolveToken(To.Left(ToDot), TokenErr);
				if (!TargetNode)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("connection %d: target %s"), i, *TokenErr));
				}

				const FString FromPinName = From.Mid(FromDot + 1);
				const FString ToPinName = To.Mid(ToDot + 1);
				UEdGraphPin* SourcePin = SourceNode->FindPin(FName(*FromPinName), EGPD_Output);
				if (!SourcePin)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(
						TEXT("connection %d: output pin '%s' not found (available: %s)"),
						i, *FromPinName, *DescribePins(SourceNode, EGPD_Output)));
				}
				UEdGraphPin* TargetPin = TargetNode->FindPin(FName(*ToPinName), EGPD_Input);
				if (!TargetPin)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(
						TEXT("connection %d: input pin '%s' not found (available: %s)"),
						i, *ToPinName, *DescribePins(TargetNode, EGPD_Input)));
				}

				SourceNode->Modify();
				TargetNode->Modify();
				const UEdGraphSchema* Schema = Graph->GetSchema();
				const FPinConnectionResponse ConnectResponse = Schema->CanCreateConnection(SourcePin, TargetPin);
				if (ConnectResponse.Response == CONNECT_RESPONSE_DISALLOW)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("connection %d incompatible_pins: %s"), i, *ConnectResponse.Message.ToString()));
				}
				if (!Schema->TryCreateConnection(SourcePin, TargetPin))
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("connection %d: connect_failed"), i));
				}
				MadeLinks.Add(TPair<UEdGraphPin*, UEdGraphPin*>(SourcePin, TargetPin));
				++ConnectionsMade;
			}
		}

		if (PinDefaults)
		{
			for (int32 i = 0; i < PinDefaults->Num(); ++i)
			{
				const TSharedPtr<FJsonObject>* DefObj = nullptr;
				FString NodeToken, PinName, Value;
				if (!(*PinDefaults)[i].IsValid() || !(*PinDefaults)[i]->TryGetObject(DefObj) ||
					!(*DefObj)->TryGetStringField(TEXT("node"), NodeToken) ||
					!(*DefObj)->TryGetStringField(TEXT("pin"), PinName) ||
					!(*DefObj)->TryGetStringField(TEXT("value"), Value))
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("bad_pin_default at index %d: needs {node, pin, value}"), i));
				}

				FString TokenErr;
				UEdGraphNode* Node = ResolveToken(NodeToken, TokenErr);
				if (!Node)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("pinDefault %d: %s"), i, *TokenErr));
				}
				UEdGraphPin* Pin = Node->FindPin(FName(*PinName), EGPD_Input);
				if (!Pin)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(
						TEXT("pinDefault %d: input pin '%s' not found (available: %s)"),
						i, *PinName, *DescribePins(Node, EGPD_Input)));
				}
				if (Pin->LinkedTo.Num() > 0)
				{
					RollbackBatch();
					return MakeErrorResponse(FString::Printf(TEXT("pinDefault %d: pin_is_connected: %s"), i, *PinName));
				}
				Node->Modify();
				SavedDefaults.Add({ Pin, Pin->DefaultValue });
				if (Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Object ||
					Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Class ||
					Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftObject ||
					Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_SoftClass)
				{
					UObject* Loaded = LoadObject<UObject>(nullptr, *Value);
					if (!Loaded)
					{
						RollbackBatch();
						return MakeErrorResponse(FString::Printf(TEXT("pinDefault %d: asset_not_found: %s"), i, *Value));
					}
					Pin->DefaultObject = Loaded;
				}
				else
				{
					Pin->DefaultValue = Value;
				}
				Node->PinDefaultValueChanged(Pin);
				++DefaultsSet;
			}
		}

		FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetObjectField(TEXT("nodes"), NodesOut);
	Result->SetNumberField(TEXT("connectionsMade"), ConnectionsMade);
	Result->SetNumberField(TEXT("pinDefaultsSet"), DefaultsSet);

	// Compile by default: the workflow rule is compile-after-every-batch anyway, so doing
	// it here saves the caller a round trip. Opt out with compile=false.
	bool bCompile = true;
	Params->TryGetBoolField(TEXT("compile"), bCompile);
	if (bCompile)
	{
		FCompilerResultsLog CompileResults;
		FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::None, &CompileResults);

		TSharedRef<FJsonObject> CompileObj = MakeShared<FJsonObject>();
		CompileObj->SetNumberField(TEXT("errorCount"), CompileResults.NumErrors);
		CompileObj->SetNumberField(TEXT("warningCount"), CompileResults.NumWarnings);
		CompileObj->SetBoolField(TEXT("success"), CompileResults.NumErrors == 0);
		if (CompileResults.NumErrors > 0 || CompileResults.NumWarnings > 0)
		{
			TArray<TSharedPtr<FJsonValue>> Messages;
			for (const TSharedRef<FTokenizedMessage>& Message : CompileResults.Messages)
			{
				TSharedRef<FJsonObject> MsgObj = MakeShared<FJsonObject>();
				MsgObj->SetStringField(TEXT("severity"),
					Message->GetSeverity() == EMessageSeverity::Error ? TEXT("error") : TEXT("warning"));
				MsgObj->SetStringField(TEXT("text"), Message->ToText().ToString());
				Messages.Add(MakeShared<FJsonValueObject>(MsgObj));
			}
			CompileObj->SetArrayField(TEXT("messages"), Messages);
		}
		Result->SetObjectField(TEXT("compile"), CompileObj);
	}

	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListAssets(const TSharedPtr<FJsonObject>& Params)
{
	FString ClassName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("className"), ClassName) || ClassName.IsEmpty())
	{
		return MakeErrorResponse(TEXT("missing_param: className is required (e.g. SkeletalMesh, AnimBlueprint, AnimSequence)"));
	}

	FString ClassError;
	UClass* AssetClass = ResolveClassByName(ClassName, ClassError);
	if (!AssetClass)
	{
		return MakeErrorResponse(ClassError);
	}

	FString PathPrefix = TEXT("/Game");
	Params->TryGetStringField(TEXT("pathPrefix"), PathPrefix);
	int32 MaxResults = 100;
	double MaxRaw = 0.0;
	if (Params->TryGetNumberField(TEXT("maxResults"), MaxRaw))
	{
		MaxResults = FMath::Clamp(static_cast<int32>(MaxRaw), 1, 500);
	}

	FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	FARFilter Filter;
	Filter.ClassPaths.Add(AssetClass->GetClassPathName());
	Filter.bRecursiveClasses = true;
	Filter.PackagePaths.Add(FName(*PathPrefix));
	Filter.bRecursivePaths = true;

	TArray<FAssetData> Assets;
	AssetRegistryModule.Get().GetAssets(Filter, Assets);

	TArray<TSharedPtr<FJsonValue>> Hits;
	for (const FAssetData& Asset : Assets)
	{
		if (Hits.Num() >= MaxResults)
		{
			break;
		}
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Asset.AssetName.ToString());
		Entry->SetStringField(TEXT("path"), Asset.GetObjectPathString());
		Entry->SetStringField(TEXT("class"), Asset.AssetClassPath.GetAssetName().ToString());
		Hits.Add(MakeShared<FJsonValueObject>(Entry));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("assets"), Hits);
	Result->SetNumberField(TEXT("count"), Hits.Num());
	Result->SetBoolField(TEXT("truncated"), Assets.Num() > MaxResults);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateLevel(const TSharedPtr<FJsonObject>& Params)
{
	FString PackagePath;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("packagePath"), PackagePath))
	{
		return MakeErrorResponse(TEXT("missing_param: packagePath is required, e.g. /Game/Maps/NewLevel"));
	}

	// Refuse an existing path BEFORE touching AssetTools: CreateAsset answers an existing
	// asset with a modal overwrite dialog, which freezes the game thread and therefore
	// this whole bridge until a human clicks it. A modal is never an acceptable failure
	// mode for a headless caller.
	if (FPackageName::DoesPackageExist(PackagePath))
	{
		return MakeErrorResponse(FString::Printf(TEXT("asset_already_exists: %s"), *PackagePath));
	}

	const FString AssetName = FPackageName::GetShortName(PackagePath);
	const FString PackageDir = FPackageName::GetLongPackagePath(PackagePath);

	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools");
	UWorldFactory* Factory = NewObject<UWorldFactory>();
	UObject* NewAsset = AssetToolsModule.Get().CreateAsset(AssetName, PackageDir, UWorld::StaticClass(), Factory);
	UWorld* NewWorld = Cast<UWorld>(NewAsset);
	if (!NewWorld)
	{
		return MakeErrorResponse(FString::Printf(TEXT("create_level_failed: %s (does an asset already exist there?)"), *PackagePath));
	}

	// Optional per-level GameMode override, so the level is playable without touching
	// project-wide defaults.
	FString GameModeClassName;
	if (Params->TryGetStringField(TEXT("gameModeClass"), GameModeClassName) && !GameModeClassName.IsEmpty())
	{
		FString ClassError;
		UClass* GameModeClass = ResolveClassByName(GameModeClassName, ClassError);
		if (!GameModeClass)
		{
			return MakeErrorResponse(ClassError);
		}
		AWorldSettings* WorldSettings = NewWorld->GetWorldSettings();
		if (WorldSettings)
		{
			WorldSettings->DefaultGameMode = GameModeClass;
		}
	}

	// Maps save with the map extension, not the asset extension.
	UPackage* Package = NewWorld->GetOutermost();
	Package->MarkPackageDirty();
	const FString FileName = FPackageName::LongPackageNameToFilename(Package->GetName(), FPackageName::GetMapPackageExtension());
	FSavePackageArgs SaveArgs;
	SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
	const bool bSaved = UPackage::SavePackage(Package, NewWorld, *FileName, SaveArgs);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), NewWorld->GetPathName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSetGameSettings(const TSharedPtr<FJsonObject>& Params)
{
	if (!Params.IsValid())
	{
		return MakeErrorResponse(TEXT("missing_param: provide defaultGameMode, editorStartupMap, and/or gameDefaultMap"));
	}

	UGameMapsSettings* Settings = GetMutableDefault<UGameMapsSettings>();
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	bool bChangedAnything = false;

	FString DefaultGameMode;
	if (Params->TryGetStringField(TEXT("defaultGameMode"), DefaultGameMode) && !DefaultGameMode.IsEmpty())
	{
		UGameMapsSettings::SetGlobalDefaultGameMode(DefaultGameMode);
		Result->SetStringField(TEXT("defaultGameMode"), DefaultGameMode);
		bChangedAnything = true;
	}
	FString EditorStartupMap;
	if (Params->TryGetStringField(TEXT("editorStartupMap"), EditorStartupMap) && !EditorStartupMap.IsEmpty())
	{
		Settings->EditorStartupMap = FSoftObjectPath(EditorStartupMap);
		Result->SetStringField(TEXT("editorStartupMap"), EditorStartupMap);
		bChangedAnything = true;
	}
	FString GameDefaultMap;
	if (Params->TryGetStringField(TEXT("gameDefaultMap"), GameDefaultMap) && !GameDefaultMap.IsEmpty())
	{
		UGameMapsSettings::SetGameDefaultMap(GameDefaultMap);
		Result->SetStringField(TEXT("gameDefaultMap"), GameDefaultMap);
		bChangedAnything = true;
	}

	if (!bChangedAnything)
	{
		return MakeErrorResponse(TEXT("missing_param: provide defaultGameMode, editorStartupMap, and/or gameDefaultMap"));
	}

	// Persists to DefaultEngine.ini so the change survives an editor restart.
	Settings->TryUpdateDefaultConfigFile();
	Result->SetBoolField(TEXT("saved"), true);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleAddInputMapping(const TSharedPtr<FJsonObject>& Params)
{
	FString Kind, Name, KeyName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("kind"), Kind) ||
		!Params->TryGetStringField(TEXT("name"), Name) ||
		!Params->TryGetStringField(TEXT("key"), KeyName))
	{
		return MakeErrorResponse(TEXT("missing_param: kind (action|axis), name, key are required"));
	}

	const FKey Key(*KeyName);
	if (!Key.IsValid())
	{
		return MakeErrorResponse(FString::Printf(TEXT("unknown_key: %s (use UE key names like F, SpaceBar, W, MouseX, Gamepad_LeftX)"), *KeyName));
	}

	UInputSettings* InputSettings = UInputSettings::GetInputSettings();
	if (Kind == TEXT("action"))
	{
		InputSettings->AddActionMapping(FInputActionKeyMapping(FName(*Name), Key), /*bForceRebuildKeymaps=*/true);
	}
	else if (Kind == TEXT("axis"))
	{
		double Scale = 1.0;
		Params->TryGetNumberField(TEXT("scale"), Scale);
		InputSettings->AddAxisMapping(FInputAxisKeyMapping(FName(*Name), Key, static_cast<float>(Scale)), /*bForceRebuildKeymaps=*/true);
	}
	else
	{
		return MakeErrorResponse(FString::Printf(TEXT("unknown_kind: %s (expected action or axis)"), *Kind));
	}

	// SaveKeyMappings alone writes the Saved config layer, which does NOT survive as
	// project configuration: mappings added through it vanished on the next editor
	// restart, leaving every InputAxis node referencing an unknown axis (found by the
	// owner when WASD died). TryUpdateDefaultConfigFile persists to Config/DefaultInput.ini.
	InputSettings->SaveKeyMappings();
	InputSettings->TryUpdateDefaultConfigFile();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("kind"), Kind);
	Result->SetStringField(TEXT("name"), Name);
	Result->SetStringField(TEXT("key"), KeyName);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleStartPie(const TSharedPtr<FJsonObject>& Params)
{
	if (!GEditor)
	{
		return MakeErrorResponse(TEXT("no_editor"));
	}
	if (GEditor->PlayWorld)
	{
		return MakeErrorResponse(TEXT("pie_already_running: call stop_pie first"));
	}

	int32 NumPlayers = 2;
	bool bListenServer = true;
	double NumRaw = 0.0;
	if (Params.IsValid() && Params->TryGetNumberField(TEXT("numPlayers"), NumRaw))
	{
		NumPlayers = FMath::Clamp(static_cast<int32>(NumRaw), 1, 4);
	}
	if (Params.IsValid())
	{
		Params->TryGetBoolField(TEXT("listenServer"), bListenServer);
	}

	ULevelEditorPlaySettings* PlaySettings = GetMutableDefault<ULevelEditorPlaySettings>();
	PlaySettings->SetPlayNumberOfClients(NumPlayers);
	PlaySettings->SetPlayNetMode(bListenServer && NumPlayers > 1 ? PIE_ListenServer : PIE_Standalone);
	PlaySettings->SetRunUnderOneProcess(true);

	FRequestPlaySessionParams SessionParams;
	GEditor->RequestPlaySession(SessionParams);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("requested"), true);
	Result->SetNumberField(TEXT("numPlayers"), NumPlayers);
	Result->SetBoolField(TEXT("listenServer"), bListenServer);
	Result->SetStringField(TEXT("note"), TEXT("PIE starts on the next editor tick; poll pie_status and read the editor log for runtime errors"));
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleStopPie(const TSharedPtr<FJsonObject>& Params)
{
	if (!GEditor)
	{
		return MakeErrorResponse(TEXT("no_editor"));
	}
	const bool bWasRunning = GEditor->PlayWorld != nullptr;
	if (bWasRunning)
	{
		GEditor->RequestEndPlayMap();
	}
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("wasRunning"), bWasRunning);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandlePieStatus(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("running"), GEditor && GEditor->PlayWorld != nullptr);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRefreshBlueprint(const TSharedPtr<FJsonObject>& Params)
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

	// This is the "right-click > Refresh Nodes" fix a human applies after a C++ change:
	// every node re-reads its backing function/struct/pin signature, dropping pins that
	// no longer exist and picking up new ones. It clears the whole "in use pin no longer
	// exists, please refresh node" error family that a signature change leaves behind.
	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPRefreshBlueprint", "MCP: Refresh Blueprint"));
	Blueprint->Modify();
	FBlueprintEditorUtils::RefreshAllNodes(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Blueprint->GetPathName());
	Result->SetBoolField(TEXT("refreshed"), true);

	// Recompile by default and report the before/after so a caller can see the effect.
	bool bCompile = true;
	Params->TryGetBoolField(TEXT("compile"), bCompile);
	if (bCompile)
	{
		FCompilerResultsLog CompileResults;
		FKismetEditorUtilities::CompileBlueprint(Blueprint, EBlueprintCompileOptions::None, &CompileResults);
		TSharedRef<FJsonObject> CompileObj = MakeShared<FJsonObject>();
		CompileObj->SetNumberField(TEXT("errorCount"), CompileResults.NumErrors);
		CompileObj->SetNumberField(TEXT("warningCount"), CompileResults.NumWarnings);
		CompileObj->SetBoolField(TEXT("success"), CompileResults.NumErrors == 0);
		if (CompileResults.NumErrors > 0 || CompileResults.NumWarnings > 0)
		{
			TArray<TSharedPtr<FJsonValue>> Messages;
			for (const TSharedRef<FTokenizedMessage>& Message : CompileResults.Messages)
			{
				TSharedRef<FJsonObject> MsgObj = MakeShared<FJsonObject>();
				MsgObj->SetStringField(TEXT("severity"),
					Message->GetSeverity() == EMessageSeverity::Error ? TEXT("error") : TEXT("warning"));
				MsgObj->SetStringField(TEXT("text"), Message->ToText().ToString());
				Messages.Add(MakeShared<FJsonValueObject>(MsgObj));
			}
			CompileObj->SetArrayField(TEXT("messages"), Messages);
		}
		Result->SetObjectField(TEXT("compile"), CompileObj);
	}

	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleDeleteAsset(const TSharedPtr<FJsonObject>& Params)
{
	// Accepts either a single path or an array, so a whole dead cluster deletes at once
	// (its members reference each other, and force-delete breaks those intra-set links).
	TArray<FString> Paths;
	FString SinglePath;
	if (Params.IsValid() && Params->TryGetStringField(TEXT("path"), SinglePath))
	{
		Paths.Add(SinglePath);
	}
	const TArray<TSharedPtr<FJsonValue>>* PathArray = nullptr;
	if (Params.IsValid() && Params->TryGetArrayField(TEXT("paths"), PathArray))
	{
		for (const TSharedPtr<FJsonValue>& Entry : *PathArray)
		{
			FString P;
			if (Entry.IsValid() && Entry->TryGetString(P))
			{
				Paths.Add(P);
			}
		}
	}
	if (Paths.Num() == 0)
	{
		return MakeErrorResponse(TEXT("missing_param: path or paths[] is required"));
	}

	FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
	IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();

	// Safety report: what OUTSIDE this delete set still references each asset. force=true
	// deletes anyway (breaking those references to None); without force, an outside
	// referencer blocks the delete so the caller cannot silently orphan live content.
	bool bForce = false;
	if (Params.IsValid())
	{
		Params->TryGetBoolField(TEXT("force"), bForce);
	}

	TSet<FName> DeleteSet;
	for (const FString& P : Paths)
	{
		DeleteSet.Add(FName(*FPackageName::ObjectPathToPackageName(P)));
	}

	TArray<FAssetData> ToDelete;
	TArray<TSharedPtr<FJsonValue>> Blockers;
	for (const FString& P : Paths)
	{
		const FSoftObjectPath ObjectPath(P);
		FAssetData Asset = AssetRegistry.GetAssetByObjectPath(ObjectPath);
		if (!Asset.IsValid())
		{
			return MakeErrorResponse(FString::Printf(TEXT("asset_not_found: %s"), *P));
		}
		ToDelete.Add(Asset);

		if (!bForce)
		{
			TArray<FName> Referencers;
			AssetRegistry.GetReferencers(Asset.PackageName, Referencers);
			for (const FName& Ref : Referencers)
			{
				const FString RefStr = Ref.ToString();
				if (!DeleteSet.Contains(Ref) && !RefStr.StartsWith(TEXT("/Script/")))
				{
					TSharedRef<FJsonObject> B = MakeShared<FJsonObject>();
					B->SetStringField(TEXT("asset"), P);
					B->SetStringField(TEXT("referencedBy"), RefStr);
					Blockers.Add(MakeShared<FJsonValueObject>(B));
				}
			}
		}
	}

	if (Blockers.Num() > 0)
	{
		TSharedRef<FJsonObject> Blocked = MakeErrorResponse(
			TEXT("delete_blocked: live assets outside the delete set still reference these. Pass force:true to delete anyway (breaks those references to None)."));
		Blocked->SetArrayField(TEXT("blockers"), Blockers);
		return Blocked;
	}

	const int32 Deleted = ObjectTools::DeleteAssets(ToDelete, /*bShowConfirmation=*/false);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("requested"), Paths.Num());
	Result->SetNumberField(TEXT("deleted"), Deleted);
	Result->SetBoolField(TEXT("forced"), bForce);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleOpenLevel(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return MakeErrorResponse(TEXT("missing_param: path"));
	}
	if (!FPackageName::DoesPackageExist(Path))
	{
		return MakeErrorResponse(FString::Printf(TEXT("level_not_found: %s"), *Path));
	}

	// bSaveDirty=true so switching maps never raises the save-changes modal, which would
	// freeze the bridge. Anything dirty in the current map is saved, not discarded.
	const bool bOpened = UEditorLoadingAndSavingUtils::LoadMap(Path) != nullptr;
	if (!bOpened)
	{
		return MakeErrorResponse(FString::Printf(TEXT("open_level_failed: %s"), *Path));
	}

	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("openedLevel"), World ? World->GetOutermost()->GetName() : Path);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSpawnActor(const TSharedPtr<FJsonObject>& Params)
{
	FString ClassName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("actorClass"), ClassName))
	{
		return MakeErrorResponse(TEXT("missing_param: actorClass"));
	}
	FString ClassError;
	UClass* ActorClass = ResolveClassByName(ClassName, ClassError);
	if (!ActorClass)
	{
		return MakeErrorResponse(ClassError);
	}
	if (!ActorClass->IsChildOf(AActor::StaticClass()))
	{
		return MakeErrorResponse(FString::Printf(TEXT("not_an_actor_class: %s"), *ActorClass->GetName()));
	}

	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	if (!World)
	{
		return MakeErrorResponse(TEXT("no_editor_world: open a level first (open_level)"));
	}

	auto ReadVector = [&Params](const TCHAR* Prefix, double DefaultValue) -> FVector
	{
		double X = DefaultValue, Y = DefaultValue, Z = DefaultValue;
		Params->TryGetNumberField(FString::Printf(TEXT("%sX"), Prefix), X);
		Params->TryGetNumberField(FString::Printf(TEXT("%sY"), Prefix), Y);
		Params->TryGetNumberField(FString::Printf(TEXT("%sZ"), Prefix), Z);
		return FVector(X, Y, Z);
	};
	const FVector Location = ReadVector(TEXT("loc"), 0.0);
	const FVector Scale = ReadVector(TEXT("scale"), 1.0);
	double Pitch = 0, Yaw = 0, Roll = 0;
	Params->TryGetNumberField(TEXT("pitch"), Pitch);
	Params->TryGetNumberField(TEXT("yaw"), Yaw);
	Params->TryGetNumberField(TEXT("roll"), Roll);

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSpawnActor", "MCP: Spawn Actor"));
	FActorSpawnParameters SpawnParams;
	SpawnParams.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AActor* Actor = World->SpawnActor(ActorClass, &Location, nullptr, SpawnParams);
	if (!Actor)
	{
		return MakeErrorResponse(FString::Printf(TEXT("spawn_failed: %s"), *ActorClass->GetName()));
	}
	Actor->SetActorRotation(FRotator(Pitch, Yaw, Roll));
	Actor->SetActorScale3D(Scale);

	FString Label;
	if (Params->TryGetStringField(TEXT("label"), Label) && !Label.IsEmpty())
	{
		Actor->SetActorLabel(Label);
	}

	// Convenience for the most common level-blocking need: a StaticMeshActor with a mesh
	// assigned in one call (floors, walls, platforms).
	FString MeshPath;
	if (Params->TryGetStringField(TEXT("staticMesh"), MeshPath) && !MeshPath.IsEmpty())
	{
		AStaticMeshActor* MeshActor = Cast<AStaticMeshActor>(Actor);
		UStaticMesh* Mesh = LoadObject<UStaticMesh>(nullptr, *MeshPath);
		if (!MeshActor || !Mesh)
		{
			return MakeErrorResponse(MeshActor
				? FString::Printf(TEXT("static_mesh_not_found: %s"), *MeshPath)
				: TEXT("staticMesh only applies to actorClass StaticMeshActor"));
		}
		MeshActor->GetStaticMeshComponent()->SetStaticMesh(Mesh);
	}

	World->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("actor"), Actor->GetName());
	Result->SetStringField(TEXT("label"), Actor->GetActorLabel());
	Result->SetStringField(TEXT("class"), ActorClass->GetName());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSaveLevel(const TSharedPtr<FJsonObject>& Params)
{
	const bool bSaved = FEditorFileUtils::SaveCurrentLevel();
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("saved"), bSaved);
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleAddComponent(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, ComponentClassName, ComponentName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("componentClass"), ComponentClassName) ||
		!Params->TryGetStringField(TEXT("name"), ComponentName))
	{
		return MakeErrorResponse(TEXT("missing_param: path, componentClass, name are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}
	if (!Blueprint->SimpleConstructionScript)
	{
		return MakeErrorResponse(TEXT("no_construction_script: this Blueprint type cannot own components"));
	}

	FString ClassError;
	UClass* ComponentClass = ResolveClassByName(ComponentClassName, ClassError);
	if (!ComponentClass)
	{
		return MakeErrorResponse(ClassError);
	}
	if (!ComponentClass->IsChildOf(UActorComponent::StaticClass()))
	{
		return MakeErrorResponse(FString::Printf(TEXT("not_a_component_class: %s"), *ComponentClass->GetName()));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPAddComponent", "MCP: Add Component"));
	Blueprint->Modify();

	USimpleConstructionScript* SCS = Blueprint->SimpleConstructionScript;
	USCS_Node* NewNode = SCS->CreateNode(ComponentClass, FName(*ComponentName));
	if (!NewNode)
	{
		return MakeErrorResponse(TEXT("component_creation_failed"));
	}

	// Optional attachment to an existing SCS component by variable name; root otherwise.
	FString ParentName;
	if (Params->TryGetStringField(TEXT("parent"), ParentName) && !ParentName.IsEmpty())
	{
		USCS_Node* ParentNode = nullptr;
		for (USCS_Node* Existing : SCS->GetAllNodes())
		{
			if (Existing && Existing->GetVariableName() == FName(*ParentName))
			{
				ParentNode = Existing;
				break;
			}
		}
		if (!ParentNode)
		{
			return MakeErrorResponse(FString::Printf(TEXT("parent_component_not_found: %s"), *ParentName));
		}
		ParentNode->AddChildNode(NewNode);
	}
	else
	{
		SCS->AddNode(NewNode);
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("name"), NewNode->GetVariableName().ToString());
	Result->SetStringField(TEXT("class"), ComponentClass->GetName());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListComponents(const TSharedPtr<FJsonObject>& Params)
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

	TArray<TSharedPtr<FJsonValue>> Components;
	if (Blueprint->SimpleConstructionScript)
	{
		for (const USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
		{
			if (!Node)
			{
				continue;
			}
			TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), Node->GetVariableName().ToString());
			Entry->SetStringField(TEXT("class"), Node->ComponentClass ? Node->ComponentClass->GetName() : TEXT("?"));
			Components.Add(MakeShared<FJsonValueObject>(Entry));
		}
	}

	// Native components inherited from the parent class, reported by PROPERTY name
	// (Mesh, CapsuleComponent, CharacterMovement), because that is the name VariableGet
	// accepts in a graph. The CDO's instance names (CharacterMesh0, CollisionCylinder)
	// are useless to a graph author.
	TArray<TSharedPtr<FJsonValue>> Inherited;
	if (const UClass* ParentClass = Blueprint->ParentClass)
	{
		for (TFieldIterator<FObjectProperty> It(ParentClass); It; ++It)
		{
			if (!It->PropertyClass || !It->PropertyClass->IsChildOf(UActorComponent::StaticClass()))
			{
				continue;
			}
			TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), It->GetName());
			Entry->SetStringField(TEXT("class"), It->PropertyClass->GetName());
			Inherited.Add(MakeShared<FJsonValueObject>(Entry));
		}
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetArrayField(TEXT("components"), Components);
	Result->SetArrayField(TEXT("inherited"), Inherited);
	return MakeOkResponse(Result);
}

namespace
{
	// Shared by set_component_property and set_class_default: set a reflected property
	// from its string form, answering an unknown name with the object's real properties.
	TSharedRef<FJsonObject> SetPropertyFromString(UObject* Target, const FString& PropertyName, const FString& Value,
		TSharedRef<FJsonObject> (*MakeOk)(const TSharedPtr<FJsonObject>&),
		TSharedRef<FJsonObject> (*MakeError)(const FString&))
	{
		FProperty* Property = Target->GetClass()->FindPropertyByName(FName(*PropertyName));
		if (!Property)
		{
			TArray<FString> Names;
			for (TFieldIterator<FProperty> It(Target->GetClass()); It; ++It)
			{
				Names.Add(It->GetName());
			}
			// Compact near-miss list: contains-match first, then edit distance so plain
			// typos (TargettArmLength) still land on the right answer.
			auto EditDistance = [](const FString& A, const FString& B) -> int32
			{
				const int32 LenA = A.Len(), LenB = B.Len();
				TArray<int32> Prev, Curr;
				Prev.SetNumUninitialized(LenB + 1);
				Curr.SetNumUninitialized(LenB + 1);
				for (int32 Col = 0; Col <= LenB; ++Col) { Prev[Col] = Col; }
				for (int32 Row = 1; Row <= LenA; ++Row)
				{
					Curr[0] = Row;
					for (int32 Col = 1; Col <= LenB; ++Col)
					{
						const int32 Cost = (FChar::ToLower(A[Row - 1]) == FChar::ToLower(B[Col - 1])) ? 0 : 1;
						Curr[Col] = FMath::Min3(Curr[Col - 1] + 1, Prev[Col] + 1, Prev[Col - 1] + Cost);
					}
					Prev = Curr;
				}
				return Prev[LenB];
			};

			const int32 MaxDistance = FMath::Max(2, PropertyName.Len() / 4);
			TArray<FString> Similar;
			for (const FString& Name : Names)
			{
				if (Name.Contains(PropertyName) || PropertyName.Contains(Name) ||
					(FMath::Abs(Name.Len() - PropertyName.Len()) <= MaxDistance && EditDistance(Name, PropertyName) <= MaxDistance))
				{
					Similar.Add(Name);
					if (Similar.Num() >= 8)
					{
						break;
					}
				}
			}
			const FString Hint = Similar.Num() > 0
				? FString::Printf(TEXT(" (similar: %s)"), *FString::Join(Similar, TEXT(", ")))
				: FString::Printf(TEXT(" (%d properties exist; none match)"), Names.Num());
			return MakeError(FString::Printf(TEXT("property_not_found: %s on %s%s"),
				*PropertyName, *Target->GetClass()->GetName(), *Hint));
		}

		Target->Modify();
		void* ValuePtr = Property->ContainerPtrToValuePtr<void>(Target);
		const TCHAR* ImportResult = Property->ImportText_Direct(*Value, ValuePtr, Target, PPF_None);
		if (!ImportResult)
		{
			return MakeError(FString::Printf(TEXT("value_parse_failed: could not parse '%s' as %s (property %s)"),
				*Value, *Property->GetCPPType(), *PropertyName));
		}

		// Silent-None guard. ImportText on an object/class property with an unresolvable
		// path "succeeds" by writing null, which reads back as a working call that set
		// nothing. That exact failure cost a playtest: DefaultPawnClass was set before
		// the pawn Blueprint existed, the tool said ok, and PIE spawned the engine
		// default pawn. If the caller passed something that is not None but the property
		// resolved to null, that is an error, and a weak model especially needs it said.
		if (const FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property))
		{
			const bool bCallerMeantNull = Value.IsEmpty() || Value == TEXT("None") || Value == TEXT("none") || Value == TEXT("null");
			if (!bCallerMeantNull && ObjectProperty->GetObjectPropertyValue(ValuePtr) == nullptr)
			{
				return MakeError(FString::Printf(
					TEXT("asset_not_resolved: '%s' did not resolve for %s; the property is now None, which is almost never what you meant. Check the path exists (list_assets) and create referenced assets before referencing them."),
					*Value, *PropertyName));
			}
		}

		FPropertyChangedEvent ChangeEvent(Property);
		Target->PostEditChangeProperty(ChangeEvent);

		TSharedRef<FJsonObject> ResultObj = MakeShared<FJsonObject>();
		ResultObj->SetStringField(TEXT("property"), PropertyName);
		ResultObj->SetStringField(TEXT("type"), Property->GetCPPType());
		FString NewValue;
		Property->ExportTextItem_Direct(NewValue, ValuePtr, nullptr, Target, PPF_None);
		ResultObj->SetStringField(TEXT("value"), NewValue);
		return MakeOk(ResultObj);
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSetComponentProperty(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, ComponentName, PropertyName, Value;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("component"), ComponentName) ||
		!Params->TryGetStringField(TEXT("property"), PropertyName) ||
		!Params->TryGetStringField(TEXT("value"), Value))
	{
		return MakeErrorResponse(TEXT("missing_param: path, component, property, value are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}
	if (!Blueprint->SimpleConstructionScript)
	{
		return MakeErrorResponse(TEXT("no_construction_script"));
	}

	USCS_Node* TargetNode = nullptr;
	TArray<FString> Available;
	for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
	{
		if (!Node)
		{
			continue;
		}
		Available.Add(Node->GetVariableName().ToString());
		if (Node->GetVariableName() == FName(*ComponentName))
		{
			TargetNode = Node;
		}
	}
	if (!TargetNode || !TargetNode->ComponentTemplate)
	{
		return MakeErrorResponse(FString::Printf(TEXT("component_not_found: %s (available: %s)"),
			*ComponentName, *FString::Join(Available, TEXT(", "))));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSetComponentProp", "MCP: Set Component Property"));
	Blueprint->Modify();
	TSharedRef<FJsonObject> Response = SetPropertyFromString(
		TargetNode->ComponentTemplate, PropertyName, Value, &MakeOkResponse, &MakeErrorResponse);
	if (Response->GetBoolField(TEXT("ok")))
	{
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	}
	return Response;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSetClassDefault(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, PropertyName, Value;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("property"), PropertyName) ||
		!Params->TryGetStringField(TEXT("value"), Value))
	{
		return MakeErrorResponse(TEXT("missing_param: path, property, value are required"));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}
	if (!Blueprint->GeneratedClass)
	{
		return MakeErrorResponse(TEXT("no_generated_class: compile the Blueprint first"));
	}

	UObject* CDO = Blueprint->GeneratedClass->GetDefaultObject();
	if (!CDO)
	{
		return MakeErrorResponse(TEXT("no_class_default_object"));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSetClassDefault", "MCP: Set Class Default"));
	Blueprint->Modify();
	TSharedRef<FJsonObject> Response = SetPropertyFromString(CDO, PropertyName, Value, &MakeOkResponse, &MakeErrorResponse);
	if (Response->GetBoolField(TEXT("ok")))
	{
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	}
	return Response;
}

// ---------------------------------------------------------------------------------------------
// UMG / Widget Blueprints
//
// A game the user can see is mostly UI, and until now none of it was reachable: the bridge could
// author gameplay Blueprints but not a single health bar, menu, or HUD. These four commands cover
// the whole loop - create a Widget Blueprint, build its widget tree, read that tree back, and set
// properties on any widget in it.
//
// Deliberately built on the pre-5.8 creation sequence rather than
// FWidgetBlueprintOperationUtils::CreateWidgetBlueprint, which does exactly this but only exists
// on 5.8. Using it would have compiled clean here and broken the 5.6 build, which is the project's
// whole "one source, both engines" claim.
// ---------------------------------------------------------------------------------------------

/** Resolve a UWidget subclass by name, so callers can say "TextBlock" rather than "/Script/UMG.TextBlock". */
UClass* FMCPCommandHandler::ResolveWidgetClass(const FString& ClassName, FString& OutError)
{
	UClass* Resolved = ResolveClassByName(ClassName, OutError);
	if (!Resolved)
	{
		return nullptr;
	}
	if (!Resolved->IsChildOf(UWidget::StaticClass()))
	{
		OutError = FString::Printf(
			TEXT("not_a_widget_class: %s is not a UWidget. Widget classes include TextBlock, Button, Image, ")
			TEXT("ProgressBar, CanvasPanel, VerticalBox, HorizontalBox, Overlay, SizeBox, Border."),
			*Resolved->GetName());
		return nullptr;
	}
	if (Resolved->HasAnyClassFlags(CLASS_Abstract))
	{
		OutError = FString::Printf(TEXT("abstract_widget_class: %s cannot be instantiated"), *Resolved->GetName());
		return nullptr;
	}
	return Resolved;
}

/** Load a Widget Blueprint, failing with a message that says what was found instead. */
UWidgetBlueprint* FMCPCommandHandler::LoadWidgetBlueprint(const FString& Path, FString& OutError)
{
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, OutError);
	if (!Blueprint)
	{
		return nullptr;
	}
	UWidgetBlueprint* WidgetBlueprint = Cast<UWidgetBlueprint>(Blueprint);
	if (!WidgetBlueprint)
	{
		OutError = FString::Printf(
			TEXT("not_a_widget_blueprint: %s is a %s. Widget tools only work on Widget Blueprints; ")
			TEXT("create one with create_widget_blueprint."),
			*Path, *Blueprint->GetClass()->GetName());
		return nullptr;
	}
	if (!WidgetBlueprint->WidgetTree)
	{
		OutError = TEXT("no_widget_tree: this Widget Blueprint has no widget tree, which usually means it failed to load fully");
		return nullptr;
	}
	return WidgetBlueprint;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateWidgetBlueprint(const TSharedPtr<FJsonObject>& Params)
{
	FString PackagePath;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("packagePath"), PackagePath))
	{
		return MakeErrorResponse(TEXT("missing_param: packagePath is required, e.g. /Game/UI/W_HealthBar"));
	}

	if (FPackageName::DoesPackageExist(PackagePath))
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_already_exists: %s"), *PackagePath));
	}

	// Parent class: UserWidget unless the caller wants their own base.
	UClass* ParentClass = UUserWidget::StaticClass();
	FString ParentClassName;
	if (Params->TryGetStringField(TEXT("parentClass"), ParentClassName) && !ParentClassName.IsEmpty())
	{
		FString ClassError;
		UClass* Resolved = ResolveClassByName(ParentClassName, ClassError);
		if (!Resolved)
		{
			return MakeErrorResponse(ClassError);
		}
		if (!Resolved->IsChildOf(UUserWidget::StaticClass()))
		{
			return MakeErrorResponse(FString::Printf(
				TEXT("bad_parent_class: %s does not derive from UserWidget"), *Resolved->GetName()));
		}
		ParentClass = Resolved;
	}

	// Root widget: CanvasPanel by default, which is what the editor's own "User Widget" gives you
	// and the only root that supports free positioning.
	UClass* RootClass = UCanvasPanel::StaticClass();
	FString RootClassName;
	if (Params->TryGetStringField(TEXT("rootWidget"), RootClassName) && !RootClassName.IsEmpty())
	{
		FString ClassError;
		UClass* Resolved = ResolveWidgetClass(RootClassName, ClassError);
		if (!Resolved)
		{
			return MakeErrorResponse(ClassError);
		}
		if (!Resolved->IsChildOf(UPanelWidget::StaticClass()))
		{
			return MakeErrorResponse(FString::Printf(
				TEXT("root_must_be_a_panel: %s cannot contain children, so nothing could be added to it. ")
				TEXT("Use CanvasPanel, VerticalBox, HorizontalBox, Overlay, or another panel."),
				*Resolved->GetName()));
		}
		RootClass = Resolved;
	}

	bool bSave = true;
	if (Params->HasField(TEXT("save")))
	{
		bSave = Params->GetBoolField(TEXT("save"));
	}

	const FString AssetName = FPackageName::GetShortName(PackagePath);
	UPackage* Package = CreatePackage(*PackagePath);
	if (!Package)
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_creation_failed: %s"), *PackagePath));
	}

	const FScopedTransaction Transaction(
		NSLOCTEXT("UnrealMCPBridge", "MCPCreateWidgetBP", "MCP: Create Widget Blueprint"));

	UBlueprint* Created = FKismetEditorUtilities::CreateBlueprint(
		ParentClass,
		Package,
		FName(*AssetName),
		BPTYPE_Normal,
		UWidgetBlueprint::StaticClass(),
		UWidgetBlueprintGeneratedClass::StaticClass(),
		FName("MCPBridge"));

	UWidgetBlueprint* NewBlueprint = Cast<UWidgetBlueprint>(Created);
	if (!NewBlueprint)
	{
		return MakeErrorResponse(TEXT("create_widget_blueprint_failed"));
	}

	if (!NewBlueprint->WidgetTree)
	{
		NewBlueprint->WidgetTree = NewObject<UWidgetTree>(NewBlueprint, TEXT("WidgetTree"), RF_Transactional);
	}
	if (!NewBlueprint->WidgetTree->RootWidget)
	{
		UWidget* Root = NewBlueprint->WidgetTree->ConstructWidget<UWidget>(RootClass);
		NewBlueprint->WidgetTree->RootWidget = Root;
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(NewBlueprint);
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
	Result->SetStringField(TEXT("rootWidget"),
		NewBlueprint->WidgetTree->RootWidget ? NewBlueprint->WidgetTree->RootWidget->GetName() : TEXT(""));
	Result->SetStringField(TEXT("rootWidgetClass"), RootClass->GetName());
	Result->SetBoolField(TEXT("saved"), bSaved);
	if (bSave && !bSaved)
	{
		Result->SetStringField(TEXT("saveError"), SaveError);
	}
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleAddWidget(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, WidgetClassName, WidgetName;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("widgetClass"), WidgetClassName) ||
		!Params->TryGetStringField(TEXT("name"), WidgetName))
	{
		return MakeErrorResponse(TEXT("missing_param: path, widgetClass, name are required"));
	}

	FString LoadError;
	UWidgetBlueprint* Blueprint = LoadWidgetBlueprint(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	FString ClassError;
	UClass* WidgetClass = ResolveWidgetClass(WidgetClassName, ClassError);
	if (!WidgetClass)
	{
		return MakeErrorResponse(ClassError);
	}

	UWidgetTree* Tree = Blueprint->WidgetTree;
	if (Tree->FindWidget(FName(*WidgetName)))
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("widget_name_taken: %s already exists in this Widget Blueprint"), *WidgetName));
	}

	// Parent: an explicit panel, or the root. Naming the available panels in the error matters,
	// because "parent not found" with no list is the point where a caller starts guessing.
	UPanelWidget* Parent = nullptr;
	FString ParentName;
	if (Params->TryGetStringField(TEXT("parent"), ParentName) && !ParentName.IsEmpty())
	{
		UWidget* Found = Tree->FindWidget(FName(*ParentName));
		if (!Found)
		{
			TArray<FString> Panels;
			Tree->ForEachWidget([&Panels](UWidget* Widget)
			{
				if (Cast<UPanelWidget>(Widget))
				{
					Panels.Add(Widget->GetName());
				}
			});
			return MakeErrorResponse(FString::Printf(TEXT("parent_not_found: %s (panels available: %s)"),
				*ParentName, *FString::Join(Panels, TEXT(", "))));
		}
		Parent = Cast<UPanelWidget>(Found);
		if (!Parent)
		{
			return MakeErrorResponse(FString::Printf(
				TEXT("parent_not_a_panel: %s is a %s, which cannot contain children"),
				*ParentName, *Found->GetClass()->GetName()));
		}
	}
	else
	{
		Parent = Cast<UPanelWidget>(Tree->RootWidget);
		if (!Parent)
		{
			return MakeErrorResponse(TEXT("root_is_not_a_panel: pass an explicit parent, or recreate this Widget Blueprint with a panel root"));
		}
	}

	if (!Parent->CanAddMoreChildren())
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("parent_full: %s already has its one allowed child (%s holds a single child). ")
			TEXT("Put a CanvasPanel, VerticalBox, or Overlay inside it to hold more."),
			*Parent->GetName(), *Parent->GetClass()->GetName()));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPAddWidget", "MCP: Add Widget"));
	Blueprint->Modify();
	Tree->Modify();

	UWidget* NewWidget = Tree->ConstructWidget<UWidget>(WidgetClass, FName(*WidgetName));
	if (!NewWidget)
	{
		return MakeErrorResponse(FString::Printf(TEXT("widget_construction_failed: %s"), *WidgetClass->GetName()));
	}
	UPanelSlot* Slot = Parent->AddChild(NewWidget);
	if (!Slot)
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("add_child_failed: %s would not accept a child of type %s"),
			*Parent->GetName(), *WidgetClass->GetName()));
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("name"), NewWidget->GetName());
	Result->SetStringField(TEXT("class"), WidgetClass->GetName());
	Result->SetStringField(TEXT("parent"), Parent->GetName());
	// The slot is where layout lives (position, size, alignment, padding), and its class differs
	// per panel type, so the caller is told what it got rather than having to infer it.
	Result->SetStringField(TEXT("slotClass"), Slot->GetClass()->GetName());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListWidgets(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return MakeErrorResponse(TEXT("missing_param: path"));
	}

	FString LoadError;
	UWidgetBlueprint* Blueprint = LoadWidgetBlueprint(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	UWidgetTree* Tree = Blueprint->WidgetTree;
	TArray<TSharedPtr<FJsonValue>> Entries;

	// Walk the tree depth-first so the response reads in hierarchy order, with a depth on each
	// entry, rather than making the caller rebuild the shape from parent pointers.
	TFunction<void(UWidget*, const FString&, int32)> Visit =
		[&Entries, &Visit](UWidget* Widget, const FString& ParentName, int32 Depth)
	{
		if (!Widget)
		{
			return;
		}
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Widget->GetName());
		Entry->SetStringField(TEXT("class"), Widget->GetClass()->GetName());
		Entry->SetStringField(TEXT("parent"), ParentName);
		Entry->SetNumberField(TEXT("depth"), Depth);
		if (Widget->Slot)
		{
			Entry->SetStringField(TEXT("slotClass"), Widget->Slot->GetClass()->GetName());
		}
		const bool bIsPanel = Cast<UPanelWidget>(Widget) != nullptr;
		Entry->SetBoolField(TEXT("isPanel"), bIsPanel);
		Entries.Add(MakeShared<FJsonValueObject>(Entry));

		if (UPanelWidget* Panel = Cast<UPanelWidget>(Widget))
		{
			const int32 ChildCount = Panel->GetChildrenCount();
			for (int32 i = 0; i < ChildCount; ++i)
			{
				Visit(Panel->GetChildAt(i), Widget->GetName(), Depth + 1);
			}
		}
	};
	Visit(Tree->RootWidget, FString(), 0);

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Path);
	Result->SetStringField(TEXT("root"), Tree->RootWidget ? Tree->RootWidget->GetName() : TEXT(""));
	Result->SetArrayField(TEXT("widgets"), Entries);
	Result->SetNumberField(TEXT("count"), Entries.Num());
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSetWidgetProperty(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, WidgetName, PropertyName, Value;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("widget"), WidgetName) ||
		!Params->TryGetStringField(TEXT("property"), PropertyName) ||
		!Params->TryGetStringField(TEXT("value"), Value))
	{
		return MakeErrorResponse(TEXT("missing_param: path, widget, property, value are required"));
	}

	FString LoadError;
	UWidgetBlueprint* Blueprint = LoadWidgetBlueprint(Path, LoadError);
	if (!Blueprint)
	{
		return MakeErrorResponse(LoadError);
	}

	UWidget* Widget = Blueprint->WidgetTree->FindWidget(FName(*WidgetName));
	if (!Widget)
	{
		TArray<FString> Available;
		Blueprint->WidgetTree->ForEachWidget([&Available](UWidget* Each)
		{
			if (Each)
			{
				Available.Add(Each->GetName());
			}
		});
		return MakeErrorResponse(FString::Printf(TEXT("widget_not_found: %s (available: %s)"),
			*WidgetName, *FString::Join(Available, TEXT(", "))));
	}

	// Layout lives on the slot, not the widget, and that split is the single most confusing thing
	// about UMG for anyone (or any model) meeting it for the first time. So both are addressable
	// here, and the error below says which one to use.
	bool bOnSlot = false;
	Params->TryGetBoolField(TEXT("onSlot"), bOnSlot);

	UObject* Target = Widget;
	if (bOnSlot)
	{
		if (!Widget->Slot)
		{
			return MakeErrorResponse(FString::Printf(
				TEXT("no_slot: %s is the root widget, which has no slot. Position and size on the root are ")
				TEXT("controlled by whatever displays it, not by the widget itself."), *WidgetName));
		}
		Target = Widget->Slot;
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSetWidgetProp", "MCP: Set Widget Property"));
	Blueprint->Modify();
	Widget->Modify();

	TSharedRef<FJsonObject> Response = SetPropertyFromString(
		Target, PropertyName, Value, &MakeOkResponse, &MakeErrorResponse);
	if (Response->GetBoolField(TEXT("ok")))
	{
		FBlueprintEditorUtils::MarkBlueprintAsModified(Blueprint);
	}
	return Response;
}

// ---------------------------------------------------------------------------------------------
// User-defined Structs and Enums
//
// Six loose variables called Name, Icon, Count, Weight, Stackable, Rarity is what a project looks
// like before someone introduces a struct. Structs and enums are the first refactor a real project
// gets, and without them an agent-built project accretes loose variables forever.
//
// Everything here goes through FStructureEditorUtils / FEnumEditorUtils, never through
// UUserDefinedEnum::SetEnums. That is not a style preference. SetEnums has a genuinely different
// signature on the two supported engines:
//
//   5.6: SetEnums(TArray<TPair<FName,int64>>&, ECppForm, EEnumFlags, bool)
//   5.8: SetEnums(TArray<TPair<FName,int64>>&, ECppForm, UEnum::EUnderlyingType, EEnumFlags,
//                 EAddMaxKeyIfMissing)
//
// so no single call to it compiles against both. This is the C2660 that ChiR24/Unreal_mcp #566
// reports as an open bug. The editor utils above it are identical on both versions, verified
// header-to-header, so routing through them makes the whole problem not exist.
// ---------------------------------------------------------------------------------------------

/** Find a user-defined asset (struct or enum) by short name, using the asset registry. */
static UObject* FindUserDefinedAssetByName(UClass* AssetClass, const FString& Name)
{
	FAssetRegistryModule& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
	TArray<FAssetData> Assets;
	Registry.Get().GetAssetsByClass(AssetClass->GetClassPathName(), Assets);
	for (const FAssetData& Asset : Assets)
	{
		if (Asset.AssetName.ToString().Equals(Name, ESearchCase::IgnoreCase))
		{
			return Asset.GetAsset();
		}
	}
	return nullptr;
}

UScriptStruct* FMCPCommandHandler::ResolveStructByName(const FString& Name, FString& OutError)
{
	if (Name.StartsWith(TEXT("/")))
	{
		// Accept both "/Game/Data/S_Item" and "/Game/Data/S_Item.S_Item".
		FString Path = Name;
		if (!Path.Contains(TEXT(".")))
		{
			Path = FString::Printf(TEXT("%s.%s"), *Name, *FPackageName::GetShortName(Name));
		}
		if (UScriptStruct* Loaded = LoadObject<UScriptStruct>(nullptr, *Path))
		{
			return Loaded;
		}
	}
	else
	{
		// Engine structs first, then the project's own.
		for (const TCHAR* Prefix : { TEXT("/Script/CoreUObject."), TEXT("/Script/Engine.") })
		{
			if (UScriptStruct* Native = FindObject<UScriptStruct>(nullptr, *(FString(Prefix) + Name)))
			{
				return Native;
			}
		}
		if (UObject* Found = FindUserDefinedAssetByName(UUserDefinedStruct::StaticClass(), Name))
		{
			return Cast<UScriptStruct>(Found);
		}
	}

	OutError = FString::Printf(
		TEXT("struct_not_found: %s (pass a short asset name like S_ItemData, or a full path like ")
		TEXT("/Game/Data/S_ItemData. Create one with create_struct.)"), *Name);
	return nullptr;
}

UEnum* FMCPCommandHandler::ResolveEnumByName(const FString& Name, FString& OutError)
{
	if (Name.StartsWith(TEXT("/")))
	{
		FString Path = Name;
		if (!Path.Contains(TEXT(".")))
		{
			Path = FString::Printf(TEXT("%s.%s"), *Name, *FPackageName::GetShortName(Name));
		}
		if (UEnum* Loaded = LoadObject<UEnum>(nullptr, *Path))
		{
			return Loaded;
		}
	}
	else
	{
		if (UEnum* Native = FindObject<UEnum>(nullptr, *(FString(TEXT("/Script/Engine.")) + Name)))
		{
			return Native;
		}
		if (UObject* Found = FindUserDefinedAssetByName(UUserDefinedEnum::StaticClass(), Name))
		{
			return Cast<UEnum>(Found);
		}
	}

	OutError = FString::Printf(
		TEXT("enum_not_found: %s (pass a short asset name like E_WeaponType, or a full path like ")
		TEXT("/Game/Data/E_WeaponType. Create one with create_enum.)"), *Name);
	return nullptr;
}

/** Read a struct's fields into JSON, shared by create_struct, add_struct_field, and list_struct_fields. */
static TArray<TSharedPtr<FJsonValue>> DescribeStructFields(UUserDefinedStruct* Struct)
{
	TArray<TSharedPtr<FJsonValue>> Fields;
	for (const FStructVariableDescription& Desc : FStructureEditorUtils::GetVarDesc(Struct))
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		const FEdGraphPinType PinType = Desc.ToPinType();
		Entry->SetStringField(TEXT("name"), Desc.FriendlyName);
		Entry->SetStringField(TEXT("type"), PinType.PinCategory.ToString());
		if (PinType.PinSubCategoryObject.IsValid())
		{
			Entry->SetStringField(TEXT("subType"), PinType.PinSubCategoryObject->GetName());
		}
		Entry->SetBoolField(TEXT("isArray"), PinType.ContainerType == EPinContainerType::Array);
		if (!Desc.DefaultValue.IsEmpty())
		{
			Entry->SetStringField(TEXT("defaultValue"), Desc.DefaultValue);
		}
		Fields.Add(MakeShared<FJsonValueObject>(Entry));
	}
	return Fields;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateStruct(const TSharedPtr<FJsonObject>& Params)
{
	FString PackagePath;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("packagePath"), PackagePath))
	{
		return MakeErrorResponse(TEXT("missing_param: packagePath is required, e.g. /Game/Data/S_ItemData"));
	}
	if (FPackageName::DoesPackageExist(PackagePath))
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_already_exists: %s"), *PackagePath));
	}

	// Resolve every field type BEFORE creating anything, so a typo in field five does not leave a
	// half-built struct asset behind for someone to find later.
	struct FPendingField
	{
		FString Name;
		FEdGraphPinType Type;
	};
	TArray<FPendingField> Pending;
	const TArray<TSharedPtr<FJsonValue>>* FieldArray = nullptr;
	if (Params->TryGetArrayField(TEXT("fields"), FieldArray))
	{
		for (int32 i = 0; i < FieldArray->Num(); ++i)
		{
			const TSharedPtr<FJsonObject>* FieldObj = nullptr;
			if (!(*FieldArray)[i]->TryGetObject(FieldObj))
			{
				return MakeErrorResponse(FString::Printf(TEXT("bad_field at index %d: expected an object"), i));
			}
			FPendingField Field;
			FString TypeStr;
			if (!(*FieldObj)->TryGetStringField(TEXT("name"), Field.Name) || Field.Name.IsEmpty() ||
				!(*FieldObj)->TryGetStringField(TEXT("type"), TypeStr))
			{
				return MakeErrorResponse(FString::Printf(TEXT("bad_field at index %d: name and type are required"), i));
			}
			FString TypeError;
			if (!ResolvePinType(TypeStr, Field.Type, TypeError))
			{
				return MakeErrorResponse(FString::Printf(TEXT("bad_field '%s': %s"), *Field.Name, *TypeError));
			}
			Pending.Add(MoveTemp(Field));
		}
	}

	const FString AssetName = FPackageName::GetShortName(PackagePath);
	UPackage* Package = CreatePackage(*PackagePath);
	if (!Package)
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_creation_failed: %s"), *PackagePath));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPCreateStruct", "MCP: Create Struct"));

	UUserDefinedStruct* Struct = FStructureEditorUtils::CreateUserDefinedStruct(
		Package, FName(*AssetName), RF_Public | RF_Standalone | RF_Transactional);
	if (!Struct)
	{
		return MakeErrorResponse(TEXT("create_struct_failed"));
	}

	// A freshly created struct always arrives with one placeholder bool member, exactly as it does
	// in the editor. Reuse it for the first requested field rather than adding and then deleting.
	for (int32 i = 0; i < Pending.Num(); ++i)
	{
		if (i > 0 && !FStructureEditorUtils::AddVariable(Struct, Pending[i].Type))
		{
			return MakeErrorResponse(FString::Printf(TEXT("add_field_failed: %s"), *Pending[i].Name));
		}

		const TArray<FStructVariableDescription>& Desc = FStructureEditorUtils::GetVarDesc(Struct);
		if (!Desc.IsValidIndex(i))
		{
			return MakeErrorResponse(FString::Printf(TEXT("field_index_out_of_range: %s"), *Pending[i].Name));
		}
		const FGuid Guid = Desc[i].VarGuid;

		if (i == 0)
		{
			FStructureEditorUtils::ChangeVariableType(Struct, Guid, Pending[i].Type);
		}
		FStructureEditorUtils::RenameVariable(Struct, Guid, Pending[i].Name);
	}

	FAssetRegistryModule::AssetCreated(Struct);
	Package->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Struct->GetPathName());
	Result->SetStringField(TEXT("name"), AssetName);
	Result->SetArrayField(TEXT("fields"), DescribeStructFields(Struct));
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleAddStructField(const TSharedPtr<FJsonObject>& Params)
{
	FString Path, FieldName, TypeStr;
	if (!Params.IsValid() ||
		!Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("name"), FieldName) ||
		!Params->TryGetStringField(TEXT("type"), TypeStr))
	{
		return MakeErrorResponse(TEXT("missing_param: path, name, type are required"));
	}

	FString StructError;
	UScriptStruct* Resolved = ResolveStructByName(Path, StructError);
	UUserDefinedStruct* Struct = Cast<UUserDefinedStruct>(Resolved);
	if (!Resolved)
	{
		return MakeErrorResponse(StructError);
	}
	if (!Struct)
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("not_a_user_struct: %s is a native engine struct and cannot be edited"), *Path));
	}

	FEdGraphPinType PinType;
	FString TypeError;
	if (!ResolvePinType(TypeStr, PinType, TypeError))
	{
		return MakeErrorResponse(TypeError);
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPAddStructField", "MCP: Add Struct Field"));
	if (!FStructureEditorUtils::AddVariable(Struct, PinType))
	{
		return MakeErrorResponse(FString::Printf(TEXT("add_field_failed: %s"), *FieldName));
	}

	const TArray<FStructVariableDescription>& Desc = FStructureEditorUtils::GetVarDesc(Struct);
	if (Desc.Num() > 0)
	{
		FStructureEditorUtils::RenameVariable(Struct, Desc.Last().VarGuid, FieldName);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Struct->GetPathName());
	Result->SetStringField(TEXT("added"), FieldName);
	Result->SetArrayField(TEXT("fields"), DescribeStructFields(Struct));
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListStructFields(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return MakeErrorResponse(TEXT("missing_param: path"));
	}

	FString StructError;
	UScriptStruct* Resolved = ResolveStructByName(Path, StructError);
	if (!Resolved)
	{
		return MakeErrorResponse(StructError);
	}
	UUserDefinedStruct* Struct = Cast<UUserDefinedStruct>(Resolved);
	if (!Struct)
	{
		return MakeErrorResponse(FString::Printf(
			TEXT("not_a_user_struct: %s is a native engine struct; its layout is defined in C++"), *Path));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Struct->GetPathName());
	Result->SetStringField(TEXT("name"), Struct->GetName());
	Result->SetArrayField(TEXT("fields"), DescribeStructFields(Struct));
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateEnum(const TSharedPtr<FJsonObject>& Params)
{
	FString PackagePath;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("packagePath"), PackagePath))
	{
		return MakeErrorResponse(TEXT("missing_param: packagePath is required, e.g. /Game/Data/E_WeaponType"));
	}
	if (FPackageName::DoesPackageExist(PackagePath))
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_already_exists: %s"), *PackagePath));
	}

	TArray<FString> Entries;
	const TArray<TSharedPtr<FJsonValue>>* EntryArray = nullptr;
	if (Params->TryGetArrayField(TEXT("entries"), EntryArray))
	{
		for (const TSharedPtr<FJsonValue>& Value : *EntryArray)
		{
			FString Entry;
			if (!Value->TryGetString(Entry) || Entry.IsEmpty())
			{
				return MakeErrorResponse(TEXT("bad_entry: entries must be non-empty strings"));
			}
			Entries.Add(Entry);
		}
	}

	const FString AssetName = FPackageName::GetShortName(PackagePath);
	UPackage* Package = CreatePackage(*PackagePath);
	if (!Package)
	{
		return MakeErrorResponse(FString::Printf(TEXT("package_creation_failed: %s"), *PackagePath));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPCreateEnum", "MCP: Create Enum"));

	UUserDefinedEnum* Enum = Cast<UUserDefinedEnum>(FEnumEditorUtils::CreateUserDefinedEnum(
		Package, FName(*AssetName), RF_Public | RF_Standalone | RF_Transactional));
	if (!Enum)
	{
		return MakeErrorResponse(TEXT("create_enum_failed"));
	}

	// Like a new struct, a new enum arrives with one placeholder entry. Rename it for the first
	// requested value and append the rest. Display names are what a designer sees and what
	// Blueprint pins show, so they are set rather than left as NewEnumerator0.
	for (int32 i = 0; i < Entries.Num(); ++i)
	{
		if (i > 0)
		{
			FEnumEditorUtils::AddNewEnumeratorForUserDefinedEnum(Enum);
		}
		FEnumEditorUtils::SetEnumeratorDisplayName(Enum, i, FText::FromString(Entries[i]));
	}

	FAssetRegistryModule::AssetCreated(Enum);
	Package->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Enum->GetPathName());
	Result->SetStringField(TEXT("name"), AssetName);
	Result->SetNumberField(TEXT("entryCount"), Entries.Num());
	Result->SetStringField(TEXT("useAs"), FString::Printf(TEXT("enum:%s"), *AssetName));
	return MakeOkResponse(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleListEnumEntries(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return MakeErrorResponse(TEXT("missing_param: path"));
	}

	FString EnumError;
	UEnum* Enum = ResolveEnumByName(Path, EnumError);
	if (!Enum)
	{
		return MakeErrorResponse(EnumError);
	}

	TArray<TSharedPtr<FJsonValue>> Entries;
	// NumEnums() counts the implicit _MAX sentinel, which is never a value a caller should use.
	const int32 Count = Enum->NumEnums() > 0 ? Enum->NumEnums() - 1 : 0;
	for (int32 i = 0; i < Count; ++i)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetNumberField(TEXT("index"), i);
		Entry->SetStringField(TEXT("name"), Enum->GetNameStringByIndex(i));
		Entry->SetStringField(TEXT("displayName"), Enum->GetDisplayNameTextByIndex(i).ToString());
		Entry->SetNumberField(TEXT("value"), Enum->GetValueByIndex(i));
		Entries.Add(MakeShared<FJsonValueObject>(Entry));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("path"), Enum->GetPathName());
	Result->SetStringField(TEXT("name"), Enum->GetName());
	Result->SetBoolField(TEXT("editable"), Cast<UUserDefinedEnum>(Enum) != nullptr);
	Result->SetArrayField(TEXT("entries"), Entries);
	return MakeOkResponse(Result);
}
