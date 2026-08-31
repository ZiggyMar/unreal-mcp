// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Live Coding: apply a C++ change to the editor that is already running.
 *
 * Every other leg of this bridge can finish a job on its own. The C++ leg could not. A model could
 * find a bug in native code, write the fix, and prove it compiles with `compile_cpp` - and then the
 * change sat on disk, because the running editor holds the DLL it was built from. The last step was
 * always a human closing the editor, rebuilding, and reopening it. A human does not do that; a human
 * presses Ctrl+Alt+F11.
 *
 * This is that keystroke. It is deliberately two thin commands rather than one blocking one:
 *
 *   live_coding_compile   starts a compile and returns immediately
 *   live_coding_status    says whether it is still going, and hands back what it logged
 *
 * The blocking form exists in the engine - `Compile(WaitForCompletion)` - and is wrong here for two
 * separate reasons, both of which cost a session to learn elsewhere in this project. It spins on
 * `FPlatformProcess::Sleep` on the game thread, so this plugin's own ticker never runs and the reply
 * cannot be flushed; the client times out and reports the editor as hung. And it opens a modal slow
 * task dialog, which is the exact failure `blockingDialogTitle()` on the server side exists to
 * diagnose: a modal window owns the main thread and every later command hangs behind it.
 *
 * So the waiting happens on the Node side, where waiting is free. The model spends one tool call.
 *
 * What is captured, and why it is the interesting half: LogLiveCoding is where the engine writes the
 * outcome, including the two warnings that matter more than the result itself - a patch that changed
 * data types with re-instancing disabled says so, and says it "will likely lead to a crash". A tool
 * that reported "Success" and dropped that line would be lying in the most expensive possible way.
 */

#include "MCPCommandHandler.h"
#include "Misc/OutputDevice.h"
#include "Misc/ScopeLock.h"
#include "Modules/ModuleManager.h"

#if WITH_LIVE_CODING
#include "ILiveCodingModule.h"
#endif

namespace
{
#if WITH_LIVE_CODING

/**
 * Everything LogLiveCoding says while a compile is running.
 *
 * Registered on the global log for the length of one compile and taken off again when it finishes,
 * because an output device left on the log costs on every line the editor ever prints.
 *
 * Serialize can be called from any thread - the live coding console talks back on its own - so the
 * lines are held under a lock and only ever handed out by value.
 */
class FMCPLiveCodingLog : public FOutputDevice
{
public:
	virtual void Serialize(const TCHAR* V, ELogVerbosity::Type Verbosity, const FName& Category) override
	{
		if (Category != TEXT("LogLiveCoding"))
		{
			return;
		}
		FScopeLock Lock(&Mutex);
		// A compile that goes wrong can be talkative. Keep the front of it: the first lines say what
		// was attempted and what failed, and the tail is repetition of the same failure.
		if (Lines.Num() < 60)
		{
			const TCHAR* Prefix = TEXT("");
			if (Verbosity == ELogVerbosity::Error)
			{
				Prefix = TEXT("error: ");
			}
			else if (Verbosity == ELogVerbosity::Warning)
			{
				Prefix = TEXT("warning: ");
			}
			Lines.Add(FString::Printf(TEXT("%s%s"), Prefix, V));
		}
	}

	TArray<FString> Take()
	{
		FScopeLock Lock(&Mutex);
		TArray<FString> Out = MoveTemp(Lines);
		Lines.Reset();
		return Out;
	}

	void Reset()
	{
		FScopeLock Lock(&Mutex);
		Lines.Reset();
	}

private:
	FCriticalSection Mutex;
	TArray<FString> Lines;
};

FMCPLiveCodingLog& GetCaptureDevice()
{
	static FMCPLiveCodingLog Device;
	return Device;
}

/** Whether the capture device is currently on the global log, so it is added and removed once each. */
bool bCaptureAttached = false;

/** Lines from the compile that just finished, kept until something asks for them. */
TArray<FString> LastCompileLines;

/** True between the compile starting and the status call that reports it finished. */
bool bCompileOutstanding = false;

void AttachCapture()
{
	if (!bCaptureAttached && GLog)
	{
		GetCaptureDevice().Reset();
		GLog->AddOutputDevice(&GetCaptureDevice());
		bCaptureAttached = true;
	}
}

void DetachCapture()
{
	if (bCaptureAttached && GLog)
	{
		GLog->RemoveOutputDevice(&GetCaptureDevice());
		bCaptureAttached = false;
	}
}

ILiveCodingModule* GetLiveCoding()
{
	return FModuleManager::LoadModulePtr<ILiveCodingModule>(LIVE_CODING_MODULE_NAME);
}

void AddLogField(const TSharedRef<FJsonObject>& Result, const TArray<FString>& Lines)
{
	if (Lines.Num() == 0)
	{
		return;
	}
	TArray<TSharedPtr<FJsonValue>> LineValues;
	for (const FString& Line : Lines)
	{
		LineValues.Add(MakeShared<FJsonValueString>(Line));
	}
	Result->SetArrayField(TEXT("log"), LineValues);
}

#endif // WITH_LIVE_CODING
} // namespace

