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
