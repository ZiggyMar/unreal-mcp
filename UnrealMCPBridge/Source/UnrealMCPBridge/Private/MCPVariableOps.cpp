// Renaming and removing a Blueprint variable.
//
// The whole authoring surface could add and never take away: add_variable, add_component,
// add_struct_field, create_function all exist, and not one of them has a remove or a rename. A
// person does both in the editor without thinking about it.
//
// The rename is the one that stings. "Rename FireRate to RateOfFire" is the sentence the change
// request routing was built and tested against, quoted in this repo over and over - and it is a
// VARIABLE rename. The asset rename added alongside this is a real gap closed and it is not the
// thing that sentence asks for.
//
// Both go through FBlueprintEditorUtils rather than editing NewVariables directly, because that is
// what updates the GET and SET nodes that read the variable. Renaming the descriptor by hand leaves
// every node in every graph bound to a name that no longer exists: the Blueprint stops compiling,
// and the damage is spread across graphs nobody was looking at.

#include "MCPCommandHandler.h"

#include "MCPResponse.h"

#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "Engine/Blueprint.h"
#include "K2Node_Variable.h"
#include "Kismet2/BlueprintEditorUtils.h"
#include "ScopedTransaction.h"
#include "UObject/UnrealType.h"

namespace
{
	/** The error shape the sibling files use; see the note in MCPAssetOps.cpp for why. */
	TSharedRef<FJsonObject> FailVar(const TSharedRef<FJsonObject>& Result, const FString& Code, const FString& Detail)
	{
		return MCPResponse::Fail(Result, Code, Detail);
	}

	/** Is this a variable the Blueprint itself declares, as opposed to one inherited from C++? */
	bool DeclaresVariable(UBlueprint* Blueprint, const FName& Name)
	{
		for (const FBPVariableDescription& Var : Blueprint->NewVariables)
		{
			if (Var.VarName == Name)
			{
				return true;
			}
		}
		return false;
	}

