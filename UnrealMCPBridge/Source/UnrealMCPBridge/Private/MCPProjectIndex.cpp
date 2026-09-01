#include "MCPProjectIndex.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/AssetData.h"
#include "Engine/Blueprint.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "EdGraph/EdGraphPin.h"
#include "Dom/JsonValue.h"
#include "Modules/ModuleManager.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UnrealType.h"
#include "Misc/Paths.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "K2Node_CustomEvent.h"
#include "EdGraphSchema_K2.h"
#include "Engine/TimelineTemplate.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPProjectIndex, Log, All);

/**
 * Bump this whenever the cached index format changes.
 *
 * Version 2 added Custom Events, which are callable by name and were previously invisible to
 * search_project because the index only walked FunctionGraphs.
 * Version 3 added Timelines, which live in Blueprint->Timelines and were in no list at all.
 */
static constexpr int32 MCPIndexSchemaVersion = 3;

FMCPProjectIndex* FMCPProjectIndex::Instance = nullptr;

namespace
{
	FString PinTypeToString(const FEdGraphPinType& PinType)
	{
		FString Result = PinType.PinCategory.ToString();
		if (PinType.PinSubCategory != NAME_None)
		{
			Result += TEXT(":") + PinType.PinSubCategory.ToString();
		}
		else if (PinType.PinSubCategoryObject.IsValid())
		{
			Result += TEXT(":") + PinType.PinSubCategoryObject->GetName();
		}
		if (PinType.IsArray())
		{
			Result += TEXT("[]");
		}
		return Result;
	}

	TSharedRef<FJsonObject> MakeHit(const TCHAR* Kind, const FString& Path, const FString& Name, const FString& Context)
	{
		TSharedRef<FJsonObject> Hit = MakeShared<FJsonObject>();
		Hit->SetStringField(TEXT("kind"), Kind);
		Hit->SetStringField(TEXT("path"), Path);
		Hit->SetStringField(TEXT("name"), Name);
		Hit->SetStringField(TEXT("context"), Context);
		return Hit;
	}

	// --- JSON (de)serialization for the on-disk cache ---

