// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Getting a file into the project, which nothing here could do.
 *
 * Every other command in this bridge operates on assets that already exist. There was no way to turn
 * a PNG on disk into a Texture2D, which means the answer to "here is the arrow texture, use it" was
 * to ask a person to drag it into the Content Browser by hand. For a tool whose claim is that it
 * supports what a person has in the editor, import is not an advanced feature - it is the front door.
 *
 * Textures are the common case and the one that prompted this, but the same task handles meshes,
 * sounds and anything else the engine has a factory for, so nothing here is texture-specific.
 *
 * ## Why it reports the objects rather than "ok"
 *
 * An import that produces no object is the failure that matters: a wrong path, an unsupported format,
 * or a factory that declined all report through an empty result rather than an error. Returning the
 * created object paths makes the difference between "imported" and "did nothing" visible, and gives
 * the caller the path it needs for the very next call.
 */

#include "MCPCommandHandler.h"

#include "AssetToolsModule.h"
#include "AssetRegistry/AssetData.h"
#include "Engine/Texture2D.h"
#include "AssetImportTask.h"
#include "HAL/FileManager.h"
#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "UObject/Package.h"

#include "MCPResponse.h"

TSharedRef<FJsonObject> FMCPCommandHandler::HandleImportAsset(const TSharedPtr<FJsonObject>& Params)
{
	FString SourceFile, DestinationPath;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("sourceFile"), SourceFile))
	{
		return MCPResponse::Fail(MakeShared<FJsonObject>(), TEXT("missing_sourceFile"),
			TEXT("import_asset needs `sourceFile`, an absolute path on disk, e.g. C:/Users/me/Desktop/arrow.png."));
	}
	if (!Params->TryGetStringField(TEXT("destinationPath"), DestinationPath))
	{
		return MCPResponse::Fail(MakeShared<FJsonObject>(), TEXT("missing_destinationPath"),
			TEXT("import_asset needs `destinationPath`, a content folder, e.g. /Game/UI/Textures."));
	}

	FPaths::NormalizeFilename(SourceFile);
	if (!IFileManager::Get().FileExists(*SourceFile))
	{
		return MCPResponse::Fail(MakeShared<FJsonObject>(), TEXT("source_not_found"),
			FString::Printf(TEXT("No file at %s. The path is on the machine running the EDITOR, and it must be absolute."), *SourceFile));
	}

	// A content path, not a disk path. Getting this wrong writes into a folder nobody looks in.
	if (!DestinationPath.StartsWith(TEXT("/Game")))
	{
		return MCPResponse::Fail(MakeShared<FJsonObject>(), TEXT("bad_destination"),
			FString::Printf(TEXT("destinationPath must be a content path starting with /Game, not '%s'. /Game is the project's Content folder."), *DestinationPath));
	}

	UAssetImportTask* Task = NewObject<UAssetImportTask>();
	Task->Filename = SourceFile;
	Task->DestinationPath = DestinationPath;
	// Unattended: an import dialog would block the game thread exactly the way the PIE compile dialog
	// does, and nothing here could dismiss it.
	Task->bAutomated = true;
	Task->bSave = false;
	Task->bReplaceExisting = true;

	FString AssetName;
	if (Params->TryGetStringField(TEXT("assetName"), AssetName) && !AssetName.IsEmpty())
	{
		Task->DestinationName = AssetName;
	}

	FAssetToolsModule& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
	TArray<UAssetImportTask*> Tasks;
	Tasks.Add(Task);
	AssetTools.Get().ImportAssetTasks(Tasks);

	TArray<TSharedPtr<FJsonValue>> Imported;
	for (UObject* Object : Task->GetObjects())
	{
		if (Object)
		{
			Imported.Add(MakeShared<FJsonValueString>(Object->GetPathName()));
		}
	}

	if (Imported.Num() == 0)
	{
		return MCPResponse::Fail(MakeShared<FJsonObject>(), TEXT("import_produced_nothing"),
			FString::Printf(TEXT("The engine accepted the task for %s but created no asset. Usually an unsupported format, or a file the factory declined. Nothing was added."), *SourceFile));
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("next"),
		TEXT("save_asset to keep it - the import is in memory until then. For a texture destined for a UI or decal material, check its compression and sRGB settings with read_asset_properties."));
	Result->SetArrayField(TEXT("imported"), Imported);
	Result->SetStringField(TEXT("sourceFile"), SourceFile);
	return MCPResponse::Ok(Result);
}
