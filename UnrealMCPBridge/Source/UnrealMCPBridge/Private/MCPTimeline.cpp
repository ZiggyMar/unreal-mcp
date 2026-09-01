// Reading a Timeline, which nothing here could do.
//
// A Timeline is how a Blueprint animates anything over time without an animation asset: aim-down-
// sights, a door swinging, a fade, a camera lerp, a charge meter filling. It is ordinary, common,
// and was completely invisible to this server. `Blueprint->Timelines` was read by no file at all,
// and the project index did not know the name either, so searching for "TL_Aim" - a timeline that
// plainly exists and shows up as an entry point in explain_graph - returned zero hits.
//
// So a request like "make aiming smoother" or "the door closes too fast" had no route in. The model
// could see the node that plays the timeline and nothing about what the timeline does: not its
// length, not whether it loops, not the shape of the curve driving it, not which function each event
// track fires. That is the whole content of the feature.
//
// What is returned is deliberately the shape of the thing rather than every key: a curve can hold
// hundreds of points and dumping them would cost more than reading the Blueprint. Length, mode,
// flags, and each track with its curve and key count answers "what is this and what would I change";
// the keys themselves are one more call away for the rare case that needs them.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "Curves/CurveFloat.h"
#include "Curves/CurveLinearColor.h"
#include "Curves/CurveVector.h"
#include "Engine/Blueprint.h"
#include "Engine/TimelineTemplate.h"

namespace
{
	/** ETimelineLengthMode as the words the editor uses, not a number nobody can read. */
	FString LengthModeName(const TEnumAsByte<ETimelineLengthMode>& Mode)
	{
		return Mode == TL_TimelineLength ? TEXT("fixed") : TEXT("lastKeyFrame");
	}

	/**
	 * The bits of a curve worth reporting without printing it.
	 *
	 * `keys` is the count rather than the values: what a caller usually needs is whether a curve is
	 * a straight two-key ramp or a hand-shaped ease, and that is answered by the count plus the
	 * first and last value. An external curve asset is named instead, because that is a different
	 * thing to edit - it is shared, and changing it changes every timeline using it.
	 */
	void DescribeFloatCurve(const TSharedRef<FJsonObject>& Out, const UCurveFloat* Curve, bool bExternal)
	{
		if (!Curve)
		{
			Out->SetStringField(TEXT("curve"), TEXT("none"));
			return;
		}
		if (bExternal)
		{
			Out->SetStringField(TEXT("externalCurveAsset"), Curve->GetPathName());
		}
		const FRichCurve& Rich = Curve->FloatCurve;
		Out->SetNumberField(TEXT("keys"), Rich.GetNumKeys());
		float MinTime = 0.f, MaxTime = 0.f;
		Rich.GetTimeRange(MinTime, MaxTime);
		float MinValue = 0.f, MaxValue = 0.f;
		Rich.GetValueRange(MinValue, MaxValue);
		// Rounded, because six decimal places of float noise on a curve range is not information.
		Out->SetNumberField(TEXT("fromValue"), FMath::RoundToDouble(MinValue * 1000.0) / 1000.0);
		Out->SetNumberField(TEXT("toValue"), FMath::RoundToDouble(MaxValue * 1000.0) / 1000.0);
		Out->SetNumberField(TEXT("lastKeyAt"), FMath::RoundToDouble(MaxTime * 1000.0) / 1000.0);
	}