TSharedRef<FJsonObject> FMCPCommandHandler::HandleLiveCodingStatus(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

#if !WITH_LIVE_CODING
	// Not an error, and not a failure to look: this build of the engine has no live coding at all.
	// Saying "unavailable" without saying why would send a model hunting for a setting to turn on.
	Result->SetBoolField(TEXT("available"), false);
	Result->SetStringField(TEXT("why"),
		TEXT("This engine build was compiled without live coding (WITH_LIVE_CODING=0). C++ changes need a full rebuild with the editor closed."));
	return Result;
#else
	ILiveCodingModule* LiveCoding = GetLiveCoding();
	if (!LiveCoding)
	{
		Result->SetBoolField(TEXT("available"), false);
		Result->SetStringField(TEXT("why"),
			TEXT("The LiveCoding module is not loaded in this editor. C++ changes need a full rebuild with the editor closed."));
		return Result;
	}

	const bool bCompiling = LiveCoding->IsCompiling();
	Result->SetBoolField(TEXT("available"), true);
	Result->SetBoolField(TEXT("started"), LiveCoding->HasStarted());
	Result->SetBoolField(TEXT("enabled"), LiveCoding->IsEnabledForSession());
	Result->SetBoolField(TEXT("canEnable"), LiveCoding->CanEnableForSession());
	Result->SetBoolField(TEXT("compiling"), bCompiling);

	// CanEnableForSession is false for real reasons - the editor was started from a debugger that
	// forbids it, or a module was already hot reloaded this session - and the engine holds the actual
	// sentence. Passing it through beats inventing a guess about which reason applied.
	const FText& EnableError = LiveCoding->GetEnableErrorText();
	if (!EnableError.IsEmpty())
	{
		Result->SetStringField(TEXT("enableError"), EnableError.ToString());
	}

	if (bCompiling)
	{
		// Still going. Do not take the lines yet; they are what the finished reply is made of.
		Result->SetBoolField(TEXT("done"), false);
		return Result;
	}

	// Not compiling. If a compile was outstanding, this is the edge where it finished: pull the log
	// off, unhook the device, and keep the lines for whoever asks first.
	if (bCompileOutstanding)
	{
		LastCompileLines = GetCaptureDevice().Take();
		DetachCapture();
		bCompileOutstanding = false;
	}

	Result->SetBoolField(TEXT("done"), true);
	AddLogField(Result, LastCompileLines);
	return Result;
#endif
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleLiveCodingCompile(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

#if !WITH_LIVE_CODING
	Result->SetBoolField(TEXT("started"), false);
	Result->SetStringField(TEXT("why"),
		TEXT("This engine build was compiled without live coding (WITH_LIVE_CODING=0)."));
	return Result;
#else
	ILiveCodingModule* LiveCoding = GetLiveCoding();
	if (!LiveCoding)
	{
		Result->SetBoolField(TEXT("started"), false);
		Result->SetStringField(TEXT("why"), TEXT("The LiveCoding module is not loaded in this editor."));
		return Result;
	}

	if (LiveCoding->IsCompiling())
	{
		// Someone else - the human at the keyboard, most likely - already has one running. Starting a
		// second returns CompileStillActive and does nothing, so say the true thing instead.
		Result->SetBoolField(TEXT("started"), false);
		Result->SetBoolField(TEXT("alreadyRunning"), true);
		Result->SetStringField(TEXT("why"), TEXT("A live coding compile is already running."));
		return Result;
	}

	if (!LiveCoding->IsEnabledForSession() && !LiveCoding->CanEnableForSession())
	{
		Result->SetBoolField(TEXT("started"), false);
		const FText& EnableError = LiveCoding->GetEnableErrorText();
		const FString Why = EnableError.IsEmpty()
			? FString(TEXT("Live coding cannot be enabled in this session."))
			: EnableError.ToString();
		Result->SetStringField(TEXT("why"), Why);
		return Result;
	}

	// Hook the log before starting, not after: the first thing a failed start prints is the reason it
	// failed, and that line goes out before Compile() has returned.
	AttachCapture();
	LastCompileLines.Reset();

	// Compile() enables for the session itself if it is not already. Asked for the non-blocking form
	// deliberately - see the note at the top of this file.
	ELiveCodingCompileResult CompileResult = ELiveCodingCompileResult::Failure;
	LiveCoding->Compile(ELiveCodingCompileFlags::None, &CompileResult);

	const TCHAR* ResultName = TEXT("failure");
	switch (CompileResult)
	{
	case ELiveCodingCompileResult::Success: ResultName = TEXT("success"); break;
	case ELiveCodingCompileResult::NoChanges: ResultName = TEXT("no-changes"); break;
	case ELiveCodingCompileResult::InProgress: ResultName = TEXT("in-progress"); break;
	case ELiveCodingCompileResult::CompileStillActive: ResultName = TEXT("already-running"); break;
	case ELiveCodingCompileResult::NotStarted: ResultName = TEXT("not-started"); break;
	case ELiveCodingCompileResult::Cancelled: ResultName = TEXT("cancelled"); break;
	default: break;
	}
	Result->SetStringField(TEXT("result"), ResultName);

	const bool bRunning = CompileResult == ELiveCodingCompileResult::InProgress;
	Result->SetBoolField(TEXT("started"), bRunning);
	if (bRunning)
	{
		bCompileOutstanding = true;
	}
	else
	{
		// It never got going, so nothing more will come off the log. Take what it managed to say -
		// "Unable to start live coding session. Missing executable..." is a whole diagnosis on its own -
		// and unhook, rather than leaving a device attached waiting for a compile that is not coming.
		LastCompileLines = GetCaptureDevice().Take();
		DetachCapture();
		bCompileOutstanding = false;
		AddLogField(Result, LastCompileLines);
	}
	return Result;
#endif
}
