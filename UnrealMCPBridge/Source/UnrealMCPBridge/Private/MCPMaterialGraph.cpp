// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Authoring material graphs, which nothing here could do.
 *
 * `create_material` makes a material with a few fixed expressions - a colour parameter, a roughness
 * scalar, an optional texture sample - and that is the whole surface. Anything a material is actually
 * FOR is out of reach: a Panner, a TexCoord, Time, a Sine, a mask into opacity. Asked for floor
 * arrows that scroll toward a target - one of the most ordinary effects in a game - the honest answer
 * was that this tool cannot make that material, and the workaround was a flat ribbon.
 *
 * That is a hole in the claim that this supports what a person has in the editor, and it is a wide
 * one: masked foliage, panning water, blinking indicators, dissolves, UV animation of any kind.
 *
 * ## The shape
 *
 * One call, mirroring `build_graph` on the Blueprint side, because the alternative is a call per node
 * plus a call per wire and a caller that has to keep the ids straight. Refs are local to the call:
 *
 *   nodes:       [{ ref, type, x, y, properties }]
 *   connections: [{ from, fromOutput, to, toInput }]
 *   outputs:     [{ from, fromOutput, property }]
 *   settings:    { blendMode, shadingModel, twoSided }
 *
 * `type` is the expression class without its prefix - "Panner" finds UMaterialExpressionPanner. The
 * class is resolved by name rather than switched on, so every expression the engine has is reachable
 * the day it exists, and a typo is answered with what was actually looked for.
 *
 * ## Settings are not an afterthought
 *
 * `blendMode` and `shadingModel` are here because the graph alone is not the effect. Chevrons with an
 * alpha mask render as an opaque rectangle until the blend mode is Masked, and a floor marker reads
 * as mud until the shading model is Unlit. Both are one property on the material and both are
 * invisible in the graph, which is exactly the kind of thing a caller forgets and then cannot see.
 */

#include "MCPCommandHandler.h"

#include "AssetRegistry/AssetData.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpression.h"
#include "ScopedTransaction.h"
#include "UObject/UnrealType.h"

#include "MCPResponse.h"

