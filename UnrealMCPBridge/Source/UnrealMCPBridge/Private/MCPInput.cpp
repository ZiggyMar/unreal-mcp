// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Enhanced Input: the input system every modern Unreal project actually uses.
 *
 * `list_input_mappings` reads the legacy project-settings bindings, and on a real project it
 * correctly returned nothing at all - because that project, like every UE5 project made in the last
 * few years, keeps its bindings in InputMappingContext and InputAction assets. Its note said as much
 * and then pointed at `list_assets`, which finds the files and says nothing about what is in them.
 *
 * So "what is W bound to" had exactly one answer available: read_asset_properties on the context,
 * which hands back the raw export string of the Mappings array. On IMC_Default that is kilobytes of
 * this, per binding:
 *
 *   (Modifiers=("/Script/EnhancedInput.InputModifierSwizzleAxis'/Game/.../IMC_Default.IMC_Default
 *   :InputModifierSwizzleAxis_1'","/Script/EnhancedInput.InputModifierNegate'/Game/...'"),
 *   Action="/Script/EnhancedInput.InputAction'/Game/.../IA_Move.IA_Move'",Key=S)
 *
 * Every modifier carries a full object path to an instance whose only interesting fact is its class.
 * The question was "which key moves the player backwards"; the answer was several thousand tokens of
 * package paths with "Negate" buried in them.
 *
 * These three commands answer it directly, and close the loop: read what is bound, bind a key,
 * unbind one. "Bind Q to interact" is an ordinary sentence a person says, and until now nothing here
 * could act on it.
 */

#include "MCPCommandHandler.h"

#include "AssetRegistry/AssetData.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "EnhancedActionKeyMapping.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "InputTriggers.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"

namespace
{
/** Find an asset of a given class by short name, the way the struct and enum resolvers do. */
UObject* FindInputAssetByName(UClass* AssetClass, const FString& Name)
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

/** Accepts a short asset name or a full path, like every other path parameter in this bridge. */
template <typename T>
T* ResolveInputAsset(const FString& NameOrPath)
{
	if (NameOrPath.StartsWith(TEXT("/")))
	{
		FString Path = NameOrPath;
		if (!Path.Contains(TEXT(".")))
		{
			Path = FString::Printf(TEXT("%s.%s"), *NameOrPath, *FPackageName::GetShortName(NameOrPath));
		}
		return LoadObject<T>(nullptr, *Path);
	}
	return Cast<T>(FindInputAssetByName(T::StaticClass(), NameOrPath));
}

/**
 * "InputModifierNegate" -> "Negate", "InputTriggerPressed" -> "Pressed".
 *
 * The prefix is on every one of them and carries nothing: the field it appears in already says
 * whether it is a modifier or a trigger. What a reader wants is the word that distinguishes this one.
 */
FString ShortBehaviourName(const UObject* Object, const TCHAR* Prefix)
{
	if (!Object)
	{
		return FString();
	}
	FString Name = Object->GetClass()->GetName();
	Name.RemoveFromStart(Prefix);
	return Name;
}

/** "W", or "S (Negate)", or "Mouse2D (SwizzleAxis, Negate) [Pressed]". */
FString DescribeMapping(const FEnhancedActionKeyMapping& Mapping)
{
	FString Text = Mapping.Key.ToString();

	TArray<FString> ModifierNames;
	for (const TObjectPtr<UInputModifier>& Modifier : Mapping.Modifiers)
	{
		const FString Short = ShortBehaviourName(Modifier, TEXT("InputModifier"));
		if (!Short.IsEmpty())
		{
			ModifierNames.Add(Short);
		}
	}
	if (ModifierNames.Num() > 0)
	{
		Text += FString::Printf(TEXT(" (%s)"), *FString::Join(ModifierNames, TEXT(", ")));
	}

	TArray<FString> TriggerNames;
	for (const TObjectPtr<UInputTrigger>& Trigger : Mapping.Triggers)
	{
		const FString Short = ShortBehaviourName(Trigger, TEXT("InputTrigger"));
		if (!Short.IsEmpty())
		{
			TriggerNames.Add(Short);
		}
	}
	if (TriggerNames.Num() > 0)
	{
		Text += FString::Printf(TEXT(" [%s]"), *FString::Join(TriggerNames, TEXT(", ")));
	}

	return Text;
}

/** The reply every failure here shares: what was asked for, and how to find what exists. */
TSharedRef<FJsonObject> NotFound(const TCHAR* Code, const FString& Detail)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("error"), Code);
	Result->SetStringField(TEXT("detail"), Detail);
	return Result;
}
} // namespace