	TSharedRef<FJsonObject> ParamToJson(const FMCPIndexParam& P)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("name"), P.Name);
		O->SetStringField(TEXT("type"), P.Type);
		return O;
	}

	FMCPIndexParam ParamFromJson(const TSharedPtr<FJsonObject>& O)
	{
		FMCPIndexParam P;
		if (O.IsValid())
		{
			O->TryGetStringField(TEXT("name"), P.Name);
			O->TryGetStringField(TEXT("type"), P.Type);
		}
		return P;
	}

	TSharedRef<FJsonObject> FunctionToJson(const FMCPIndexFunction& F)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("name"), F.Name);
		O->SetStringField(TEXT("returnType"), F.ReturnType);
		TArray<TSharedPtr<FJsonValue>> ParamsArr;
		for (const FMCPIndexParam& P : F.Params)
		{
			ParamsArr.Add(MakeShared<FJsonValueObject>(ParamToJson(P)));
		}
		O->SetArrayField(TEXT("params"), ParamsArr);
		if (F.bIsCustomEvent)
		{
			O->SetBoolField(TEXT("isCustomEvent"), true);
		}
		return O;
	}

	FMCPIndexFunction FunctionFromJson(const TSharedPtr<FJsonObject>& O)
	{
		FMCPIndexFunction F;
		if (O.IsValid())
		{
			O->TryGetStringField(TEXT("name"), F.Name);
			O->TryGetStringField(TEXT("returnType"), F.ReturnType);
			O->TryGetBoolField(TEXT("isCustomEvent"), F.bIsCustomEvent);
			const TArray<TSharedPtr<FJsonValue>>* ParamsArr = nullptr;
			if (O->TryGetArrayField(TEXT("params"), ParamsArr) && ParamsArr)
			{
				for (const TSharedPtr<FJsonValue>& V : *ParamsArr)
				{
					if (V.IsValid())
					{
						F.Params.Add(ParamFromJson(V->AsObject()));
					}
				}
			}
		}
		return F;
	}

	TSharedRef<FJsonObject> VariableToJson(const FMCPIndexVariable& V)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("name"), V.Name);
		O->SetStringField(TEXT("type"), V.Type);
		O->SetStringField(TEXT("category"), V.Category);
		return O;
	}

	FMCPIndexVariable VariableFromJson(const TSharedPtr<FJsonObject>& O)
	{
		FMCPIndexVariable V;
		if (O.IsValid())
		{
			O->TryGetStringField(TEXT("name"), V.Name);
			O->TryGetStringField(TEXT("type"), V.Type);
			O->TryGetStringField(TEXT("category"), V.Category);
		}
		return V;
	}

	TSharedRef<FJsonObject> GraphToJson(const FMCPIndexGraph& G)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("name"), G.Name);
		O->SetNumberField(TEXT("nodeCount"), G.NodeCount);
		TSharedRef<FJsonObject> Histogram = MakeShared<FJsonObject>();
		for (const TPair<FString, int32>& Pair : G.NodeTypeHistogram)
		{
			Histogram->SetNumberField(Pair.Key, Pair.Value);
		}
		O->SetObjectField(TEXT("nodeTypeHistogram"), Histogram);
		return O;
	}

	FMCPIndexGraph GraphFromJson(const TSharedPtr<FJsonObject>& O)
	{
		FMCPIndexGraph G;
		if (O.IsValid())
		{
			O->TryGetStringField(TEXT("name"), G.Name);
			int32 NodeCount = 0;
			if (O->TryGetNumberField(TEXT("nodeCount"), NodeCount))
			{
				G.NodeCount = NodeCount;
			}
			const TSharedPtr<FJsonObject>* Histogram = nullptr;
			if (O->TryGetObjectField(TEXT("nodeTypeHistogram"), Histogram) && Histogram && Histogram->IsValid())
			{
				for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*Histogram)->Values)
				{
					if (Pair.Value.IsValid())
					{
						G.NodeTypeHistogram.Add(Pair.Key, static_cast<int32>(Pair.Value->AsNumber()));
					}
				}
			}
		}
		return G;
	}

	TSharedRef<FJsonObject> BlueprintEntryToJson(const FMCPIndexBlueprint& BP)
	{
		TSharedRef<FJsonObject> O = MakeShared<FJsonObject>();
		O->SetStringField(TEXT("path"), BP.Path);
		O->SetStringField(TEXT("name"), BP.Name);
		O->SetStringField(TEXT("parentClass"), BP.ParentClass);

		TArray<TSharedPtr<FJsonValue>> InterfacesArr;
		for (const FString& I : BP.Interfaces)
		{
			InterfacesArr.Add(MakeShared<FJsonValueString>(I));
		}
		O->SetArrayField(TEXT("interfaces"), InterfacesArr);

		TArray<TSharedPtr<FJsonValue>> FunctionsArr;
		for (const FMCPIndexFunction& F : BP.Functions)
		{
			FunctionsArr.Add(MakeShared<FJsonValueObject>(FunctionToJson(F)));
		}
		O->SetArrayField(TEXT("functions"), FunctionsArr);

		TArray<TSharedPtr<FJsonValue>> VariablesArr;
		for (const FMCPIndexVariable& V : BP.Variables)
		{
			VariablesArr.Add(MakeShared<FJsonValueObject>(VariableToJson(V)));
		}
		O->SetArrayField(TEXT("variables"), VariablesArr);

		TArray<TSharedPtr<FJsonValue>> GraphsArr;
		for (const FMCPIndexGraph& G : BP.Graphs)
		{
			GraphsArr.Add(MakeShared<FJsonValueObject>(GraphToJson(G)));
		}
		O->SetArrayField(TEXT("graphs"), GraphsArr);

		return O;
	}

	FMCPIndexBlueprint BlueprintEntryFromJson(const TSharedPtr<FJsonObject>& O)
	{
		FMCPIndexBlueprint BP;
		if (!O.IsValid())
		{
			return BP;
		}
		O->TryGetStringField(TEXT("path"), BP.Path);
		O->TryGetStringField(TEXT("name"), BP.Name);
		O->TryGetStringField(TEXT("parentClass"), BP.ParentClass);

		const TArray<TSharedPtr<FJsonValue>>* InterfacesArr = nullptr;
		if (O->TryGetArrayField(TEXT("interfaces"), InterfacesArr) && InterfacesArr)
		{
			for (const TSharedPtr<FJsonValue>& V : *InterfacesArr)
			{
				BP.Interfaces.Add(V->AsString());
			}
		}

		const TArray<TSharedPtr<FJsonValue>>* FunctionsArr = nullptr;
		if (O->TryGetArrayField(TEXT("functions"), FunctionsArr) && FunctionsArr)
		{
			for (const TSharedPtr<FJsonValue>& V : *FunctionsArr)
			{
				BP.Functions.Add(FunctionFromJson(V->AsObject()));
			}
		}

		const TArray<TSharedPtr<FJsonValue>>* VariablesArr = nullptr;
		if (O->TryGetArrayField(TEXT("variables"), VariablesArr) && VariablesArr)
		{
			for (const TSharedPtr<FJsonValue>& V : *VariablesArr)
			{
				BP.Variables.Add(VariableFromJson(V->AsObject()));
			}
		}

		const TArray<TSharedPtr<FJsonValue>>* GraphsArr = nullptr;
		if (O->TryGetArrayField(TEXT("graphs"), GraphsArr) && GraphsArr)
		{
			for (const TSharedPtr<FJsonValue>& V : *GraphsArr)
			{
				BP.Graphs.Add(GraphFromJson(V->AsObject()));
			}
		}

		return BP;
	}
}

