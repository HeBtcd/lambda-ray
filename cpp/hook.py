import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from laws import SUFFIXES, check_paths


def main():
    raw = sys.stdin.buffer.read().decode("utf-8-sig", "replace")
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError as error:
        print(json.dumps({"systemMessage": f"dog laws: not checked, the tool payload was not JSON ({error})"}))
        return 0
    tool_input = payload.get("tool_input") or {}
    tool_response = payload.get("tool_response") if isinstance(payload.get("tool_response"), dict) else {}
    edited = tool_input.get("file_path") or tool_response.get("filePath") or ""
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()).resolve()
    source = root / "Source"
    if not edited or Path(edited).suffix.lower() not in SUFFIXES:
        return 0
    path = Path(edited)
    path = (path if path.is_absolute() else root / path).resolve()
    if not path.is_relative_to(source) or not source.is_dir():
        return 0
    violations = check_paths([source], root=root)
    if not violations:
        return 0
    listed = "\n".join(f"- {violation}" for violation in violations)
    reason = f"This edit leaves {len(violations)} violation(s) of the dog laws in Source/. Fix them before going on:\n{listed}"
    sys.stdout.write(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