namespace
{
/**
 * Refuse with a code and a sentence, carrying no partial result.
 *
 * Every refusal in this file happens before anything is written, so there is nothing partial to
 * report - unlike remove_function, where the refusal's payload is the whole point.
 */
TSharedRef<FJsonObject> Refuse(const FString& Code, const FString& Detail)
{
	return MCPResponse::Fail(MakeShared<FJsonObject>(), Code, Detail);
}

/** Stand-in for an absent array, so callers can bind a reference without testing for null first. */
const TArray<TSharedPtr<FJsonValue>> EmptyJsonArray;

/**
 * Accept the word a person says, not the engine's identifier.
 *
 * "Masked" is what the editor's own dropdown shows and what anyone would type; `BLEND_Masked` is the
 * enum. Demanding the latter makes the caller guess a prefix, and the first attempt at this command
 * failed on exactly that - after it had already created ten expressions.
 *
 * The engine spelling is still accepted, so nothing that worked stops working.
 */
struct FEnumAlias
{
	const TCHAR* Friendly;
	const TCHAR* Engine;
};

const FEnumAlias BlendModeAliases[] = {
	{ TEXT("Opaque"), TEXT("BLEND_Opaque") },
	{ TEXT("Masked"), TEXT("BLEND_Masked") },
	{ TEXT("Translucent"), TEXT("BLEND_Translucent") },
	{ TEXT("Additive"), TEXT("BLEND_Additive") },
	{ TEXT("Modulate"), TEXT("BLEND_Modulate") },
	{ TEXT("AlphaComposite"), TEXT("BLEND_AlphaComposite") },
	{ TEXT("AlphaHoldout"), TEXT("BLEND_AlphaHoldout") },
};

const FEnumAlias ShadingModelAliases[] = {
	{ TEXT("Unlit"), TEXT("MSM_Unlit") },
	{ TEXT("DefaultLit"), TEXT("MSM_DefaultLit") },
	{ TEXT("Subsurface"), TEXT("MSM_Subsurface") },
	{ TEXT("PreintegratedSkin"), TEXT("MSM_PreintegratedSkin") },
	{ TEXT("ClearCoat"), TEXT("MSM_ClearCoat") },
	{ TEXT("SubsurfaceProfile"), TEXT("MSM_SubsurfaceProfile") },
	{ TEXT("TwoSidedFoliage"), TEXT("MSM_TwoSidedFoliage") },
	{ TEXT("Hair"), TEXT("MSM_Hair") },
	{ TEXT("Cloth"), TEXT("MSM_Cloth") },
	{ TEXT("Eye"), TEXT("MSM_Eye") },
	{ TEXT("SingleLayerWater"), TEXT("MSM_SingleLayerWater") },
};

/** Resolve a setting to its engine spelling, or list what was allowed. Nothing is written here. */
template <int32 N>
bool ResolveEnumSetting(const FEnumAlias (&Aliases)[N], const FString& Given, const TCHAR* What,
	FString& OutValue, FString& OutError)
{
	for (const FEnumAlias& Alias : Aliases)
	{
		if (Given.Equals(Alias.Friendly, ESearchCase::IgnoreCase) || Given.Equals(Alias.Engine, ESearchCase::IgnoreCase))
		{
			OutValue = Alias.Engine;
			return true;
		}
	}
	TArray<FString> Allowed;
	for (const FEnumAlias& Alias : Aliases)
	{
		Allowed.Add(Alias.Friendly);
	}
	OutError = FString::Printf(TEXT("'%s' is not a %s. These are: %s. Nothing was changed."),
		*Given, What, *FString::Join(Allowed, TEXT(", ")));
	return false;
}

/** `nodes`, `connections` and `outputs` are all optional; absent reads as empty, never as an error. */
const TArray<TSharedPtr<FJsonValue>>& ArrayFieldOrEmpty(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field)
{
	const TArray<TSharedPtr<FJsonValue>>* Found = nullptr;
	return Params->TryGetArrayField(Field, Found) && Found ? *Found : EmptyJsonArray;
}

/** Every material output this understands, spelled as the editor spells it. */
struct FMaterialOutputTarget
{
	const TCHAR* Name;
	EMaterialProperty Property;
};

const FMaterialOutputTarget MaterialOutputs[] = {
	{ TEXT("BaseColor"), MP_BaseColor },
	{ TEXT("Metallic"), MP_Metallic },
	{ TEXT("Specular"), MP_Specular },
	{ TEXT("Roughness"), MP_Roughness },
	{ TEXT("EmissiveColor"), MP_EmissiveColor },
	{ TEXT("Opacity"), MP_Opacity },
	{ TEXT("OpacityMask"), MP_OpacityMask },
	{ TEXT("Normal"), MP_Normal },
	{ TEXT("WorldPositionOffset"), MP_WorldPositionOffset },
	{ TEXT("AmbientOcclusion"), MP_AmbientOcclusion },
};

/**
 * Find a material expression class from the short name a person would say.
 *
 * Resolved by name instead of a switch so the whole expression library is reachable, including
 * whatever the next engine version adds. Tries the plain name first, then the Parameter variants,
 * because "TextureSample" and "TextureSampleParameter2D" are both things callers reasonably type.
 */
UClass* FindExpressionClass(const FString& TypeName)
{
	const FString Trimmed = TypeName.TrimStartAndEnd();
	if (Trimmed.IsEmpty())
	{
		return nullptr;
	}

	// Accept both "Panner" and "MaterialExpressionPanner".
	FString Bare = Trimmed;
	Bare.RemoveFromStart(TEXT("MaterialExpression"));

	const FString Candidates[] = {
		FString::Printf(TEXT("/Script/Engine.MaterialExpression%s"), *Bare),
		FString::Printf(TEXT("/Script/Engine.MaterialExpression%sParameter"), *Bare),
	};

	for (const FString& Path : Candidates)
	{
		if (UClass* Found = FindObject<UClass>(nullptr, *Path))
		{
			if (Found->IsChildOf(UMaterialExpression::StaticClass()))
			{
				return Found;
			}
		}
	}
	return nullptr;
}

/** Expression type names that exist, for a "did you mean" that is derived rather than typed out. */
TArray<FString> SimilarExpressionTypes(const FString& TypeName)
{
	FString Bare = TypeName.TrimStartAndEnd();
	Bare.RemoveFromStart(TEXT("MaterialExpression"));
	const FString Lower = Bare.ToLower();

	TArray<FString> Similar;
	for (TObjectIterator<UClass> It; It; ++It)
	{
		UClass* Class = *It;
		if (!Class->IsChildOf(UMaterialExpression::StaticClass()) || Class->HasAnyClassFlags(CLASS_Abstract))
		{
			continue;
		}
		FString Name = Class->GetName();
		Name.RemoveFromStart(TEXT("MaterialExpression"));
		// Substring either way: a caller who typed too much ("PannerNode") and one who typed too
		// little ("Pan") are both looking for Panner.
		if (Name.ToLower().Contains(Lower) || (Lower.Len() >= 3 && Lower.Contains(Name.ToLower())))
		{
			Similar.Add(Name);
			if (Similar.Num() >= 8)
			{
				break;
			}
		}
	}
	Similar.Sort();
	return Similar;
}

/**
 * Set one property by name, reporting what actually went wrong.
 *
 * Takes a UObject rather than an expression because the material itself needs the same treatment -
 * BlendMode and ShadingModel are ordinary reflected properties, and duplicating this for them would
 * mean two places to get the silent-None guard wrong.
 */
bool SetPropertyByName(UObject* Target, const FString& Name, const FString& Value, FString& OutError)
{
	FProperty* Property = Target->GetClass()->FindPropertyByName(FName(*Name));
	if (!Property)
	{
		TArray<FString> Names;
		for (TFieldIterator<FProperty> It(Target->GetClass()); It; ++It)
		{
			Names.Add(It->GetName());
		}
		Names.Sort();
		OutError = FString::Printf(TEXT("no property '%s' on %s (it has: %s)"),
			*Name, *Target->GetClass()->GetName(),
			*FString::Join(Names, TEXT(", ")));
		return false;
	}

	Target->Modify();
	void* ValuePtr = Property->ContainerPtrToValuePtr<void>(Target);

	// Same silent-None guard as set_asset_property: ImportText on an object property with an
	// unresolvable path "succeeds" by writing null, which reads back as a call that set nothing.
	const FObjectPropertyBase* ObjectProperty = CastField<FObjectPropertyBase>(Property);
	if (!Property->ImportText_Direct(*Value, ValuePtr, Target, PPF_None))
	{
		OutError = FString::Printf(TEXT("could not parse '%s' as %s for '%s'"),
			*Value, *Property->GetCPPType(), *Name);
		return false;
	}
	if (ObjectProperty && !Value.Equals(TEXT("None"), ESearchCase::IgnoreCase))
	{
		if (ObjectProperty->GetObjectPropertyValue(ValuePtr) == nullptr)
		{
			OutError = FString::Printf(TEXT("'%s' did not resolve to an asset for '%s' - it was left unset rather than silently None"),
				*Value, *Name);
			return false;
		}
	}
	return true;
}

} // namespace

