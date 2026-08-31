// Creating any asset the editor's own "New Asset" menu can create.
//
// This project could create eight kinds of asset - Blueprint, Widget Blueprint, Data Table, Enum,
// Struct, Material, Material Instance, Level - each by a handler that hard-codes one factory. Every
// other kind was simply unreachable, and the gap is not exotic: an ordinary UE5 request like "add a
// dash on Left Shift" needs an InputAction asset, and this server could map an input key to an
// InputAction but never make one. The feature dead-ended at step one on a modern project.
//
// The generalization is the thing the editor already does. Every creatable asset type has a UFactory
// whose GetSupportedClass() names it, and "New Asset" is a menu built by walking those factories. So
// rather than write a handler per asset type forever, this finds the factory the same way and calls
// the same IAssetTools::CreateAsset the eight specific handlers call. What the editor can make, this
// can make.
//
// Two details worth stating because both are load-bearing:
//
// CreateAsset, not CreateAssetWithDialog. The "WithDialog" form calls Factory->ConfigureProperties(),
// which opens a MODAL window - and a modal window in a headless bridge command is a hang that takes
// the editor with it. The non-dialog form skips configuration entirely, which is why the classes
// whose factories genuinely need configuring are redirected below rather than served badly here.
//
// The eight with dedicated tools are refused on purpose. A UBlueprintFactory with no ParentClass set
// and a UDataTableFactory with no RowStruct produce assets that exist and are broken, which is worse
// than an error, because the caller believes it worked. Refusing and naming the right tool is the
// pattern this project uses everywhere it can see the caller's real intent.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Factories/Factory.h"
#include "IAssetTools.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"

namespace
{
	/** The error shape the sibling ops files use; see the note in MCPAssetOps.cpp for why. */
	TSharedRef<FJsonObject> FailCreate(const TSharedRef<FJsonObject>& Result, const FString& Code, const FString& Detail)
	{
		return MCPResponse::Fail(Result, Code, Detail);
	}

	/**
	 * The asset types that already have a tool which does more than make an empty file.
	 *
	 * Keyed by class name, valued with the tool to use instead. Each of these factories needs
	 * configuration this command cannot supply - a parent class, a row struct, a parent material -
	 * and producing the unconfigured asset would be a silent half-failure.
	 */
	const TMap<FString, FString>& DedicatedTools()
	{
		static const TMap<FString, FString> Map = {
			{ TEXT("Blueprint"), TEXT("create_blueprint (it needs a parent class)") },
			{ TEXT("WidgetBlueprint"), TEXT("create_widget_blueprint") },
			{ TEXT("DataTable"), TEXT("create_data_table (it needs a row struct)") },
			{ TEXT("UserDefinedEnum"), TEXT("create_enum (it needs its entries)") },
			{ TEXT("UserDefinedStruct"), TEXT("create_struct (it needs its fields)") },
			{ TEXT("Material"), TEXT("create_material") },
			{ TEXT("MaterialInstanceConstant"), TEXT("create_material_instance (it needs a parent material)") },
			{ TEXT("World"), TEXT("create_level") },
		};
		return Map;
	}

