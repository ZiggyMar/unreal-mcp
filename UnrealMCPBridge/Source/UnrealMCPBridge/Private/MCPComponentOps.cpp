// Renaming and removing a component, and removing a function graph.
//
// The last two halves of the same asymmetry: add_component and create_function both existed with no
// way to undo either. A person does both in the editor without thinking about it, and a feature
// built by trial and error leaves behind the components and functions that did not work out.
//
// Both operations are the kind that look trivial and are not. A component is referenced by name from
// graph nodes; a function graph is called from other graphs. Removing either without noticing what
// depended on it is how a Blueprint stops compiling in a place nobody was looking.

#include "MCPCommandHandler.h"

#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
#include "Engine/Blueprint.h"
#include "Engine/SCS_Node.h"
#include "Engine/SimpleConstructionScript.h"
#include "K2Node_CallFunction.h"
#include "Kismet2/BlueprintEditorUtils.h"

namespace
{
	/** The error shape the sibling files use; see the note in MCPAssetOps.cpp for why. */
	TSharedRef<FJsonObject> FailOp(const TSharedRef<FJsonObject>& Result, const FString& Code, const FString& Detail)
	{
		Result->SetStringField(TEXT("error"), Code);
		Result->SetStringField(TEXT("detail"), Detail);
		return Result;
	}

	/** The SCS node for a component this Blueprint declares, by name. */
	USCS_Node* FindComponentNode(UBlueprint* Blueprint, const FString& Name, TArray<FString>& OutKnown)
	{
		if (!Blueprint->SimpleConstructionScript)
		{
			return nullptr;
		}
		USCS_Node* Found = nullptr;
		for (USCS_Node* Node : Blueprint->SimpleConstructionScript->GetAllNodes())
		{
			if (!Node)
			{
				continue;
			}
			const FString NodeName = Node->GetVariableName().ToString();
			OutKnown.Add(NodeName);
			if (NodeName.Equals(Name, ESearchCase::IgnoreCase))
			{
				Found = Node;
			}
		}
		return Found;
	}

