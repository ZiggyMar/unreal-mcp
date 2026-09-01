// Driving input into a running game, so a change to gameplay can actually be exercised.
//
// This server could start a game, read variables out of it, and screenshot it. It could not press
// anything. So every verification stopped at "the values agree while nothing is happening", and any
// behaviour that only appears while an ability is being used could be reasoned about and not tested.
//
// That is not a theoretical gap. A networking fix in a real project was shipped on the strength of
// exactly that kind of evidence - both roles agreeing at their defaults, with nobody using the
// ability - and it made the bug worse. The person on the other end found it in thirty seconds by
// holding a key. The tool could not.
//
// InjectInputForAction is how Enhanced Input is meant to be driven programmatically: it feeds the
// action through the same modifiers and triggers a real key press would, so what the game sees is
// indistinguishable from a player doing it. That matters - synthesising a key press at the
// PlayerController would bypass the mapping context and test a path nobody plays.
//
// Injection lasts one frame, so a hold is a ticker that re-injects until the time is up. The ticker
// is deliberately the same shape as the runtime watcher's: one global, cancelled and replaced rather
// than accumulated, so a forgotten call cannot leave the game holding a key down forever.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "Containers/Ticker.h"
#include "EnhancedInputSubsystems.h"
#include "Engine/Engine.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "InputAction.h"
#include "InputActionValue.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Misc/PackageName.h"

namespace
{
	/** An InputAction by short name or full path, the same as every other path parameter here. */
	UInputAction* FindInputAction(const FString& NameOrPath, FString& OutError)
	{
		if (NameOrPath.StartsWith(TEXT("/")))
		{
			FString Path = NameOrPath;
			if (!Path.Contains(TEXT(".")))
			{
				Path = FString::Printf(TEXT("%s.%s"), *NameOrPath, *FPackageName::GetShortName(NameOrPath));
			}
			if (UInputAction* Loaded = LoadObject<UInputAction>(nullptr, *Path))
			{
				return Loaded;
			}
			OutError = TEXT("nothing loads at that path");
			return nullptr;
		}
		FAssetRegistryModule& Registry = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		TArray<FAssetData> Actions;
		Registry.Get().GetAssetsByClass(UInputAction::StaticClass()->GetClassPathName(), Actions);
		for (const FAssetData& Candidate : Actions)
		{
			if (Candidate.AssetName.ToString().Equals(NameOrPath, ESearchCase::IgnoreCase))
			{
				return Cast<UInputAction>(Candidate.GetAsset());
			}
		}
		OutError = FString::Printf(TEXT("no InputAction named that among %d in the project"), Actions.Num());
		return nullptr;
	}

	/** The one hold in flight, so a second call replaces it rather than fighting it. */
	struct FMCPInputHold
	{
		FTSTicker::FDelegateHandle Ticker;
		TWeakObjectPtr<const UInputAction> Action;
		float Value = 0.f;
		double EndsAt = 0.0;
		FString WorldFilter;
	};
	FMCPInputHold GMCPHold;

