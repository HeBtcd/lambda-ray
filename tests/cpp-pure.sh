set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.cache/venv/Scripts/python.exe"
WORK="$ROOT/.cache/systest/cpp-pure"
rm -rf "$WORK"; mkdir -p "$WORK"
cat > "$WORK/lib.cpp" <<'EOF'
#define DOG_PURE
DOG_PURE int Good(int A, int B) { return A + B; }
DOG_PURE int Clock() { return (int)std::chrono::system_clock::now().time_since_epoch().count(); }
DOG_PURE int Hidden() { static int calls = 0; return calls++; }
DOG_PURE int Write(int* P) { *P = 1; return *P; }
int NotChecked() { return (int)std::chrono::system_clock::now().time_since_epoch().count(); }
EOF
OUT="$("$PY" "$ROOT/cpp/laws.py" --profile cpp-pure "$WORK" 2>/dev/null || true)"
for expect in "std::chrono" "static local calls" "int\* P"; do
  echo "$OUT" | grep -q "$expect" || { echo "missing: $expect"; echo "$OUT"; exit 1; }
done
echo "$OUT" | grep -q "Good" && { echo "lawful function flagged"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "NotChecked" && { echo "unmarked function flagged"; echo "$OUT"; exit 1; }
echo "cpp-pure: ok"
