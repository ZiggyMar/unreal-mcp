// Where things are in a running game, and putting one somewhere else.
//
// The runtime watcher answers "what is this variable", and press_input answers "what if I hold this
// key". Between them sat the thing neither could do: get two actors into the same place so an
// interaction can happen at all.
//
// That is not a corner case. Verifying a two-player ability in PIE means both players are in range
// of each other, and they spawn at different PlayerStarts. Holding the vacuum key in an automated
// session did nothing for exactly that reason - the input arrived, the ability ran, and there was
// no target within reach, so every value stayed at its default and the session proved nothing. A
// person solves this by ejecting and dragging the pawn. This is that.
//
// Reading comes first on purpose. Teleporting somewhere you have not looked is how an actor ends up
// inside geometry, so `pie_actors` reports what is there and where, and `teleport_actor` takes a
// destination the caller has actually seen - including another actor's position, which is the case
// that matters.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "Engine/Engine.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Actor.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/Controller.h"

/** Shared with MCPCommandHandler.cpp, which owns the "name or _C or a parent" matching rule. */
extern bool MCPActorClassMatches(const AActor* Actor, const FString& Wanted);

namespace
{
	/** The role names the runtime watcher uses, so one reply can be aimed at another. */
	FString RoleOf(const FWorldContext& Context, UWorld* World)
	{
		return World->GetNetMode() == NM_Client
			? FString::Printf(TEXT("Client%d"), FMath::Max(0, Context.PIEInstance - 1))
			: TEXT("Authority");
	}

	/** Matching actors in every playing world, in iteration order, with their role. */
	void ForEachPieActor(const FString& ClassName, const FString& WorldFilter,
		TFunctionRef<void(AActor*, const FString&)> Visit)
	{
		if (!GEngine)
		{
			return;
		}
		for (const FWorldContext& Context : GEngine->GetWorldContexts())
		{
			if (Context.WorldType != EWorldType::PIE || !Context.World())
			{
				continue;
			}
			UWorld* World = Context.World();
			const FString Role = RoleOf(Context, World);
			if (!WorldFilter.IsEmpty() && !Role.Equals(WorldFilter, ESearchCase::IgnoreCase))
			{
				continue;
			}
			for (TActorIterator<AActor> It(World); It; ++It)
			{
				AActor* Actor = *It;
				if (Actor && MCPActorClassMatches(Actor, ClassName))
				{
					Visit(Actor, Role);
				}
			}
		}
	}

