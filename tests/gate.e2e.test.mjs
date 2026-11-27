import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const CLI = resolve(REPO_ROOT, 'src/js/ray.js');

const tmpRoot = mkdtempSync(join(tmpdir(), 'lambda-ray-gate-e2e-'));
let seq = 0;

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCaseDir(name) {
  seq += 1;
  const dir = join(tmpRoot, `${String(seq).padStart(3, '0')}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const normalized = content.replace(/^\n/, '').replace(/\r\n/g, '\n');
  writeFileSync(full, normalized, 'utf8');
  return full;
}

function runCli(args, cwd = tmpRoot) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseLineViolations(stdout) {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = /^(.+):(\d+):(\d+)\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
      assert.ok(m, `expected 'file:line:col [rule] msg', got: ${line}`);
      return {
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        rule: m[4],
        message: m[5],
      };
    });
}

describe('lambda-ray --gate CLI contract & error handling', () => {
  it('prints gate help for --gate --help and exits 0', () => {
    const res = runCli(['--gate', '--help']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /usage: lambda-ray --gate <profile\|policy\.json> \[--json\] <files\.\.\.>/);
    assert.match(res.stdout, /strict-sim/);
  });

  it('exits 2 on missing --gate value, missing files, bad policy, missing target, or bad extension', () => {
    const dir = makeCaseDir('cli-errors');
    const clean = writeFile(dir, 'clean.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    const badJson = writeFile(dir, 'bad.json', '{not json');
    const badExtends = writeFile(dir, 'bad-ext.json', JSON.stringify({ extends: 'nope' }));
    const txtFile = writeFile(dir, 'notes.txt', 'hello\n');

    for (const args of [
      ['--gate'],
      ['--gate='],
      ['--gate', 'strict-sim'],
      ['--gate', 'unknown-profile', clean],
      ['--gate', badJson, clean],
      ['--gate', badExtends, clean],
      ['--gate', 'strict-sim', join(dir, 'missing.ts')],
      ['--gate', 'strict-sim', txtFile],
    ]) {
      const res = runCli(args, dir);
      assert.equal(res.status, 2, `expected exit 2 for [${args.join(' ')}], got ${res.status}, stdout=${res.stdout}`);
      assert.notEqual(res.stderr.trim(), '');
    }
  });

  it('supports --gate=strict-sim, multi-file gating, and --json output', () => {
    const dir = makeCaseDir('multi-file');
    const f1 = writeFile(dir, 'a.ts', 'export function f(x: number) { return x + 1; }\n');
    const f2 = writeFile(dir, 'b.ts', 'let count = 0;\nexport function bump() { count += 1; }\n');

    const passRes = runCli(['--gate=strict-sim', '--json', 'a.ts'], dir);
    assert.equal(passRes.status, 0);
    const passJson = JSON.parse(passRes.stdout);
    assert.equal(passJson.passed, true);
    assert.equal(passJson.profile, 'strict-sim');
    assert.deepEqual(passJson.files, ['a.ts']);
    assert.deepEqual(passJson.violations, []);

    const failRes = runCli(['--gate', 'strict-sim', f1, f2], dir);
    assert.equal(failRes.status, 1);
    const parsed = parseLineViolations(failRes.stdout);
    assert.ok(parsed.some((v) => v.file === 'b.ts' && v.line === 1 && v.rule === 'no-module-writes'));
    assert.ok(parsed.some((v) => v.file === 'b.ts' && v.line === 2 && v.rule === 'no-module-writes'));
  });
});

describe('TypeScript/JavaScript structural facts & strict-sim gate', () => {
  it('emits declarations, comments, imports, hazards, and per-function metrics via ray() --json', () => {
    const dir = makeCaseDir('ts-facts');
    const file = writeFile(
      dir,
      'facts.ts',
      `// header comment
import { readFileSync } from 'node:fs';
interface PureShape { readonly x: number; }
const STEP = 2;
export function branchy(n: number): number {
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) return i + STEP;
    }
  }
  return 0;
}
`,
    );

    const res = runCli([file, '--json'], dir);
    assert.equal(res.status, 0);
    const data = JSON.parse(res.stdout);
    assert.equal(data.comments.count, 1);
    assert.deepEqual(data.comments.spans, [{ kind: 'line', line: 1, endLine: 1, col: 1 }]);
    assert.deepEqual(data.imports, [{ source: 'node:fs', kind: 'import', line: 2, col: 1 }]);
    assert.ok(data.declarations.some((d) => d.kind === 'interface' && d.name === 'PureShape'));
    assert.ok(data.declarations.some((d) => d.kind === 'variable' && d.name === 'STEP' && d.modifiers.includes('const')));
    const fn = data.functions.find((f) => f.name === 'branchy');
    assert.deepEqual(fn.metrics, { lines: 8, branches: 3, maxNesting: 3 });
  });

  it('passes clean pure TypeScript simulation rules with exit 0', () => {
    const dir = makeCaseDir('ts-clean');
    const clean = writeFile(
      dir,
      'pure_rules.ts',
      `import { type SimState } from './types.ts';