void FMCPProjectIndex::Initialize()
{
	if (Instance)
	{
		return;
	}
	Instance = new FMCPProjectIndex();

	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
	Instance->OnAssetAddedHandle = AssetRegistry.OnAssetAdded().AddRaw(Instance, &FMCPProjectIndex::OnAssetAdded);
	Instance->OnAssetRemovedHandle = AssetRegistry.OnAssetRemoved().AddRaw(Instance, &FMCPProjectIndex::OnAssetRemoved);
	Instance->OnAssetRenamedHandle = AssetRegistry.OnAssetRenamed().AddRaw(Instance, &FMCPProjectIndex::OnAssetRenamed);
	Instance->OnAssetUpdatedHandle = AssetRegistry.OnAssetUpdated().AddRaw(Instance, &FMCPProjectIndex::OnAssetUpdated);
	Instance->OnFilesLoadedHandle = AssetRegistry.OnFilesLoaded().AddRaw(Instance, &FMCPProjectIndex::OnFilesLoaded);
}

void FMCPProjectIndex::Shutdown()
{
	if (!Instance)
	{
		return;
	}

	if (FModuleManager::Get().IsModuleLoaded(TEXT("AssetRegistry")))
	{
		IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
		AssetRegistry.OnAssetAdded().Remove(Instance->OnAssetAddedHandle);
		AssetRegistry.OnAssetRemoved().Remove(Instance->OnAssetRemovedHandle);
		AssetRegistry.OnAssetRenamed().Remove(Instance->OnAssetRenamedHandle);
		AssetRegistry.OnAssetUpdated().Remove(Instance->OnAssetUpdatedHandle);
		AssetRegistry.OnFilesLoaded().Remove(Instance->OnFilesLoadedHandle);
	}

	delete Instance;
	Instance = nullptr;
}

FMCPProjectIndex& FMCPProjectIndex::Get()
{
	check(Instance);
	return *Instance;
}

FString FMCPProjectIndex::GetIndexFilePath()
{
	return FPaths::ProjectSavedDir() / TEXT("UnrealMCPBridge") / TEXT("index.json");
}

bool FMCPProjectIndex::IsBlueprintAsset(const FAssetData& AssetData)
{
	UClass* Class = AssetData.GetClass();
	return Class && Class->IsChildOf(UBlueprint::StaticClass());
}

void FMCPProjectIndex::EnsureBuilt()
{
	if (bBuilt)
	{
		return;
	}

	if (LoadFromDisk())
	{
		bBuilt = true;
		UE_LOG(LogMCPProjectIndex, Log, TEXT("UnrealMCPBridge: loaded project index from disk (%d blueprints)"), Entries.Num());
		return;
	}

	RebuildFull();
}

void FMCPProjectIndex::RebuildFull()
{
	Entries.Empty();

	IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
	bAssetRegistryStillScanning = AssetRegistry.IsLoadingAssets();

	FARFilter Filter;
	Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
	Filter.bRecursiveClasses = true;
	Filter.PackagePaths.Add(FName(TEXT("/Game")));
	Filter.bRecursivePaths = true;

	TArray<FAssetData> Assets;
	AssetRegistry.GetAssets(Filter, Assets);

	for (const FAssetData& Asset : Assets)
	{
		IndexBlueprintByPath(Asset.GetObjectPathString());
	}

	bBuilt = true;
	UE_LOG(LogMCPProjectIndex, Log, TEXT("UnrealMCPBridge: rebuilt project index (%d blueprints, assetRegistryStillScanning=%d)"),
		Entries.Num(), bAssetRegistryStillScanning ? 1 : 0);
	SaveToDisk();
}

