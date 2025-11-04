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
