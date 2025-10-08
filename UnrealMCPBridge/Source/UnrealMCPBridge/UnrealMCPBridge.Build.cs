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
			"BlueprintGraph",
			"Kismet",
			"KismetCompiler",
			"EditorSubsystem",