void FMCPProjectIndex::IndexBlueprintByPath(const FString& ObjectPath)
{
	UObject* Asset = StaticLoadObject(UBlueprint::StaticClass(), nullptr, *ObjectPath);
	UBlueprint* Blueprint = Cast<UBlueprint>(Asset);
	if (!Blueprint)
	{
		Entries.Remove(ObjectPath);
		return;
	}

	FMCPIndexBlueprint Entry;
	Entry.Path = ObjectPath;
	Entry.Name = Blueprint->GetName();
	Entry.ParentClass = Blueprint->ParentClass ? Blueprint->ParentClass->GetName() : FString();

	for (const FBPInterfaceDescription& Interface : Blueprint->ImplementedInterfaces)
	{
		if (Interface.Interface)
		{
			Entry.Interfaces.Add(Interface.Interface->GetName());
		}
	}

	for (const FBPVariableDescription& Var : Blueprint->NewVariables)
	{
		FMCPIndexVariable V;
		V.Name = Var.VarName.ToString();
		V.Type = PinTypeToString(Var.VarType);
		V.Category = Var.Category.ToString();
		Entry.Variables.Add(V);
	}

	TArray<UEdGraph*> AllGraphs;
	Blueprint->GetAllGraphs(AllGraphs);
	for (UEdGraph* Graph : AllGraphs)
	{
		if (!Graph)
		{
			continue;
		}
		FMCPIndexGraph GraphEntry;
		GraphEntry.Name = Graph->GetName();
		GraphEntry.NodeCount = Graph->Nodes.Num();
		for (UEdGraphNode* Node : Graph->Nodes)
		{
			if (!Node)
			{
				continue;
			}
			int32& Count = GraphEntry.NodeTypeHistogram.FindOrAdd(Node->GetClass()->GetName());
			Count++;
		}
		Entry.Graphs.Add(GraphEntry);
	}

	// Function params/return type come from the compiled generated class's UFunction
	// (real reflection data) rather than re-deriving them from graph pins.
	UClass* GenClass = Blueprint->GeneratedClass;
	for (UEdGraph* FuncGraph : Blueprint->FunctionGraphs)
	{
		if (!FuncGraph)
		{
			continue;
		}
		FMCPIndexFunction FuncEntry;
		FuncEntry.Name = FuncGraph->GetName();

		UFunction* Func = GenClass ? GenClass->FindFunctionByName(FName(*FuncGraph->GetName())) : nullptr;
		if (Func)
		{
			for (TFieldIterator<FProperty> PropIt(Func); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
			{
				FProperty* Prop = *PropIt;
				if (Prop->HasAnyPropertyFlags(CPF_ReturnParm))
				{
					FuncEntry.ReturnType = Prop->GetCPPType();
				}
				else
				{
					FMCPIndexParam Param;
					Param.Name = Prop->GetName();
					Param.Type = Prop->GetCPPType();
					FuncEntry.Params.Add(Param);
				}
			}
		}
		Entry.Functions.Add(FuncEntry);
	}

	// Custom Events, which are callable by name and are not in FunctionGraphs.
	//
	// They live as nodes inside the event graph, so an index built only from FunctionGraphs cannot
	// see them - and searching for one returned nothing at all. That is the worst kind of miss:
	// "CE_Server_TryPing" is the name of a whole subsystem, and a search that answers "no hits"
	// reads as "this does not exist", which is how a live feature gets rebuilt from scratch or
	// declared broken.
	for (UEdGraph* Ubergraph : Blueprint->UbergraphPages)
	{
		if (!Ubergraph)
		{
			continue;
		}
		for (UEdGraphNode* Node : Ubergraph->Nodes)
		{
			const UK2Node_CustomEvent* Event = Cast<UK2Node_CustomEvent>(Node);
			if (!Event)
			{
				continue;
			}
			FMCPIndexFunction EventEntry;
			EventEntry.Name = Event->CustomFunctionName.ToString();
			EventEntry.bIsCustomEvent = true;
			// Parameters come off the event's own output pins: an event's inputs are what it hands
			// to the chain below it, so they read as outputs on the node.
			for (UEdGraphPin* Pin : Event->Pins)
			{
				if (!Pin || Pin->Direction != EGPD_Output || Pin->PinType.PinCategory == UEdGraphSchema_K2::PC_Exec ||
					Pin->PinName == UK2Node_Event::DelegateOutputName)
				{
					continue;
				}
				FMCPIndexParam Param;
				Param.Name = Pin->PinName.ToString();
				Param.Type = UEdGraphSchema_K2::TypeToText(Pin->PinType).ToString();
				EventEntry.Params.Add(Param);
			}
			Entry.Functions.Add(EventEntry);
		}
	}

	// Timelines, which are variables with a graph-shaped life of their own.
	//
	// They are in Blueprint->Timelines and nowhere else, so searching for "TL_Aim" - a timeline that
	// exists, drives aiming, and shows up as an entry point in explain_graph - returned nothing at
	// all. Indexed as variables because that is what the graph calls them: a timeline IS a variable
	// of its own type, and a caller looking for one is asking the same question as for any other.
	for (UTimelineTemplate* Template : Blueprint->Timelines)
	{
		if (!Template)
		{
			continue;
		}
		FMCPIndexVariable TimelineEntry;
		// The variable name, not the template's object name: the template carries a "_Template"
		// suffix the editor never shows, and answering with that gives a name usable nowhere.
		TimelineEntry.Name = Template->GetVariableName().ToString();
		TimelineEntry.Type = TEXT("Timeline");
		Entry.Variables.Add(TimelineEntry);
	}

	Entries.Add(ObjectPath, MoveTemp(Entry));
}

void FMCPProjectIndex::SaveToDisk() const
{
	TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("version"), MCPIndexSchemaVersion);

	TSharedRef<FJsonObject> BlueprintsObj = MakeShared<FJsonObject>();
	for (const TPair<FString, FMCPIndexBlueprint>& Pair : Entries)
	{
		BlueprintsObj->SetObjectField(Pair.Key, BlueprintEntryToJson(Pair.Value));
	}
	Root->SetObjectField(TEXT("blueprints"), BlueprintsObj);

	FString OutStr;
	TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&OutStr);
	FJsonSerializer::Serialize(Root, Writer);

	const FString FilePath = GetIndexFilePath();
	if (!FFileHelper::SaveStringToFile(OutStr, *FilePath))
	{
		UE_LOG(LogMCPProjectIndex, Warning, TEXT("UnrealMCPBridge: failed to save project index to %s"), *FilePath);
	}
}

