#pragma once

#include "CoreMinimal.h"
#include "Templates/SharedPointer.h"
#include "UObject/Class.h"

#define DOG_SIM_SHELL

template <typename FState, typename FCommand>
struct TDogSim
{
	using FDogState = FState;
	using FDogCommand = FCommand;

	static FState Init()
	{
		return FState();
	}
};

template <typename FMemory, typename FInput, typename FOutput>
struct TDogLayer
{
	using FDogMemory = FMemory;
	using FDogInput = FInput;
	using FDogOutput = FOutput;

	static FMemory Init()
	{
		return FMemory();
	}
};

template <typename FCommand>
class TDogLog
{
	struct FTick
	{
		FTick(const TSharedPtr<const FTick>& InParent, TConstArrayView<FCommand> InCommands, int32 InDepth)
			: Parent(InParent), Commands(InCommands), Depth(InDepth)
		{
		}

		const TSharedPtr<const FTick> Parent;
		const TArray<FCommand> Commands;
		const int32 Depth;
	};

	explicit TDogLog(const TSharedPtr<const FTick>& InHead)
		: Head(InHead)
	{
	}

	TSharedPtr<const FTick> Head;

	const FTick* Find(int32 Depth) const
	{
		const FTick* Tick = Head.Get();
		while (Tick && Tick->Depth > Depth)
		{
			Tick = Tick->Parent.Get();
		}
		return Tick;
	}

public:
	TDogLog() = default;

	int32 Num() const
	{
		return Head ? Head->Depth : 0;
	}

	TDogLog Append(TConstArrayView<FCommand> Commands) const
	{
		return TDogLog(TSharedPtr<const FTick>(MakeShared<FTick>(Head, Commands, Num() + 1)));
	}

	TDogLog Prefix(int32 Ticks) const
	{
		TSharedPtr<const FTick> Tick = Head;
		while (Tick && Tick->Depth > Ticks)
		{
			Tick = Tick->Parent;
		}
		return TDogLog(Tick);
	}

	TConstArrayView<FCommand> At(int32 Tick) const
	{
		const FTick* Found = Find(Tick + 1);
		return Found && Found->Depth == Tick + 1 ? TConstArrayView<FCommand>(Found->Commands) : TConstArrayView<FCommand>();
	}

	template <typename FValue, typename FFold>
	FValue Fold(FValue Value, FFold&& Step) const
	{
		TArray<const FTick*, TInlineAllocator<64>> Ticks;
		for (const FTick* Tick = Head.Get(); Tick; Tick = Tick->Parent.Get())
		{
			Ticks.Add(Tick);
		}
		for (int32 Index = Ticks.Num() - 1; Index >= 0; --Index)
		{
			Value = Step(Value, TConstArrayView<FCommand>(Ticks[Index]->Commands));
		}
		return Value;
	}
};

template <typename TSim>
typename TSim::FDogState DogSeek(const TSim& Sim, const TDogLog<typename TSim::FDogCommand>& Log, int32 Tick)
{
	using FState = typename TSim::FDogState;
	using FCommand = typename TSim::FDogCommand;
	return Log.Prefix(Tick).Fold(FState(Sim.Init()), [&Sim](const FState& State, TConstArrayView<FCommand> Commands) { return FState(Sim.Step(State, Commands)); });
}

template <typename TSim>
typename TSim::FDogState DogSeek(const TDogLog<typename TSim::FDogCommand>& Log, int32 Tick)
{
	const TSim Sim{};
	return DogSeek(Sim, Log, Tick);
}

struct FDogSync
{
	bool bOk = true;
	int32 FirstDivergentTick = -1;
};

template <typename FState>
bool DogSame(const FState& A, const FState& B)
{
	if constexpr (requires { FState::StaticStruct(); })
	{
		return FState::StaticStruct()->CompareScriptStruct(&A, &B, 0);
	}
	else
	{
		return A == B;
	}
}

template <typename TSim>
FDogSync DogSynctest(const TSim& Sim, const TDogLog<typename TSim::FDogCommand>& Log)
{
	using FState = typename TSim::FDogState;
	using FCommand = typename TSim::FDogCommand;
	const int32 Half = Log.Num() / 2;
	struct FRun
	{
		FState First;
		FState Second;
		FState Resumed;
		int32 Tick;
		FDogSync Sync;
	};
	const FRun Start{ FState(Sim.Init()), FState(Sim.Init()), DogSeek(Sim, Log, Half), 0, FDogSync() };
	const FRun End = Log.Fold(Start, [&Sim, Half](const FRun& Run, TConstArrayView<FCommand> Commands)
	{
		FRun Next = Run;
		Next.First = FState(Sim.Step(Run.First, Commands));
		Next.Second = FState(Sim.Step(Run.Second, Commands));
		if (Run.Tick >= Half)
		{
			Next.Resumed = FState(Sim.Step(Run.Resumed, Commands));
		}
		Next.Tick = Run.Tick + 1;
		if (Next.Sync.bOk && (!DogSame(Next.First, Next.Second) || (Run.Tick >= Half && !DogSame(Next.First, Next.Resumed))))
		{
			Next.Sync = FDogSync{ false, Next.Tick };
		}
		return Next;
	});
	return End.Sync;
}

template <typename TSim>
FDogSync DogSynctest(const TDogLog<typename TSim::FDogCommand>& Log)
{
	const TSim Sim{};
	return DogSynctest(Sim, Log);
}
