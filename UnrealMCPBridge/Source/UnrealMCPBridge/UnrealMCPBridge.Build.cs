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
			// For reading Niagara systems: emitters and the user parameters a Blueprint may set.
			"Niagara",
			"SourceControl",
			// Enhanced Input is where every modern UE project keeps its bindings. It is a runtime
			// plugin module, not an editor one, so reading a mapping context costs no editor
			// machinery - and the legacy project-settings path this bridge already had returns
			// nothing at all on a project that uses it, which is most of them.
			"EnhancedInput"
		});

		// Live coding is Windows-only and is compiled out of some targets entirely, so it is asked for
		// the same way the engine's own modules ask for it: gated on the target flag, matched by a
		// `#if WITH_LIVE_CODING` in MCPLiveCoding.cpp. Without both, this plugin would stop building on
		// any target that does not have it - which is every shipping build.
		if (Target.bWithLiveCoding)
		{
			PrivateDependencyModuleNames.Add("LiveCoding");
		}

		bEnableExceptions = false;
	}
}

