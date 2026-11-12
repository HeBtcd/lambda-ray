#pragma once

#include "CoreMinimal.h"
#include "DogSim.h"
#include "Camera/PlayerCameraManager.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"
#include "ImageUtils.h"
#include "Misc/FileHelper.h"
#include "SceneView.h"
#include "SceneViewExtension.h"
#include "UnrealClient.h"

inline int32 DogJitterPeriod()
{
	IConsoleManager& Console = IConsoleManager::Get();
	const IConsoleVariable* Method = Console.FindConsoleVariable(TEXT("r.AntiAliasingMethod"));
	const IConsoleVariable* Samples = Console.FindConsoleVariable(TEXT("r.TemporalAASamples"));
	const IConsoleVariable* Scale = Console.FindConsoleVariable(TEXT("r.TemporalAAScaleSamples"));
	const IConsoleVariable* Percentage = Console.FindConsoleVariable(TEXT("r.ScreenPercentage"));
	const int32 Aa = Method ? Method->GetInt() : 0;
	if (Aa != 2 && Aa != 4)
	{
		return 1;
	}
	const bool bTsr = Aa == 4;
	const float Raw = Percentage ? Percentage->GetFloat() : 100.f;
	const float Fraction = Raw > 0.f && Raw < 100.f ? Raw / 100.f : 1.f;
	const int32 Requested = Samples ? Samples->GetInt() : 8;
	int32 Count = bTsr ? 8 : FMath::Clamp(Requested, 1, 255);
	if (Fraction < 1.f && (!Scale || Scale->GetInt() != 0))
	{
		Count = FMath::RoundToInt(float(Count) * FMath::Max(1.f, 1.f / (Fraction * Fraction)));
	}
	else if (Requested == 5 && !bTsr)
	{
		Count = 4;
	}
	if (bTsr)
	{
		static const uint8 Primes[] = {
			2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
			101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199,
			211, 223, 227, 229, 233, 239, 241, 251,
		};
		for (int32 Index = FMath::Max(4, (Count - 1) / 5); Index < UE_ARRAY_COUNT(Primes); ++Index)
		{
			if (int32(Primes[Index]) >= Count)
			{
				return Primes[Index];
			}
		}
	}
	return Count;
}

inline int32 DogCadence()
{
	int32 Cadence = 1;
	for (const TCHAR* Name : { TEXT("r.LumenScene.DirectLighting.UpdateFactor"), TEXT("r.LumenScene.Radiosity.UpdateFactor") })
	{
		const IConsoleVariable* Factor = IConsoleManager::Get().FindConsoleVariable(Name);
		const int32 Value = Factor ? FMath::Max(1, Factor->GetInt()) : 1;
		int32 A = Cadence;
		int32 B = Value;
		while (B != 0)
		{
			const int32 Rest = A % B;
			A = B;
			B = Rest;
		}
		Cadence = Cadence / A * Value;
	}
	return Cadence;
}

inline int32 DogCut(UWorld* World)
{
	int32 Cut = 0;
	if (!World)
	{
		return Cut;
	}
	for (FConstPlayerControllerIterator It = World->GetPlayerControllerIterator(); It; ++It)
	{
		APlayerController* Controller = It->Get();
		if (Controller && Controller->PlayerCameraManager)
		{
			Controller->PlayerCameraManager->SetGameCameraCutThisFrame();
			++Cut;
		}
	}
	return Cut;
}

class FDogTickView : public FWorldSceneViewExtension
{
public:
	FDogTickView(const FAutoRegister& AutoRegister, UWorld* InWorld)
		: FWorldSceneViewExtension(AutoRegister, InWorld)
	{
	}

	virtual void SetupView(FSceneViewFamily& InViewFamily, FSceneView& InView) override
	{
		InView.OverrideFrameIndexValue = uint32(Tick);
	}

	UWorld* GetTarget() const
	{
		return GetWorld();
	}

	int32 Tick = 0;
};

inline void DogMarkTick(UWorld* World, int32 Tick)
{
	static TArray<TSharedRef<FDogTickView, ESPMode::ThreadSafe>> Views;
	Views.RemoveAll([](const TSharedRef<FDogTickView, ESPMode::ThreadSafe>& View) { return View->GetTarget() == nullptr; });
	if (!World)
	{
		return;
	}
	TSharedRef<FDogTickView, ESPMode::ThreadSafe>* Found = Views.FindByPredicate([World](const TSharedRef<FDogTickView, ESPMode::ThreadSafe>& View) { return View->GetTarget() == World; });
	if (!Found)
	{
		Found = &Views.Add_GetRef(FSceneViewExtensions::NewExtension<FDogTickView>(World));
	}
	(*Found)->Tick = Tick;
}

template <typename TSim>
class TDogPlayer
{
	DOG_SIM_SHELL

public:
	using FState = typename TSim::FDogState;
	using FCommand = typename TSim::FDogCommand;

	explicit TDogPlayer(const TSim& InSim = TSim())
		: Sim(InSim), State(InSim.Init())
	{
	}

	const FState& GetState() const
	{
		return State;
	}

	const TDogLog<FCommand>& GetLog() const
	{
		return Log;
	}

	int32 GetTick() const
	{
		return Log.Num();
	}

	bool IsViewing() const
	{
		return Viewing.IsSet();
	}

	void Send(const FCommand& Command)
	{
		Pending.Add(Command);
	}

	FState Seek(int32 Tick) const
	{
		return DogSeek(Sim, Log, Tick);
	}