	TSharedRef<FJsonObject> TrackBase(const FName& TrackName, const TCHAR* Kind)
	{
		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("track"), TrackName.ToString());
		Entry->SetStringField(TEXT("kind"), Kind);
		return Entry;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleReadTimeline(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) || Path.IsEmpty())
	{
		return MCPResponse::Fail(Result, TEXT("missing_param"),
			TEXT("path is required: the Blueprint holding the timeline, e.g. \"/Game/Player/BP_Player\"."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return MCPResponse::Fail(Result, TEXT("blueprint_not_found"), LoadError);
	}

	// Optional: one timeline by name. Without it, all of them - a Blueprint rarely has many, and
	// listing them is how a caller finds out the name to ask for.
	FString Wanted;
	Params->TryGetStringField(TEXT("timelineName"), Wanted);

	TArray<TSharedPtr<FJsonValue>> Timelines;
	TArray<FString> Available;

	for (UTimelineTemplate* Template : Blueprint->Timelines)
	{
		if (!Template)
		{
			continue;
		}
		// The variable name is what appears in the graph and what a person calls it. The template's
		// own object name carries a "_Template" suffix the editor never shows, and answering with
		// that would be a name the caller cannot use anywhere else.
		const FString Name = Template->GetVariableName().ToString();
		Available.Add(Name);
		if (!Wanted.IsEmpty() && !Name.Equals(Wanted, ESearchCase::IgnoreCase))
		{
			continue;
		}

		TSharedRef<FJsonObject> Entry = MakeShared<FJsonObject>();
		Entry->SetStringField(TEXT("name"), Name);
		Entry->SetNumberField(TEXT("lengthSeconds"), FMath::RoundToDouble(Template->TimelineLength * 1000.0) / 1000.0);
		Entry->SetStringField(TEXT("lengthMode"), LengthModeName(Template->LengthMode));
		Entry->SetBoolField(TEXT("autoPlay"), Template->bAutoPlay != 0);
		Entry->SetBoolField(TEXT("loop"), Template->bLoop != 0);
		// Worth stating even when false: a timeline that drives visible movement and is NOT
		// replicated is a multiplayer bug in waiting, and this is the only place that fact appears.
		Entry->SetBoolField(TEXT("replicated"), Template->bReplicated != 0);

		TArray<TSharedPtr<FJsonValue>> Tracks;
		for (const FTTFloatTrack& Track : Template->FloatTracks)
		{
			TSharedRef<FJsonObject> TrackEntry = TrackBase(Track.GetTrackName(), TEXT("float"));
			DescribeFloatCurve(TrackEntry, Track.CurveFloat, Track.bIsExternalCurve);
			Tracks.Add(MakeShared<FJsonValueObject>(TrackEntry));
		}
		for (const FTTVectorTrack& Track : Template->VectorTracks)
		{
			TSharedRef<FJsonObject> TrackEntry = TrackBase(Track.GetTrackName(), TEXT("vector"));
			if (Track.CurveVector && Track.bIsExternalCurve)
			{
				TrackEntry->SetStringField(TEXT("externalCurveAsset"), Track.CurveVector->GetPathName());
			}
			TrackEntry->SetNumberField(TEXT("keys"), Track.CurveVector ? Track.CurveVector->FloatCurves[0].GetNumKeys() : 0);
			Tracks.Add(MakeShared<FJsonValueObject>(TrackEntry));
		}
		for (const FTTLinearColorTrack& Track : Template->LinearColorTracks)
		{
			TSharedRef<FJsonObject> TrackEntry = TrackBase(Track.GetTrackName(), TEXT("linearColor"));
			if (Track.CurveLinearColor && Track.bIsExternalCurve)
			{
				TrackEntry->SetStringField(TEXT("externalCurveAsset"), Track.CurveLinearColor->GetPathName());
			}
			Tracks.Add(MakeShared<FJsonValueObject>(TrackEntry));
		}
		for (const FTTEventTrack& Track : Template->EventTracks)
		{
			TSharedRef<FJsonObject> TrackEntry = TrackBase(Track.GetTrackName(), TEXT("event"));
			// An event track fires an output pin at each key. The key count is how many times it
			// fires across the timeline, which is the thing a caller is actually asking about.
			TrackEntry->SetNumberField(TEXT("fires"), Track.CurveKeys ? Track.CurveKeys->FloatCurve.GetNumKeys() : 0);
			Tracks.Add(MakeShared<FJsonValueObject>(TrackEntry));
		}
		Entry->SetArrayField(TEXT("tracks"), Tracks);
		Entry->SetNumberField(TEXT("trackCount"), Tracks.Num());
		Timelines.Add(MakeShared<FJsonValueObject>(Entry));
	}

	if (Blueprint->Timelines.Num() == 0)
	{
		return MCPResponse::Fail(Result, TEXT("no_timelines"),
			FString::Printf(TEXT("\"%s\" has no timelines. list_blueprint_graphs shows what it does have."),
				*Blueprint->GetName()));
	}
	if (Timelines.Num() == 0)
	{
		return MCPResponse::Fail(Result, TEXT("timeline_not_found"),
			FString::Printf(TEXT("No timeline called \"%s\" on %s. It has: %s"),
				*Wanted, *Blueprint->GetName(), *FString::Join(Available, TEXT(", "))));
	}

	Result->SetStringField(TEXT("blueprint"), Blueprint->GetName());
	Result->SetArrayField(TEXT("timelines"), Timelines);
	Result->SetNumberField(TEXT("count"), Timelines.Num());
	return MCPResponse::Ok(Result);
}