export interface EntityRow {
  readonly hp: number;
  readonly shield: number;
}

export type Action =
  | { readonly kind: 'hit'; readonly dmg: number }
  | { readonly kind: 'heal'; readonly amount: number };

const BASE_COEFF = 2;

export function applyAction(row: EntityRow, act: Action): EntityRow {
  switch (act.kind) {
    case 'hit': {
      const rem = Math.max(0, row.shield - act.dmg);
      const spill = Math.max(0, act.dmg - row.shield);
      return { hp: Math.max(0, row.hp - spill), shield: rem };
    }
    case 'heal':
      return { hp: row.hp + act.amount * BASE_COEFF, shield: row.shield };
  }
}
`,
    );
    writeFile(dir, 'types.ts', 'export interface SimState { readonly tick: number; }\n');

    const res = runCli(['--gate', 'strict-sim', clean], dir);
    assert.equal(res.status, 0, `expected PASS, got violations:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^PASS pure_rules\.ts/);
  });

  it('rejects adversarial TS slop (GAS class/inheritance/override/blackboard, static/closure/global writes, eval/Reflect, suspends, impure calls, comments, forbidden imports)', () => {
    const dir = makeCaseDir('ts-slop');
    const slop = writeFile(
      dir,
      'slop.ts',
      `// slop comment
import { readFileSync } from 'node:fs';
let modCounter = 0;
abstract class BaseAbility {
  abstract trigger(): void;
}
class FireballAbility extends BaseAbility {
  static activeCount = 0;
  private tags: Record<string, any> = {};
  override trigger(): void {
    FireballAbility.activeCount += 1;
    modCounter += 1;
  }
}
export async function tickSlop(seed: number) {
  /* block
     comment */
  let captured = 0;
  const mutator = () => {
    captured += 1;
  };
  mutator();
  const bag = new Map<string, any>();
  const r = Math.random() + Date.now() + performance.now();
  const raw = readFileSync('x', 'utf8');
  eval('1 + 1');
  Reflect.get({}, 'a');
  (globalThis as any).leak = r;
  await Promise.resolve(raw);
  return bag.size + captured;
}
`,
    );

    const res = runCli(['--gate', 'strict-sim', slop], dir);
    assert.equal(res.status, 1);
    const violations = parseLineViolations(res.stdout);
    const rules = new Set(violations.map((v) => v.rule));

    for (const expectedRule of [
      'no-comments',
      'forbidden-import',
      'no-module-writes',
      'no-classes',
      'no-inheritance',
      'no-polymorphism',
      'no-dynamic-blackboards',
      'no-closure-writes',
      'impure-call',
      'no-eval',
      'no-reflection',
      'no-global-writes',
      'no-suspends',
    ]) {
      assert.ok(rules.has(expectedRule), `missing rule '${expectedRule}' in [${[...rules].join(', ')}]`);
    }

    const commentV = violations.filter((v) => v.rule === 'no-comments');
    assert.deepEqual(commentV.map((v) => v.line), [1, 16]);
    const closureV = violations.find((v) => v.rule === 'no-closure-writes');
    assert.equal(closureV.line, 20);
  });

  it('enforces custom policy.json complexity ceilings and cross-layer forbiddenImports', () => {
    const dir = makeCaseDir('ts-policy');
    const policy = writeFile(
      dir,
      'policy.json',
      JSON.stringify({
        extends: 'strict-sim',
        extraForbiddenImports: ['render', '../net/*'],
        maxFunctionLines: 10,
        maxBranches: 3,
        maxNesting: 2,
        maxFunctionsPerFile: 1,
      }),
    );
    const bloated = writeFile(
      dir,
      'bloated.ts',
      `import { draw } from './render/canvas.ts';
import { send } from '../net/sock.ts';
export function one(x: number): number {
  if (x > 0) {
    if (x > 1) {
      if (x > 2) {
        for (let i = 0; i < x; i++) {
          if (i > 3) return i;
        }
      }
    }
  }
  draw(x);
  send(x);
  return 0;
}
export function two() { return 2; }
`,
    );

    const res = runCli(['--gate', policy, '--json', bloated], dir);
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    const rules = new Set(report.violations.map((v) => v.rule));
    assert.ok(rules.has('forbidden-import'));
    assert.ok(rules.has('max-function-lines'));
    assert.ok(rules.has('max-branches'));
    assert.ok(rules.has('max-nesting'));
    assert.ok(rules.has('max-functions-per-file'));
    assert.equal(report.violations.filter((v) => v.rule === 'forbidden-import').length, 2);
  });
});

