using UnrealBuildTool;

public class UnrealMCPBridge : ModuleRules
{
	public UnrealMCPBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"Engine",
			"Sockets",
			"Networking",
			"Json",
			"JsonUtilities"
		});

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"Slate",
			"SlateCore",
			"UnrealEd",
			"AssetRegistry",
			"AssetTools",
			"BlueprintGraph",
			"EngineSettings",
			"InputCore",
			"Kismet",
			"KismetCompiler",
			"EditorSubsystem",
			"Projects",
			"MessageLog",
			"UMG",
			"UMGEditor",
			"MaterialEditor",
			// For reading Anim Blueprint state machines. AnimGraph is the editor module that owns
			// UAnimGraphNode_StateMachine, UAnimStateNode and UAnimStateTransitionNode; this plugin
			// is editor-only already, so it costs a runtime dependency on nothing.
			"AnimGraph",
			// For reading Behavior Trees. AIModule is runtime, not editor: a Behavior Tree is a
			// cooked asset, and reading one needs no editor machinery at all.
			"AIModule",
			"SourceControl"
		});

		bEnableExceptions = false;
	}
}