bool FMCPProjectIndex::LoadFromDisk()
{
	const FString FilePath = GetIndexFilePath();
	FString FileContents;
	if (!FFileHelper::LoadFileToString(FileContents, *FilePath))
	{
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	TSharedRef<TJsonReader<TCHAR>> Reader = TJsonReaderFactory<TCHAR>::Create(FileContents);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		UE_LOG(LogMCPProjectIndex, Warning, TEXT("UnrealMCPBridge: failed to parse project index cache at %s, will rebuild"), *FilePath);
		return false;
	}

	// A cache older than the format is worse than no cache.
	//
	// The version was being WRITTEN and never read. So when the index learned to record Custom
	// Events, the improvement did nothing: the editor loaded a cache built by the previous format,
	// found no events in it, and every search kept answering "no hits" - which reads exactly like
	// the change not working. The fix was to delete a file nobody knew existed, and the same trap
	// was waiting for every future change to this format.
	double CachedVersion = 0.0;
	if (!Root->TryGetNumberField(TEXT("version"), CachedVersion) || static_cast<int32>(CachedVersion) != MCPIndexSchemaVersion)
	{
		UE_LOG(LogMCPProjectIndex, Log,
			TEXT("UnrealMCPBridge: project index cache is version %d, this build writes %d - rebuilding."),
			static_cast<int32>(CachedVersion), MCPIndexSchemaVersion);
		return false;
	}

	const TSharedPtr<FJsonObject>* BlueprintsObj = nullptr;
	if (!Root->TryGetObjectField(TEXT("blueprints"), BlueprintsObj) || !BlueprintsObj || !BlueprintsObj->IsValid())
	{
		return false;
	}

	Entries.Empty();
	for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : (*BlueprintsObj)->Values)
	{
		if (Pair.Value.IsValid())
		{
			Entries.Add(Pair.Key, BlueprintEntryFromJson(Pair.Value->AsObject()));
		}
	}

	return true;
}

