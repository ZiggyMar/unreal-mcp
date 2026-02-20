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
