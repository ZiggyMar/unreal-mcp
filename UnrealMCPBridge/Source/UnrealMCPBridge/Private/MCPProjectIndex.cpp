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

DEFINE_LOG_CATEGORY_STATIC(LogMCPProjectIndex, Log, All);

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
		return O;
	}

	FMCPIndexFunction FunctionFromJson(const TSharedPtr<FJsonObject>& O)
	{
		FMCPIndexFunction F;
		if (O.IsValid())
		{
			O->TryGetStringField(TEXT("name"), F.Name);
			O->TryGetStringField(TEXT("returnType"), F.ReturnType);
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

	Entries.Add(ObjectPath, MoveTemp(Entry));
}

void FMCPProjectIndex::SaveToDisk() const
{
	TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetNumberField(TEXT("version"), 1);

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
					MakeHit(TEXT("function"), BP.Path, Fn.Name, FString::Printf(TEXT("function in %s"), *BP.Name))));
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