TArray<TSharedPtr<FJsonValue>> FMCPProjectIndex::Search(const FString& Query, int32 MaxResults) const
{
	TArray<TSharedPtr<FJsonValue>> Hits;
	const FString LowerQuery = Query.ToLower();

	for (const TPair<FString, FMCPIndexBlueprint>& Pair : Entries)
	{
		if (Hits.Num() >= MaxResults)
		{
			break;
		}
		const FMCPIndexBlueprint& BP = Pair.Value;

		if (BP.Name.ToLower().Contains(LowerQuery) || BP.ParentClass.ToLower().Contains(LowerQuery))
		{
			Hits.Add(MakeShared<FJsonValueObject>(
				MakeHit(TEXT("blueprint"), BP.Path, BP.Name, FString::Printf(TEXT("parent=%s"), *BP.ParentClass))));
		}

		for (const FMCPIndexFunction& Fn : BP.Functions)
		{
			if (Fn.Name.ToLower().Contains(LowerQuery))
			{
				Hits.Add(MakeShared<FJsonValueObject>(
					MakeHit(Fn.bIsCustomEvent ? TEXT("customEvent") : TEXT("function"), BP.Path, Fn.Name,
						FString::Printf(TEXT("%s in %s"), Fn.bIsCustomEvent ? TEXT("custom event") : TEXT("function"), *BP.Name))));
			}
		}

		for (const FMCPIndexVariable& Var : BP.Variables)
		{
			if (Var.Name.ToLower().Contains(LowerQuery))
			{
				Hits.Add(MakeShared<FJsonValueObject>(MakeHit(
					TEXT("variable"), BP.Path, Var.Name, FString::Printf(TEXT("%s variable in %s"), *Var.Type, *BP.Name))));
			}
		}
	}

	if (Hits.Num() > MaxResults)
	{
		Hits.SetNum(MaxResults);
	}
	return Hits;
}

TSharedRef<FJsonObject> FMCPProjectIndex::GetOverview() const
{
	int32 TotalFunctions = 0;
	int32 TotalVariables = 0;
	int32 TotalGraphs = 0;
	int32 TotalNodes = 0;
	TMap<FString, int32> FolderCounts;
	TMap<FString, int32> ParentClassCounts;

	// What the editor currently has, so the summary can notice when this index disagrees with it.
	//
	// This is the first call a model is told to make, and its numbers come from a cache rather than
	// from the editor. The cache follows the asset registry's add/remove/rename events, which is
	// right until something changes an asset by a path those events do not cover - and then the
	// overview reports a project that no longer exists, with nothing to suggest checking.
	//
	// Found by pointing the tools at a real 356-Blueprint project and noticing that
	// get_project_overview said 356 while list_blueprints said 355. One deleted asset. Neither number
	// was checkable from the reply, and the honest answer to "which is right" was "ask a third tool".
	//
	// Counted rather than trusted, and reported when they differ: a stale count that says it is stale
	// costs a caller one extra call, and a stale count that looks authoritative costs them the whole
	// mental model they build on top of it.
	int32 RegistryBlueprints = 0;
	{
		IAssetRegistry& AssetRegistry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry")).Get();
		TArray<FAssetData> Found;
		FARFilter Filter;
		Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
		Filter.bRecursiveClasses = true;
		Filter.PackagePaths.Add(FName(TEXT("/Game")));
		Filter.bRecursivePaths = true;
		AssetRegistry.GetAssets(Filter, Found);
		RegistryBlueprints = Found.Num();
	}

	for (const TPair<FString, FMCPIndexBlueprint>& Pair : Entries)
	{
		const FMCPIndexBlueprint& BP = Pair.Value;
		TotalFunctions += BP.Functions.Num();
		TotalVariables += BP.Variables.Num();
		TotalGraphs += BP.Graphs.Num();
		for (const FMCPIndexGraph& G : BP.Graphs)
		{
			TotalNodes += G.NodeCount;
		}

		const FString ParentKey = BP.ParentClass.IsEmpty() ? TEXT("Unknown") : BP.ParentClass;
		int32& ParentCount = ParentClassCounts.FindOrAdd(ParentKey);
		ParentCount++;

		FString Folder = TEXT("(root)");
		if (BP.Path.StartsWith(TEXT("/Game/")))
		{
			FString Trimmed = BP.Path.Mid(6);
			FString Head;
			if (Trimmed.Split(TEXT("/"), &Head, nullptr))
			{
				Folder = Head;
			}
		}
		int32& FolderCount = FolderCounts.FindOrAdd(Folder);
		FolderCount++;
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("blueprintCount"), Entries.Num());
	if (RegistryBlueprints != Entries.Num())
	{
		Result->SetNumberField(TEXT("blueprintCountInEditor"), RegistryBlueprints);
		Result->SetStringField(TEXT("indexDrift"),
			FString::Printf(
				TEXT("This summary is built from a cached index holding %d Blueprints, and the editor currently has %d. ")
				TEXT("The counts and totals below describe the cache, so treat them as approximate. unreal_list_blueprints ")
				TEXT("and unreal_list_assets read the editor directly and are authoritative."),
				Entries.Num(), RegistryBlueprints));
	}
	Result->SetNumberField(TEXT("totalFunctions"), TotalFunctions);
	Result->SetNumberField(TEXT("totalVariables"), TotalVariables);
	Result->SetNumberField(TEXT("totalGraphs"), TotalGraphs);
	Result->SetNumberField(TEXT("totalNodes"), TotalNodes);

	TArray<TSharedPtr<FJsonValue>> FolderArray;
	for (const TPair<FString, int32>& FolderPair : FolderCounts)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("folder"), FolderPair.Key);
		Entry->SetNumberField(TEXT("blueprintCount"), FolderPair.Value);
		FolderArray.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("folders"), FolderArray);

	TArray<TSharedPtr<FJsonValue>> ParentClassArray;
	for (const TPair<FString, int32>& PCPair : ParentClassCounts)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("parentClass"), PCPair.Key);
		Entry->SetNumberField(TEXT("count"), PCPair.Value);
		ParentClassArray.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("byParentClass"), ParentClassArray);

	Result->SetBoolField(TEXT("assetRegistryStillScanning"), bAssetRegistryStillScanning);

	return Result;
}