	/** Graph nodes that call a named function, so removing it is a decision rather than a surprise. */
	int32 CountCallsTo(UBlueprint* Blueprint, const FName& FunctionName, TArray<FString>& OutGraphs)
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
			int32 Here = 0;
			for (UEdGraphNode* Node : Graph->Nodes)
			{
				if (UK2Node_CallFunction* Call = Cast<UK2Node_CallFunction>(Node))
				{
					if (Call->FunctionReference.GetMemberName() == FunctionName)
					{
						++Here;
					}
				}
			}
			if (Here > 0)
			{
				Total += Here;
				OutGraphs.AddUnique(Graph->GetName());
			}
		}
		return Total;
	}
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRenameComponent(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, Name, NewName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("component"), Name) || Name.IsEmpty() ||
		!Params->TryGetStringField(TEXT("newName"), NewName) || NewName.IsEmpty())
	{
		return FailOp(Result, TEXT("missing_param"), TEXT("path, component and newName are all required."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailOp(Result, TEXT("blueprint_not_found"), LoadError);
	}

	TArray<FString> Known;
	USCS_Node* Node = FindComponentNode(Blueprint, Name, Known);
	if (!Node)
	{
		return FailOp(Result, TEXT("component_not_found"),
			FString::Printf(TEXT("No component called \"%s\". This Blueprint has: %s."),
				*Name, Known.Num() > 0 ? *FString::Join(Known, TEXT(", ")) : TEXT("(none)")));
	}

	// RenameComponentMemberVariable, not USCS_Node::SetVariableName. A component is reached from a
	// graph through a member variable of the same name, and only this rebinds that variable along
	// with the node - setting the name directly leaves every node that used the component pointing at
	// a name that is gone. (USimpleConstructionScript has no RenameComponent at all, which is what
	// the compiler said when this was written the obvious way.)
	Blueprint->SimpleConstructionScript->Modify();
	FBlueprintEditorUtils::RenameComponentMemberVariable(Blueprint, Node, FName(*NewName));

	if (!Node->GetVariableName().ToString().Equals(NewName, ESearchCase::CaseSensitive))
	{
		return FailOp(Result, TEXT("rename_failed"),
			FString::Printf(
				TEXT("The editor did not rename \"%s\" to \"%s\" - it is now \"%s\". The usual cause is the ")
				TEXT("new name already being taken by another component or variable."),
				*Name, *NewName, *Node->GetVariableName().ToString()));
	}

	Result->SetStringField(TEXT("from"), Name);
	Result->SetStringField(TEXT("to"), Node->GetVariableName().ToString());
	return Result;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRemoveComponent(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, Name;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("component"), Name) || Name.IsEmpty())
	{
		return FailOp(Result, TEXT("missing_param"), TEXT("path and component are both required."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailOp(Result, TEXT("blueprint_not_found"), LoadError);
	}

	TArray<FString> Known;
	USCS_Node* Node = FindComponentNode(Blueprint, Name, Known);
	if (!Node)
	{
		return FailOp(Result, TEXT("component_not_found"),
			FString::Printf(TEXT("No component called \"%s\". This Blueprint has: %s."),
				*Name, Known.Num() > 0 ? *FString::Join(Known, TEXT(", ")) : TEXT("(none)")));
	}

	// Children go with the parent in the editor too, but silently. Saying how many is the difference
	// between removing one component and removing a subtree without noticing.
	const int32 ChildCount = Node->GetChildNodes().Num();

	Blueprint->SimpleConstructionScript->Modify();
	Blueprint->SimpleConstructionScript->RemoveNodeAndPromoteChildren(Node);
	FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified(Blueprint);

	Result->SetStringField(TEXT("removed"), Name);
	Result->SetNumberField(TEXT("childrenPromoted"), ChildCount);
	return Result;
}

TSharedRef<FJsonObject> FMCPCommandHandler::HandleRemoveFunction(const TSharedPtr<FJsonObject>& Params)
{
	TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();

	FString Path, FunctionName;
	if (!Params.IsValid() || !Params->TryGetStringField(TEXT("path"), Path) ||
		!Params->TryGetStringField(TEXT("functionName"), FunctionName) || FunctionName.IsEmpty())
	{
		return FailOp(Result, TEXT("missing_param"), TEXT("path and functionName are both required."));
	}

	FString LoadError;
	UBlueprint* Blueprint = LoadBlueprintByPath(Path, LoadError);
	if (!Blueprint)
	{
		return FailOp(Result, TEXT("blueprint_not_found"), LoadError);
	}

	UEdGraph* Target = nullptr;
	TArray<FString> Known;
	for (UEdGraph* Graph : Blueprint->FunctionGraphs)
	{
		if (!Graph)
		{
			continue;
		}
		Known.Add(Graph->GetName());
		if (Graph->GetName().Equals(FunctionName, ESearchCase::IgnoreCase))
		{
			Target = Graph;
		}
	}
	if (!Target)
	{
		return FailOp(Result, TEXT("function_not_found"),
			FString::Printf(
				TEXT("No function called \"%s\". This Blueprint declares: %s. An event is not a function - ")
				TEXT("remove its nodes with remove_node instead."),
				*FunctionName, Known.Num() > 0 ? *FString::Join(Known, TEXT(", ")) : TEXT("(none)")));
	}

	TArray<FString> Callers;
	const int32 Calls = CountCallsTo(Blueprint, FName(*FunctionName), Callers);

	bool bForce = false;
	Params->TryGetBoolField(TEXT("force"), bForce);
	if (Calls > 0 && !bForce)
	{
		TArray<TSharedPtr<FJsonValue>> List;
		for (const FString& G : Callers)
		{
			List.Add(MakeShared<FJsonValueString>(G));
		}
		Result->SetArrayField(TEXT("calledFrom"), List);
		Result->SetNumberField(TEXT("callCount"), Calls);
		return FailOp(Result, TEXT("function_in_use"),
			FString::Printf(
				TEXT("\"%s\" is called by %d node(s) in: %s. Removing it leaves those calls broken. Pass ")
				TEXT("force:true if that is what you mean, or remove the calls first. Nothing has been changed."),
				*FunctionName, Calls, *FString::Join(Callers, TEXT(", "))));
	}

	FBlueprintEditorUtils::RemoveGraph(Blueprint, Target);

	Result->SetStringField(TEXT("removed"), FunctionName);
	Result->SetNumberField(TEXT("callsLeftBroken"), Calls);
	return Result;
}