	template <typename FProject>
	void Show(UWorld* World, int32 Tick, FProject&& Project) const
	{
		check(Tick >= 0 && Tick <= Log.Num());
		DogMarkTick(World, Tick);
		Project(Seek(Tick));
	}

	template <typename FProject>
	void Rewind(UWorld* World, int32 Tick, FProject&& Project)
	{
		check(Tick >= 0 && Tick <= Log.Num());
		Viewing.Reset();
		Log = Log.Prefix(Tick);
		State = DogSeek(Sim, Log, Tick);
		DogMarkTick(World, Tick);
		Project(State);
	}

	template <typename FProject>
	int32 View(UWorld* World, int32 Tick, int32 Warm, FProject&& Project, int32 Period = DogJitterPeriod(), int32 Cadence = DogCadence())
	{
		check(Tick >= 0 && Tick <= Log.Num() && Warm >= 0);
		const TDogLog<FCommand> Kept = Log.Prefix(Tick);
		int32 From = FMath::Max(0, Tick - Warm);
		From -= From % FMath::Max(1, Period);
		const int64 Span = FMath::Max(1, Cadence);
		const int32 Hold = int32(((Phase + From - int64(GFrameCounter)) % Span + Span) % Span);
		FView Next{ Kept, DogSeek(Sim, Kept, From), From, Tick, Hold };
		DogCut(World);
		DogMarkTick(World, From);
		Project(Next.Cursor);
		if (From == Tick && Hold == 0)
		{
			Viewing.Reset();
			Log = Kept;
			State = Next.Cursor;
		}
		else
		{
			Viewing = Next;
		}
		return Hold + Tick - From;
	}

	template <typename FProject>
	void Advance(UWorld* World, FProject&& Project)
	{
		if (Viewing.IsSet())
		{
			FView& Current = Viewing.GetValue();
			if (Current.Hold > 0)
			{
				Current.Hold -= 1;
				DogCut(World);
				DogMarkTick(World, Current.At);
				Project(Current.Cursor);
				if (Current.Hold == 0 && Current.At >= Current.To)
				{
					Log = Current.Log;
					State = Current.Cursor;
					Viewing.Reset();
				}
				return;
			}
			Current.Cursor = FState(Sim.Step(Current.Cursor, Current.Log.At(Current.At)));
			Current.At += 1;
			DogMarkTick(World, Current.At);
			Project(Current.Cursor);
			if (Current.At >= Current.To)
			{
				Log = Current.Log;
				State = Current.Cursor;
				Viewing.Reset();
			}
			return;
		}
		Log = Log.Append(Pending);
		State = FState(Sim.Step(State, Pending));
		Pending.Reset();
		Phase = int64(GFrameCounter) - Log.Num();
		DogMarkTick(World, Log.Num());
		Project(State);
	}

private:
	struct FView
	{
		TDogLog<FCommand> Log;
		FState Cursor;
		int32 At = 0;
		int32 To = 0;
		int32 Hold = 0;
	};

	int64 Phase = 0;

	TSim Sim;
	TDogLog<FCommand> Log;
	FState State;
	TArray<FCommand> Pending;
	TOptional<FView> Viewing;
};

struct FDogFrame
{
	int32 Width = 0;
	int32 Height = 0;
	TArray<FColor> Pixels;
};

class FDogCapture
{
public:
	FDogCapture()
	{
		Handle = UGameViewportClient::OnScreenshotCaptured().AddRaw(this, &FDogCapture::Receive);
	}

	~FDogCapture()
	{
		UGameViewportClient::OnScreenshotCaptured().Remove(Handle);
	}

	FDogCapture(const FDogCapture&) = delete;
	FDogCapture& operator=(const FDogCapture&) = delete;

	void Request()
	{
		Frame.Reset();
		FScreenshotRequest::RequestScreenshot(false);
	}

	bool IsReady() const
	{
		return Frame.IsSet();
	}

	FDogFrame Take()
	{
		FDogFrame Out = MoveTemp(Frame.GetValue());
		Frame.Reset();
		return Out;
	}

private:
	void Receive(int32 Width, int32 Height, const TArray<FColor>& Pixels)
	{
		Frame = FDogFrame{ Width, Height, Pixels };
	}

	FDelegateHandle Handle;
	TOptional<FDogFrame> Frame;
};

inline double DogDiffers(const FDogFrame& A, const FDogFrame& B, int32 Threshold = 8)
{
	check(A.Width == B.Width && A.Height == B.Height && A.Pixels.Num() == B.Pixels.Num());
	int64 Off = 0;
	for (int32 Index = 0; Index < A.Pixels.Num(); ++Index)
	{
		const FColor X = A.Pixels[Index];
		const FColor Y = B.Pixels[Index];
		if (FMath::Abs(int32(X.R) - int32(Y.R)) > Threshold || FMath::Abs(int32(X.G) - int32(Y.G)) > Threshold || FMath::Abs(int32(X.B) - int32(Y.B)) > Threshold)
		{
			++Off;
		}
	}
	return A.Pixels.Num() ? double(Off) / double(A.Pixels.Num()) : 0.0;
}

inline bool DogSavePng(const FDogFrame& Frame, const FString& Path)
{
	TArray64<uint8> Png;
	FImageUtils::PNGCompressImageArray(Frame.Width, Frame.Height, TArrayView64<const FColor>(Frame.Pixels.GetData(), Frame.Pixels.Num()), Png);
	return FFileHelper::SaveArrayToFile(Png, *Path);
}