	TSharedRef<FJsonObject> DescribeActor(AActor* Actor, const FString& Role)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Actor->GetName());
		Entry->SetStringField(TEXT("role"), Role);
		const FVector Location = Actor->GetActorLocation();
		// Rounded to whole units. A player standing still reports six decimal places of float noise
		// otherwise, and nobody positioning an actor cares about a thousandth of a centimetre.
		Entry->SetNumberField(TEXT("x"), FMath::RoundToDouble(Location.X));
		Entry->SetNumberField(TEXT("y"), FMath::RoundToDouble(Location.Y));
		Entry->SetNumberField(TEXT("z"), FMath::RoundToDouble(Location.Z));
		// Which way it is looking, because that is half of "can it see the thing".
		//
		// An ability that gates on a dot product against the camera forward - most aimed abilities do -
		// finds nothing when the pawn is in range but facing away. Two players were teleported next to
		// each other to reproduce a bug and still nothing happened, for exactly that reason, and there
		// was no way to see it. For a possessed pawn the CONTROL rotation is the one that matters: the
		// camera follows the controller, not the mesh.
		if (const APawn* Pawn = Cast<APawn>(Actor))
		{
			Entry->SetBoolField(TEXT("locallyControlled"), Pawn->IsLocallyControlled());
			const FRotator Look = Pawn->GetController() ? Pawn->GetControlRotation() : Actor->GetActorRotation();
			Entry->SetNumberField(TEXT("yaw"), FMath::RoundToDouble(Look.Yaw));
			Entry->SetNumberField(TEXT("pitch"), FMath::RoundToDouble(Look.Pitch));
		}
		else
		{
			Entry->SetNumberField(TEXT("yaw"), FMath::RoundToDouble(Actor->GetActorRotation().Yaw));
		}
		return Entry;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandlePieActors(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString ClassName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("actorClass"), ClassName) || ClassName.IsEmpty())
	{
		return MCPResponse::Fail(Result, TEXT("missing_param"),
			TEXT("actorClass is required, e.g. \"BP_Player\". The Blueprint name without _C; derived classes match too."));
	}
	FString WorldFilter;
	Params->TryGetStringField(TEXT("world"), WorldFilter);

	TArray<TSharedPtr<FJsonValue>> Actors;
	ForEachPieActor(ClassName, WorldFilter, [&Actors](AActor* Actor, const FString& Role)
	{
		Actors.Add(MakeShared<FJsonValueObject>(DescribeActor(Actor, Role)));
	});

	if (Actors.Num() == 0)
	{
		return MCPResponse::Fail(Result, TEXT("nothing_playing"),
			FString::Printf(TEXT("No \"%s\" in any running world%s. Start a session with start_pie, or check the ")
				TEXT("class name - pie_actors with actorClass \"Actor\" lists everything."),
				*ClassName, WorldFilter.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" matching \"%s\""), *WorldFilter)));
	}

	Result->SetArrayField(TEXT("actors"), Actors);
	Result->SetNumberField(TEXT("count"), Actors.Num());
	return MCPResponse::Ok(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleTeleportActor(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString ClassName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("actorClass"), ClassName) || ClassName.IsEmpty())
	{
		return MCPResponse::Fail(Result, TEXT("missing_param"),
			TEXT("actorClass is required, plus x/y/z. Read positions first with pie_actors."));
	}
	double X = 0.0, Y = 0.0, Z = 0.0;
	if (!Params->TryGetNumberField(TEXT("x"), X) || !Params->TryGetNumberField(TEXT("y"), Y) ||
		!Params->TryGetNumberField(TEXT("z"), Z))
	{
		return MCPResponse::Fail(Result, TEXT("missing_param"),
			TEXT("x, y and z are all required. pie_actors reports the position of anything already playing, "
				"which is usually where you want to put this one."));
	}
	FString WorldFilter, NameFilter;
	Params->TryGetStringField(TEXT("world"), WorldFilter);
	Params->TryGetStringField(TEXT("name"), NameFilter);
	double Yaw = 0.0, Pitch = 0.0;
	const bool bHasYaw = Params->TryGetNumberField(TEXT("yaw"), Yaw);
	const bool bHasPitch = Params->TryGetNumberField(TEXT("pitch"), Pitch);

	// Moved in EVERY world it exists in, unless narrowed.
	//
	// A pawn has a copy per world, and moving only the server's leaves the client's where it was -
	// which looks exactly like the desync this tool exists to investigate, except self-inflicted.
	// The default is therefore all of them, and `world` narrows it when that is really what is meant.
	int32 Moved = 0;
	TArray<TSharedPtr<FJsonValue>> Results;
	ForEachPieActor(ClassName, WorldFilter, [&](AActor* Actor, const FString& Role)
	{
		if (!NameFilter.IsEmpty() && !Actor->GetName().Equals(NameFilter, ESearchCase::IgnoreCase))
		{
			return;
		}
		// TeleportTo, not SetActorLocation: it sweeps the capsule out of geometry and tells the
		// movement component what happened, which is the difference between arriving and arriving
		// stuck inside a wall.
		FRotator Facing = Actor->GetActorRotation();
		if (bHasYaw)
		{
			Facing.Yaw = Yaw;
		}
		const bool bOk = Actor->TeleportTo(FVector(X, Y, Z), Facing);
		// The controller too, or the camera keeps looking where it was and every aimed ability still
		// misses - which is the whole reason this takes a rotation at all.
		if (APawn* Pawn = Cast<APawn>(Actor))
		{
			if (AController* Controller = Pawn->GetController())
			{
				FRotator Control = Controller->GetControlRotation();
				if (bHasYaw)
				{
					Control.Yaw = Yaw;
				}
				if (bHasPitch)
				{
					Control.Pitch = Pitch;
				}
				Controller->SetControlRotation(Control);
			}
		}
		if (bOk)
		{
			++Moved;
		}
		TSharedRef<FJsonObject> Entry = DescribeActor(Actor, Role);
		Entry->SetBoolField(TEXT("moved"), bOk);
		Results.Add(MakeShared<FJsonValueObject>(Entry));
	});

	if (Results.Num() == 0)
	{
		return MCPResponse::Fail(Result, TEXT("nothing_playing"),
			TEXT("Nothing matched in a running world. pie_actors lists what is there."));
	}

	Result->SetArrayField(TEXT("actors"), Results);
	Result->SetNumberField(TEXT("moved"), Moved);
	if (Moved < Results.Num())
	{
		Result->SetStringField(TEXT("note"),
			TEXT("Some did not move. TeleportTo refuses a destination the actor cannot fit in, which is a "
				"real answer: pick a spot with room, or read a standing actor's position and offset from it."));
	}
	return MCPResponse::Ok(Result);
}
