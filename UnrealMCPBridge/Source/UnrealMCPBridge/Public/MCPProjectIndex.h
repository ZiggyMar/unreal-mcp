#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

struct FAssetData;

struct FMCPIndexParam
{
	FString Name;
	FString Type;
};

struct FMCPIndexFunction
{
	FString Name;
	FString ReturnType;
	TArray<FMCPIndexParam> Params;
};

struct FMCPIndexVariable
{
	FString Name;
	FString Type;
	FString Category;
};

struct FMCPIndexGraph
{
	FString Name;
	int32 NodeCount = 0;
	TMap<FString, int32> NodeTypeHistogram;
};

struct FMCPIndexBlueprint