describe('C# (Roslyn) structural facts & strict-sim gate', () => {
  it('passes clean pure C# struct rules with exit 0', () => {
    const dir = makeCaseDir('cs-clean');
    const clean = writeFile(
      dir,
      'PureRules.cs',
      `using System;

public enum DamageKind
{
    Physical,
    Arcane
}

public readonly record struct UnitState(int Hp, int Armor)
{
    public UnitState ApplyDamage(int amount, DamageKind kind)
    {
        var mitigation = kind == DamageKind.Physical ? Armor : 0;
        var net = Math.Max(0, amount - mitigation);
        return new UnitState(Math.Max(0, Hp - net), Armor);
    }
}
`,
    );

    const res = runCli(['--gate', 'strict-sim', clean], dir);
    assert.equal(res.status, 0, `expected PASS, got violations:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^PASS PureRules\.cs/);
  });

  it('rejects adversarial C# slop with accurate file:line:col [rule]', () => {
    const dir = makeCaseDir('cs-slop');
    const slop = writeFile(
      dir,
      'SlopAbility.cs',
      `// slop header
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

public abstract class AbilityBase
{
    public virtual int Cost() => 1;
}

public class GasAbility : AbilityBase
{
    private static int _globalCastCount = 0;
    private Dictionary<string, object> _blackboard = new Dictionary<string, object>();

    public override int Cost() => 5;

    public async Task<int> Execute(dynamic target)
    {
        _globalCastCount++;
        int localAcc = 0;
        Action bump = () => { localAcc += 1; };
        bump();
        var r = new Random().Next() + DateTime.Now.Millisecond;
        Console.WriteLine(File.ReadAllText("x"));
        var t = target.GetType();
        unsafe
        {
            int v = 1;
            int* p = &v;
            *p = r;
        }
        await Task.Delay(1);
        return localAcc + _blackboard.Count + t.Name.Length;
    }
}
`,
    );

    const res = runCli(['--gate', 'strict-sim', slop], dir);
    assert.equal(res.status, 1);
    const violations = parseLineViolations(res.stdout);
    const rules = new Set(violations.map((v) => v.rule));

    for (const expectedRule of [
      'no-comments',
      'forbidden-import',
      'no-classes',
      'no-inheritance',
      'no-polymorphism',
      'no-module-writes',
      'no-dynamic-blackboards',
      'no-dynamic-calls',
      'no-closure-writes',
      'impure-call',
      'no-reflection',
      'no-unsafe',
      'no-suspends',
    ]) {
      assert.ok(rules.has(expectedRule), `missing rule '${expectedRule}' in [${[...rules].join(', ')}]`);
    }

    const commentV = violations.find((v) => v.rule === 'no-comments');
    assert.equal(commentV.line, 1);
    assert.equal(commentV.col, 1);
    const unsafeV = violations.find((v) => v.rule === 'no-unsafe');
    assert.ok(unsafeV.line >= 28);
  });

  it('enforces custom policy.json complexity ceilings on C#', () => {
    const dir = makeCaseDir('cs-policy');
    const policy = writeFile(
      dir,
      'cs-policy.json',
      JSON.stringify({
        extends: 'strict-sim',
        maxFunctionLines: 8,
        maxBranches: 2,
        maxNesting: 2,
      }),
    );
    const bloated = writeFile(
      dir,
      'Bloated.cs',
      `public readonly struct S
{
    public static int Heavy(int x)
    {
        if (x > 0)
        {
            if (x > 1)
            {
                if (x > 2)
                {
                    return 3;
                }
            }
        }
        return 0;
    }
}
`,
    );

    const res = runCli(['--gate', policy, '--json', bloated], dir);
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    const rules = new Set(report.violations.map((v) => v.rule));
    assert.ok(rules.has('max-function-lines'));
    assert.ok(rules.has('max-branches'));
    assert.ok(rules.has('max-nesting'));
  });
});

describe('4-language AST syntaxKinds & external call allowlist (strict-sim-allowlist)', () => {
  it('passes clean pure rule files across TS, C#, C++, and Rust (plus doghouse e2e/game-src/rules.ts)', () => {
    const dir = makeCaseDir('allowlist-clean');

    const tsTypes = writeFile(dir, 'types.ts', 'export interface Unit { readonly hp: number; }\n');
    const tsClean = writeFile(
      dir,
      'rules.ts',
      `import { type Unit } from './types.ts';

export type StepCmd = { readonly kind: 'hit'; readonly dmg: number };

export function stepUnit(u: Unit, cmd: StepCmd): Unit {
  const next = Math.max(0, u.hp - cmd.dmg);
  return { hp: next };
}
`,
    );

    const csClean = writeFile(
      dir,
      'PureRules.cs',
      `using System;

namespace PureSim
{
    public enum Phase
    {
        Idle = 0,
        Active = 1
    }

    public readonly record struct ActorState(int Hp, int Shield, Phase Phase)
    {
        public ActorState ApplyHit(int dmg)
        {
            var blocked = Math.Min(Shield, dmg);
            var rem = dmg - blocked;
            return new ActorState(Math.Max(0, Hp - rem), Shield - blocked, Phase.Active);
        }
    }
}
`,
    );

    const cppClean = writeFile(
      dir,
      'pure_rules.hpp',
      `#pragma once
#include <algorithm>
#include <cstdint>

enum class Phase : uint8_t { Idle = 0, Active = 1 };

struct ActorState {
  int32_t hp;
  int32_t shield;
  Phase phase;
};

constexpr int32_t MAX_HP = 100;

inline ActorState apply_hit(ActorState s, int32_t dmg) {
  const int32_t blocked = std::min(s.shield, dmg);
  const int32_t rem = dmg - blocked;
  s.shield -= blocked;
  s.hp = std::clamp(s.hp - rem, 0, MAX_HP);
  return s;
}
`,
    );

    const rsClean = writeFile(
      dir,
      'pure_rules.rs',
      `#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Active,
}

#[derive(Clone, Copy)]
pub struct Actor {
    pub hp: i32,
    pub shield: i32,
    pub phase: Phase,
}

pub const MAX_HP: i32 = 100;

pub fn step_actor(mut actor: Actor, dmg: i32) -> Actor {
    let blocked = actor.shield.min(dmg);
    let rem = dmg - blocked;
    actor.shield -= blocked;
    actor.hp = (actor.hp - rem).max(0).min(MAX_HP);
    match actor.phase {
        Phase::Idle => {
            actor.phase = Phase::Active;
        }
        Phase::Active => {}
    }
    for i in 0..2 {
        if i > 0 && actor.hp > 0 {
            actor.hp -= 1;
        }
    }
    actor
}
`,
    );

    const targets = [tsTypes, tsClean, csClean, cppClean, rsClean];
    const doghouseRules = resolve(REPO_ROOT, '../e2e/game-src/rules.ts');
    if (existsSync(doghouseRules)) {
      targets.push(doghouseRules);
    }

    const res = runCli(['--gate', 'strict-sim-allowlist', ...targets], dir);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^PASS /);
  });

  it('rejects TS novel syntax (Proxy, function*, with, class, any) and unapproved external calls under strict-sim-allowlist', () => {
    const dir = makeCaseDir('allowlist-ts-slop');
    const proxyFile = writeFile(dir, 'proxy.ts', 'export function mk(x: { a: number }) { return new Proxy(x, {}); }\n');
    const genFile = writeFile(dir, 'gen.ts', 'export function* sneaky() { return 1; }\n');
    const withFile = writeFile(dir, 'with.js', 'export function f(o) { with (o) { return a; } }\n');
    const clsFile = writeFile(dir, 'cls.ts', 'export class Box { v = 1; }\n');
    const extFile = writeFile(dir, 'ext.ts', 'export function parse(s: string) { return JSON.parse(s); }\n');

    for (const [f, expectedRules] of [
      [proxyFile, ['no-reflection', 'disallowed-external-call']],
      [genFile, ['disallowed-syntax']],
      [withFile, ['disallowed-syntax', 'no-eval']],
      [clsFile, ['disallowed-syntax', 'no-classes']],
      [extFile, ['disallowed-external-call']],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      for (const r of expectedRules) {
        assert.ok(rules.has(r), `expected '${r}' for ${f}, got [${[...rules].join(', ')}]`);
      }
    }
  });

  it('rejects C# novel syntax (delegate, goto, event, record class) and unapproved external calls under strict-sim-allowlist', () => {
    const dir = makeCaseDir('allowlist-cs-slop');
    const delFile = writeFile(dir, 'Del.cs', 'public delegate int Op(int x);\n');
    const gotoFile = writeFile(
      dir,
      'Goto.cs',
      'public readonly struct S { public static int F(int x) { if (x > 0) goto end; return 0; end: return 1; } }\n',
    );
    const eventFile = writeFile(
      dir,
      'Evt.cs',
      'using System;\npublic struct S { public event Action Changed; }\n',
    );
    const recClassFile = writeFile(dir, 'RecClass.cs', 'public record EntityRecord(int Id);\n');
    const extFile = writeFile(
      dir,
      'Ext.cs',
      'using System;\npublic readonly struct S { public static byte[] F(int x) => BitConverter.GetBytes(x); }\n',
    );

    for (const [f, expectedRule] of [
      [delFile, 'disallowed-syntax'],
      [gotoFile, 'disallowed-syntax'],
      [eventFile, 'disallowed-syntax'],
      [recClassFile, 'disallowed-syntax'],
      [extFile, 'disallowed-external-call'],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      assert.ok(rules.has(expectedRule), `expected '${expectedRule}' for ${f}, got [${[...rules].join(', ')}]`);
    }
  });

  it('rejects C++ novel syntax (goto, reinterpret_cast, thread_local) and unapproved external calls under strict-sim-allowlist', () => {
    const dir = makeCaseDir('allowlist-cpp-slop');
    const gotoFile = writeFile(dir, 'goto.cpp', 'int f(int x) { if (x > 0) goto done; return 0; done: return 1; }\n');
    const castFile = writeFile(dir, 'reinterp.cpp', 'long f(int* p) { return reinterpret_cast<long>(p); }\n');
    const tlFile = writeFile(dir, 'tl.cpp', 'int f() { thread_local int c = 0; return c; }\n');
    const extFile = writeFile(dir, 'ext.cpp', 'int f(int x) { return mystery_external_fn(x); }\n');

    for (const [f, expectedRule] of [
      [gotoFile, 'disallowed-syntax'],
      [castFile, 'disallowed-syntax'],
      [tlFile, 'disallowed-syntax'],
      [extFile, 'disallowed-external-call'],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      assert.ok(rules.has(expectedRule), `expected '${expectedRule}' for ${f}, got [${[...rules].join(', ')}]`);
    }
  });

  it('rejects Rust structural & novel syntax (unsafe, static mut, macro_rules!, dyn Trait, comments) and unapproved external calls', () => {
    const dir = makeCaseDir('allowlist-rs-slop');
    const unsafeFile = writeFile(dir, 'unsafe_mod.rs', 'pub fn f(x: i32) -> i32 { unsafe { x + 1 } }\n');
    const staticMutFile = writeFile(dir, 'stat_mut.rs', 'static mut COUNTER: i32 = 0;\npub fn f() -> i32 { 1 }\n');
    const macroFile = writeFile(dir, 'mac.rs', 'macro_rules! make_one { () => { 1 }; }\npub fn f() -> i32 { make_one!() }\n');
    const dynFile = writeFile(dir, 'dyn_tr.rs', 'pub fn f(x: &dyn core::fmt::Debug) -> i32 { 1 }\n');
    const extFile = writeFile(dir, 'ext.rs', 'pub fn f(x: i32) -> i32 { mystery_rust_fn(x) }\n');
    const commentFile = writeFile(dir, 'commented.rs', '// slop comment\npub fn f(x: i32) -> i32 { x }\n');

    for (const [f, expectedRules] of [
      [unsafeFile, ['disallowed-syntax', 'no-unsafe']],
      [staticMutFile, ['disallowed-syntax', 'no-module-writes']],
      [macroFile, ['disallowed-syntax', 'no-dynamic-calls']],
      [dynFile, ['disallowed-syntax', 'no-dynamic-calls']],
      [extFile, ['disallowed-external-call']],
      [commentFile, ['no-comments']],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      for (const r of expectedRules) {
        assert.ok(rules.has(r), `expected '${r}' for ${f}, got [${[...rules].join(', ')}]`);
      }
    }
  });
});

describe('C++ structural facts & strict-sim gate', () => {
  it('passes clean pure C++ struct/constexpr rules with exit 0', () => {
    const dir = makeCaseDir('cpp-clean');
    const clean = writeFile(
      dir,
      'pure_rules.hpp',
      `#pragma once
#include <algorithm>
#include <cstdint>

enum class Phase : uint8_t { Idle, Active };

struct SimActor {
  int32_t hp;
  int32_t shield;
  Phase phase;
};

constexpr int32_t MAX_SHIELD = 100;

inline SimActor step_damage(SimActor actor, int32_t dmg) {
  int32_t blocked = std::min(actor.shield, dmg);
  int32_t rem_dmg = dmg - blocked;
  actor.shield = std::min(MAX_SHIELD, actor.shield - blocked);
  actor.hp = std::max(0, actor.hp - rem_dmg);
  return actor;
}
`,
    );

    const res = runCli(['--gate', 'strict-sim', clean], dir);
    assert.equal(res.status, 0, `expected PASS, got violations:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^PASS pure_rules\.hpp/);
  });

  it('rejects adversarial C++ slop with accurate file:line:col [rule]', () => {
    const dir = makeCaseDir('cpp-slop');
    const slop = writeFile(
      dir,
      'slop_ability.cpp',
      `// GAS slop header
#include <fstream>
#include <iostream>
#include <unordered_map>
#include <any>
#include <cstdlib>

int g_tick_counter = 0;

class UBaseAbility {
public:
  virtual void activate() = 0;
};

struct DerivedAbility : public UBaseAbility {
  static int s_instances;
  std::unordered_map<std::string, std::any> blackboard;
  void activate() override {
    g_tick_counter += 1;
    s_instances += 1;
  }
};

struct CoroTask {};

CoroTask run_slop(UBaseAbility* ab) {
  /* multiline
     slop comment */
  static int s_local = 0;
  s_local += 1;
  int cap = 0;
  auto mutate_cap = [&]() {
    cap += 1;
  };
  mutate_cap();
  auto* derived = dynamic_cast<DerivedAbility*>(ab);
  auto* raw = reinterpret_cast<char*>(ab);
  int r = std::rand();
  std::cout << r;
  if (derived && raw) goto fail;
  co_await r;
fail:
  co_yield cap;
}
`,
    );

    const res = runCli(['--gate', 'strict-sim', slop], dir);
    assert.equal(res.status, 1);
    const violations = parseLineViolations(res.stdout);
    const rules = new Set(violations.map((v) => v.rule));

    for (const expectedRule of [
      'no-comments',
      'forbidden-import',
      'no-module-writes',
      'no-classes',
      'no-inheritance',
      'no-polymorphism',
      'no-dynamic-blackboards',
      'no-closure-writes',
      'no-reflection',
      'no-unsafe',
      'impure-call',
      'no-suspends',
    ]) {
      assert.ok(rules.has(expectedRule), `missing rule '${expectedRule}' in [${[...rules].join(', ')}]`);
    }

    const clsV = violations.find((v) => v.rule === 'no-classes');
    assert.equal(clsV.line, 10);
    const closureV = violations.find((v) => v.rule === 'no-closure-writes');
    assert.equal(closureV.line, 33);
  });

  it('enforces custom policy.json complexity ceilings on C++', () => {
    const dir = makeCaseDir('cpp-policy');
    const policy = writeFile(
      dir,
      'cpp-policy.json',
      JSON.stringify({
        extends: 'strict-sim',
        maxFunctionLines: 8,
        maxBranches: 2,
        maxNesting: 2,
      }),
    );
    const bloated = writeFile(
      dir,
      'bloated.cpp',
      `int heavy(int x) {
  if (x > 0) {
    if (x > 1) {
      if (x > 2) {
        return 3;
      }
    }
  }
  return 0;
}
`,
    );

    const res = runCli(['--gate', policy, '--json', bloated], dir);
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    const rules = new Set(report.violations.map((v) => v.rule));
    assert.ok(rules.has('max-function-lines'));
    assert.ok(rules.has('max-branches'));
    assert.ok(rules.has('max-nesting'));
  });
});

