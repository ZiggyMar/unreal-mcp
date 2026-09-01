// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * The console. One command, and a large fraction of "everything a human has" arrives with it.
 *
 * Almost every tool in this bridge is a specific verb: create this, connect that, read the other.
 * The console is the opposite shape and that is exactly why it belongs here - it is the one thing a
 * person at the keyboard reaches for when the specific verb does not exist yet. `ce StartWave` to
 * fire an event that nothing is calling yet. `Ke * ResetHealth` to call a function on every instance
 * of a class. `stat unit` to see whether the frame cost is the game thread or the GPU. `slomo 0.1` to
 * watch something that happens too fast to see. `r.ScreenPercentage 50`. `showdebug abilitysystem`.
 * `DisableAllScreenMessages`. None of those need a tool of their own, and defining a tool for each
 * would cost a session more standing context than the whole console does.
 *
 * The care is all in reporting honestly, because the console is unusually good at appearing to work.
 *
 * **A misspelled command does nothing and says nothing.** Type `stat untis` and the game carries on
 * exactly as before. `UEngine::Exec` returns false for that, and this reports it as `recognised:
 * false` rather than as a success with empty output. That distinction is the whole difference between
 * a model that notices its typo and a model that concludes the engine ignored a working command.
 *
 * **Most commands answer through the log, not to the caller.** `stat fps` returns an empty string and
 * writes elsewhere; so do the cvars, so does `showdebug`. A tool that reported only the return value
 * would say nothing about almost every command worth running. So the log is captured for the length
 * of the exec and handed back with it.
 *
 * **In a running game the console belongs to the player controller.** `ce`, cheats, and anything the
 * cheat manager owns are routed through `APlayerController::ConsoleCommand`, not through the engine.
 * Sending those to GEditor silently does nothing. So PIE goes through the player controller, which is
 * the same path the in-game console uses when a human presses the tilde key.
 *
 * **Two commands are refused.** `quit` and `exit` close the editor, and this plugin lives inside it -
 * the model would not receive an error, it would receive nothing ever again, having deleted its own
 * ability to notice. That is not a policy about what the user may do; it is the one case where
 * running the command destroys the thing that would report on it.
 */

#include "MCPCommandHandler.h"
#include "MCPLogCapture.h"

#include "Editor.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"

#include "MCPResponse.h"