TSharedRef<FJsonObject> FMCPCommandHandler::HandleReadInputContext(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
	{
		return NotFound(TEXT("missing_param"),
			TEXT("Pass `path`: an InputMappingContext, by short name like \"IMC_Default\" or full path. List them with list_assets className=InputMappingContext."));
	}

	UInputMappingContext* Context = ResolveInputAsset<UInputMappingContext>(Path);
	if (!Context)
	{
		return NotFound(TEXT("context_not_found"),
			FString::Printf(
				TEXT("No InputMappingContext called \"%s\". List them with list_assets className=InputMappingContext."),
				*Path));
	}

	// Grouped by action, because that is the question. "What fires IA_Jump" has one answer and
	// "which action does W belong to" is answered by reading the same map the other way, whereas a
	// flat list of mappings makes both of them a scan.
	TMap<FString, TArray<TSharedPtr<FJsonValue>>> ByAction;
	TArray<FString> ActionOrder;
	int32 Unbound = 0;

	for (const FEnhancedActionKeyMapping& Mapping : Context->GetMappings())
	{
		if (!Mapping.Action)
		{
			// A mapping whose action asset was deleted. Real, and invisible in the editor unless you
			// scroll to it, so it is counted rather than skipped in silence.
			++Unbound;
			continue;
		}
		const FString ActionName = Mapping.Action->GetName();
		if (!ByAction.Contains(ActionName))
		{
			ActionOrder.Add(ActionName);
		}
		ByAction.FindOrAdd(ActionName).Add(MakeShared<FJsonValueString>(DescribeMapping(Mapping)));
	}

	TSharedRef<FJsonObject> Actions = MakeShared<FJsonObject>();
	for (const FString& ActionName : ActionOrder)
	{
		Actions->SetArrayField(ActionName, ByAction[ActionName]);
	}

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("context"), Context->GetName());
	Result->SetObjectField(TEXT("actions"), Actions);
	Result->SetNumberField(TEXT("mappingCount"), Context->GetMappings().Num());
	if (Unbound > 0)
	{
		Result->SetNumberField(TEXT("mappingsWithNoAction"), Unbound);
		Result->SetStringField(TEXT("warning"),
			TEXT("Some mappings point at no action - usually an InputAction asset that was deleted. They do nothing, and they are easy to miss in the editor."));
	}
	return Result;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleMapInputKey(const TSharedPtr<FJsonObject>& Params)
{
	FString ContextPath, ActionPath, KeyName;
	if (!Params.IsValid()
		|| !Params->TryGetStringField(TEXT("path"), ContextPath)
		|| !Params->TryGetStringField(TEXT("action"), ActionPath)
		|| !Params->TryGetStringField(TEXT("key"), KeyName))
	{
		return NotFound(TEXT("missing_param"),
			TEXT("Pass `path` (the InputMappingContext), `action` (the InputAction) and `key` (e.g. \"Q\", \"SpaceBar\", \"Gamepad_FaceButton_Bottom\")."));
	}

	UInputMappingContext* Context = ResolveInputAsset<UInputMappingContext>(ContextPath);
	if (!Context)
	{
		return NotFound(TEXT("context_not_found"),
			FString::Printf(TEXT("No InputMappingContext called \"%s\"."), *ContextPath));
	}

	UInputAction* Action = ResolveInputAsset<UInputAction>(ActionPath);
	if (!Action)
	{
		return NotFound(TEXT("action_not_found"),
			FString::Printf(
				TEXT("No InputAction called \"%s\". List them with list_assets className=InputAction."),
				*ActionPath));
	}

	// A misspelled key is the failure that matters here, because FKey accepts any FName without
	// complaint and a binding to a key that does not exist is silent in every direction: it compiles,
	// it saves, it shows in the editor, and it never fires. EKeys knows every real key, so ask it.
	const FKey Key(*KeyName);
	if (!EKeys::GetKeyDetails(Key).IsValid())
	{
		return NotFound(TEXT("unknown_key"),
			FString::Printf(
				TEXT("\"%s\" is not a key this engine knows. Keys are named as the editor names them - \"Q\", \"SpaceBar\", \"LeftMouseButton\", \"Gamepad_FaceButton_Bottom\" - and a binding to a key that does not exist saves happily and never fires."),
				*KeyName));
	}

	// Already there? Say so rather than adding a duplicate: two identical mappings both fire, which
	// is a bug that looks like the action triggering twice for no reason.
	for (const FEnhancedActionKeyMapping& Existing : Context->GetMappings())
	{
		if (Existing.Action == Action && Existing.Key == Key)
		{
			TSharedRef<FJsonObject> Already = MakeShared<FJsonObject>();
			Already->SetBoolField(TEXT("changed"), false);
			Already->SetStringField(TEXT("note"),
				FString::Printf(TEXT("%s is already mapped to %s in %s. Nothing was added - a duplicate mapping fires twice."),
					*KeyName, *Action->GetName(), *Context->GetName()));
			return Already;
		}
	}

	Context->Modify();
	FEnhancedActionKeyMapping& Mapping = Context->MapKey(Action, Key);

	TArray<FString> Applied;
	const TArray<TSharedPtr<FJsonValue>>* ModifierNames = nullptr;
	if (Params->TryGetArrayField(TEXT("modifiers"), ModifierNames))
	{
		for (const TSharedPtr<FJsonValue>& Value : *ModifierNames)
		{
			const FString Wanted = Value->AsString();
			FString ClassError;
			// Accept "Negate" as well as "InputModifierNegate": the read prints the short form, so
			// the short form has to be the one the write takes.
			UClass* ModifierClass = ResolveClassByName(FString(TEXT("InputModifier")) + Wanted, ClassError);
			if (!ModifierClass)
			{
				ModifierClass = ResolveClassByName(Wanted, ClassError);
			}
			if (!ModifierClass || !ModifierClass->IsChildOf(UInputModifier::StaticClass()))
			{
				return NotFound(TEXT("unknown_modifier"),
					FString::Printf(
						TEXT("\"%s\" is not an input modifier. The common ones are Negate, SwizzleAxis, DeadZone, Scalar and SmoothDelta. The key was mapped before this failed, so re-read the context."),
						*Wanted));
			}
			Mapping.Modifiers.Add(NewObject<UInputModifier>(Context, ModifierClass));
			Applied.Add(Wanted);
		}
	}

	Context->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("changed"), true);
	Result->SetStringField(TEXT("context"), Context->GetName());
	Result->SetStringField(TEXT("action"), Action->GetName());
	Result->SetStringField(TEXT("key"), Key.ToString());
	if (Applied.Num() > 0)
	{
		Result->SetStringField(TEXT("modifiers"), FString::Join(Applied, TEXT(", ")));
	}
	// The asset is dirty, not written. Saying so is the difference between a change that survives a
	// restart and one that does not.
	Result->SetStringField(TEXT("next"),
		TEXT("Save it with save_asset, or the mapping is lost when the editor closes."));
	return Result;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleUnmapInputKey(const TSharedPtr<FJsonObject>& Params)
{
	FString ContextPath, ActionPath, KeyName;
	if (!Params.IsValid()
		|| !Params->TryGetStringField(TEXT("path"), ContextPath)
		|| !Params->TryGetStringField(TEXT("action"), ActionPath)
		|| !Params->TryGetStringField(TEXT("key"), KeyName))
	{
		return NotFound(TEXT("missing_param"),
			TEXT("Pass `path` (the InputMappingContext), `action` (the InputAction) and `key`."));
	}

	UInputMappingContext* Context = ResolveInputAsset<UInputMappingContext>(ContextPath);
	if (!Context)
	{
		return NotFound(TEXT("context_not_found"),
			FString::Printf(TEXT("No InputMappingContext called \"%s\"."), *ContextPath));
	}
	UInputAction* Action = ResolveInputAsset<UInputAction>(ActionPath);
	if (!Action)
	{
		return NotFound(TEXT("action_not_found"),
			FString::Printf(TEXT("No InputAction called \"%s\"."), *ActionPath));
	}

	const FKey Key(*KeyName);
	// Was it actually bound? UnmapKey on a mapping that is not there does nothing and reports
	// nothing, so a caller who misspelled the key would be told the unbinding succeeded.
	bool bFound = false;
	for (const FEnhancedActionKeyMapping& Existing : Context->GetMappings())
	{
		if (Existing.Action == Action && Existing.Key == Key)
		{
			bFound = true;
			break;
		}
	}
	if (!bFound)
	{
		TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
		Result->SetBoolField(TEXT("changed"), false);
		Result->SetStringField(TEXT("note"),
			FString::Printf(TEXT("%s was not mapped to %s in %s, so nothing was removed. Read the context to see what is."),
				*KeyName, *Action->GetName(), *Context->GetName()));
		return Result;
	}

	Context->Modify();
	Context->UnmapKey(Action, Key);
	Context->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetBoolField(TEXT("changed"), true);
	Result->SetStringField(TEXT("context"), Context->GetName());
	Result->SetStringField(TEXT("action"), Action->GetName());
	Result->SetStringField(TEXT("key"), Key.ToString());
	Result->SetStringField(TEXT("next"), TEXT("Save it with save_asset."));
	return Result;
}
