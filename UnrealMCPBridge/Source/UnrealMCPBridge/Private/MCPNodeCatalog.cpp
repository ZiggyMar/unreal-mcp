#include "MCPNodeCatalog.h"

#include "Dom/JsonValue.h"
#include "UObject/Class.h"
#include "UObject/UObjectIterator.h"
#include "UObject/UnrealType.h"

DEFINE_LOG_CATEGORY_STATIC(LogMCPNodeCatalog, Log, All);

FMCPNodeCatalog* FMCPNodeCatalog::Instance = nullptr;

namespace
{
	// Metadata lives behind WITH_EDITORONLY_DATA. This module is editor-only so it is always
	// available in practice, but guarding keeps the file honest if that ever changes.
	FString GetFunctionMetaData(const UFunction* Func, const TCHAR* Key)
	{
#if WITH_EDITORONLY_DATA
		if (Func && Func->HasMetaData(Key))
		{
			return Func->GetMetaData(Key);
		}
#endif
		return FString();
	}

	// Split a name into lowercase words, treating underscores, spaces and camelCase humps all as
	// the same kind of boundary.
	//
	// "Array_Length", "Array Length" and "ArrayLength" all become ["array", "length"], which is the
	// point: a caller types what the editor shows them, and the editor shows "Array Length" for a
	// function actually called Array_Length.
	void TokenizeName(const FString& In, TArray<FString>& Out)
	{
		FString Current;
		for (int32 Index = 0; Index < In.Len(); ++Index)
		{
			const TCHAR Char = In[Index];
			if (!FChar::IsAlnum(Char))
			{
				if (!Current.IsEmpty())
				{
					Out.Add(Current.ToLower());
					Current.Reset();
				}
				continue;
			}
			// A capital starts a new word after a lowercase ("SpawnActor"), and also when it is the
			// last capital of a run that runs into a lowercase ("HTTPServer" -> http, server).
			if (FChar::IsUpper(Char) && !Current.IsEmpty())
			{
				const TCHAR Previous = In[Index - 1];
				const bool bPreviousEndsWord = FChar::IsLower(Previous) || FChar::IsDigit(Previous);
				const bool bNextIsLower = (Index + 1 < In.Len()) && FChar::IsLower(In[Index + 1]);
				if (bPreviousEndsWord || (FChar::IsUpper(Previous) && bNextIsLower))
				{
					Out.Add(Current.ToLower());
					Current.Reset();
				}
			}
			Current.AppendChar(Char);
		}
		if (!Current.IsEmpty())
		{
			Out.Add(Current.ToLower());
		}
	}

	// Where Needle appears in Hay as a run of consecutive WHOLE words, or INDEX_NONE.
	//
	// Whole words are what stops the nonsense. A plain substring search for "Do N" matched
	// GetCustomDoNotImportCurveWithZero - "...Do N ot Import..." - and returned it as the best
	// answer for a caller who wanted the DoN macro. A confident wrong hit is worse than no hit,
	// because no hit sends the caller to look somewhere else.
	int32 WordRunIndex(const TArray<FString>& Hay, const TArray<FString>& Needle, bool bAllowLastPartial)
	{
		if (Needle.Num() == 0 || Needle.Num() > Hay.Num())
		{
			return INDEX_NONE;
		}
		for (int32 Start = 0; Start + Needle.Num() <= Hay.Num(); ++Start)
		{
			bool bMatched = true;
			for (int32 Offset = 0; Offset < Needle.Num(); ++Offset)
			{
				const FString& Want = Needle[Offset];
				const FString& Have = Hay[Start + Offset];
				// The final word may be a prefix, so someone typing "len" still finds Length. Only
				// the final one: allowing it everywhere brings the noise straight back.
				const bool bLast = (Offset == Needle.Num() - 1);
				if (Have == Want || (bLast && bAllowLastPartial && Have.StartsWith(Want)))
				{
					continue;
				}
				bMatched = false;
				break;
			}
			if (bMatched)
			{
				return Start;
			}
		}
		return INDEX_NONE;
	}