	/**
	 * Every graph node that reads or writes this variable, by graph.
	 *
	 * Counted before anything is removed, because "3 nodes still use it" is the fact that decides
	 * whether removing it is a tidy-up or a breakage, and after the removal it cannot be recovered.
	 */
	int32 CountVariableNodes(UBlueprint* Blueprint, const FName& Name, TArray<FString>& OutGraphs)
	{
		int32 Total = 0;
		TArray<UEdGraph*> Graphs;
		Blueprint->GetAllGraphs(Graphs);
		for (UEdGraph* Graph : Graphs)
		{
			if (!Graph)
			{
				continue;
			}
			int32 InThisGraph = 0;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_Variable* VarNode = Cast<UK2Node_Variable>(Node))
				{
					if (VarNode->GetVarName() == Name)
					{
						++InThisGraph;
					}
				}
			}
			if (InThisGraph > 0)
			{
				Total += InThisGraph;
				OutGraphs.AddUnique(Graph->GetName());
			}
		}
		return Total;
	}

	/**
	 * Confirm the Blueprint declares this variable, or say which ones it does declare.
	 *
	 * Takes an already-loaded Blueprint rather than loading one: LoadBlueprintByPath is a PRIVATE
	 * static on FMCPCommandHandler, so only a member can call it. The handlers below are members and
	 * do the load themselves; this half is the part that does not need the access.
	 */
	bool ConfirmDeclared(UBlueprint* Blueprint, const FString& Name, const TSharedRef<FJsonObject>& Result)
	{
		if (DeclaresVariable(Blueprint, FName(*Name)))
		{
			return true;
		}
		// Naming the ones that do exist, because the commonest cause is a spelling or a case
		// difference and a bare "not found" leaves the caller guessing at their own Blueprint.
		TArray<FString> Names;
		for (const FBPVariableDescription& Var : Blueprint->NewVariables)
		{
			Names.Add(Var.VarName.ToString());
		}
		const FString Known = Names.Num() > 0 ? FString::Join(Names, TEXT(", ")) : FString(TEXT("(none)"));
		FailVar(Result, TEXT("variable_not_found"),
			FString::Printf(
				TEXT("\"%s\" is not a variable this Blueprint declares. It declares: %s. A variable inherited ")
				TEXT("from a C++ parent cannot be renamed or removed here - change it in the parent class."),
				*Name, *Known));
		return false;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleSetVariableType(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, Name, NewType;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("variableName"), Name) || Name.IsEmpty() ||
		!Params->TryGetStringField(TEXT("type"), NewType) || NewType.IsEmpty())
	{
		return FailVar(Result, TEXT("missing_param"), TEXT("path, variableName and type are all required."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailVar(Result, TEXT("blueprint_not_found"), LoadError);
	}

	if (!DeclaresVariable(Blueprint, FName(*Name)))
	{
		return FailVar(Result, TEXT("variable_not_found"),
			FString::Printf(TEXT("This Blueprint declares no variable called \"%s\". Inherited variables cannot be ")
				TEXT("retyped here - retype them where they are declared."), *Name));
	}

	FEdGraphPinType NewPinType;
	FString TypeError;
	if (!ResolvePinType(NewType, NewPinType, TypeError))
	{
		return FailVar(Result, TEXT("bad_type"), TypeError);
	}

	// What it was, so the reply can say what changed rather than just that something did.
	FString OldType;
	for (const FBPVariableDescription& Desc : Blueprint->NewVariables)
	{
		if (Desc.VarName == FName(*Name))
		{
			OldType = Desc.VarType.PinCategory.ToString();
			if (Desc.VarType.ContainerType != EPinContainerType::None)
			{
				OldType += TEXT(" (container)");
			}
			break;
		}
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPSetVariableType", "MCP: Change Variable Type"));
	Blueprint->Modify();

	// The engine does the work, including breaking pin links that no longer make sense. Doing it by
	// hand on NewVariables would change the descriptor and leave every Get and Set node still typed
	// the old way - the same half-rename this file's rename command exists to avoid.
	FBlueprintEditorUtils::ChangeMemberVariableType(Blueprint, FName(*Name), NewPinType);
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	/**
	 * Did it actually change? Asked, rather than assumed.
	 *
	 * This reported `to: <what you asked for>` unconditionally. It is wrong often enough to matter:
	 * ChangeMemberVariableType asks for confirmation when the retype would break existing pin
	 * connections, and since this bridge runs under GIsRunningUnattendedScript that dialog now
	 * returns its conservative default - which DECLINES. So the retype silently does not happen and
	 * the reply says it did.
	 *
	 * Measured: retyping a wired GuideTargetData from BP_VirusData_C to Actor returned
	 * {"from":"object","to":"object:Actor","compiled":{"errorCount":0}} and the variable was still
	 * BP_VirusData_C afterwards. Every field in that reply was true except the one that mattered.
	 *
	 * That is the other half of the unattended guard. Suppressing the dialog stops the editor
	 * hanging; without this, it converts a hang into a lie. A command that can be declined has to
	 * look afterwards.
	 */
	bool bActuallyChanged = false;
	for (const FBPVariableDescription& Desc : Blueprint->NewVariables)
	{
		if (Desc.VarName == FName(*Name))
		{
			bActuallyChanged = (Desc.VarType == NewPinType);
			break;
		}
	}

	Result->SetStringField(TEXT("variable"), Name);
	Result->SetStringField(TEXT("from"), OldType);
	Result->SetStringField(TEXT("to"), NewType);
	Result->SetBoolField(TEXT("changed"), bActuallyChanged);
	if (!bActuallyChanged)
	{
		Result->SetStringField(TEXT("warning"),
			FString::Printf(TEXT("%s is STILL its old type - the retype did not take. The engine asks for ")
				TEXT("confirmation when a retype would break existing pin connections, and this bridge runs ")
				TEXT("unattended, so that prompt is declined rather than shown. Disconnect the nodes that use ")
				TEXT("%s first, retype, then rewire - or make the change by hand in the editor."),
				*Name, *Name));
	}
	// Said plainly because it is the whole risk of this command: a retype can leave nodes that were
	// valid before wired to a pin that no longer accepts them, and the compiler is what reports it.
	Result->SetStringField(TEXT("next"),
		TEXT("Compile this Blueprint and check the result. Changing a type breaks connections that no ")
		TEXT("longer typecheck, and those breaks are reported by the compiler rather than by this call."));
	return MCPResponse::Ok(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRenameVariable(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, OldName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("variableName"), OldName) || OldName.IsEmpty())
	{
		return FailVar(Result, TEXT("missing_param"), TEXT("path and variableName are both required."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailVar(Result, TEXT("blueprint_not_found"), LoadError);
	}
	if (!ConfirmDeclared(Blueprint, OldName, Result))
	{
		return MCPResponse::Ok(Result);
	}

	FString NewName;
	if (!Params->TryGetStringField(TEXT("newName"), NewName) || NewName.IsEmpty())
	{
		return FailVar(Result, TEXT("missing_param"), TEXT("newName is required - what the variable should be called."));
	}

	if (NewName == OldName)
	{
		return FailVar(Result, TEXT("no_change"),
			FString::Printf(TEXT("\"%s\" is already its name. Nothing was done."), *OldName));
	}

	if (DeclaresVariable(Blueprint, FName(*NewName)))
	{
		return FailVar(Result, TEXT("name_taken"),
			FString::Printf(
				TEXT("This Blueprint already declares a variable called \"%s\". Nothing has been changed."),
				*NewName));
	}

	TArray<FString> Graphs;
	const int32 Nodes = CountVariableNodes(Blueprint, FName(*OldName), Graphs);

	// This is the whole reason the command exists rather than the caller editing NewVariables: it
	// rebinds every GET and SET node to the new name. Doing it by hand leaves the nodes pointing at a
	// name that is gone, which breaks graphs nobody was looking at.
	// Undoable, like every other edit this bridge makes and like the editor's own rename.
	//
	// The thirty commands in MCPCommandHandler.cpp each open a named transaction; the eight added
	// since did not, so a human watching an agent rename a variable across a dozen nodes could not
	// Ctrl+Z it. Found by reading what Epic's own plugin and other MCP servers do about undo, and
	// noticing this project had the habit everywhere except in its newest code.
	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPRenameVariable", "MCP: Rename Variable"));
	Blueprint->Modify();

	FBlueprintEditorUtils::RenameMemberVariable(Blueprint, FName(*OldName), FName(*NewName));

	if (DeclaresVariable(Blueprint, FName(*OldName)))
	{
		return FailVar(Result, TEXT("rename_failed"),
			FString::Printf(
				TEXT("The editor did not rename \"%s\". The usual cause is the new name colliding with an ")
				TEXT("inherited property or a reserved word. Nothing has been changed."),
				*OldName));
	}

	Result->SetStringField(TEXT("from"), OldName);
	Result->SetStringField(TEXT("to"), NewName);
	Result->SetNumberField(TEXT("nodesUpdated"), Nodes);
	TArray<TSharedPtr<FJsonValue>> GraphList;
	for (const FString& G : Graphs)
	{
		GraphList.Add(MakeShared<FJsonValueString>(G));
	}
	Result->SetArrayField(TEXT("graphsTouched"), GraphList);
	return MCPResponse::Ok(Result);
}

/**
 * Rename a function, macro or event graph, and keep every RepNotify binding pointing at it.
 *
 * There was no way to rename a graph at all - rename_variable, rename_component, rename_asset,
 * rename_struct_field and rename_enum_entry all existed, and the one a person does most often did
 * not. It surfaced as a fix nobody could take: name-has-stray-whitespace tells a caller to rename
 * "OnRep_VacuumDragged " and, for a graph, named an action this bridge could not perform.
 *
 * ## Why this also touches variables
 *
 * A RepNotify handler is bound BY NAME. FBPVariableDescription::RepNotifyFunc holds the function
 * name as an FName, and nothing links it to the graph object - so renaming the graph on its own
 * leaves the variable pointing at a function that no longer exists. The binding does not error. It
 * simply stops firing, on clients only, which is the most expensive shape of bug this project knows
 * about and exactly the one somebody would create while tidying up a name.
 *
 * So the rename updates any variable whose RepNotifyFunc named this graph, and reports how many.
 * Doing half of this would be worse than doing none.
 *
 * Ubergraph pages are refused. "EventGraph" is not a function and renaming it is not the operation
 * anybody means by "rename a function".
 */
TSharedRef<FJsonObject> FMCPCommandHandler::HandleRenameFunction(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, OldName, NewName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("functionName"), OldName) || OldName.IsEmpty())
	{
		return FailVar(Result, TEXT("missing_param"), TEXT("path and functionName are both required."));
	}
	if (!Params->TryGetStringField(TEXT("newName"), NewName) || NewName.IsEmpty())
	{
		return FailVar(Result, TEXT("missing_param"), TEXT("newName is required - what the function should be called."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailVar(Result, TEXT("blueprint_not_found"), LoadError);
	}

	// Matched EXACTLY, including whitespace. The names this is most often reached for are the ones
	// with a stray space in them, and a forgiving match would rename a different graph than the
	// caller named while reporting success.
	UEdGraph* Target = nullptr;
	TArray<FString> Candidates;
	auto Consider = [&](const TArray<TObjectPtr<UEdGraph>>& Graphs)
	{
		for (const TObjectPtr<UEdGraph>& Graph : Graphs)
		{
			if (!Graph) continue;
			const FString Name = Graph->GetName();
			Candidates.Add(Name);
			if (Name.Equals(OldName, ESearchCase::CaseSensitive))
			{
				Target = Graph;
			}
		}
	};
	Consider(Blueprint->FunctionGraphs);
	Consider(Blueprint->MacroGraphs);

	if (!Target)
	{
		// An ubergraph page by that name is a different refusal from "no such graph", because the
		// caller found a real name and this is declining to act on it.
		for (const TObjectPtr<UEdGraph>& Graph : Blueprint->UbergraphPages)
		{
			if (Graph && Graph->GetName().Equals(OldName, ESearchCase::CaseSensitive))
			{
				return FailVar(Result, TEXT("not_a_function"),
					FString::Printf(
						TEXT("\"%s\" is an event graph, not a function or macro. Renaming it is not what ")
						TEXT("\"rename a function\" means, and nothing has been changed."),
						*OldName));
			}
		}
		return FailVar(Result, TEXT("function_not_found"),
			FString::Printf(
				TEXT("No function or macro named \"%s\" on this Blueprint. It declares: %s. Names are matched ")
				TEXT("exactly, including spaces - if the one you want has a stray space in it, pass it with the space."),
				*OldName, Candidates.Num() > 0 ? *FString::Join(Candidates, TEXT(", ")) : TEXT("(none)")));
	}

	if (NewName.Equals(OldName, ESearchCase::CaseSensitive))
	{
		return FailVar(Result, TEXT("no_change"),
			FString::Printf(TEXT("\"%s\" is already its name. Nothing was done."), *OldName));
	}
	for (const FString& Existing : Candidates)
	{
		if (Existing.Equals(NewName, ESearchCase::CaseSensitive))
		{
			return FailVar(Result, TEXT("name_taken"),
				FString::Printf(
					TEXT("This Blueprint already has a graph called \"%s\". Nothing has been changed."), *NewName));
		}
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPRenameFunction", "MCP: Rename Function"));
	Blueprint->Modify();

	FBlueprintEditorUtils::RenameGraph(Target, NewName);

	if (!Target->GetName().Equals(NewName, ESearchCase::CaseSensitive))
	{
		return FailVar(Result, TEXT("rename_failed"),
			FString::Printf(
				TEXT("The editor did not rename \"%s\" - it is now called \"%s\". The usual cause is a collision ")
				TEXT("with an inherited function or a reserved word."),
				*OldName, *Target->GetName()));
	}

	// The half that makes this safe. See the note above the function.
	int32 RepNotifiesRebound = 0;
	TArray<TSharedPtr<FJsonValue>> ReboundList;
	for (FBPVariableDescription& Variable : Blueprint->NewVariables)
	{
		if (Variable.RepNotifyFunc == FName(*OldName))
		{
			Variable.RepNotifyFunc = FName(*NewName);
			RepNotifiesRebound += 1;
			ReboundList.Add(MakeShared<FJsonValueString>(Variable.VarName.ToString()));
		}
	}

	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	Result->SetStringField(TEXT("from"), OldName);
	Result->SetStringField(TEXT("to"), NewName);
	Result->SetNumberField(TEXT("repNotifiesRebound"), RepNotifiesRebound);
	if (RepNotifiesRebound > 0)
	{
		Result->SetArrayField(TEXT("repNotifyVariables"), ReboundList);
	}
	Result->SetStringField(TEXT("next"),
		TEXT("Callers of this function were rebound by the editor. compile_blueprint, then save_blueprint."));
	return MCPResponse::Ok(Result);
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRemoveVariable(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, Name;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("variableName"), Name) || Name.IsEmpty())
	{
		return FailVar(Result, TEXT("missing_param"), TEXT("path and variableName are both required."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailVar(Result, TEXT("blueprint_not_found"), LoadError);
	}
	if (!ConfirmDeclared(Blueprint, Name, Result))
	{
		return MCPResponse::Ok(Result);
	}

	TArray<FString> Graphs;
	const int32 Nodes = CountVariableNodes(Blueprint, FName(*Name), Graphs);

	bool bForce = false;
	Params->TryGetBoolField(TEXT("force"), bForce);

	// A variable still read by a graph is a different request from an unused one, and only the caller
	// knows which they meant. Removing it takes those nodes with it - the same shape as delete_asset
	// refusing while something still references the asset, and for the same reason: the damage is in
	// graphs the caller is not looking at.
	if (Nodes > 0 && !bForce)
	{
		TArray<TSharedPtr<FJsonValue>> GraphList;
		for (const FString& G : Graphs)
		{
			GraphList.Add(MakeShared<FJsonValueString>(G));
		}
		Result->SetArrayField(TEXT("usedIn"), GraphList);
		Result->SetNumberField(TEXT("nodeCount"), Nodes);
		return FailVar(Result, TEXT("variable_in_use"),
			FString::Printf(
				TEXT("\"%s\" is read or written by %d node(s) in: %s. Removing it deletes those nodes too. ")
				TEXT("Pass force:true if that is what you mean, or rewire them first. Nothing has been changed."),
				*Name, Nodes, *FString::Join(Graphs, TEXT(", "))));
	}

	const FScopedTransaction Transaction(NSLOCTEXT("UnrealMCPBridge", "MCPRemoveVariable", "MCP: Remove Variable"));
	Blueprint->Modify();

	FBlueprintEditorUtils::RemoveMemberVariable(Blueprint, FName(*Name));

	if (DeclaresVariable(Blueprint, FName(*Name)))
	{
		return FailVar(Result, TEXT("remove_failed"),
			FString::Printf(TEXT("The editor did not remove \"%s\". Nothing has been changed."), *Name));
	}

	Result->SetStringField(TEXT("removed"), Name);
	Result->SetNumberField(TEXT("nodesRemoved"), Nodes);
	return MCPResponse::Ok(Result);
}