/**
 * Project-wide health scan.
 *
 * unreal_review_blueprint answers "is this one Blueprint good?". Nobody asks that first. On a
 * project someone has been building for months the real question is "where is the damage?", and
 * answering it by reviewing every Blueprint in turn costs a read per asset - exactly the
 * enumerate-everything cost this project exists to avoid.
 *
 * The index already holds a node-type histogram for every graph, computed once and kept fresh by
 * AssetRegistry delegates. So this costs nothing beyond a walk of memory that was already paid
 * for, and it answers the question directly: which Blueprints have grown past the point of being
 * readable, and which carry the cast chains an interface should have replaced.
 *
 * Every threshold below is a judgement, so each finding says what it measured. A number without
 * its reason is something a reader either obeys blindly or ignores entirely.
 */
TSharedRef<FJsonObject> FMCPProjectIndex::GetHealthReport(int32 MaxPerCategory) const
{
	const int32 Cap = FMath::Clamp(MaxPerCategory, 1, 100);

	// A graph past this many nodes cannot be read at a glance and should have been split into
	// functions. 60 is roughly one screen at a comfortable zoom.
	constexpr int32 LargeGraphNodes = 60;
	// Total nodes across a Blueprint. Past this it is a system, not a class.
	constexpr int32 LargeBlueprintNodes = 250;
	// Deliberately NOT scanned here: per-frame Tick work. The index stores node CLASSES, and
	// "Event Tick" is an event node distinguished only by its title, so this data cannot tell a
	// Tick handler from a BeginPlay handler. Guessing would produce confident false positives on
	// the one measure people most want to trust. review_blueprint reads real titles and reports
	// tick-heavy properly; this scan points you at which Blueprints to run it on.

	struct FOffender
	{
		FString Path;
		FString Name;
		int32 Value = 0;
		FString Detail;
	};

	TArray<FOffender> LargeGraphs;
	TArray<FOffender> LargeBlueprints;
	TArray<FOffender> ManyCasts;

	int32 TotalNodes = 0;

	for (const TPair<FString, FMCPIndexBlueprint>& Pair : Entries)
	{
		const FMCPIndexBlueprint& Blueprint = Pair.Value;
		int32 BlueprintNodes = 0;
		int32 BlueprintCasts = 0;

		for (const FMCPIndexGraph& Graph : Blueprint.Graphs)
		{
			BlueprintNodes += Graph.NodeCount;

			if (Graph.NodeCount >= LargeGraphNodes)
			{
				LargeGraphs.Add({ Blueprint.Path, Blueprint.Name, Graph.NodeCount,
					FString::Printf(TEXT("graph '%s' has %d nodes"), *Graph.Name, Graph.NodeCount) });
			}

			for (const TPair<FString, int32>& Entry : Graph.NodeTypeHistogram)
			{
				if (Entry.Key.Contains(TEXT("DynamicCast")))
				{
					BlueprintCasts += Entry.Value;
				}
			}
		}

		TotalNodes += BlueprintNodes;

		if (BlueprintNodes >= LargeBlueprintNodes)
		{
			LargeBlueprints.Add({ Blueprint.Path, Blueprint.Name, BlueprintNodes,
				FString::Printf(TEXT("%d nodes across %d graphs"), BlueprintNodes, Blueprint.Graphs.Num()) });
		}
		if (BlueprintCasts >= 5)
		{
			ManyCasts.Add({ Blueprint.Path, Blueprint.Name, BlueprintCasts,
				FString::Printf(TEXT("%d cast nodes"), BlueprintCasts) });
		}
	}

	auto SortAndEmit = [Cap](TArray<FOffender>& Offenders) -> TArray<TSharedPtr<FJsonValue>>
	{
		Offenders.Sort([](const FOffender& A, const FOffender& B) { return A.Value > B.Value; });
		TArray<TSharedPtr<FJsonValue>> Out;
		for (int32 i = 0; i < Offenders.Num() && i < Cap; ++i)
		{
			TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
			Entry->SetStringField(TEXT("name"), Offenders[i].Name);
			Entry->SetStringField(TEXT("path"), Offenders[i].Path);
			Entry->SetStringField(TEXT("why"), Offenders[i].Detail);
			Out.Add(MakeShared<FJsonValueObject>(Entry));
		}
		return Out;
	};

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetNumberField(TEXT("blueprintsScanned"), Entries.Num());
	Result->SetNumberField(TEXT("totalNodes"), TotalNodes);

	TSharedRef<FJsonObject> Findings = MakeShared<FJsonObject>();
	Findings->SetArrayField(TEXT("oversizedGraphs"), SortAndEmit(LargeGraphs));
	Findings->SetArrayField(TEXT("oversizedBlueprints"), SortAndEmit(LargeBlueprints));
	Findings->SetArrayField(TEXT("castHeavy"), SortAndEmit(ManyCasts));
	Result->SetObjectField(TEXT("findings"), Findings);

	TSharedRef<FJsonObject> Thresholds = MakeShared<FJsonObject>();
	Thresholds->SetStringField(TEXT("oversizedGraphs"),
		FString::Printf(TEXT("a graph with %d or more nodes: past what can be read at a glance, so it should be "
			"split into named functions"), LargeGraphNodes));
	Thresholds->SetStringField(TEXT("oversizedBlueprints"),
		FString::Printf(TEXT("a Blueprint with %d or more nodes in total: that is a system rather than a class, and "
			"is usually several responsibilities that never got separated"), LargeBlueprintNodes));
	Thresholds->SetStringField(TEXT("castHeavy"),
		TEXT("5 or more cast nodes: a chain of casts is the shape an interface exists to replace, and it grows "
			"every time a new type is added"));
	Result->SetObjectField(TEXT("thresholds"), Thresholds);

	Result->SetStringField(TEXT("note"),
		TEXT("Computed from the index's existing node-type histograms, so this costs no asset reads. These are "
			"places worth LOOKING at, not defects: a big graph can be fine. Use review_blueprint on anything here "
			"for the per-Blueprint detail, and find_references before changing something widely used."));
	// Returned raw, like GetOverview: the command handler wraps it.
	return Result;
}