TSharedRef<FJsonObject> FMCPCommandHandler::HandleBuildMaterialGraph(const TSharedPtr<FJsonObject>& Params)
{
	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path))
	{
		return Refuse(TEXT("missing_path"),
			TEXT("build_material_graph needs `path`, the material to author, e.g. /Game/UI/M_Arrow."));
	}

	UMaterial* Material = LoadObject<UMaterial>(nullptr, *Path);
	if (!Material)
	{
		// A package path without the object name is the common shape, so try it before failing.
		FString Retry = Path;
		int32 Slash = INDEX_NONE;
		if (Retry.FindLastChar('/', Slash))
		{
			Retry = FString::Printf(TEXT("%s.%s"), *Path, *Path.Mid(Slash + 1));
			Material = LoadObject<UMaterial>(nullptr, *Retry);
		}
	}
	if (!Material)
	{
		return Refuse(TEXT("material_not_found"),
			FString::Printf(TEXT("No Material at %s. create_material makes one; this authors its graph. A MaterialInstance cannot be authored this way - instances only override parameters their parent declares."), *Path));
	}

	// --- validate settings BEFORE touching anything ------------------------------------------
	//
	// The first version applied these last, and the first real call proved why that is wrong: it
	// created ten expressions and then refused on a blend-mode spelling, leaving the material in a
	// state the caller could not see and could not safely retry - re-running would have duplicated
	// every parameter. Anything that can be checked without writing is checked here, so a refusal
	// means nothing happened.
	FString ResolvedBlendMode;
	FString ResolvedShadingModel;
	bool bHasTwoSided = false;
	bool bWantTwoSided = false;

	const TSharedPtr<FJsonObject>* Settings = nullptr;
	if (Params->TryGetObjectField(TEXT("settings"), Settings) && Settings)
	{
		FString Given, Error;
		if ((*Settings)->TryGetStringField(TEXT("blendMode"), Given)
			&& !ResolveEnumSetting(BlendModeAliases, Given, TEXT("blend mode"), ResolvedBlendMode, Error))
		{
			return Refuse(TEXT("bad_blend_mode"), Error);
		}
		if ((*Settings)->TryGetStringField(TEXT("shadingModel"), Given)
			&& !ResolveEnumSetting(ShadingModelAliases, Given, TEXT("shading model"), ResolvedShadingModel, Error))
		{
			return Refuse(TEXT("bad_shading_model"), Error);
		}
		bHasTwoSided = (*Settings)->TryGetBoolField(TEXT("twoSided"), bWantTwoSided);
	}

	// One transaction for the whole graph, so a person can Ctrl+Z the lot rather than undoing ten
	// expressions one at a time. Opened only after validation, so a refusal leaves no empty entry on
	// the undo stack.
	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPBuildMaterialGraph", "MCP: Build Material Graph"));
	Material->Modify();

	// --- expressions -----------------------------------------------------------------------
	TMap<FString, UMaterialExpression*> ByRef;
	for (const TSharedPtr<FJsonValue>& Entry : ArrayFieldOrEmpty(Params, TEXT("nodes")))
	{
		const TSharedPtr<FJsonObject>* Node = nullptr;
		if (!Entry.IsValid() || !Entry->TryGetObject(Node) || !Node)
		{
			continue;
		}

		FString Ref, Type;
		(*Node)->TryGetStringField(TEXT("ref"), Ref);
		(*Node)->TryGetStringField(TEXT("type"), Type);
		if (Ref.IsEmpty() || Type.IsEmpty())
		{
			return Refuse(TEXT("bad_node"),
				TEXT("Every node needs `ref` (your own name for it) and `type` (the expression, e.g. \"Panner\"). Nothing was changed."));
		}
		if (ByRef.Contains(Ref))
		{
			return Refuse(TEXT("duplicate_ref"),
				FString::Printf(TEXT("Two nodes both use ref '%s'; refs address the wires, so they must be unique. Nothing was changed."), *Ref));
		}

		UClass* Class = FindExpressionClass(Type);
		if (!Class)
		{
			const TArray<FString> Similar = SimilarExpressionTypes(Type);
			return Refuse(TEXT("unknown_expression"),
				FString::Printf(TEXT("No material expression called '%s'.%s Nothing was changed."),
					*Type,
					Similar.Num() > 0
						? *FString::Printf(TEXT(" Did you mean: %s?"), *FString::Join(Similar, TEXT(", ")))
						: TEXT(" Names are the class without its MaterialExpression prefix, e.g. Panner, TextureCoordinate, Multiply, Time.")));
		}

		double X = 0.0, Y = 0.0;
		(*Node)->TryGetNumberField(TEXT("x"), X);
		(*Node)->TryGetNumberField(TEXT("y"), Y);

		UMaterialExpression* Expression = UMaterialEditingLibrary::CreateMaterialExpression(
			Material, Class, static_cast<int32>(X), static_cast<int32>(Y));
		if (!Expression)
		{
			return Refuse(TEXT("expression_not_created"),
				FString::Printf(TEXT("The engine refused to create a %s in this material."), *Type));
		}

		const TSharedPtr<FJsonObject>* Properties = nullptr;
		if ((*Node)->TryGetObjectField(TEXT("properties"), Properties) && Properties)
		{
			for (const auto& Pair : (*Properties)->Values)
			{
				FString AsString;
				if (!Pair.Value.IsValid() || !Pair.Value->TryGetString(AsString))
				{
					// Numbers and bools arrive as themselves; ImportText wants text either way.
					double AsNumber = 0.0;
					bool AsBool = false;
					if (Pair.Value.IsValid() && Pair.Value->TryGetNumber(AsNumber))
					{
						AsString = FString::SanitizeFloat(AsNumber);
					}
					else if (Pair.Value.IsValid() && Pair.Value->TryGetBool(AsBool))
					{
						AsString = AsBool ? TEXT("true") : TEXT("false");
					}
				}
				FString Error;
				if (!SetPropertyByName(Expression, Pair.Key, AsString, Error))
				{
					return Refuse(TEXT("property_not_set"),
						FString::Printf(TEXT("On node '%s' (%s): %s"), *Ref, *Type, *Error));
				}
			}
		}

		ByRef.Add(Ref, Expression);
	}

	// --- wires between expressions ---------------------------------------------------------
	int32 ConnectionsMade = 0;
	for (const TSharedPtr<FJsonValue>& Entry : ArrayFieldOrEmpty(Params, TEXT("connections")))
	{
		const TSharedPtr<FJsonObject>* Link = nullptr;
		if (!Entry.IsValid() || !Entry->TryGetObject(Link) || !Link)
		{
			continue;
		}
		FString From, To, FromOutput, ToInput;
		(*Link)->TryGetStringField(TEXT("from"), From);
		(*Link)->TryGetStringField(TEXT("to"), To);
		(*Link)->TryGetStringField(TEXT("fromOutput"), FromOutput);
		(*Link)->TryGetStringField(TEXT("toInput"), ToInput);

		UMaterialExpression** Source = ByRef.Find(From);
		UMaterialExpression** Dest = ByRef.Find(To);
		if (!Source || !Dest)
		{
			TArray<FString> Known;
			ByRef.GenerateKeyArray(Known);
			return Refuse(TEXT("unknown_ref"),
				FString::Printf(TEXT("Connection %s -> %s names a ref that is not in this call. Known refs: %s."),
					*From, *To, *FString::Join(Known, TEXT(", "))));
		}

		if (!UMaterialEditingLibrary::ConnectMaterialExpressions(*Source, FromOutput, *Dest, ToInput))
		{
			return Refuse(TEXT("connection_refused"),
				FString::Printf(TEXT("The engine refused %s%s -> %s%s. Check the input name against the node in the editor - an empty name means the first pin."),
					*From, FromOutput.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(".%s"), *FromOutput),
					*To, ToInput.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(".%s"), *ToInput)));
		}
		++ConnectionsMade;
	}

	// --- wires into the material's own outputs ---------------------------------------------
	int32 OutputsMade = 0;
	for (const TSharedPtr<FJsonValue>& Entry : ArrayFieldOrEmpty(Params, TEXT("outputs")))
	{
		const TSharedPtr<FJsonObject>* Out = nullptr;
		if (!Entry.IsValid() || !Entry->TryGetObject(Out) || !Out)
		{
			continue;
		}
		FString From, FromOutput, PropertyName;
		(*Out)->TryGetStringField(TEXT("from"), From);
		(*Out)->TryGetStringField(TEXT("fromOutput"), FromOutput);
		(*Out)->TryGetStringField(TEXT("property"), PropertyName);

		UMaterialExpression** Source = ByRef.Find(From);
		if (!Source)
		{
			return Refuse(TEXT("unknown_ref"),
				FString::Printf(TEXT("Output names ref '%s', which is not in this call."), *From));
		}

		const FMaterialOutputTarget* Target = nullptr;
		for (const FMaterialOutputTarget& Candidate : MaterialOutputs)
		{
			if (PropertyName.Equals(Candidate.Name, ESearchCase::IgnoreCase))
			{
				Target = &Candidate;
				break;
			}
		}
		if (!Target)
		{
			TArray<FString> Names;
			for (const FMaterialOutputTarget& Candidate : MaterialOutputs)
			{
				Names.Add(Candidate.Name);
			}
			return Refuse(TEXT("unknown_output"),
				FString::Printf(TEXT("'%s' is not a material output. These are: %s."),
					*PropertyName, *FString::Join(Names, TEXT(", "))));
		}

		if (!UMaterialEditingLibrary::ConnectMaterialProperty(*Source, FromOutput, Target->Property))
		{
			return Refuse(TEXT("output_refused"),
				FString::Printf(TEXT("The engine refused %s -> %s."), *From, *PropertyName));
		}
		++OutputsMade;
	}

	// --- material settings ------------------------------------------------------------------
	//
	// The graph alone is not the effect: an alpha mask renders as an opaque rectangle until the blend
	// mode is Masked, and a floor marker reads as mud until it is Unlit. Both are invisible in the
	// graph, so they are set here rather than left for the caller to discover.
	// Validated at the top of the call, before a single expression was created. Applying them here is
	// now only assignment - it cannot fail, so it cannot leave a half-built graph behind.
	TArray<FString> SettingsApplied;
	if (!ResolvedBlendMode.IsEmpty())
	{
		FString Error;
		if (!SetPropertyByName(Material, TEXT("BlendMode"), ResolvedBlendMode, Error))
		{
			return Refuse(TEXT("bad_blend_mode"), Error);
		}
		SettingsApplied.Add(FString::Printf(TEXT("BlendMode=%s"), *ResolvedBlendMode));
	}
	if (!ResolvedShadingModel.IsEmpty())
	{
		FString Error;
		if (!SetPropertyByName(Material, TEXT("ShadingModel"), ResolvedShadingModel, Error))
		{
			return Refuse(TEXT("bad_shading_model"), Error);
		}
		SettingsApplied.Add(FString::Printf(TEXT("ShadingModel=%s"), *ResolvedShadingModel));
	}
	if (bHasTwoSided)
	{
		Material->TwoSided = bWantTwoSided ? 1 : 0;
		SettingsApplied.Add(FString::Printf(TEXT("TwoSided=%s"), bWantTwoSided ? TEXT("true") : TEXT("false")));
	}

	UMaterialEditingLibrary::RecompileMaterial(Material);
	Material->MarkPackageDirty();

	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
	Result->SetStringField(TEXT("next"),
		TEXT("save_asset to keep it. Parameters you added are settable at runtime with set_material_parameter or a dynamic material instance."));
	Result->SetNumberField(TEXT("expressionsAdded"), ByRef.Num());
	Result->SetNumberField(TEXT("connectionsMade"), ConnectionsMade);
	Result->SetNumberField(TEXT("outputsConnected"), OutputsMade);
	if (SettingsApplied.Num() > 0)
	{
		Result->SetStringField(TEXT("settings"), FString::Join(SettingsApplied, TEXT(", ")));
	}
	Result->SetStringField(TEXT("material"), Material->GetPathName());
	return MCPResponse::Ok(Result);
}