namespace
{
/**
 * Commands that end the process this plugin is running inside.
 *
 * Deliberately short. Anything that merely breaks the project is the caller's business and they have
 * undo; these are the ones where there is no reply, no error, and no session left to fix it in.
 * `debug crash` and its relatives are here for the same reason - they exist to test crash handling,
 * and they work.
 */
bool IsSelfDestructing(const FString& Command, FString& OutWhy)
{
	const FString Trimmed = Command.TrimStartAndEnd().ToLower();
	FString Verb = Trimmed;
	int32 Space = INDEX_NONE;
	if (Trimmed.FindChar(TEXT(' '), Space))
	{
		Verb = Trimmed.Left(Space);
	}

	if (Verb == TEXT("quit") || Verb == TEXT("exit"))
	{
		OutWhy = TEXT("`quit` and `exit` close the editor, and this bridge runs inside it - the reply would never arrive and the session would end. Ask the user to close the editor if that is what is wanted.");
		return true;
	}
	if (Verb == TEXT("debug"))
	{
		const FString Rest = Trimmed.Mid(Verb.Len()).TrimStartAndEnd();
		if (Rest == TEXT("crash") || Rest == TEXT("gpf") || Rest == TEXT("assert") || Rest == TEXT("fatal")
			|| Rest == TEXT("bufferoverrun") || Rest == TEXT("threadcrash"))
		{
			OutWhy = FString::Printf(
				TEXT("`debug %s` deliberately crashes the editor, which is where this bridge runs. It works, and there would be no reply."),
				*Rest);
			return true;
		}
	}
	return false;
}

/** The PIE world if the game is running, otherwise the level open in the editor. */
UWorld* PickWorld(const FString& Requested, bool& bOutIsPie)
{
	bOutIsPie = false;
	if (!GEditor)
	{
		return nullptr;
	}

	UWorld* EditorWorld = nullptr;
	UWorld* PieWorld = nullptr;
	for (const FWorldContext& Context : GEditor->GetWorldContexts())
	{
		if (!Context.World())
		{
			continue;
		}
		// The server world is the one worth having: it owns the authoritative game state, and a
		// command sent to a client would be answered by a copy. NM_Client worlds are skipped for that
		// reason rather than by taking whichever came first.
		if (Context.WorldType == EWorldType::PIE && !PieWorld && Context.World()->GetNetMode() != NM_Client)
		{
			PieWorld = Context.World();
		}
		else if (Context.WorldType == EWorldType::Editor && !EditorWorld)
		{
			EditorWorld = Context.World();
		}
	}

	if (Requested == TEXT("editor"))
	{
		return EditorWorld;
	}
	if (Requested == TEXT("pie"))
	{
		bOutIsPie = PieWorld != nullptr;
		return PieWorld;
	}
	// "auto": the running game if there is one, because a caller who started PIE is asking about the
	// game, not about the editor's idle copy of the level.
	if (PieWorld)
	{
		bOutIsPie = true;
		return PieWorld;
	}
	return EditorWorld;
}
} // namespace

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRunConsoleCommand(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Command;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("command"), Command) || Command.TrimStartAndEnd().IsEmpty())
	{
		Result->SetStringField(TEXT("error"), TEXT("missing_command"));
		Result->SetStringField(TEXT("detail"), TEXT("Pass `command`, the console line to run - e.g. \"stat fps\"."));
		return MCPResponse::Fail(Result, TEXT("missing_command"), FString());
	}
	Command = Command.TrimStartAndEnd();

	FString Why;
	if (IsSelfDestructing(Command, Why))
	{
		Result->SetStringField(TEXT("error"), TEXT("refused"));
		Result->SetStringField(TEXT("detail"), Why);
		return MCPResponse::Fail(Result, TEXT("refused"), FString());
	}

	FString Requested = TEXT("auto");
	Params->TryGetStringField(TEXT("world"), Requested);
	Requested = Requested.ToLower();

	bool bIsPie = false;
	UWorld* World = PickWorld(Requested, bIsPie);
	if (!World)
	{
		Result->SetStringField(TEXT("error"), TEXT("no_world"));
		Result->SetStringField(TEXT("detail"),
			Requested == TEXT("pie")
				? TEXT("No game is running. Start one with start_pie, or leave `world` unset to run against the editor.")
				: TEXT("No world is loaded. Open a level first."));
		return MCPResponse::Fail(Result, TEXT("no_world"), FString());
	}

	Result->SetStringField(TEXT("world"), bIsPie ? TEXT("pie") : TEXT("editor"));

	FMCPLogCapture Capture(NAME_None, 60);
	FString Output;
	bool bRecognised = true;
	int32 TotalLines = 0;
	TArray<FString> Lines;

	{
		FMCPScopedLogCapture Scoped(Capture);

		APlayerController* PC = bIsPie ? World->GetFirstPlayerController() : nullptr;
		if (PC)
		{
			// The path the tilde key uses. `ce`, cheats and anything the cheat manager owns only exist
			// here - sending them through the engine silently does nothing at all.
			Output = PC->ConsoleCommand(Command, /*bWriteToLog=*/true);
			// ConsoleCommand has no "was that a real command" return value; the engine says so in the
			// text instead. Matching on it is not guesswork - it is UConsole's own wording.
			bRecognised = !Output.Contains(TEXT("Command not recognized"));
		}
		else
		{
			// Deliberately NOT FStringOutputDevice, which is where this file failed to build on 5.8:
			// the class moved from Containers/UnrealString.h to Misc/StringOutputDevice.h, and that
			// header does not exist on 5.6 - so there is no single include that satisfies both, only
			// a version guard. Exec takes any FOutputDevice, and this plugin already has one that
			// collects lines under a lock and caps itself, so it is used for the exec output too.
			//
			// Found by `npm run check:engines`, which builds the whole plugin against every installed
			// engine. Single-file compiles against 5.6 had passed all along.
			FMCPLogCapture Direct(NAME_None, 60);
			bRecognised = GEditor->Exec(World, *Command, Direct);
			int32 DirectSeen = 0;
			Output = FString::Join(Direct.Take(DirectSeen), TEXT("\n"));
		}

		Lines = Capture.Take(TotalLines);
	}

	Result->SetBoolField(TEXT("recognised"), bRecognised);
	if (!Output.TrimStartAndEnd().IsEmpty())
	{
		Result->SetStringField(TEXT("output"), Output.TrimStartAndEnd());
	}
	if (Lines.Num() > 0)
	{
		TArray<TSharedPtr<FJsonValue>> LineValues;
		for (const FString& Line : Lines)
		{
			LineValues.Add(MakeShared<FJsonValueString>(Line));
		}
		Result->SetArrayField(TEXT("log"), LineValues);
	}
	if (TotalLines > Lines.Num())
	{
		// "60 lines" and "the first 60 of 4,312 lines" are different answers, and `obj list` produces
		// the second one. Saying which is which is the difference between a summary and a lie.
		Result->SetNumberField(TEXT("logLinesTotal"), TotalLines);
	}
	return MCPResponse::Ok(Result);
}
