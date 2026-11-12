import unittest
from pathlib import Path

from laws import KERNEL, LAWS, check_paths, check_sources

HERE = Path(__file__).parent
KERNEL_SOURCE = (KERNEL, (HERE / KERNEL).read_bytes())

GOOD = b"""
#include "DogSim.h"

UENUM()
enum class EKind : uint8 { Move, Reset };

USTRUCT()
struct FCommand
{
	GENERATED_BODY()
	UPROPERTY() EKind Kind = EKind::Move;
	UPROPERTY() float By = 0;
};

USTRUCT()
struct FBody
{
	GENERATED_BODY()
	UPROPERTY() FVector At;
	UPROPERTY() TArray<float> Trail;
	UPROPERTY() TOptional<int32> Seed;
};

struct FLevel
{
	float Speed = 1;
};

static float Ease(float X) { return FMath::Sin(X); }

struct FRunner : TDogSim<FBody, FCommand>
{
	FLevel Level;

	FBody Step(const FBody& State, TConstArrayView<FCommand> Commands) const
	{
		FBody Next = State;
		for (const FCommand& Command : Commands)
		{
			if (Command.Kind == EKind::Reset) return FBody();
			Next.At.X += Ease(Command.By) * this->Level.Speed;
			Next.Trail.Add(Next.At.X);
		}
		Next.Trail.Sort();
		return Next;
	}
};

UCLASS()
class DOGRUN_API ADogShell : public AActor
{
	GENERATED_BODY()
	DOG_SIM_SHELL
public:
	void Tick(TConstArrayView<FCommand> Commands)
	{
		Log = Log.Append(Commands);
		State = Runner.Step(State, Commands);
	}
	TDogLog<FCommand> Log;
	FRunner Runner;
	FBody State;
};
"""


def found(source: bytes):
    return check_sources([KERNEL_SOURCE, ("Game.h", source)])


def laws(source: bytes):
    return sorted({violation.law for violation in found(source)})


def sim(state: str, step_body: str = "return State;", command: str = "struct FCmd { int32 N; };", extra: str = "") -> bytes:
    return f"""
#include "DogSim.h"
{command}
{state}
{extra}
struct FSim : TDogSim<FState, FCmd>
{{
	static FState Step(const FState& State, TConstArrayView<FCmd> Commands)
	{{
		{step_body}
	}}
}};
""".encode()


class Laws(unittest.TestCase):
    def test_pass_a_pure_sim_over_value_data_with_a_shell(self):
        self.assertEqual([str(violation) for violation in found(GOOD)], [])

    def test_refuse_a_function_a_pointer_a_handle_and_a_map_in_the_state(self):
        messages = [violation.message for violation in found(sim("struct FState { TFunction<void()> OnHit; AActor* Who; TWeakObjectPtr<AActor> Ref; TMap<int32, int32> Seen; };"))]
        self.assertEqual(laws(sim("struct FState { TFunction<void()> OnHit; };")), ["state-is-data"])
        self.assertTrue(any(message.startswith("FState.OnHit is a function") for message in messages), messages)
        self.assertTrue(any(message.startswith("FState.Who is a pointer") for message in messages), messages)
        self.assertTrue(any(message.startswith("FState.Ref is the handle TWeakObjectPtr") for message in messages), messages)
        self.assertTrue(any(message.startswith("FState.Seen is TMap") for message in messages), messages)

    def test_refuse_an_engine_object_by_value_and_a_type_it_cannot_see(self):
        messages = [violation.message for violation in found(sim("struct FState { UMaterial Material; FHitResult Hit; };"))]
        self.assertTrue(any("engine object UMaterial" in message for message in messages), messages)
        self.assertTrue(any("FHitResult, which the checker cannot see" in message for message in messages), messages)

    def test_refuse_a_command_that_is_a_function(self):
        self.assertEqual(laws(sim("struct FState { int32 N; };", command="struct FCmd { TFunction<FState(FState)> Apply; };")), ["commands-are-data"])

    def test_follow_step_into_helpers_and_name_the_path(self):
        violations = found(sim("struct FState { float N; };", "return FState{ Roll() };", extra="static float Roll() { return FMath::FRand(); }"))
        self.assertEqual([violation.law for violation in violations], ["step-is-pure"])
        self.assertIn("FMath random", violations[0].message)
        self.assertIn("Roll", " ".join(violations[0].via))

    def test_refuse_the_clock_the_world_globals_statics_and_pointers(self):
        cases = {
            "return FState{ (float)FPlatformTime::Seconds() };": "FPlatformTime",
            "return FState{ (float)GetWorld()->TimeSeconds };": "reaches the world",
            "return FState{ (float)GFrameCounter };": "engine global GFrameCounter",
            "static int32 Calls = 0; return FState{ (float)Calls++ };": "static local",
            "Total += 1; return State;": "writes into Total",
            "FRandomStream Stream(1); return FState{ Stream.FRand() };": "makes FRandomStream",
        }
        for body, expected in cases.items():
            with self.subTest(body=body):
                messages = [violation.message for violation in found(sim("struct FState { float N; };", body, extra="float Total = 0;")) if violation.law == "step-is-pure"]
                self.assertTrue(any(expected in message for message in messages), messages)

    def test_refuse_a_step_that_can_write_into_its_input_or_the_sim(self):
        source = b"""
#include "DogSim.h"
struct FState { int32 N; };
struct FCmd { int32 N; };
struct FSim : TDogSim<FState, FCmd>
{
	mutable int32 Seen = 0;
	FState Step(FState& State, TConstArrayView<FCmd> Commands) { return State; }
};
"""
        messages = [violation.message for violation in found(source)]
        self.assertTrue(any("neither static nor const" in message for message in messages), messages)
        self.assertTrue(any("takes FState& State" in message for message in messages), messages)
        self.assertTrue(any("mutable member" in message for message in messages), messages)

    def test_hold_a_layer_to_the_same_laws_its_out_included(self):
        layer = b"""
#include "DogSim.h"
struct FGait { int32 Ticks; };
struct FBody { float Speed; };
struct FGaitLayer : TDogLayer<FGait, FBody, float>
{
	static FGait Step(const FGait& Gait, const FBody& Body) { return FGait{ Gait.Ticks + 1 }; }
	static float Out(const FGait& Gait) { return Gait.Ticks / 60.f; }
};
"""
        self.assertEqual(found(layer), [])
        violations = found(layer.replace(b"return Gait.Ticks / 60.f;", b"return (float)FPlatformTime::Seconds();"))
        self.assertEqual([violation.law for violation in violations], ["step-is-pure"])
        self.assertEqual(violations[0].via, ["FGaitLayer::Out"])

    def test_refuse_a_log_kept_in_an_array(self):
        self.assertEqual(laws(GOOD.replace(b"TDogLog<FCommand> Log;", b"TArray<TArray<FCommand>> Log;").replace(b"Log = Log.Append(Commands);", b"")), ["log-is-append-only"])

    def test_refuse_a_view_that_steps_the_sim(self):
        self.assertEqual(laws(GOOD.replace(b"DOG_SIM_SHELL", b"")), ["project-never-writes-back"])

    def test_every_violation_has_a_law_and_a_fix(self):
        violations = found(sim("struct FState { AActor* Who; };", "return FState{ GetWorld() };"))
        self.assertTrue(violations)
        self.assertTrue(all(violation.law in LAWS and violation.fix for violation in violations))

    def test_the_kernel_keeps_every_law(self):
        self.assertEqual(check_paths([HERE / KERNEL], root=HERE), [])


if __name__ == "__main__":
    unittest.main()
