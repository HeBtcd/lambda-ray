set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.cache/venv/Scripts/python.exe"
WORK="$ROOT/.cache/systest/hooks"
rm -rf "$WORK"

mkdir -p "$WORK/ts/src/sim" "$WORK/ts/src/depot" "$WORK/ts/src/game"
cp "$ROOT/ts/src/sim/sim.ts" "$WORK/ts/src/sim/"
cp "$ROOT/ts/src/depot/schema.ts" "$WORK/ts/src/depot/"
cat > "$WORK/ts/src/game/dice.ts" <<'EOF'
import type { Sim } from '../sim/sim';
export const dice: Sim<{ readonly n: number }, never> = { stepsPerSecond: 60, init: { n: 0 }, step: () => ({ n: Math.random() }) };
EOF

OUT="$(printf '{"tool_input":{"file_path":"%s"},"cwd":"%s"}' "$WORK/ts/src/game/dice.ts" "$WORK/ts" | CLAUDE_PROJECT_DIR="$WORK/ts" node "$ROOT/ts/hooks/laws-guard.mjs")"
echo "$OUT" | grep -q '"decision":"block"' || { echo "ts hook did not block"; echo "$OUT"; exit 1; }

mkdir -p "$WORK/cpp/Source"
cp "$ROOT/cpp/DogSim.h" "$WORK/cpp/Source/"
cat > "$WORK/cpp/Source/Game.h" <<'EOF'
struct FState { int32 N; };
struct FCmd { int32 N; };
struct FSim : TDogSim<FState, FCmd>
{
	static FState Step(const FState& State, TConstArrayView<FCmd> Commands)
	{
		return FState{ (int)FPlatformTime::Seconds() };
	}
};
EOF

OUT="$(printf '{"tool_input":{"file_path":"%s"},"cwd":"%s"}' "$WORK/cpp/Source/Game.h" "$WORK/cpp" | CLAUDE_PROJECT_DIR="$WORK/cpp" "$PY" "$ROOT/cpp/hook.py")"
echo "$OUT" | grep -q '"decision": "block"' || { echo "cpp hook did not block"; echo "$OUT"; exit 1; }

cat > "$WORK/cpp/Source/Clean.h" <<'EOF'
struct FState2 { int32 N; };
struct FCmd2 { int32 N; };
struct FSim2 : TDogSim<FState2, FCmd2>
{
	static FState2 Step(const FState2& State, TConstArrayView<FCmd2> Commands)
	{
		FState2 Next = State;
		Next.N += 1;
		return Next;
	}
};
EOF
rm "$WORK/cpp/Source/Game.h"
OUT="$(printf '{"tool_input":{"file_path":"%s"},"cwd":"%s"}' "$WORK/cpp/Source/Clean.h" "$WORK/cpp" | CLAUDE_PROJECT_DIR="$WORK/cpp" "$PY" "$ROOT/cpp/hook.py")"
[ -z "$OUT" ] || { echo "cpp hook spoke on clean file"; echo "$OUT"; exit 1; }

echo "hooks: ok"