	// Tooltips can run to several paragraphs. Only the first line is useful as a search
	// hint, and returning the whole thing for every hit would defeat the point of a
	// compact catalog.
	FString MakeShortTooltip(const FString& Raw)
	{
		FString FirstLine = Raw;
		int32 NewlineIndex;
		if (FirstLine.FindChar(TEXT('\n'), NewlineIndex))
		{
			FirstLine = FirstLine.Left(NewlineIndex);
		}
		FirstLine.TrimStartAndEndInline();
		const int32 MaxLength = 160;
		if (FirstLine.Len() > MaxLength)
		{
			FirstLine = FirstLine.Left(MaxLength) + TEXT("...");
		}
		return FirstLine;
	}

	// Generated, transient, and stale-recompile classes show up in TObjectIterator and would
	// otherwise produce duplicate or garbage catalog entries after any Blueprint recompile.
	bool IsUsableClass(const UClass* Class)
	{
		if (!Class)
		{
			return false;
		}
		if (Class->HasAnyClassFlags(CLASS_NewerVersionExists | CLASS_Deprecated))
		{
			return false;
		}

		const FString Name = Class->GetName();
		static const TCHAR* RejectedPrefixes[] = {
			TEXT("SKEL_"), TEXT("REINST_"), TEXT("TRASHCLASS_"), TEXT("PLACEHOLDER-"),
			TEXT("HOTRELOADED_"), TEXT("LIVECODING_"),
		};
		for (const TCHAR* Prefix : RejectedPrefixes)
		{
			if (Name.StartsWith(Prefix))
			{
				return false;
			}
		}
		return true;
	}

	// Standard Levenshtein distance, used only for did-you-mean suggestions on a name that
	// already failed to resolve, so it never runs on the hot path.
	int32 ComputeEditDistance(const FString& A, const FString& B)
	{
		const int32 LenA = A.Len();
		const int32 LenB = B.Len();
		if (LenA == 0)
		{
			return LenB;
		}
		if (LenB == 0)
		{
			return LenA;
		}

		TArray<int32> Previous;
		TArray<int32> Current;
		Previous.SetNumUninitialized(LenB + 1);
		Current.SetNumUninitialized(LenB + 1);
		for (int32 j = 0; j <= LenB; ++j)
		{
			Previous[j] = j;
		}

		for (int32 i = 1; i <= LenA; ++i)
		{
			Current[0] = i;
			for (int32 j = 1; j <= LenB; ++j)
			{
				const int32 Cost = (A[i - 1] == B[j - 1]) ? 0 : 1;
				Current[j] = FMath::Min3(Current[j - 1] + 1, Previous[j] + 1, Previous[j - 1] + Cost);
			}
			Previous = Current;
		}
		return Previous[LenB];
	}
}

void FMCPNodeCatalog::Initialize()
{
	if (!Instance)
	{
		Instance = new FMCPNodeCatalog();
	}
}

void FMCPNodeCatalog::Shutdown()
{
	if (Instance)
	{
		delete Instance;
		Instance = nullptr;
	}
}

FMCPNodeCatalog& FMCPNodeCatalog::Get()
{
	if (!Instance)
	{
		Initialize();
	}
	return *Instance;
}

bool FMCPNodeCatalog::ShouldIncludeFunction(const UFunction* Func)
{
	if (!Func)
	{
		return false;
	}

	// Only what a Blueprint graph can actually call or implement.
	const bool bCallable = Func->HasAnyFunctionFlags(FUNC_BlueprintCallable | FUNC_BlueprintPure | FUNC_BlueprintEvent);
	if (!bCallable)
	{
		return false;
	}

	// These are visible to reflection but deliberately hidden from the node palette, so
	// suggesting them would send a model somewhere the editor itself will not go.
	if (!GetFunctionMetaData(Func, TEXT("DeprecatedFunction")).IsEmpty())
	{
		return false;
	}
	if (!GetFunctionMetaData(Func, TEXT("BlueprintInternalUseOnly")).IsEmpty())
	{
		return false;
	}

	return true;
}

