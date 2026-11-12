import unittest
from pathlib import Path

from laws import KERNEL, LAWS, check_paths, check_sources

HERE = Path(__file__).parent
VIEW = "DogView.h"
KERNELS = [(KERNEL, (HERE / KERNEL).read_bytes()), (VIEW, (HERE / VIEW).read_bytes())]
LAW = "project-is-a-function-of-state"

SIM = """
#include "DogView.h"

struct FOrb
{
	FVector At;
	float Spin = 0;
};

struct FArena
{
	int32 Tick = 0;
	uint32 Seed = 1;
	TArray<FOrb> Orbs;
};

struct FBounce : TDogSim<FArena, int32>
{
	static FArena Step(const FArena& State, TConstArrayView<int32> Commands)
	{
		FArena Next = State;
		Next.Tick += 1;
		for (FOrb& Orb : Next.Orbs)
		{
			Orb.At.Z += 1;
		}
		return Next;
	}
};

static FVector Lift(const FVector& At, float By)
{
	return At + FVector(0, 0, By);
}

static constexpr float Height = 40.f;
"""

SHELL = """
UCLASS()
class AArenaShell : public AActor
{
	GENERATED_BODY()
	DOG_SIM_SHELL

public:
	virtual void Tick(float DeltaSeconds) override
	{
		Super::Tick(DeltaSeconds);
		if (!Player.IsViewing() && Player.GetTick() % 23 == 0)
		{
			Player.Send(Player.GetTick());
		}
		Player.Advance(GetWorld(), [this](const FArena& State) { Project(State); });
	}

	void Project(const FArena& State)
	{
		for (int32 Index = 0; Index < State.Orbs.Num() && Index < Bodies.Num(); ++Index)
		{
			Bodies[Index]->SetRelativeLocation(Lift(State.Orbs[Index].At, Height * Scale));
			Bodies[Index]->SetRelativeRotation(Turn(State, Index));
		}
		Lamp->SetRelativeLocation(FVector(FMath::Cos(State.Tick * 0.02f) * 300, 0, 220));
		Eye->SetActorLocation(FVector(0, 0, Count));
		Glow->SetScalarParameterValue(TEXT("Glow"), State.Tick % 60 / 60.f);
		/*EXTRA*/
	}

	FRotator Turn(const FArena& State, int32 Index) const
	{
		return FRotator(State.Tick * 2.5f + Index * 30, State.Orbs[Index].Spin, 0);
	}

	/*MEMBERS*/
	static constexpr int32 Count = 14;
	const float Scale = 1.5f;
	UPROPERTY()
	TArray<TObjectPtr<UStaticMeshComponent>> Bodies;
	UPROPERTY()
	TObjectPtr<UPointLightComponent> Lamp;
	UPROPERTY()
	ACameraActor* Eye = nullptr;
	UMaterialInstanceDynamic* Glow = nullptr;
	TDogPlayer<FBounce> Player;
	float Elapsed = 0;
	static int32 Frames;
};
"""


def source(extra="", members="", prefix=""):
    return (SIM + prefix + SHELL.replace("/*EXTRA*/", extra).replace("/*MEMBERS*/", members)).encode()


def found(code):
    return check_sources(KERNELS + [("Arena.h", code)])


def project(code):
    return [violation for violation in found(code) if violation.law == LAW]