	/** Every Enhanced Input subsystem currently playing, optionally narrowed to one net role. */
	TArray<UEnhancedInputLocalPlayerSubsystem*> PlayingSubsystems(const FString& WorldFilter, TArray<FString>& OutRoles)
	{
		TArray<UEnhancedInputLocalPlayerSubsystem*> Found;
		if (!GEngine)
		{
			return Found;
		}
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if (Context.WorldType != EWorldType::PIE || !Context.World())
			{
				continue;
			}
			UWorld* World = Context.World();
			// The same role names the watcher reports, so a caller can aim at the world it just read.
			const FString Role = World->GetNetMode() == NM_Client
				? FString::Printf(TEXT("Client%d"), FMath::Max(0, Context.PIEInstance - 1))
				: TEXT("Authority");
			if (!WorldFilter.IsEmpty() && !Role.Equals(WorldFilter, ESearchCase::IgnoreCase))
			{
				continue;
			}
			for (FConstPlayerControllerIterator It = World->GetPlayerControllerIterator(); It; ++It)
			{
				APlayerController* PC = It->Get();
				if (!PC || !PC->IsLocalController())
				{
					continue;
				}
				if (ULocalPlayer* Local = PC->GetLocalPlayer())
				{
					if (UEnhancedInputLocalPlayerSubsystem* Sub = Local->GetSubsystem<UEnhancedInputLocalPlayerSubsystem>())
					{
						Found.Add(Sub);
						OutRoles.AddUnique(Role);
					}
				}
			}
		}
		return Found;
	}

	void InjectOnce(const UInputAction* Action, float Raw)
	{
		TArray<FString> Roles;
		for (UEnhancedInputLocalPlayerSubsystem* Sub : PlayingSubsystems(GMCPHold.WorldFilter, Roles))
		{
			// Built from the action's own value type so a Boolean action is pressed rather than
			// handed a float it will not read, and an Axis1D gets its magnitude.
			const FInputActionValue Value(Action->ValueType, FVector(Raw, 0.0, 0.0));
			Sub->InjectInputForAction(Action, Value, {}, {});
		}
	}

	void StopHold()
	{
		if (GMCPHold.Ticker.IsValid())
		{
			FTSTicker::GetCoreTicker().RemoveTicker(GMCPHold.Ticker);
			GMCPHold.Ticker.Reset();
		}
		GMCPHold.Action = nullptr;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleInjectInput(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString ActionName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("inputAction"), ActionName) || ActionName.IsEmpty())
	{
		// "stop" with no action is a legitimate call: let go of whatever is held.
		FString Action;
		if (Params.IsValid() && Params->TryGetStringField(TEXT("action"), Action) && Action.Equals(TEXT("stop"), ESearchCase::IgnoreCase))
		{
			StopHold();
			Result->SetBoolField(TEXT("released"), true);
			return MCPResponse::Ok(Result);
		}
		return MCPResponse::Fail(Result, TEXT("missing_param"),
			TEXT("inputAction is required, e.g. \"IA_Vacuum\". Pass action:\"stop\" to release a hold early."));
	}

	FString LoadError;
	UInputAction* Action = FindInputAction(ActionName, LoadError);
	if (!Action)
	{
		return MCPResponse::Fail(Result, TEXT("input_action_not_found"),
			FString::Printf(TEXT("No InputAction called \"%s\" (%s). List them with list_assets ")
				TEXT("className=InputAction."), *ActionName, *LoadError));
	}

	double Seconds = 0.0;
	Params->TryGetNumberField(TEXT("seconds"), Seconds);
	double Value = 1.0;
	Params->TryGetNumberField(TEXT("value"), Value);
	FString WorldFilter;
	Params->TryGetStringField(TEXT("world"), WorldFilter);

	TArray<FString> Roles;
	GMCPHold.WorldFilter = WorldFilter;
	const int32 Reachable = PlayingSubsystems(WorldFilter, Roles).Num();
	if (Reachable == 0)
	{
		return MCPResponse::Fail(Result, TEXT("no_pie_player"),
			WorldFilter.IsEmpty()
				? TEXT("No game is running with a local player, so there is nothing to press. Start one with start_pie.")
				: FString::Printf(TEXT("No local player in world \"%s\". The watcher reports which worlds exist."), *WorldFilter));
	}

	StopHold();
	InjectOnce(Action, static_cast<float>(Value));

	if (Seconds > 0.0)
	{
		// Capped, and low. A held key is a change to a running game that nothing else will undo, and
		// a caller that crashes mid-hold should not leave the player walking into a wall forever.
		const double Hold = FMath::Min(Seconds, 30.0);
		GMCPHold.Action = Action;
		GMCPHold.Value = static_cast<float>(Value);
		GMCPHold.EndsAt = FPlatformTime::Seconds() + Hold;
		GMCPHold.Ticker = FTSTicker::GetCoreTicker().AddTicker(
			FTickerDelegate::CreateLambda([](float) -> bool
			{
				if (!GMCPHold.Action.IsValid() || FPlatformTime::Seconds() >= GMCPHold.EndsAt)
				{
					GMCPHold.Action = nullptr;
					GMCPHold.Ticker.Reset();
					return false;
				}
				InjectOnce(GMCPHold.Action.Get(), GMCPHold.Value);
				return true;
			}),
			0.0f);
		Result->SetNumberField(TEXT("heldForSeconds"), Hold);
	}

	Result->SetStringField(TEXT("inputAction"), Action->GetName());
	Result->SetNumberField(TEXT("value"), Value);
	Result->SetNumberField(TEXT("localPlayers"), Reachable);
	TArray<TSharedPtr<FJsonValue>> RoleList;
	for (const FString& Role : Roles)
	{
		RoleList.Add(MakeShared<FJsonValueString>(Role));
	}
	Result->SetArrayField(TEXT("worlds"), RoleList);
	return MCPResponse::Ok(Result);
}
