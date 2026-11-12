set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.cache/venv/Scripts/python.exe"
WORK="$ROOT/.cache/systest/custom"
rm -rf "$WORK"; mkdir -p "$WORK"
cat > "$WORK/myprof.json" <<'EOF'
{
  "name": "myprof",
  "language": "cpp",
  "diagnostics": { "step-is-pure": "step-is-pure" },
  "roots": { "attributes": ["MY_PURE"] },
  "hidden": { "clock": ["std::chrono::"], "io": [] },
  "scan": { "suffixes": [".h", ".cpp"] }
}
EOF
cat > "$WORK/lib.cpp" <<'EOF'
#define MY_PURE
MY_PURE int Good(int A) { return A + 1; }
MY_PURE int Clock() { return (int)std::chrono::system_clock::now().time_since_epoch().count(); }
MY_PURE int Rand() { return std::rand(); }
EOF
OUT="$("$PY" "$ROOT/cpp/laws.py" --profile "$WORK/myprof.json" "$WORK" 2>/dev/null || true)"
echo "$OUT" | grep -q "std::chrono" || { echo "custom profile did not flag the clock"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "Rand" && { echo "custom profile flagged what it excluded"; echo "$OUT"; exit 1; }
echo "custom-profile: ok"