describe('4-language AST syntaxKinds & external call allowlist (strict-sim-allowlist)', () => {
  it('passes clean pure rule files across TS, C#, C++, and Rust (plus doghouse e2e/game-src/rules.ts)', () => {
    const dir = makeCaseDir('allowlist-clean');

    const tsTypes = writeFile(dir, 'types.ts', 'export interface Unit { readonly hp: number; }\n');
    const tsClean = writeFile(
      dir,
      'rules.ts',
      `import { type Unit } from './types.ts';

export type StepCmd = { readonly kind: 'hit'; readonly dmg: number };

export function stepUnit(u: Unit, cmd: StepCmd): Unit {
  const next = Math.max(0, u.hp - cmd.dmg);
  return { hp: next };
}
`,
    );

    const csClean = writeFile(
      dir,
      'PureRules.cs',
      `using System;

namespace PureSim
{
    public enum Phase
    {
        Idle = 0,
        Active = 1
    }

    public readonly record struct ActorState(int Hp, int Shield, Phase Phase)
    {
        public ActorState ApplyHit(int dmg)
        {
            var blocked = Math.Min(Shield, dmg);
            var rem = dmg - blocked;
            return new ActorState(Math.Max(0, Hp - rem), Shield - blocked, Phase.Active);
        }
    }
}
`,
    );

    const cppClean = writeFile(
      dir,
      'pure_rules.hpp',
      `#pragma once
#include <algorithm>
#include <cstdint>

enum class Phase : uint8_t { Idle = 0, Active = 1 };

struct ActorState {
  int32_t hp;
  int32_t shield;
  Phase phase;
};

constexpr int32_t MAX_HP = 100;

inline ActorState apply_hit(ActorState s, int32_t dmg) {
  const int32_t blocked = std::min(s.shield, dmg);
  const int32_t rem = dmg - blocked;
  s.shield -= blocked;
  s.hp = std::clamp(s.hp - rem, 0, MAX_HP);
  return s;
}
`,
    );

    const rsClean = writeFile(
      dir,
      'pure_rules.rs',
      `#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Active,
}

#[derive(Clone, Copy)]
pub struct Actor {
    pub hp: i32,
    pub shield: i32,
    pub phase: Phase,
}

pub const MAX_HP: i32 = 100;

pub fn step_actor(mut actor: Actor, dmg: i32) -> Actor {
    let blocked = actor.shield.min(dmg);
    let rem = dmg - blocked;
    actor.shield -= blocked;
    actor.hp = (actor.hp - rem).max(0).min(MAX_HP);
    match actor.phase {
        Phase::Idle => {
            actor.phase = Phase::Active;
        }
        Phase::Active => {}
    }
    for i in 0..2 {
        if i > 0 && actor.hp > 0 {
            actor.hp -= 1;
        }
    }
    actor
}
`,
    );

    const targets = [tsTypes, tsClean, csClean, cppClean, rsClean];
    const doghouseRules = resolve(REPO_ROOT, '../e2e/game-src/rules.ts');
    if (existsSync(doghouseRules)) {
      targets.push(doghouseRules);
    }

    const res = runCli(['--gate', 'strict-sim-allowlist', ...targets], dir);
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /^PASS /);
  });

  it('rejects TS novel syntax (Proxy, function*, with, class, any) and unapproved external calls under strict-sim-allowlist', () => {
    const dir = makeCaseDir('allowlist-ts-slop');
    const proxyFile = writeFile(dir, 'proxy.ts', 'export function mk(x: { a: number }) { return new Proxy(x, {}); }\n');
    const genFile = writeFile(dir, 'gen.ts', 'export function* sneaky() { return 1; }\n');
    const withFile = writeFile(dir, 'with.js', 'export function f(o) { with (o) { return a; } }\n');
    const clsFile = writeFile(dir, 'cls.ts', 'export class Box { v = 1; }\n');
    const extFile = writeFile(dir, 'ext.ts', 'export function parse(s: string) { return JSON.parse(s); }\n');

    for (const [f, expectedRules] of [
      [proxyFile, ['no-reflection', 'disallowed-external-call']],
      [genFile, ['disallowed-syntax']],
      [withFile, ['disallowed-syntax', 'no-eval']],
      [clsFile, ['disallowed-syntax', 'no-classes']],
      [extFile, ['disallowed-external-call']],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      for (const r of expectedRules) {
        assert.ok(rules.has(r), `expected '${r}' for ${f}, got [${[...rules].join(', ')}]`);
      }
    }
  });

  it('rejects C# novel syntax (delegate, goto, event, record class) and unapproved external calls under strict-sim-allowlist', () => {
    const dir = makeCaseDir('allowlist-cs-slop');
    const delFile = writeFile(dir, 'Del.cs', 'public delegate int Op(int x);\n');
    const gotoFile = writeFile(
      dir,
      'Goto.cs',
      'public readonly struct S { public static int F(int x) { if (x > 0) goto end; return 0; end: return 1; } }\n',
    );
    const eventFile = writeFile(
      dir,
      'Evt.cs',
      'using System;\npublic struct S { public event Action Changed; }\n',
    );
    const recClassFile = writeFile(dir, 'RecClass.cs', 'public record EntityRecord(int Id);\n');
    const extFile = writeFile(
      dir,
      'Ext.cs',
      'using System;\npublic readonly struct S { public static byte[] F(int x) => BitConverter.GetBytes(x); }\n',
    );

    for (const [f, expectedRule] of [
      [delFile, 'disallowed-syntax'],
      [gotoFile, 'disallowed-syntax'],
      [eventFile, 'disallowed-syntax'],
      [recClassFile, 'disallowed-syntax'],
      [extFile, 'disallowed-external-call'],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      assert.ok(rules.has(expectedRule), `expected '${expectedRule}' for ${f}, got [${[...rules].join(', ')}]`);
    }
  });

  it('rejects C++ novel syntax (goto, reinterpret_cast, thread_local) and unapproved external calls under strict-sim-allowlist', () => {
    const dir = makeCaseDir('allowlist-cpp-slop');
    const gotoFile = writeFile(dir, 'goto.cpp', 'int f(int x) { if (x > 0) goto done; return 0; done: return 1; }\n');
    const castFile = writeFile(dir, 'reinterp.cpp', 'long f(int* p) { return reinterpret_cast<long>(p); }\n');
    const tlFile = writeFile(dir, 'tl.cpp', 'int f() { thread_local int c = 0; return c; }\n');
    const extFile = writeFile(dir, 'ext.cpp', 'int f(int x) { return mystery_external_fn(x); }\n');

    for (const [f, expectedRule] of [
      [gotoFile, 'disallowed-syntax'],
      [castFile, 'disallowed-syntax'],
      [tlFile, 'disallowed-syntax'],
      [extFile, 'disallowed-external-call'],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      assert.ok(rules.has(expectedRule), `expected '${expectedRule}' for ${f}, got [${[...rules].join(', ')}]`);
    }
  });

  it('rejects Rust structural & novel syntax (unsafe, static mut, macro_rules!, dyn Trait, comments) and unapproved external calls', () => {
    const dir = makeCaseDir('allowlist-rs-slop');
    const unsafeFile = writeFile(dir, 'unsafe_mod.rs', 'pub fn f(x: i32) -> i32 { unsafe { x + 1 } }\n');
    const staticMutFile = writeFile(dir, 'stat_mut.rs', 'static mut COUNTER: i32 = 0;\npub fn f() -> i32 { 1 }\n');
    const macroFile = writeFile(dir, 'mac.rs', 'macro_rules! make_one { () => { 1 }; }\npub fn f() -> i32 { make_one!() }\n');
    const dynFile = writeFile(dir, 'dyn_tr.rs', 'pub fn f(x: &dyn core::fmt::Debug) -> i32 { 1 }\n');
    const extFile = writeFile(dir, 'ext.rs', 'pub fn f(x: i32) -> i32 { mystery_rust_fn(x) }\n');
    const commentFile = writeFile(dir, 'commented.rs', '// slop comment\npub fn f(x: i32) -> i32 { x }\n');

    for (const [f, expectedRules] of [
      [unsafeFile, ['disallowed-syntax', 'no-unsafe']],
      [staticMutFile, ['disallowed-syntax', 'no-module-writes']],
      [macroFile, ['disallowed-syntax', 'no-dynamic-calls']],
      [dynFile, ['disallowed-syntax', 'no-dynamic-calls']],
      [extFile, ['disallowed-external-call']],
      [commentFile, ['no-comments']],
    ]) {
      const res = runCli(['--gate', 'strict-sim-allowlist', '--json', f], dir);
      assert.equal(res.status, 1, `expected exit 1 for ${f}, got ${res.status}`);
      const report = JSON.parse(res.stdout);
      const rules = new Set(report.violations.map((v) => v.rule));
      for (const r of expectedRules) {
        assert.ok(rules.has(r), `expected '${r}' for ${f}, got [${[...rules].join(', ')}]`);
      }
    }
  });
});
