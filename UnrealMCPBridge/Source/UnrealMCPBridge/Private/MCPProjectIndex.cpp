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