	/** The factory that makes this exact class, or null if nothing does. */
	UFactory* FindFactoryFor(UClass* Target)
	{
		for (TObjectIterator<UClass> It; It; ++It)
		{
			UClass* Candidate = *It;
			if (!Candidate->IsChildOf(UFactory::StaticClass()))
			{
				continue;
			}
			if (Candidate->HasAnyClassFlags(CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists))
			{
				continue;
			}
			UFactory* Defaults = Candidate->GetDefaultObject<UFactory>();
			if (!Defaults || !Defaults->CanCreateNew())
			{
				continue;
			}
			// Exact match only. A factory for a parent class would produce an asset of the wrong type
			// while reporting success, and "close enough" is the failure mode this project keeps
			// finding in other people's tools.
			if (Defaults->GetSupportedClass() == Target)
			{
				return NewObject<UFactory>(GetTransientPackage(), Candidate);
			}
		}
		return nullptr;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleCreateAsset(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, ClassName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty() ||
		!Params->TryGetStringField(TEXT("assetClass"), ClassName) || ClassName.IsEmpty())
	{
		return FailCreate(Result, TEXT("missing_param"),
			TEXT("path and assetClass are both required, e.g. path \"/Game/Input/IA_Dash\", assetClass \"InputAction\"."));
	}

	// Object-path form is accepted too, because that is what arrives.
	//
	// Every path parameter in this bridge takes either "/Game/Dir/Name" or the object path
	// "/Game/Dir/Name.Name", and the MCP server normalises to the latter before sending. Splitting on
	// the last slash then handed CreateAsset an asset name of "Name.Name", which the engine refuses -
	// so this command failed for EVERY class, with an error blaming the folder.
	//
	// It read as a per-class problem right up until InputAction, CurveFloat, BlackboardData and
	// SoundCue all failed identically, and the message itself showed the doubled name.
	if (Path.Contains(TEXT(".")))
	{
		FString Left, Right;
		Path.Split(TEXT("."), &Left, &Right, ESearchCase::IgnoreCase, ESearchDir::FromEnd);
		Path = Left;
	}

	FString PackageDir, AssetName;
	if (!Path.Split(TEXT("/"), &PackageDir, &AssetName, ESearchCase::IgnoreCase, ESearchDir::FromEnd) ||
		PackageDir.IsEmpty() || AssetName.IsEmpty())
	{
		return FailCreate(Result, TEXT("bad_path"),
			FString::Printf(TEXT("\"%s\" is not a content path. Give the folder and the name together, ")
				TEXT("e.g. \"/Game/Input/IA_Dash\"."), *Path));
	}

	FString ClassError;
	UClass* Target = ResolveClassByName(ClassName, ClassError);
	if (!Target)
	{
		return FailCreate(Result, TEXT("class_not_found"),
			FString::Printf(TEXT("No class called \"%s\" (%s). Use the C++ type name without the U prefix, ")
				TEXT("e.g. \"InputAction\", \"InputMappingContext\", \"SoundCue\", \"CurveFloat\"."),
				*ClassName, *ClassError));
	}

	if (const FString* Instead = DedicatedTools().Find(Target->GetName()))
	{
		return FailCreate(Result, TEXT("use_dedicated_tool"),
			FString::Printf(TEXT("A %s made this way would be empty and broken rather than merely blank. ")
				TEXT("Use %s instead. Nothing has been created."), *Target->GetName(), **Instead));
	}

	// An existing asset is not overwritten. Creation that silently replaces work is the one mistake
	// nobody recovers from, and the caller nearly always meant a different name.
	if (FPackageName::DoesPackageExist(Path))
	{
		return FailCreate(Result, TEXT("already_exists"),
			FString::Printf(TEXT("\"%s\" already exists. Pick another name, or edit the existing asset. ")
				TEXT("Nothing has been created or overwritten."), *Path));
	}

	UFactory* Factory = FindFactoryFor(Target);
	if (!Factory)
	{
		return FailCreate(Result, TEXT("not_creatable"),
			FString::Printf(TEXT("\"%s\" is a real class, but no factory in this editor creates one, so the ")
				TEXT("New Asset menu cannot make it either. It is usually a runtime-only type, an abstract ")
				TEXT("base, or something produced by importing a file rather than creating it."),
				*Target->GetName()));
	}

	FAssetToolsModule& AssetToolsModule = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools"));
	UObject* Created = AssetToolsModule.Get().CreateAsset(AssetName, PackageDir, Target, Factory);
	if (!Created)
	{
		return FailCreate(Result, TEXT("create_failed"),
			FString::Printf(TEXT("The editor refused to create \"%s\" as a %s. The usual causes are a folder ")
				TEXT("that does not exist or a name the engine will not accept."), *Path, *Target->GetName()));
	}

	FAssetRegistryModule::AssetCreated(Created);

	Result->SetStringField(TEXT("path"), Created->GetPathName());
	Result->SetStringField(TEXT("class"), Created->GetClass()->GetName());
	// Not saved here, for the reason given in MCPAssetOps.cpp: the MCP tool calls save_asset after
	// this returns, which keeps the bridge command doing one thing and the save visible in the reply.
	Result->SetBoolField(TEXT("saved"), false);
	return MCPResponse::Ok(Result);
}