void FMCPProjectIndex::OnAssetAdded(const FAssetData& AssetData)
{
	if (!bBuilt || !IsBlueprintAsset(AssetData))
	{
		return;
	}
	IndexBlueprintByPath(AssetData.GetObjectPathString());
	SaveToDisk();
}

void FMCPProjectIndex::OnAssetRemoved(const FAssetData& AssetData)
{
	if (!bBuilt)
	{
		return;
	}
	if (Entries.Remove(AssetData.GetObjectPathString()) > 0)
	{
		SaveToDisk();
	}
}

void FMCPProjectIndex::OnAssetRenamed(const FAssetData& AssetData, const FString& OldObjectPath)
{
	if (!bBuilt)
	{
		return;
	}
	Entries.Remove(OldObjectPath);
	if (IsBlueprintAsset(AssetData))
	{
		IndexBlueprintByPath(AssetData.GetObjectPathString());
	}
	SaveToDisk();
}

void FMCPProjectIndex::OnAssetUpdated(const FAssetData& AssetData)
{
	if (!bBuilt || !IsBlueprintAsset(AssetData))
	{
		return;
	}
	IndexBlueprintByPath(AssetData.GetObjectPathString());
	SaveToDisk();
}

void FMCPProjectIndex::OnFilesLoaded()
{
	// If we built (or loaded a stale cache) while the AssetRegistry was still doing its
	// initial project scan, do one authoritative rebuild now that it's complete.
	if (bBuilt && bAssetRegistryStillScanning)
	{
		RebuildFull();
	}
}

