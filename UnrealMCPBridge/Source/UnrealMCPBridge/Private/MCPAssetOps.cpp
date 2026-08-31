// Renaming and duplicating an asset: the two content-browser operations that were missing.
//
// A person working in Unreal renames and duplicates constantly, and neither was reachable. The gap
// showed up from the other end: "rename FireRate to RateOfFire" is one of the sentences the change
// request routing was built and tested against, and the tools it pointed at could find the thing and
// then not change it. Duplicating matters for the other half - the plan for "add a new shop upgrade"
// says to extend what exists, and duplicating BP_DamageUpgrade is exactly how a person starts.
//
// Both go through FAssetToolsModule rather than moving files, because that is what fixes up the
// references. A rename that leaves every referencing Blueprint pointing at the old path has not
// renamed anything, it has broken the project - and doing it by hand is precisely the kind of
// half-correct operation this plugin exists not to offer.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Editor.h"
#include "IAssetTools.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"

namespace
{
	/**
	 * Set the error shape the other handlers in this plugin use.
	 *
	 * MakeErrorResponse and MakeOkResponse live in an anonymous namespace inside
	 * MCPCommandHandler.cpp, so a separate translation unit cannot call them - which is why every
	 * sibling file here (MCPSequence.cpp, MCPInput.cpp, MCPConsole.cpp) builds its own object and sets
	 * `error` and `detail` directly. This does the same, in one place rather than at every return.
	 */
	TSharedRef<FJsonObject> Fail(const TSharedRef<FJsonObject>& Result, const FString& Detail)
	{
		// The code is the part before the colon, which is how every other error in this plugin reads.
		FString Code = Detail;
		FString Rest;
		if (!Detail.Split(TEXT(": "), &Code, &Rest))
		{
			Code = TEXT("error");
			Rest = Detail;
		}
		return MCPResponse::Fail(Result, Code, Rest.IsEmpty() ? Detail : Rest);
	}

	/** The folder part of a package path: /Game/Dir/Name -> /Game/Dir. */
	FString PackageFolderOf(const FString& PackagePath)
	{
		int32 Slash = INDEX_NONE;
		return PackagePath.FindLastChar('/', Slash) ? PackagePath.Left(Slash) : PackagePath;
	}

	/**
	 * Load the asset a request names, or say why not in the terms the caller used.
	 *
	 * Every path parameter reaching this plugin has already been expanded to the long object form by
	 * the MCP server, so /Game/Dir/BP_Thing arrives as /Game/Dir/BP_Thing.BP_Thing. Both are accepted
	 * anyway: a bridge that only worked when something upstream had tidied its input would be a trap
	 * for anyone calling it directly.
	 */
	UObject* LoadAssetForOps(const FString& Path, FString& OutError)
	{
		UObject* Asset = StaticLoadObject(UObject::StaticClass(), nullptr, *Path);
		if (!Asset && !Path.Contains(TEXT(".")))
		{
			FString Leaf;
			int32 Slash = INDEX_NONE;
			if (Path.FindLastChar('/', Slash))
			{
				Leaf = Path.Mid(Slash + 1);
				Asset = StaticLoadObject(UObject::StaticClass(), nullptr, *FString::Printf(TEXT("%s.%s"), *Path, *Leaf));
			}
		}
		if (!Asset)
		{
			OutError = FString::Printf(
				TEXT("asset_not_found: %s. Use a full object path like /Game/Data/DT_Items.DT_Items, or the ")
				TEXT("short form /Game/Data/DT_Items. list_assets and list_blueprints show the real ones."),
				*Path);
		}
		return Asset;
	}

