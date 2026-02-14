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
