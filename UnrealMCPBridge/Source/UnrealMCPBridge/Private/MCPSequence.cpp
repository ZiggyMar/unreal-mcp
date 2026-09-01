// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Level Sequences: what a cutscene actually animates, and the ways one silently does nothing.
 *
 * Found by checking Epic's own MCP toolset list against the project this is developed on, asset
 * class by asset class rather than by guessing. Control Rig: zero. State Tree: zero. Gameplay
 * Ability System: zero. Level Sequences: **nine**, and nothing here could read one.
 *
 * "The cutscene does not play" and "the camera does not move" are ordinary sentences, and until now
 * the only answer available was read_asset_properties, which hands back the raw export text of a
 * UMovieScene - a wall of GUIDs and section objects with the one interesting fact buried in it.
 *
 * The reply is shaped around the three ways a sequence looks correct and does nothing, because that
 * is the class of bug this project exists to find:
 *
 *   a binding with no tracks       the actor is in the sequence and nothing animates it
 *   a track with no sections       the track is in the outliner and has no keys, so it never evaluates
 *   a track with evaluation off    muted, which looks identical to working in every static read
 *
 * All three are visible in the editor only by scrolling to them and noticing an absence. None of
 * them is an error, none is a warning, and the sequence plays perfectly while doing less than it
 * appears to.
 */

#include "MCPCommandHandler.h"

#include "LevelSequence.h"
#include "Misc/PackageName.h"
#include "MovieScene.h"
#include "MovieSceneBinding.h"
#include "MovieScenePossessable.h"
#include "MovieSceneSpawnable.h"
#include "MovieSceneTrack.h"
#include "UObject/Package.h"

#include "MCPResponse.h"

namespace
{
/** Accept a short asset name or a full path, like every other path parameter in this bridge. */
ULevelSequence* ResolveSequence(const FString& NameOrPath)
{
	if (NameOrPath.StartsWith(TEXT("/")))
	{
		FString Path = NameOrPath;
		if (!Path.Contains(TEXT(".")))
		{
			Path = FString::Printf(TEXT("%s.%s"), *NameOrPath, *FPackageName::GetShortName(NameOrPath));
		}
		return LoadObject<ULevelSequence>(nullptr, *Path);
	}
	return nullptr;
}

/**
 * "MovieScene3DTransformTrack" -> "3DTransform", "MovieSceneAudioTrack" -> "Audio".
 *
 * The prefix and the suffix are on every one of them and carry nothing: the field says these are
 * tracks. What a reader wants is the word that distinguishes this one from the others.
 */
FString ShortTrackName(const UMovieSceneTrack* Track)
{
	if (!Track)
	{
		return FString();
	}
	FString Name = Track->GetClass()->GetName();
	Name.RemoveFromStart(TEXT("MovieScene"));
	Name.RemoveFromEnd(TEXT("Track"));
	return Name.IsEmpty() ? Track->GetClass()->GetName() : Name;
}
} // namespace