	/** Refuse a destination that is already taken, rather than letting AssetTools silently suffix it. */
	bool DestinationIsFree(const FString& PackagePath, FString& OutError)
	{
		if (FPackageName::DoesPackageExist(PackagePath))
		{
			OutError = FString::Printf(
				TEXT("destination_exists: %s already exists. Pick another name, or delete that asset first ")
				TEXT("with delete_asset. Nothing has been changed."),
				*PackagePath);
			return false;
		}
		return true;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRenameAsset(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return Fail(Result, TEXT("missing_param: path"));
	}

	FString NewName;
	FString NewFolder;
	const bool bHasName = Params->TryGetStringField(TEXT("newName"), NewName) && !NewName.IsEmpty();
	const bool bHasFolder = Params->TryGetStringField(TEXT("newFolder"), NewFolder) && !NewFolder.IsEmpty();
	if (!bHasName && !bHasFolder)
	{
		return Fail(Result, TEXT("missing_param: newName or newFolder. Give newName to rename in place, newFolder to move ")
			TEXT("without renaming, or both."));
	}

	FString LoadError;
	UObject* Asset = LoadAssetForOps(Path, LoadError);
	if (!Asset)
	{
		return Fail(Result, LoadError);
	}

	const FString OldPackage = Asset->GetOutermost()->GetName();
	const FString TargetFolder = bHasFolder ? NewFolder : PackageFolderOf(OldPackage);
	const FString TargetName = bHasName ? NewName : Asset->GetName();
	const FString TargetPackage = FString::Printf(TEXT("%s/%s"), *TargetFolder, *TargetName);

	if (TargetPackage == OldPackage)
	{
		return Fail(Result, FString::Printf(
			TEXT("no_change: %s is already its name and folder. Nothing was done."), *OldPackage));
	}

	FString Taken;
	if (!DestinationIsFree(TargetPackage, Taken))
	{
		return Fail(Result, Taken);
	}

	// Through AssetTools, because that is what fixes up every reference to the old path. Renaming the
	// package by hand leaves every referencing Blueprint pointing at something that no longer exists,
	// which looks like it worked until the next time anything loads.
	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
	TArray<FAssetRenameData> Renames;
	Renames.Emplace(Asset, TargetFolder, TargetName);

	const bool bRenamed = AssetToolsModule.Get().RenameAssets(Renames);
	if (!bRenamed)
	{
		return Fail(Result, FString::Printf(
			TEXT("rename_failed: the editor refused to rename %s to %s. The usual cause is the asset being ")
			TEXT("open in an editor tab, or a referencing package that is checked out by someone else. ")
			TEXT("Nothing has been changed."),
			*OldPackage, *TargetPackage));
	}

	Result->SetStringField(TEXT("from"), OldPackage);
	Result->SetStringField(TEXT("to"), Asset->GetOutermost()->GetName());
	Result->SetStringField(TEXT("path"), Asset->GetPathName());
	Result->SetStringField(TEXT("class"), Asset->GetClass()->GetName());
	// Deliberately not saved here.
	//
	// A rename that fixed every reference and was never written to disk looks correct in this session
	// and reverts on restart, so saving is not optional - but SaveAssetPackage lives in an anonymous
	// namespace in MCPCommandHandler.cpp, and prying it out of a five-thousand-line file to share it
	// is a bigger and riskier edit than the feature. The MCP tool calls save_asset after this
	// returns, which is the composite pattern this project already uses everywhere, keeps the bridge
	// command doing one thing, and makes the save visible in the reply rather than implied.
	return MCPResponse::Ok(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleDuplicateAsset(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return Fail(Result, TEXT("missing_param: path"));
	}

	FString NewName;
	if (!Params->TryGetStringField(TEXT("newName"), NewName) || NewName.IsEmpty())
	{
		return Fail(Result, TEXT("missing_param: newName - what the copy should be called."));
	}

	FString LoadError;
	UObject* Asset = LoadAssetForOps(Path, LoadError);
	if (!Asset)
	{
		return Fail(Result, LoadError);
	}

	const FString SourcePackage = Asset->GetOutermost()->GetName();
	FString TargetFolder;
	if (!Params->TryGetStringField(TEXT("newFolder"), TargetFolder) || TargetFolder.IsEmpty())
	{
		TargetFolder = PackageFolderOf(SourcePackage);
	}

	const FString TargetPackage = FString::Printf(TEXT("%s/%s"), *TargetFolder, *NewName);
	FString Taken;
	if (!DestinationIsFree(TargetPackage, Taken))
	{
		return Fail(Result, Taken);
	}

	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
	UObject* Copy = AssetToolsModule.Get().DuplicateAsset(NewName, TargetFolder, Asset);
	if (!Copy)
	{
		return Fail(Result, FString::Printf(
			TEXT("duplicate_failed: the editor refused to copy %s to %s. Nothing has been changed."),
			*SourcePackage, *TargetPackage));
	}

	Result->SetStringField(TEXT("from"), SourcePackage);
	Result->SetStringField(TEXT("path"), Copy->GetPathName());
	Result->SetStringField(TEXT("class"), Copy->GetClass()->GetName());
	// Not saved here either; the MCP tool saves. See the note in HandleRenameAsset.
	return MCPResponse::Ok(Result);
}
