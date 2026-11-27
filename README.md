# lambda-ray

Zero-execution deterministic static code X-ray and architectural red-light gate for `.ts`/`.js`, `.cs`, `.cpp`, and `.rs`.

## Usage

### Observe (passive X-ray)

```bash
lambda-ray <file> [--json]
```

Extracts per-function effects (`reads`, `writes`, `calls`, `subscripts`, `throws`, `catches`, `loops`, `suspends`, `metrics`) alongside file-level `declarations`, `comments`, `imports`, `hazards`, and `syntaxKinds` across TS/JS, C#, C++, and Rust.

### Gate (architectural red-light enforcement)

```bash
lambda-ray --gate <profile|policy.json> [--json] <files...>
```

Exit codes:
- `0`: all files pass policy checks (`PASS <files...>` in text mode, `{ passed: true, ... }` in `--json` mode).
- `1`: one or more policy violations, formatted as `file:line:col [rule] message` (or `{ passed: false, profile, files, violations }` with `--json`).
- `2`: usage, missing file, unsupported extension, or policy load/parse error.

## Built-in Profiles

### `strict-sim`

```bash
lambda-ray --gate strict-sim path/to/rules.ts
```

Enforces deterministic, data-oriented simulation boundaries across TS/JS, C#, C++, and Rust:
- **Zero OOP / dynamic dispatch**: forbids `class` / `record` class (`noClasses`), inheritance (`noInheritance`), `virtual` / `abstract` / `override` (`noPolymorphism`), dynamic/opaque calls (`noDynamicCalls`).
- **Zero reflection / unsafe / eval / blackboards**: forbids `eval` / `new Function` / `with` (`noEval`), `Reflect` / `Proxy` / `System.Reflection` / `GetType` / `dynamic_cast` / `typeid` / `std::any` / `TypeId` (`noReflection`), `unsafe` / `fixed` / `stackalloc` / `reinterpret_cast` / `const_cast` / `goto` / Rust `unsafe` / raw pointers (`noUnsafe`), `Map` / `Record<*, any>` / `Dictionary<string, object|dynamic>` / `Hashtable` / `std::unordered_map<std::string, std::any>` / `GameplayTag` / `Blackboard` (`noDynamicBlackboards`).
- **Zero hidden state & side effects**: forbids `global`, `module` / mutable `static`, and `closure` writes (`noGlobalWrites`, `noModuleWrites`, `noClosureWrites`), coroutine/async `suspends` (`noSuspends`), and impure external calls/reads such as `Math.random`, `Date.now`, `performance.now`, `Random`, `DateTime.Now`, `std::rand`, `std::chrono::system_clock`, `println!`, console/stdout, FS, Net, and Env I/O (`noImpureCalls`).
- **Zero comments**: rejects `//` and `/* */` comments (`noComments`).
- **Forbidden stdlib/layer imports**: blocks I/O, network, process, reflection, threading, and engine imports (`forbiddenImports`).
- **Anti-bloat ceilings**: `maxFunctionLines: 120`, `maxBranches: 24`, `maxNesting: 6`, `maxFunctionsPerFile: 24`.

### `strict-sim-allowlist`

```bash
lambda-ray --gate strict-sim-allowlist path/to/rules.ts
```

Extends `strict-sim` with strict per-language **AST syntax allowlists** and **external call allowlists**:
- Any AST `syntaxKind` outside the language's minimal pure-value allowlist fails with `file:line:col [disallowed-syntax] ...` (catching novel bypass syntax such as TS `Proxy`/`function*`/`with`/`class`/`any`, C# `delegate`/`goto`/`event`/`record class`, C++ `goto`/`reinterpret_cast`/`thread_local`, Rust `unsafe`/`static mut`/`macro_rules!`/`dyn Trait`).
- Any `external` call outside `allowedExternalCalls` (deterministic math, value conversions, and pure collection/string primitives) fails with `file:line:col [disallowed-external-call] ...`.

## Custom `policy.json` Format

A custom JSON policy can stand alone or extend a built-in profile with `"extends": "strict-sim"` or `"extends": "strict-sim-allowlist"`:

```json
{
  "extends": "strict-sim-allowlist",
  "noComments": true,
  "extraForbiddenImports": ["render", "../net/*"],
  "maxFunctionLines": 80,
  "maxBranches": 16,
  "maxNesting": 4,
  "maxFunctionsPerFile": 20,
  "noThrows": false,
  "noCatches": false,
  "noLoops": false
}
```

Available policy keys:
- Booleans: `noClasses`, `noInheritance`, `noPolymorphism`, `noReflection`, `noUnsafe`, `noEval`, `noDynamicBlackboards`, `noDynamicCalls`, `noGlobalWrites`, `noModuleWrites`, `noClosureWrites`, `noSuspends`, `noImpureCalls`, `noComments`, `noThrows`, `noCatches`, `noLoops`.
- Arrays / per-language maps: `forbiddenImports` (replaces base list when extending), `extraForbiddenImports` (appends to base `forbiddenImports`), `syntaxAllowlist` (`{ ts, csharp, cpp, rust }` or array), `allowedExternalCalls` (`{ ts, csharp, cpp, rust }` or array, supports exact strings or `/regex/`).
- Numbers: `maxFunctionLines`, `maxBranches`, `maxNesting`, `maxFunctionsPerFile`.

## Runtimes

- **TS/JS**: Node.js `>=18` (TypeScript compiler API)
- **C#**: .NET SDK (`LambdaRay.Observe`, Roslyn)
- **C++**: Python 3 + `pip install -r src/cpp/requirements.txt` (`tree-sitter-cpp`)
- **Rust**: Cargo (`src/rust`, observer mode)