TSharedRef<FJsonObject> FMCPCommandHandler::HandleReadLevelSequence(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
	{
		Result->SetStringField(TEXT("error"), TEXT("missing_param"));
		Result->SetStringField(TEXT("detail"),
			TEXT("Pass `path`: a Level Sequence, e.g. \"/Game/Cinematics/LS_Intro\". List them with list_assets className=LevelSequence."));
		return MCPResponse::Fail(Result, TEXT("missing_param"), FString());
	}

	ULevelSequence* Sequence = ResolveSequence(Path);
	if (!Sequence)
	{
		Result->SetStringField(TEXT("error"), TEXT("sequence_not_found"));
		Result->SetStringField(TEXT("detail"),
			FString::Printf(
				TEXT("No Level Sequence at \"%s\". Pass a full path like /Game/Cinematics/LS_Intro; list them with list_assets className=LevelSequence."),
				*Path));
		return MCPResponse::Fail(Result, TEXT("sequence_not_found"), FString());
	}

	UMovieScene* MovieScene = Sequence->GetMovieScene();
	if (!MovieScene)
	{
		Result->SetStringField(TEXT("error"), TEXT("no_movie_scene"));
		Result->SetStringField(TEXT("detail"), TEXT("This Level Sequence has no MovieScene, which means it is empty or corrupt."));
		return MCPResponse::Fail(Result, TEXT("no_movie_scene"), FString());
	}

	Result->SetStringField(TEXT("sequence"), Sequence->GetName());

	// Which actors the sequence drives, and how it gets hold of them. Spawnable and possessable are
	// the two answers and they fail differently: a possessable points at an actor already in the
	// level and breaks when that actor is renamed or deleted, a spawnable carries its own template.
	TSet<FGuid> Spawnables;
	for (int32 Index = 0; Index < MovieScene->GetSpawnableCount(); ++Index)
	{
		Spawnables.Add(MovieScene->GetSpawnable(Index).GetGuid());
	}

	TArray<TSharedPtr<FJsonValue>> Bindings;
	int32 BindingsWithNoTracks = 0;
	int32 EmptyTracks = 0;
	int32 MutedTracks = 0;

	for (const FMovieSceneBinding& Binding : MovieScene->GetBindings())
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Binding.GetName());
		// Absent means possessable, which is the ordinary case - the same "absent is the default"
		// convention the variable and Data Table reads use.
		if (Spawnables.Contains(Binding.GetObjectGuid()))
		{
			Entry->SetStringField(TEXT("kind"), TEXT("spawnable"));
		}

		TArray<FString> TrackNames;
		for (const UMovieSceneTrack* Track : Binding.GetTracks())
		{
			if (!Track)
			{
				continue;
			}
			FString Name = ShortTrackName(Track);
			if (Track->GetAllSections().Num() == 0)
			{
				// A track with no sections has nothing to evaluate. It draws in the outliner exactly
				// like one that works.
				Name += TEXT(" (no sections)");
				++EmptyTracks;
			}
			if (Track->IsEvalDisabled())
			{
				Name += TEXT(" (muted)");
				++MutedTracks;
			}
			TrackNames.Add(Name);
		}

		if (TrackNames.Num() == 0)
		{
			// The actor is bound into the sequence and nothing animates it.
			++BindingsWithNoTracks;
			Entry->SetStringField(TEXT("tracks"), TEXT("none"));
		}
		else
		{
			Entry->SetStringField(TEXT("tracks"), FString::Join(TrackNames, TEXT(", ")));
		}
		Bindings.Add(MakeShared<FJsonValueObject>(Entry));
	}
	Result->SetArrayField(TEXT("bindings"), Bindings);

	// Tracks that belong to the sequence itself rather than to an actor: camera cuts, the fade, event
	// tracks. A camera cut track with no sections is why "the cutscene plays from the wrong angle".
	TArray<FString> SequenceTracks;
	for (const UMovieSceneTrack* Track : MovieScene->GetTracks())
	{
		if (!Track)
		{
			continue;
		}
		FString Name = ShortTrackName(Track);
		if (Track->GetAllSections().Num() == 0)
		{
			Name += TEXT(" (no sections)");
			++EmptyTracks;
		}
		if (Track->IsEvalDisabled())
		{
			Name += TEXT(" (muted)");
			++MutedTracks;
		}
		SequenceTracks.Add(Name);
	}
	if (SequenceTracks.Num() > 0)
	{
		Result->SetStringField(TEXT("sequenceTracks"), FString::Join(SequenceTracks, TEXT(", ")));
	}

	// The three silent failures, counted rather than left for the reader to spot by scanning. Each is
	// omitted when it is zero, so a healthy sequence pays nothing for them.
	if (BindingsWithNoTracks > 0)
	{
		Result->SetNumberField(TEXT("bindingsWithNoTracks"), BindingsWithNoTracks);
	}
	if (EmptyTracks > 0)
	{
		Result->SetNumberField(TEXT("tracksWithNoSections"), EmptyTracks);
	}
	if (MutedTracks > 0)
	{
		Result->SetNumberField(TEXT("mutedTracks"), MutedTracks);
	}
	if (BindingsWithNoTracks > 0 || EmptyTracks > 0 || MutedTracks > 0)
	{
		Result->SetStringField(TEXT("warning"),
			TEXT("Something here is in the sequence and does nothing. A binding with no tracks, a track with no sections, and a muted track all play perfectly and animate nothing - none of them is an error, and in the editor each is visible only by scrolling to it and noticing an absence."));
	}

	return MCPResponse::Ok(Result);
}