class ProjectIsAFunctionOfState(unittest.TestCase):
    def test_pass_a_projection_that_reads_its_state_constants_and_writes_engine_objects(self):
        self.assertEqual([str(violation) for violation in found(source())], [])

    def test_the_view_kernel_keeps_every_law(self):
        self.assertEqual(check_paths([HERE / KERNEL, HERE / VIEW], root=HERE), [])

    def test_refuse_the_clock_random_counters_and_statics(self):
        cases = {
            "Eye->SetActorLocation(FVector(FApp::GetCurrentTime(), 0, 0));": "reads the clock through FApp::GetCurrentTime",
            "Eye->SetActorLocation(FVector(FApp::GetDeltaTime(), 0, 0));": "reads the clock through FApp::GetDeltaTime",
            "Eye->SetActorLocation(FVector(FPlatformTime::Seconds(), 0, 0));": "reads the clock through FPlatformTime::Seconds",
            "Eye->SetActorLocation(FVector(GetWorld()->TimeSeconds, 0, 0));": "reads the clock through GetWorld()->TimeSeconds",
            "Eye->SetActorLocation(FVector(GetWorld()->GetTimeSeconds(), 0, 0));": "reads the clock through GetTimeSeconds()",
            "Eye->SetActorLocation(FVector(UGameplayStatics::GetRealTimeSeconds(this), 0, 0));": "reads the clock through UGameplayStatics::GetRealTimeSeconds",
            "const FDateTime Now = FDateTime::Now();": "reads the clock through FDateTime::Now",
            "Eye->SetActorLocation(FVector(FMath::FRand(), 0, 0));": "draws FMath random through FMath::FRand",
            "Eye->SetActorLocation(FVector(FMath::RandRange(0, 9), 0, 0));": "draws FMath random through FMath::RandRange",
            "FRandomStream Stream(State.Seed); Eye->SetActorLocation(FVector(Stream.FRand(), 0, 0));": "makes FRandomStream Stream",
            "Eye->SetActorLocation(FVector(GFrameCounter % 8, 0, 0));": "reads the engine global GFrameCounter",
            "static int32 Calls = 0; Calls++;": "keeps the static local Calls",
            "Eye->SetActorLocation(FVector(Frames, 0, 0));": "reads the shell's mutable member Frames",
            "Eye->SetActorLocation(FVector(AArenaShell::Frames, 0, 0));": "reads the static mutable AArenaShell::Frames",
            "Eye->SetActorLocation(FVector(Shaken, 0, 0));": "reads the mutable global Shaken",
        }
        for extra, expected in cases.items():
            with self.subTest(extra=extra):
                messages = [violation.message for violation in project(source(extra, prefix="float Shaken = 0;\n"))]
                self.assertTrue(any(expected in message for message in messages), messages)

    def test_refuse_memory_kept_in_the_shell(self):
        cases = {
            "Elapsed += 1; Eye->SetActorLocation(FVector(Elapsed, 0, 0));": "reads the shell's mutable member Elapsed",
            "Eye->SetActorLocation(FVector(this->Elapsed, 0, 0));": "reads the shell's mutable member Elapsed",
            "Eye->SetActorLocation(FVector(Player.GetState().Tick, 0, 0));": "reads the shell's mutable member Player",
        }
        for extra, expected in cases.items():
            with self.subTest(extra=extra):
                messages = [violation.message for violation in project(source(extra))]
                self.assertTrue(any(expected in message for message in messages), messages)

    def test_follow_project_into_helpers_and_name_the_path(self):
        code = source("Eye->SetActorLocation(Wobble(State));", "FVector Wobble(const FArena& State) const { return FVector(Shake(State.Tick), 0, 0); }\n", "static float Shake(int32 Tick) { return Tick + FApp::GetCurrentTime(); }\n")
        violations = project(code)
        self.assertEqual(len(violations), 1, [str(violation) for violation in violations])
        self.assertIn("FApp::GetCurrentTime", violations[0].message)
        self.assertEqual(violations[0].via, ["AArenaShell::Project", "AArenaShell::Wobble", "Shake"])
        self.assertIn("via AArenaShell::Project -> AArenaShell::Wobble -> Shake", str(violations[0]))

    def test_refuse_a_projection_that_can_write_its_state(self):
        code = source().replace(b"void Project(const FArena& State)", b"void Project(FArena& State)")
        messages = [violation.message for violation in project(code)]
        self.assertTrue(any("takes FArena& State" in message for message in messages), messages)

    def test_hold_only_the_shell_to_the_law(self):
        code = source() + b"""
class AHud : public AActor
{
	void Project(const FArena& State) { Label->SetText(FText::AsNumber(FApp::GetCurrentTime())); }
	UTextRenderComponent* Label = nullptr;
};
"""
        self.assertEqual(project(code), [])

    def test_every_violation_has_the_law_and_its_fix(self):
        violations = project(source("Eye->SetActorLocation(FVector(FApp::GetCurrentTime(), Elapsed, 0));"))
        self.assertEqual(len(violations), 2)
        self.assertTrue(all(violation.law in LAWS and violation.fix == LAWS[LAW] for violation in violations))


if __name__ == "__main__":
    unittest.main()
