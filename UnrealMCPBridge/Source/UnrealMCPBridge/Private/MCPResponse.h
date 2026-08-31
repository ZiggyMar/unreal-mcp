// The reply envelope every bridge command has to speak.
//
// MCPCommandHandler.cpp has MakeOkResponse/MakeErrorResponse in an anonymous namespace, so the ops
// files added later could not reach them and returned their result object bare. The dispatcher reads
// a reply with no `ok` as a failure, so eight commands that WORKED reported errors:
//
//   rename_variable  ->  error, carrying {"from":"Speed","to":"MoveSpeed","nodesUpdated":0}
//
// The rename had happened. The variable was renamed, the nodes were rebound, and the caller was told
// it failed - which is worse than failing, because a model that believes a write failed will retry
// it or work around it. It also made the error paths look correct by accident: without `ok` every
// reply was an error, so refusals appeared to behave while successes did not.
//
// Compiling could never have caught this and did not, three times across three engine targets. It
// took running the commands against a real editor, which is what npm run trial:lifecycle is for.
//
// Shared here rather than copied into each ops file, because the whole reason this happened is that
// the shape lived in one file's private namespace and the next author could not see it.
#pragma once

#include "Dom/JsonObject.h"

namespace MCPResponse
{
	/** {"ok": true, "result": {...}} - the shape MakeOkResponse produces. */
	inline TSharedRef<FJsonObject> Ok(const TSharedRef<FJsonObject>& Result)
	{
		TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("ok"), true);
		Response->SetObjectField(TEXT("result"), Result);
		return Response;
	}

	/**
	 * {"ok": false, "error": "code: detail", ...whatever the refusal had already gathered}
	 *
	 * Code and detail are joined so this reads like every other failure in the bridge, and the code
	 * stays first because the MCP server matches on it.
	 *
	 * The partial result is carried through rather than dropped: a refusal in these files is often
	 * the most informative reply the command has. remove_function refuses with `calledFrom` naming
	 * the graphs that would break, and that list is the whole value of the refusal - throwing it
	 * away would leave the caller with "no" and no way to act on it.
	 */
	inline TSharedRef<FJsonObject> Fail(const TSharedRef<FJsonObject>& Partial, const FString& Code, const FString& Detail)
	{
		TSharedRef<FJsonObject> Response = MakeShared<FJsonObject>();
		Response->SetBoolField(TEXT("ok"), false);
		Response->SetStringField(TEXT("error"), Detail.IsEmpty() ? Code : FString::Printf(TEXT("%s: %s"), *Code, *Detail));
		for (const TPair<FString, TSharedPtr<FJsonValue>>& Pair : Partial->Values)
		{
			if (Pair.Key != TEXT("ok") && Pair.Key != TEXT("error"))
			{
				Response->SetField(Pair.Key, Pair.Value);
			}
		}
		return Response;
	}
}