FMCPCatalogFunction FMCPNodeCatalog::MakeEntry(const UFunction* Func, const UClass* OwnerClass)
{
	FMCPCatalogFunction Entry;
	Entry.Name = Func->GetName();
	Entry.OwnerClass = OwnerClass->GetName();
	Entry.OwnerClassPath = OwnerClass->GetPathName();
	Entry.bPure = Func->HasAnyFunctionFlags(FUNC_BlueprintPure);
	Entry.bStatic = Func->HasAnyFunctionFlags(FUNC_Static);

	Entry.DisplayName = GetFunctionMetaData(Func, TEXT("DisplayName"));
	if (Entry.DisplayName.IsEmpty())
	{
		Entry.DisplayName = FName::NameToDisplayString(Entry.Name, /*bIsBool=*/false);
	}
	Entry.Category = GetFunctionMetaData(Func, TEXT("Category"));
	Entry.Keywords = GetFunctionMetaData(Func, TEXT("Keywords"));
	Entry.Tooltip = MakeShortTooltip(GetFunctionMetaData(Func, TEXT("ToolTip")));

	// Split once here rather than on every search. The catalog holds tens of thousands of entries
	// and is searched repeatedly in a session, so paying for this at build time is the cheap end.
	TokenizeName(Entry.Name, Entry.NameWords);
	TokenizeName(Entry.DisplayName, Entry.DisplayWords);

	// Same reflection walk MCPProjectIndex uses for a Blueprint's own functions, applied
	// here to every engine and game class instead.
	for (TFieldIterator<FProperty> PropIt(Func); PropIt && (PropIt->PropertyFlags & CPF_Parm); ++PropIt)
	{
		FProperty* Prop = *PropIt;
		FMCPCatalogParam Param;
		Param.Name = Prop->GetName();
		Param.Type = Prop->GetCPPType();
		Param.bIsReturn = Prop->HasAnyPropertyFlags(CPF_ReturnParm);
		Param.bIsOutput = Prop->HasAnyPropertyFlags(CPF_OutParm) && !Prop->HasAnyPropertyFlags(CPF_ReferenceParm);
		Param.DefaultValue = GetFunctionMetaData(Func, *(FString(TEXT("CPP_Default_")) + Param.Name));
		Entry.Params.Add(Param);
	}

	return Entry;
}

void FMCPNodeCatalog::EnsureBuilt()
{
	if (!bBuilt)
	{
		RebuildFull();
	}
}

void FMCPNodeCatalog::RebuildFull()
{
	const double StartTime = FPlatformTime::Seconds();
	Functions.Reset();

	for (TObjectIterator<UClass> ClassIt; ClassIt; ++ClassIt)
	{
		UClass* Class = *ClassIt;
		if (!IsUsableClass(Class))
		{
			continue;
		}

		// ExcludeSuper so each function is recorded once, on the class that declares it,
		// rather than once per subclass that inherits it.
		for (TFieldIterator<UFunction> FuncIt(Class, EFieldIteratorFlags::ExcludeSuper); FuncIt; ++FuncIt)
		{
			UFunction* Func = *FuncIt;
			if (ShouldIncludeFunction(Func))
			{
				Functions.Add(MakeEntry(Func, Class));
			}
		}
	}

	Functions.Shrink();
	bBuilt = true;

	const double Elapsed = FPlatformTime::Seconds() - StartTime;
	UE_LOG(LogMCPNodeCatalog, Log,
		TEXT("Node catalog built: %d Blueprint-callable functions in %.2fs"), Functions.Num(), Elapsed);
}

