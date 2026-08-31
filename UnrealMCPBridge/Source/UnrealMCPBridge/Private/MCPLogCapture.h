// Copyright Epic Games, Inc. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Misc/OutputDevice.h"
#include "Misc/ScopeLock.h"

/**
 * Everything the editor logs while something is happening, so it can be reported instead of lost.
 *
 * Two commands need this and they need it for the same reason: the interesting half of what the
 * engine does is written to the log rather than returned to the caller. A live coding compile
 * returns an enum and logs the sentence that explains it. A console command returns nothing at all -
 * `stat fps`, `showdebug`, half the cvars - and logs whether it worked. Without the log, both tools
 * would have to report "done" and mean "I have no idea".
 *
 * Two things are deliberate.
 *
 * It is capped. A console command can be `obj list`, which prints tens of thousands of lines, and a
 * failing compile repeats itself. The front of the output is the part that says what happened; the
 * tail is repetition. Dropped lines are counted rather than silently discarded, because "the first
 * 60 of 4,000 lines" and "60 lines" are different answers and only one of them is true.
 *
 * It is attached for the length of one operation and taken off again. An output device left on the
 * global log costs on every line the editor ever prints, forever, for a command that finished
 * minutes ago.
 *
 * Serialize is called from whatever thread logged, so the lines live under a lock.
 */
class FMCPLogCapture : public FOutputDevice
{
public:
	/** @param InCategory  Only lines from this log category, or NAME_None for all of them. */
	explicit FMCPLogCapture(FName InCategory = NAME_None, int32 InMaxLines = 60)
		: Category(InCategory)
		, MaxLines(InMaxLines)
	{
	}

	virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& InCategory) override
	{
		if (Category != NAME_None && InCategory != Category)
		{
			return;
		}
		if (Verbosity > ELogVerbosity::Display && Verbosity != ELogVerbosity::Log)
		{
			// Verbose and VeryVerbose are for someone reading a log file, not for a reply.
			return;
		}
		FScopeLock Lock(&Mutex);
		++Seen;
		if (Lines.Num() >= MaxLines)
		{
			return;
		}
		const TCHAR* Prefix = TEXT("");
		if (Verbosity == ELogVerbosity::Error || Verbosity == ELogVerbosity::Fatal)
		{
			Prefix = TEXT("error: ");
		}
		else if (Verbosity == ELogVerbosity::Warning)
		{
			Prefix = TEXT("warning: ");
		}
		Lines.Add(FString::Printf(TEXT("%s%s"), Prefix, V));
	}

	/** The captured lines, and how many there were in total if more arrived than were kept. */
	TArray<FString> Take(int32& OutTotalSeen)
	{
		FScopeLock Lock(&Mutex);
		OutTotalSeen = Seen;
		TArray<FString> Out = MoveTemp(Lines);
		Lines.Reset();
		Seen = 0;
		return Out;
	}

	void Reset()
	{
		FScopeLock Lock(&Mutex);
		Lines.Reset();
		Seen = 0;
	}

private:
	FName Category;
	int32 MaxLines;
	FCriticalSection Mutex;
	TArray<FString> Lines;
	int32 Seen = 0;
};

/**
 * Attach a capture to the global log for the length of a scope.
 *
 * The manual add/remove pair is one early return away from leaving a device on the log for the rest
 * of the session, which is the kind of leak nothing ever reports.
 */
class FMCPScopedLogCapture
{
public:
	explicit FMCPScopedLogCapture(FMCPLogCapture& InCapture)
		: Capture(InCapture)
	{
		if (GLog)
		{
			Capture.Reset();
			GLog->AddOutputDevice(&Capture);
			bAttached = true;
		}
	}

	~FMCPScopedLogCapture()
	{
		if (bAttached && GLog)
		{
			GLog->RemoveOutputDevice(&Capture);
		}
	}

private:
	FMCPLogCapture& Capture;
	bool bAttached = false;
};
