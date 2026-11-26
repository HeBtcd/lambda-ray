import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'src/js/ray.js');

const tempRoot = mkdtempSync(join(tmpdir(), 'lambda-ray-cs-e2e-'));
after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

let seq = 0;
function makeCaseDir(name) {
  const dir = join(tempRoot, `${++seq}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCs(dir, relPath, source) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  const normalized = source.replace(/^\n/, '').replace(/\r\n/g, '\n');
  writeFileSync(full, normalized, 'utf8');
  return { path: full, source: normalized };
}

function runCli(args, { cwd = ROOT } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ifError(res.error);
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

function runJson(filePath, { cwd = ROOT, flagBefore = false } = {}) {
  const args = flagBefore ? ['--json', filePath] : [filePath, '--json'];
  const res = runCli(args, { cwd });
  assert.equal(res.status, 0, `CLI exited ${res.status}:\n${res.stderr}`);
  return JSON.parse(res.stdout);
}

function runText(filePath, { cwd = ROOT } = {}) {
  const res = runCli([filePath], { cwd });
  assert.equal(res.status, 0, `CLI exited ${res.status}:\n${res.stderr}`);
  return res.stdout;
}

function getFn(data, name) {
  const fn = data.functions.find((f) => f.name === name);
  assert.ok(fn, `expected function "${name}", got: [${data.functions.map((f) => f.name).join(', ')}]`);
  return fn;
}

function locOf(source, snippet, occurrence = 1) {
  let idx = -1;
  let from = 0;
  for (let i = 0; i < occurrence; i++) {
    idx = source.indexOf(snippet, from);
    assert.notEqual(idx, -1, `snippet not found (#${occurrence}): ${snippet}`);
    from = idx + snippet.length;
  }
  const before = source.slice(0, idx).split('\n');
  return { line: before.length, col: before[before.length - 1].length + 1 };
}

describe('lambda-ray C# CLI end-to-end', () => {
  describe('CLI options, errors, path normalization, and text formatting', () => {
    test('--help and -h print usage and supported languages and exit 0', () => {
      for (const flag of ['--help', '-h']) {
        const res = runCli([flag]);
        assert.equal(res.status, 0);
        assert.match(res.stdout, /usage: lambda-ray <file> \[--json\]/);
        assert.match(res.stdout, /csharp\s+\.cs/);
      }
    });

    test('exits with status 2 on missing file arg, missing file, and unsupported extension', () => {
      const noArg = runCli([]);
      assert.equal(noArg.status, 2);
      assert.match(noArg.stderr, /usage: lambda-ray <file> \[--json\]/);

      const dir = makeCaseDir('cli-errors');
      const missing = runCli([join(dir, 'Missing.cs')]);
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /file not found:/);

      const { path: txtPath } = writeCs(dir, 'notes.txt', 'hello');
      const badExt = runCli([txtPath]);
      assert.equal(badExt.status, 2);
      assert.match(badExt.stderr, /unsupported extension: \.txt/);
    });

    test('normalizes paths relative to cwd when inside cwd, absolute POSIX when outside, and accepts uppercase .CS and flag-first --json', () => {
      const dir = makeCaseDir('paths');
      const { path: csPath } = writeCs(dir, 'nested/Upper.CS', `
class EmptyBody {
  public int Auto { get; set; }
  public void NoOp() {}
}
`);
      const relJson = runJson('nested/Upper.CS', { cwd: dir, flagBefore: true });
      assert.equal(relJson.file, 'nested/Upper.CS');
      assert.equal(relJson.language, 'csharp');
      assert.equal(relJson.functions.length, 1);
      assert.equal(relJson.functions[0].name, 'EmptyBody.NoOp');

      const absJson = runJson(csPath, { cwd: ROOT });
      assert.equal(absJson.file, csPath.replaceAll('\\', '/'));
      assert.equal(absJson.language, 'csharp');

      const text = runText('nested/Upper.CS', { cwd: dir });
      assert.equal(
        text.trimEnd(),
        [
          'nested/Upper.CS (csharp)',
          '',
          '  EmptyBody.NoOp (L3:3)',
          '    (none)',
        ].join('\n'),
      );
    });

    test('renders (no functions) in text mode when a C# file has only type/auto-property declarations', () => {
      const dir = makeCaseDir('no-functions');
      const { path: csPath } = writeCs(dir, 'DataOnly.cs', `
public record Item(string Id, int Count);
public class Container {
  public int AutoProp { get; set; }
}
`);
      const data = runJson(csPath);
      assert.deepEqual(data.functions, []);

      const text = runText(csPath, { cwd: dir });
      assert.equal(text.trimEnd(), 'DataOnly.cs (csharp)\n  (no functions)');
    });

    test('human-readable formatRay formats reads, writes, calls (with truncation and tags), subscripts, throws, catches, loops, suspends', () => {
      const dir = makeCaseDir('format-ray');
      writeCs(dir, 'App.csproj', '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
      const { path: csPath } = writeCs(dir, 'FormatSample.cs', `
class FormatSample {
  private int _count;
  private int[] _items = new int[2];
  public async Task Run(int p) {
    _count += p;
    this._items[0] = _items[p];
    var x = this.VeryLongNamedHelperMethodThatExceedsSixtyCharactersInLengthTotal(p);
    UnknownFn();
    try {
      while (_count > 0) {
        await Task.Delay(1);
        throw new InvalidOperationException();
      }
    } catch { }
  }
  private int VeryLongNamedHelperMethodThatExceedsSixtyCharactersInLengthTotal(int v) => v;
}
`);
      const text = runText('FormatSample.cs', { cwd: dir });
      assert.match(text, /^FormatSample\.cs \(csharp\)/);
      assert.match(text, /  FormatSample\.Run \(L4:3, params: p\)/);
      assert.match(text, /    reads:\s+_count \(member, mutable\) @5:5; _items \(member, mutable\) @6:22; _count \(member, mutable\) @10:14/);
      assert.match(text, /    writes:\s+_count \(member\) @5:5; this\._items\[0\] \(member \[this\._items\.\(index\)\]\) @6:5/);
      assert.match(text, /    calls:\s+this\.VeryLongNamedHelperMethodThatExceedsSixtyCharactersI\.\.\. -> FormatSample\.VeryLongNamedHelperMethodThatExceedsSixtyCharactersInLengthTotal \(local, recv: member\) @7:13/);
      assert.match(text, /UnknownFn \(dynamic, unresolved\) @8:5/);
      assert.match(text, /    subscripts:\s+_items\[p\] \(member\) @6:22/);
      assert.match(text, /    throws:\s+@12:9/);
      assert.match(text, /    catches:\s+@14:7/);
      assert.match(text, /    loops:\s+while @10:7/);
      assert.match(text, /    suspends:\s+await @11:9/);
    });
  });

  describe('types, methods, overloads, constructors, properties, and indexers', () => {
    test('supports classes, nested classes, records, record structs, structs, constructors, overloads, property accessors, and indexers', () => {
      const dir = makeCaseDir('types-members');
      const { path: csPath, source } = writeCs(dir, 'Types.cs', `
using System;

public record Person(string Name, int Age) {
  public string Describe() => Name;
}

public record struct Coord(double X, double Y) {
  public double Sum() => X + Y;
}

public readonly record struct RoCoord(double X, double Y) {
  public double Sum() => X + Y;
}

public struct Counter {
  private int _value;
  public Counter(int initial) { _value = initial; }
  public void Increment() { _value++; }
}

public class Outer {
  public class Inner {
    private int _x;
    private readonly int _id;
    private int[] _buf = new int[4];

    public Inner() : this(1) {}
    public Inner(int id) { _id = id; }

    public int Prop {
      get => _x;
      set => _x = value;
    }

    public int InitProp {
      get { return _id; }
      init { _x = value; }
    }

    public int this[int i] {
      get => _buf[i];
      set => _buf[i] = value;
    }

    public int Compute(int a) => a + _x;
    public int Compute(int a, string label) => a + label.Length;

    public void Dispatch() {
      var a = new Inner();
      var b = new Inner(42);
      var p = new Person("Ada", 30);
      _ = Compute(1);
      _ = Compute(1, "ok");
    }
  }
}
`);
      const data = runJson(csPath);
      const names = data.functions.map((f) => f.name);
      assert.deepEqual(names, [
        'Person.Describe',
        'Coord.Sum',
        'RoCoord.Sum',
        'Counter.constructor',
        'Counter.Increment',
        'Outer.Inner.constructor()',
        'Outer.Inner.constructor(int)',
        'Outer.Inner.Prop.get',
        'Outer.Inner.Prop.set',
        'Outer.Inner.InitProp.get',
        'Outer.Inner.InitProp.init',
        'Outer.Inner.indexer.get',
        'Outer.Inner.indexer.set',
        'Outer.Inner.Compute(int)',
        'Outer.Inner.Compute(int,string)',
        'Outer.Inner.Dispatch',
      ]);

      const describe = getFn(data, 'Person.Describe');
      assert.deepEqual(describe.reads, [
        { name: 'Name', scope: 'member', decl: 'readonly', ...locOf(source, 'Name;', 1) },
      ]);

      const sum = getFn(data, 'Coord.Sum');
      assert.deepEqual(sum.reads.map((r) => [r.name, r.scope, r.decl]), [
        ['X', 'member', 'mutable'],
        ['Y', 'member', 'mutable'],
      ]);

      const roSum = getFn(data, 'RoCoord.Sum');
      assert.deepEqual(roSum.reads.map((r) => [r.name, r.scope, r.decl]), [
        ['X', 'member', 'readonly'],
        ['Y', 'member', 'readonly'],
      ]);

      const counterCtor = getFn(data, 'Counter.constructor');
      assert.deepEqual(counterCtor.params, ['initial']);
      assert.deepEqual(counterCtor.writes, [
        { target: '_value', root: '_value', scope: 'member', path: [], ...locOf(source, '_value = initial') },
      ]);

      const propGet = getFn(data, 'Outer.Inner.Prop.get');
      assert.deepEqual(propGet.params, []);
      assert.equal(propGet.reads[0].name, '_x');

      const propSet = getFn(data, 'Outer.Inner.Prop.set');
      assert.deepEqual(propSet.reads, []); // implicit `value` is a param and excluded from reads
      assert.deepEqual(propSet.writes, [
        { target: '_x', root: '_x', scope: 'member', path: [], ...locOf(source, '_x = value;') },
      ]);

      const initGet = getFn(data, 'Outer.Inner.InitProp.get');
      assert.equal(initGet.reads[0].decl, 'readonly');

      const initSet = getFn(data, 'Outer.Inner.InitProp.init');
      assert.equal(initSet.writes[0].target, '_x');

      const idxGet = getFn(data, 'Outer.Inner.indexer.get');
      assert.equal(idxGet.reads[0].name, '_buf');
      assert.deepEqual(idxGet.subscripts, [
        { root: '_buf', scope: 'member', index: 'i', ...locOf(source, '_buf[i];') },
      ]);

      const idxSet = getFn(data, 'Outer.Inner.indexer.set');
      assert.deepEqual(idxSet.writes, [
        { target: '_buf[i]', root: '_buf', scope: 'member', path: ['(index)'], ...locOf(source, '_buf[i] = value;') },
      ]);

      const dispatch = getFn(data, 'Outer.Inner.Dispatch');
      assert.deepEqual(
        dispatch.calls.map((c) => ({ expr: c.expr, kind: c.kind, target: c.target, resolved: c.resolved })),
        [
          { expr: 'new Inner()', kind: 'local', target: 'Outer.Inner.constructor()', resolved: true },
          { expr: 'new Inner(42)', kind: 'local', target: 'Outer.Inner.constructor(int)', resolved: true },
          { expr: 'Person.constructor', kind: 'local', target: 'Person.constructor', resolved: true },
          { expr: 'Compute', kind: 'local', target: 'Outer.Inner.Compute(int)', resolved: true },
          { expr: 'Compute', kind: 'local', target: 'Outer.Inner.Compute(int,string)', resolved: true },
        ],
      );
    });
  });

  describe('local functions, lambdas, anonymous methods, and closures', () => {
    test('collects local functions, simple/parenthesized lambdas, anonymous delegate methods, nested callables, and closure reads/writes', () => {
      const dir = makeCaseDir('callables');
      const { path: csPath, source } = writeCs(dir, 'Callables.cs', `
using System;

class Callables {
  private int _member = 5;

  public int Outer(int p) {
    const int LocalConst = 3;
    int localMut = 10;

    int LocalExpr(int a) => a + localMut + LocalConst + p + _member;

    int LocalBlock(int b) {
      Func<int, int> nestedLambda = x => x + b + localMut;
      localMut += b;
      p = b;
      return nestedLambda(1);
    }

    Func<int, int> simple = n => n + localMut;
    Func<int, int, int> paren = (u, v) => {
      int DeepLocal() => u + _member;
      return DeepLocal() + v;
    };
    Action<int> anonTyped = delegate(int k) { localMut = k; };
    Action anonBare = delegate { _member++; };

    return LocalExpr(1) + LocalBlock(2) + simple(3) + paren(4, 5);
  }
}
`);
      const data = runJson(csPath);

      const nestedLoc = locOf(source, 'x => x + b');
      const simpleLoc = locOf(source, 'n => n + localMut');
      const parenLoc = locOf(source, '(u, v) =>');
      const anonTypedLoc = locOf(source, 'delegate(int k)');
      const anonBareLoc = locOf(source, 'delegate { _member++; }');

      const expectedNames = [
        'Callables.Outer',
        'Callables.Outer/LocalExpr',
        'Callables.Outer/LocalBlock',
        `Callables.Outer/LocalBlock/<fn>@${nestedLoc.line}:${nestedLoc.col}`,
        `Callables.Outer/<fn>@${simpleLoc.line}:${simpleLoc.col}`,
        `Callables.Outer/<fn>@${parenLoc.line}:${parenLoc.col}`,
        `Callables.Outer/<fn>@${parenLoc.line}:${parenLoc.col}/DeepLocal`,
        `Callables.Outer/<fn>@${anonTypedLoc.line}:${anonTypedLoc.col}`,
        `Callables.Outer/<fn>@${anonBareLoc.line}:${anonBareLoc.col}`,
      ];
      assert.deepEqual(data.functions.map((f) => f.name), expectedNames);

      const outer = getFn(data, 'Callables.Outer');
      assert.deepEqual(outer.params, ['p']);
      assert.deepEqual(
        outer.calls.map((c) => [c.expr, c.kind, c.target ?? null]),
        [
          ['LocalExpr', 'local', 'Callables.Outer/LocalExpr'],
          ['LocalBlock', 'local', 'Callables.Outer/LocalBlock'],
          ['simple', 'param', null],
          ['paren', 'param', null],
        ],
      );

      const localExpr = getFn(data, 'Callables.Outer/LocalExpr');
      assert.deepEqual(localExpr.params, ['a']);
      assert.deepEqual(
        localExpr.reads.map((r) => [r.name, r.scope, r.decl]),
        [
          ['localMut', 'closure', 'mutable'],
          ['LocalConst', 'closure', 'const'],
          ['p', 'closure', 'param'],
          ['_member', 'member', 'mutable'],
        ],
      );

      const localBlock = getFn(data, 'Callables.Outer/LocalBlock');
      assert.deepEqual(
        localBlock.reads.map((r) => [r.name, r.scope, r.decl]),
        [['localMut', 'closure', 'mutable']],
      );
      assert.deepEqual(
        localBlock.writes.map((w) => [w.target, w.scope]),
        [
          ['localMut', 'closure'],
          ['p', 'closure'],
        ],
      );
      assert.deepEqual(
        localBlock.calls.map((c) => [c.expr, c.kind]),
        [['nestedLambda', 'param']],
      );

      const nested = getFn(data, `Callables.Outer/LocalBlock/<fn>@${nestedLoc.line}:${nestedLoc.col}`);
      assert.deepEqual(nested.params, ['x']);
      assert.deepEqual(
        nested.reads.map((r) => [r.name, r.scope, r.decl]),
        [
          ['b', 'closure', 'param'],
          ['localMut', 'closure', 'mutable'],
        ],
      );

      const parenFn = getFn(data, `Callables.Outer/<fn>@${parenLoc.line}:${parenLoc.col}`);
      assert.deepEqual(parenFn.params, ['u', 'v']);
      assert.equal(parenFn.calls[0].kind, 'local');
      assert.equal(parenFn.calls[0].target, `Callables.Outer/<fn>@${parenLoc.line}:${parenLoc.col}/DeepLocal`);

      const deepLocal = getFn(data, `Callables.Outer/<fn>@${parenLoc.line}:${parenLoc.col}/DeepLocal`);
      assert.deepEqual(deepLocal.reads.map((r) => [r.name, r.scope]), [['u', 'closure'], ['_member', 'member']]);

      const anonTyped = getFn(data, `Callables.Outer/<fn>@${anonTypedLoc.line}:${anonTypedLoc.col}`);
      assert.deepEqual(anonTyped.params, ['k']);
      assert.deepEqual(anonTyped.writes.map((w) => [w.target, w.scope]), [['localMut', 'closure']]);

      const anonBare = getFn(data, `Callables.Outer/<fn>@${anonBareLoc.line}:${anonBareLoc.col}`);
      assert.deepEqual(anonBare.params, []);
      assert.deepEqual(anonBare.reads.map((r) => [r.name, r.scope]), [['_member', 'member']]);
      assert.deepEqual(anonBare.writes.map((w) => [w.target, w.scope]), [['_member', 'member']]);
    });
  });

  describe('top-level statements (<module>)', () => {
    test('omits <module> when top-level statements have no facts, and emits <module> plus nested callables and trailing types when facts exist', () => {
      const dir = makeCaseDir('top-level');
      const { path: emptyTop } = writeCs(dir, 'TrivialTop.cs', `
int x = 1;
x = 2;
`);
      const emptyData = runJson(emptyTop);
      assert.deepEqual(emptyData.functions, []);

      const { path: richTop, source } = writeCs(dir, 'RichTop.cs', `
using System;

int seed = args.Length;
seed += 1;
Func<int, int> addSeed = n => n + seed;
int MulSeed(int n) => n * seed + args.Length;
Console.WriteLine(MulSeed(addSeed(2)));

class Trailing {
  public int Ping() => 1;
}
`);
      const data = runJson(richTop);
      const lambdaLoc = locOf(source, 'n => n + seed');

      assert.deepEqual(data.functions.map((f) => f.name), [
        '<module>',
        `<module>/<fn>@${lambdaLoc.line}:${lambdaLoc.col}`,
        '<module>/MulSeed',
        'Trailing.Ping',
      ]);

      const mod = getFn(data, '<module>');
      assert.equal(mod.line, 1);
      assert.equal(mod.col, 1);
      assert.deepEqual(mod.params, []);
      assert.deepEqual(mod.reads, []); // local `seed` and top-level param `args` are omitted
      assert.deepEqual(mod.writes, []); // simple/compound writes to local `seed` are omitted
      assert.deepEqual(
        mod.calls.map((c) => [c.expr, c.kind, c.target ?? null]),
        [
          ['Console.WriteLine', 'external', 'Console.WriteLine'],
          ['MulSeed', 'local', '<module>/MulSeed'],
          ['addSeed', 'param', null],
        ],
      );

      const lam = getFn(data, `<module>/<fn>@${lambdaLoc.line}:${lambdaLoc.col}`);
      assert.deepEqual(lam.reads.map((r) => [r.name, r.scope, r.decl]), [['seed', 'closure', 'mutable']]);

      const mul = getFn(data, '<module>/MulSeed');
      assert.deepEqual(mul.reads.map((r) => [r.name, r.scope, r.decl]), [
        ['seed', 'closure', 'mutable'],
        ['args', 'closure', 'param'],
      ]);
    });
  });

  describe('fields, reads, writes, compound writes, increments, initializers, and ref/out', () => {
    test('distinguishes const, readonly, and mutable static/instance fields via implicit, this., base., and ClassName.', () => {
      const dir = makeCaseDir('fields');
      const { path: csPath } = writeCs(dir, 'Fields.cs', `
using System;

class Parent {
  protected int _baseMut;
  protected readonly int _baseRo = 2;
  protected const int BaseConst = 3;
  public int ReadOnlyProp { get; } = 4;
  public int MutProp { get; set; }
}

class Child : Parent {
  private const int OwnConst = 10;
  private readonly int _ownRo = 20;
  private int _ownMut;
  private static int _staticMut = 30;
  private static readonly int StaticRo = 40;

  public int ReadAll() {
    return OwnConst
      + _ownRo
      + _ownMut
      + this._ownMut
      + this._ownRo
      + base._baseMut
      + base._baseRo
      + Child._staticMut
      + Child.StaticRo
      + _staticMut
      + BaseConst
      + ReadOnlyProp
      + MutProp
      + Math.PI;
  }
}
`);
      const data = runJson(csPath);
      const fn = getFn(data, 'Child.ReadAll');
      assert.deepEqual(
        fn.reads.map((r) => [r.name, r.scope, r.decl]),
        [
          ['OwnConst', 'module', 'const'],
          ['_ownRo', 'member', 'readonly'],
          ['_ownMut', 'member', 'mutable'],
          ['this._ownMut', 'member', 'mutable'],
          ['this._ownRo', 'member', 'readonly'],
          ['base._baseMut', 'member', 'mutable'],
          ['base._baseRo', 'member', 'readonly'],
          ['Child._staticMut', 'module', 'mutable'],
          ['Child.StaticRo', 'module', 'readonly'],
          ['_staticMut', 'module', 'mutable'],
          ['BaseConst', 'module', 'const'],
          ['ReadOnlyProp', 'member', 'readonly'],
          ['MutProp', 'member', 'mutable'],
          ['Math.PI', 'global', 'const'],
        ],
      );
    });

    test('records writes, compound writes, ++/--, object/collection initializers, and ref/out arguments', () => {
      const dir = makeCaseDir('writes-ref-out');
      const { path: csPath, source } = writeCs(dir, 'WritesAndRefOut.cs', `
using System.Collections.Generic;

class Holder {
  public int Value;
  public int[] Arr = new int[3];
}

class BaseBox {
  protected int _baseVal;
}

class Worker : BaseBox {
  private int _member;
  private static int _sVal;
  private Holder _holder = new Holder();

  private void MutateRefOut(ref int r, out int o) { r += 1; o = 2; }

  public void Exercise(int p, Holder paramHolder) {
    int loc = 0;
    loc = 1;
    loc += 2;
    loc++;
    --loc;

    p = 3;
    p += 4;
    p++;

    _member = 5;
    _member += 6;
    ++_member;
    _member--;

    this._member = 7;
    this._member -= 1;
    this._member++;

    base._baseVal = 8;
    base._baseVal += 2;

    _sVal = 9;
    _sVal += 1;

    var localHolder = new Holder();
    localHolder.Value = 11;
    localHolder.Value += 1;
    paramHolder.Value = 12;
    this._holder.Arr[0] = 13;

    var initObj = new Holder { Value = _member };
    var initList = new List<int> { _sVal };

    MutateRefOut(ref _member, out this._member);
    MutateRefOut(ref loc, out var freshOut);
    MutateRefOut(ref this._holder.Arr[loc], out paramHolder.Value);
  }
}
`);
      const data = runJson(csPath);
      const fn = getFn(data, 'Worker.Exercise');

      assert.deepEqual(
        fn.writes.map((w) => [w.target, w.root, w.scope, w.path]),
        [
          ['p', 'p', 'param', []],
          ['p', 'p', 'param', []],
          ['p', 'p', 'param', []],
          ['_member', '_member', 'member', []],
          ['_member', '_member', 'member', []],
          ['_member', '_member', 'member', []],
          ['_member', '_member', 'member', []],
          ['this._member', 'this', 'member', ['_member']],
          ['this._member', 'this', 'member', ['_member']],
          ['this._member', 'this', 'member', ['_member']],
          ['base._baseVal', 'base', 'member', ['_baseVal']],
          ['base._baseVal', 'base', 'member', ['_baseVal']],
          ['_sVal', '_sVal', 'module', []],
          ['_sVal', '_sVal', 'module', []],
          ['localHolder.Value', 'localHolder', 'local', ['Value']],
          ['localHolder.Value', 'localHolder', 'local', ['Value']],
          ['paramHolder.Value', 'paramHolder', 'param', ['Value']],
          ['this._holder.Arr[0]', 'this', 'member', ['_holder', 'Arr', '(index)']],
          ['_member', '_member', 'member', ['(ref)']],
          ['this._member', 'this', 'member', ['_member', '(out)']],
          ['loc', 'loc', 'local', ['(ref)']],
          ['var freshOut', 'var freshOut', 'expr', ['(out)']],
          ['this._holder.Arr[loc]', 'this', 'member', ['_holder', 'Arr', '(index)', '(ref)']],
          ['paramHolder.Value', 'paramHolder', 'param', ['Value', '(out)']],
        ],
      );

      // Compound reads: _member (+=, ++, --), this._member (-=, ++), base._baseVal (+=), _sVal (+=),
      // initializer RHS (_member, _sVal), plus ref/out argument expressions (_member, this._member, this._holder).
      // Notice initializer LHS `Value =` is NOT in writes, and local/param compound writes do NOT emit reads.
      assert.deepEqual(
        fn.reads.map((r) => [r.name, r.scope]),
        [
          ['_member', 'member'],
          ['_member', 'member'],
          ['_member', 'member'],
          ['this._member', 'member'],
          ['this._member', 'member'],
          ['base._baseVal', 'member'],
          ['_sVal', 'module'],
          ['_member', 'member'],
          ['_sVal', 'module'],
          ['_member', 'member'],
          ['this._member', 'member'],
          ['this._holder', 'member'],
        ],
      );

      // Verify exact line/col on ref/out write points to the argument syntax node
      const refWrite = fn.writes.find((w) => w.path.includes('(ref)') && w.target === '_member');
      assert.deepEqual({ line: refWrite.line, col: refWrite.col }, locOf(source, 'ref _member'));
      const outDeclWrite = fn.writes.find((w) => w.target === 'var freshOut');
      assert.deepEqual({ line: outDeclWrite.line, col: outDeclWrite.col }, locOf(source, 'out var freshOut'));
    });
  });

  describe('invocations, object creation, and subscripts', () => {
    test('classifies local, external, param, opaque, and dynamic calls, new expressions, and subscripts', () => {
      const dir = makeCaseDir('calls-subscripts');
      const { path: csPath } = writeCs(dir, 'CallsAndSubscripts.cs', `
using System;
using System.Collections.Generic;
using static System.Math;

class LocalBase {
  protected virtual void BaseWork() {}
}

class ImplicitCtorType {}

class ExplicitCtorType {
  public ExplicitCtorType(int x) {}
}

class Caller : LocalBase {
  private Action _fieldCb = () => {};
  private int[] _arr = new int[3];
  private int[][] _matrix = new int[2][];

  private void Helper() {}
  private static void StaticHelper() {}
  private Action<int> MakeCb() => _ => {};
  private int[] GetArr() => _arr;

  public void TestCalls(Action<int> paramCb, dynamic dynArg, Action<int>[] cbList) {
    Helper();
    this.Helper();
    base.BaseWork();
    Caller.StaticHelper();

    Abs(-1);
    Console.WriteLine("hi");
    var list = new List<int>();
    list.Add(1);

    paramCb(1);
    Action localCb = () => {};
    localCb();

    dynArg.UnknownMember();
    var u1 = new UnknownType();
    UnknownType u2 = new();

    MissingBare();
    _fieldCb();
    MakeCb()(2);
    cbList[0](3);

    var a = new ImplicitCtorType();
    var b = new ExplicitCtorType(9);
  }

  public int TestSubscripts(int i, int j, int[] paramArr) {
    var localArr = new int[2];
    int v1 = _arr[i];
    int v2 = this._arr[j];
    int v3 = paramArr[0];
    int v4 = localArr[1];
    int v5 = _matrix[i][j];
    int v6 = GetArr()[i];
    string s = _arr[i].ToString();
    _arr[0] = 99;
    return v1 + v2 + v3 + v4 + v5 + v6 + s.Length;
  }
}
`);
      const data = runJson(csPath);
      const callsFn = getFn(data, 'Caller.TestCalls');

      assert.deepEqual(
        callsFn.calls.map((c) => ({
          expr: c.expr,
          kind: c.kind,
          target: c.target ?? null,
          resolved: c.resolved,
          receiverScope: c.receiverScope ?? null,
          receiverRoot: c.receiverRoot ?? null,
        })),
        [
          { expr: 'Helper', kind: 'local', target: 'Caller.Helper', resolved: true, receiverScope: null, receiverRoot: null },
          { expr: 'this.Helper', kind: 'local', target: 'Caller.Helper', resolved: true, receiverScope: 'member', receiverRoot: 'this' },
          { expr: 'base.BaseWork', kind: 'local', target: 'LocalBase.BaseWork', resolved: true, receiverScope: 'member', receiverRoot: 'base' },
          { expr: 'Caller.StaticHelper', kind: 'local', target: 'Caller.StaticHelper', resolved: true, receiverScope: 'global', receiverRoot: 'Caller' },
          { expr: 'Abs', kind: 'external', target: 'Math.Abs', resolved: true, receiverScope: null, receiverRoot: null },
          { expr: 'Console.WriteLine', kind: 'external', target: 'Console.WriteLine', resolved: true, receiverScope: 'global', receiverRoot: 'Console' },
          { expr: 'List.constructor', kind: 'external', target: 'List.constructor', resolved: true, receiverScope: null, receiverRoot: null },
          { expr: 'list.Add', kind: 'external', target: 'List.Add', resolved: true, receiverScope: 'local', receiverRoot: 'list' },
          { expr: 'paramCb', kind: 'param', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'localCb', kind: 'param', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'dynArg.UnknownMember', kind: 'opaque', target: null, resolved: false, receiverScope: 'param', receiverRoot: 'dynArg' },
          { expr: 'new UnknownType', kind: 'opaque', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'new()', kind: 'opaque', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'MissingBare', kind: 'dynamic', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: '_fieldCb', kind: 'dynamic', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'MakeCb()', kind: 'dynamic', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'MakeCb', kind: 'local', target: 'Caller.MakeCb', resolved: true, receiverScope: null, receiverRoot: null },
          { expr: 'cbList[0]', kind: 'dynamic', target: null, resolved: false, receiverScope: null, receiverRoot: null },
          { expr: 'ImplicitCtorType.constructor', kind: 'local', target: 'ImplicitCtorType.constructor', resolved: true, receiverScope: null, receiverRoot: null },
          { expr: 'new ExplicitCtorType(9)', kind: 'local', target: 'ExplicitCtorType.constructor', resolved: true, receiverScope: null, receiverRoot: null },
        ],
      );

      const subFn = getFn(data, 'Caller.TestSubscripts');
      assert.deepEqual(
        subFn.subscripts.map((s) => [s.root, s.scope, s.index]),
        [
          ['_arr', 'member', 'i'],
          ['this._arr', 'member', 'j'],
          ['paramArr', 'param', '0'],
          ['localArr', 'local', '1'],
          ['_matrix[i]', 'member', 'j'],
          ['_matrix', 'member', 'i'],
          ['GetArr()', 'expr', 'i'],
          ['_arr', 'member', 'i'],
        ],
      );
      assert.deepEqual(subFn.writes, [
        {
          target: '_arr[0]',
          root: '_arr',
          scope: 'member',
          path: ['(index)'],
          line: subFn.writes[0].line,
          col: subFn.writes[0].col,
        },
      ]);
      // Receiver subscript `_arr[i].ToString()` does not emit an extra ReadFact for `_arr`
      assert.deepEqual(
        subFn.reads.map((r) => r.name),
        ['_arr', 'this._arr', '_matrix'],
      );
    });
  });

  describe('control flow: loops, throws, catches, await, and yield', () => {
    test('records unbounded loops (while, do, for(;;)) and ignores bounded for/foreach; records throw statements/expressions, catches, await, and yield', () => {
      const dir = makeCaseDir('control-flow');
      const { path: csPath, source } = writeCs(dir, 'ControlFlow.cs', `
using System;
using System.Collections.Generic;
using System.Threading.Tasks;

class ControlFlow {
  private bool _flag;

  public async Task<int> AsyncWork(int[] items, string? s) {
    for (int i = 0; i < items.Length; i++) { _ = items[i]; }
    foreach (var item in items) { _ = item; }

    while (_flag) { break; }
    do { break; } while (_flag);
    for (;;) { break; }
    for (int k = 0; ; k++) { break; }

    try {
      var nonNull = s ?? throw new ArgumentNullException(nameof(s));
      if (nonNull.Length == 0) throw new InvalidOperationException();
    } catch (ArgumentNullException) {
      throw;
    } catch when (_flag) {
    }

    await Task.Delay(1);
    return 1;
  }

  public IEnumerable<int> Stream() {
    yield return 1;
    yield break;
  }
}
`);
      const data = runJson(csPath);

      const asyncFn = getFn(data, 'ControlFlow.AsyncWork');
      assert.deepEqual(asyncFn.loops, [
        { kind: 'while', ...locOf(source, 'while (_flag)') },
        { kind: 'do', ...locOf(source, 'do {') },
        { kind: 'for(;;)', ...locOf(source, 'for (;;)') },
        { kind: 'for(;;)', ...locOf(source, 'for (int k = 0; ; k++)') },
      ]);
      assert.deepEqual(asyncFn.throws, [
        locOf(source, 'throw new ArgumentNullException'),
        locOf(source, 'throw new InvalidOperationException'),
        locOf(source, 'throw;'),
      ]);
      assert.deepEqual(asyncFn.catches, [
        locOf(source, 'catch (ArgumentNullException)'),
        locOf(source, 'catch when (_flag)'),
      ]);
      assert.deepEqual(asyncFn.suspends, [
        { kind: 'await', ...locOf(source, 'await Task.Delay(1)') },
      ]);

      const streamFn = getFn(data, 'ControlFlow.Stream');
      assert.deepEqual(streamFn.suspends, [
        { kind: 'yield', ...locOf(source, 'yield return 1;') },
        { kind: 'yield', ...locOf(source, 'yield break;') },
      ]);
    });
  });

  describe('implicit usings detection via .csproj', () => {
    const sampleCs = `
class Probe {
  public async Task Run() {
    Console.WriteLine("hi");
    var list = new List<int> { 1, 2 };
    _ = list.Where(x => x > 1).ToList();
    await Task.Delay(1);
  }
}
`;

    test('without .csproj or with <ImplicitUsings>disable</ImplicitUsings>, System/Linq/Task calls stay opaque', () => {
      const noProjDir = makeCaseDir('implicit-none');
      const { path: f1 } = writeCs(noProjDir, 'Probe.cs', sampleCs);
      const d1 = runJson(f1);
      const fn1 = getFn(d1, 'Probe.Run');
      assert.equal(fn1.calls.find((c) => c.expr === 'Console.WriteLine').kind, 'opaque');
      assert.equal(fn1.calls.find((c) => c.expr === 'new List<int>').kind, 'opaque');
      assert.equal(fn1.calls.find((c) => c.expr === 'Task.Delay').kind, 'opaque');

      const disabledDir = makeCaseDir('implicit-disable');
      writeCs(disabledDir, 'App.csproj', '<Project><PropertyGroup><ImplicitUsings>disable</ImplicitUsings></PropertyGroup></Project>');
      const { path: f2 } = writeCs(disabledDir, 'Probe.cs', sampleCs);
      const d2 = runJson(f2);
      const fn2 = getFn(d2, 'Probe.Run');
      assert.equal(fn2.calls.find((c) => c.expr === 'Console.WriteLine').kind, 'opaque');
      assert.equal(fn2.calls.find((c) => c.expr === 'Task.Delay').kind, 'opaque');
    });

    test('with <ImplicitUsings>enable</ImplicitUsings> or <ImplicitUsings>True</ImplicitUsings> (including in ancestor dir), implicit namespaces resolve to external', () => {
      const enabledDir = makeCaseDir('implicit-enable');
      writeCs(enabledDir, 'App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
      const { path: f1 } = writeCs(enabledDir, 'deep/nested/Probe.cs', sampleCs);
      const d1 = runJson(f1);
      const fn1 = getFn(d1, 'Probe.Run');
      assert.deepEqual(
        fn1.calls.map((c) => [c.expr, c.kind, c.target, c.resolved]),
        [
          ['Console.WriteLine', 'external', 'Console.WriteLine', true],
          ['List.constructor', 'external', 'List.constructor', true],
          ['list.Where(x => x > 1).ToList', 'external', 'Enumerable.ToList', true],
          ['list.Where', 'external', 'Enumerable.Where', true],
          ['Task.Delay', 'external', 'Task.Delay', true],
        ],
      );

      const trueDir = makeCaseDir('implicit-true');
      writeCs(trueDir, 'App.csproj', '<Project><PropertyGroup><ImplicitUsings>True</ImplicitUsings></PropertyGroup></Project>');
      const { path: f2 } = writeCs(trueDir, 'Probe.cs', sampleCs);
      const d2 = runJson(f2);
      const fn2 = getFn(d2, 'Probe.Run');
      assert.equal(fn2.calls.find((c) => c.expr === 'Console.WriteLine').kind, 'external');
      assert.equal(fn2.calls.find((c) => c.expr === 'Task.Delay').kind, 'external');
    });
  });

  describe('type-position and declaration-name exclusions', () => {
    test('excludes unresolved type names and declaration identifiers from reads', () => {
      const dir = makeCaseDir('type-exclusions');
      const { path: csPath } = writeCs(dir, 'Exclusions.cs', `
using System.Collections.Generic;
using UnknownAlias = FakeNs.FakeAlias;

class Exclusions {
  private int _realField = 1;
  public UnknownProp? TypedProp { get; set; }

  private void Accept(int namedArg) {}

  public UnknownRet Check(UnknownParam p, UnknownOther? opt) {
    var localVar = _realField;
    UnknownLocal? decl = default;
    List<UnknownGeneric> g = new();
    UnknownArray[] arr = new UnknownArray[2];
    (UnknownTupleA, UnknownTupleB) tup = default;
    NsA.NsB.UnknownQualified q = default;

    var t1 = typeof(UnknownTypeOf);
    var t2 = sizeof(UnknownSizeOf);
    var t3 = default(UnknownDefault);
    var c1 = (UnknownCast)p;
    var a1 = p as UnknownAs;
    bool b1 = p is UnknownIs;
    if (p is UnknownDeclPat matched) { _ = matched; }
    foreach (UnknownForeach item in g) { }
    foreach (var item2 in g) { }

    UnknownLocalRet LocalFn(UnknownLocalParam lp) => default;

    try {
      Accept(namedArg: _realField);
      var anon = new { AnonProp = _realField };
      var mb = opt?.MissingMember;
    } catch (UnknownCatchEx ex) {
    }
    return default;
  }
}
`);
      const data = runJson(csPath);
      const fn = getFn(data, 'Exclusions.Check');
      assert.deepEqual(
        fn.reads.map((r) => [r.name, r.scope, r.decl]),
        [
          ['_realField', 'member', 'mutable'],
          ['_realField', 'member', 'mutable'],
          ['_realField', 'member', 'mutable'],
        ],
      );
      const localFn = getFn(data, 'Exclusions.Check/LocalFn');
      assert.deepEqual(localFn.reads, []);
    });
  });

  describe('determinism', () => {
    test('produces byte-identical JSON and text output across repeated CLI invocations', () => {
      const dir = makeCaseDir('determinism');
      writeCs(dir, 'App.csproj', '<Project><PropertyGroup><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
      const { path: csPath } = writeCs(dir, 'Det.cs', `
record Pair(int A, int B) {
  public int Sum() => A + B;
}
class Det {
  private int _acc;
  public int Prop { get => _acc; set => _acc = value; }
  public async Task<int> Run(int x) {
    int local = x;
    int Helper(int y) => y + local + _acc;
    Func<int, int> lam = z => z * local;
    _acc += lam(Helper(1));
    await Task.Delay(1);
    return _acc;
  }
}
`);
      const jsonRuns = [1, 2, 3].map(() => {
        const res = runCli([csPath, '--json'], { cwd: dir });
        assert.equal(res.status, 0);
        return res.stdout;
      });
      assert.equal(jsonRuns[1], jsonRuns[0]);
      assert.equal(jsonRuns[2], jsonRuns[0]);

      const textRuns = [1, 2, 3].map(() => runText('Det.cs', { cwd: dir }));
      assert.equal(textRuns[1], textRuns[0]);
      assert.equal(textRuns[2], textRuns[0]);
    });
  });

  describe('edge regressions', () => {
    test('tracks array size reads, static field writes, predefined/qualified static reads, and excludes nameof and discard writes', () => {
      const dir = makeCaseDir('edge-regressions');
      const { path: csPath } = writeCs(dir, 'Edges.cs', `
using System;

class Probe {
  private int _cap = 4;
  private int _val = 7;
  public static int S = 1;

  public int Run(int x) {
    var arr = new int[_cap];
    Probe.S = 2;
    Probe.S += 3;
    var empty = string.Empty;
    var pi = System.Math.PI;
    var label = nameof(_val);
    _ = x + arr.Length + empty.Length + (int)pi + label.Length;
    return 0;
  }
}
`);
      const data = runJson(csPath);
      const fn = getFn(data, 'Probe.Run');

      assert.deepEqual(
        fn.reads.map((r) => [r.name, r.scope, r.decl]),
        [
          ['_cap', 'member', 'mutable'],
          ['Probe.S', 'module', 'mutable'],
          ['string.Empty', 'global', 'readonly'],
          ['System.Math.PI', 'global', 'const'],
        ],
      );
      assert.deepEqual(
        fn.writes.map((w) => [w.target, w.root, w.scope, w.path]),
        [
          ['Probe.S', 'Probe', 'module', ['S']],
          ['Probe.S', 'Probe', 'module', ['S']],
        ],
      );
      assert.equal(fn.calls.some((c) => c.expr === 'nameof'), false);
    });
  });
});