TSharedRef<FJsonObject> FMCPNodeCatalog::FunctionToJson(const FMCPCatalogFunction& Fn, bool bIncludeParams)
{
	TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("functionName"), Fn.Name);
	Obj->SetStringField(TEXT("displayName"), Fn.DisplayName);
	Obj->SetStringField(TEXT("className"), Fn.OwnerClass);
	Obj->SetStringField(TEXT("classPath"), Fn.OwnerClassPath);
	Obj->SetBoolField(TEXT("pure"), Fn.bPure);
	Obj->SetBoolField(TEXT("static"), Fn.bStatic);
	if (!Fn.Category.IsEmpty())
	{
		Obj->SetStringField(TEXT("category"), Fn.Category);
	}
	if (!Fn.Tooltip.IsEmpty())
	{
		Obj->SetStringField(TEXT("tooltip"), Fn.Tooltip);
	}

	if (bIncludeParams)
	{
		TArray<TSharedPtr<FJsonValue>> Params;
		for (const FMCPCatalogParam& Param : Fn.Params)
		{
			TSharedRef<FJsonObject> ParamObj = MakeShared<FJsonObject>();
			ParamObj->SetStringField(TEXT("name"), Param.Name);
			ParamObj->SetStringField(TEXT("type"), Param.Type);
			ParamObj->SetStringField(TEXT("direction"),
				Param.bIsReturn ? TEXT("return") : (Param.bIsOutput ? TEXT("out") : TEXT("in")));
			if (!Param.DefaultValue.IsEmpty())
			{
				ParamObj->SetStringField(TEXT("defaultValue"), Param.DefaultValue);
			}
			Params.Add(MakeShared<FJsonValueObject>(ParamObj));
		}
		Obj->SetArrayField(TEXT("params"), Params);
	}
	else
	{
		Obj->SetNumberField(TEXT("paramCount"), Fn.Params.Num());
	}

	return Obj;
}

TArray<TSharedPtr<FJsonValue>> FMCPNodeCatalog::Search(const FString& Query, int32 MaxResults) const
{
	const FString LowerQuery = Query.ToLower();

	struct FScoredHit
	{
		int32 Score = 0;
		int32 NameLength = 0;
		const FMCPCatalogFunction* Fn = nullptr;
	};
	TArray<FScoredHit> Scored;

	// The query, split the same way every catalog name was. Both sides being words is what makes
	// "Array Length", "array_length" and "ArrayLength" the same search.
	TArray<FString> QueryWords;
	TokenizeName(Query, QueryWords);

	// Below this length a bare substring match stops meaning anything: "don" appears inside
	// "GetCustomDoNotImportCurveWithZero". Short queries get the word tiers only.
	const bool bSubstringIsMeaningful = LowerQuery.Len() >= 4;

	for (const FMCPCatalogFunction& Fn : Functions)
	{
		const FString LowerName = Fn.Name.ToLower();
		const FString LowerDisplay = Fn.DisplayName.ToLower();

		// Exact, then prefix, then whole-word run, then typeahead, then metadata, then - last and
		// only for a query long enough to mean something - a raw substring, so nothing that used to
		// be findable stops being findable.
		int32 Score = -1;
		if (QueryWords.Num() > 0 && Fn.NameWords == QueryWords)
		{
			Score = 0;
		}
		else if (QueryWords.Num() > 0 && Fn.DisplayWords == QueryWords)
		{
			Score = 1;
		}
		else if (WordRunIndex(Fn.NameWords, QueryWords, /*bAllowLastPartial=*/false) == 0)
		{
			Score = 2;
		}
		else if (WordRunIndex(Fn.DisplayWords, QueryWords, /*bAllowLastPartial=*/false) == 0)
		{
			Score = 3;
		}
		else if (WordRunIndex(Fn.NameWords, QueryWords, /*bAllowLastPartial=*/false) != INDEX_NONE ||
			WordRunIndex(Fn.DisplayWords, QueryWords, /*bAllowLastPartial=*/false) != INDEX_NONE)
		{
			Score = 4;
		}
		else if (WordRunIndex(Fn.NameWords, QueryWords, /*bAllowLastPartial=*/true) != INDEX_NONE ||
			WordRunIndex(Fn.DisplayWords, QueryWords, /*bAllowLastPartial=*/true) != INDEX_NONE)
		{
			Score = 5;
		}
		else if (Fn.Keywords.ToLower().Contains(LowerQuery) || Fn.OwnerClass.ToLower().Contains(LowerQuery))
		{
			Score = 6;
		}
		else if (bSubstringIsMeaningful && (LowerName.Contains(LowerQuery) || LowerDisplay.Contains(LowerQuery)))
		{
			Score = 7;
		}

		if (Score >= 0)
		{
			Scored.Add({ Score, Fn.Name.Len(), &Fn });
		}
	}

	// Shorter names first within a tier: "SpawnActor" is a likelier intent match than
	// "SpawnActorFromClassDeferredWithScale".
	Scored.Sort([](const FScoredHit& A, const FScoredHit& B)
	{
		if (A.Score != B.Score)
		{
			return A.Score < B.Score;
		}
		if (A.NameLength != B.NameLength)
		{
			return A.NameLength < B.NameLength;
		}
		return A.Fn->Name < B.Fn->Name;
	});

	TArray<TSharedPtr<FJsonValue>> Hits;
	const int32 Count = FMath::Min(Scored.Num(), MaxResults);
	for (int32 i = 0; i < Count; ++i)
	{
		Hits.Add(MakeShared<FJsonValueObject>(FunctionToJson(*Scored[i].Fn, /*bIncludeParams=*/false)));
	}
	return Hits;
}

TSharedPtr<FJsonObject> FMCPNodeCatalog::FindSignature(const FString& FunctionName, const FString& ClassNameOrPath) const
{
	const FString LowerFunc = FunctionName.ToLower();
	const FString LowerClass = ClassNameOrPath.ToLower();

	for (const FMCPCatalogFunction& Fn : Functions)
	{
		if (Fn.Name.ToLower() != LowerFunc)
		{
			continue;
		}
		if (!LowerClass.IsEmpty()
			&& Fn.OwnerClass.ToLower() != LowerClass
			&& Fn.OwnerClassPath.ToLower() != LowerClass)
		{
			continue;
		}
		return FunctionToJson(Fn, /*bIncludeParams=*/true);
	}

	return nullptr;
}

TArray<TSharedPtr<FJsonValue>> FMCPNodeCatalog::SuggestSimilar(const FString& FunctionName, int32 MaxResults) const
{
	const FString LowerQuery = FunctionName.ToLower();

	// A typo is usually within a couple of characters; scale the tolerance with the name
	// length so long names get proportionally more slack without matching everything.
	const int32 MaxDistance = FMath::Max(2, LowerQuery.Len() / 4);

	struct FScoredSuggestion
	{
		int32 Distance = 0;
		const FMCPCatalogFunction* Fn = nullptr;
	};
	TArray<FScoredSuggestion> Scored;

	for (const FMCPCatalogFunction& Fn : Functions)
	{
		const FString LowerName = Fn.Name.ToLower();

		int32 Distance = MAX_int32;
		if (LowerName.StartsWith(LowerQuery) || LowerQuery.StartsWith(LowerName))
		{
			// A clean prefix relationship beats any edit-distance match.
			Distance = 0;
		}
		else if (LowerName.Contains(LowerQuery))
		{
			Distance = 1;
		}
		else if (FMath::Abs(LowerName.Len() - LowerQuery.Len()) <= MaxDistance)
		{
			const int32 Computed = ComputeEditDistance(LowerName, LowerQuery);
			if (Computed <= MaxDistance)
			{
				Distance = Computed;
			}
		}

		if (Distance != MAX_int32)
		{
			Scored.Add({ Distance, &Fn });
		}
	}

	Scored.Sort([](const FScoredSuggestion& A, const FScoredSuggestion& B)
	{
		if (A.Distance != B.Distance)
		{
			return A.Distance < B.Distance;
		}
		return A.Fn->Name.Len() < B.Fn->Name.Len();
	});

	TArray<TSharedPtr<FJsonValue>> Suggestions;
	const int32 Count = FMath::Min(Scored.Num(), MaxResults);
	for (int32 i = 0; i < Count; ++i)
	{
		const FMCPCatalogFunction& Fn = *Scored[i].Fn;
		TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
		Obj->SetStringField(TEXT("functionName"), Fn.Name);
		Obj->SetStringField(TEXT("className"), Fn.OwnerClassPath);
		Suggestions.Add(MakeShared<FJsonValueObject>(Obj));
	}
	return Suggestions;
}
