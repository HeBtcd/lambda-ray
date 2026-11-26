import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const RAY_CLI = resolve(REPO_ROOT, 'src/js/ray.js');

const tmpRoot = mkdtempSync(join(tmpdir(), 'lambda-ray-e2e-'));
let caseCounter = 0;

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCaseDir(name) {
  caseCounter += 1;
  const dir = join(tmpRoot, `${String(caseCounter).padStart(3, '0')}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSource(dir, relPath, content) {
  const fullPath = join(dir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function runCli(args, cwd = tmpRoot) {
  return spawnSync(process.execPath, [RAY_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runJson(filePath, { cwd = tmpRoot, extraArgs = [] } = {}) {
  const res = runCli([filePath, '--json', ...extraArgs], cwd);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
  assert.equal(res.stderr, '');
  return JSON.parse(res.stdout);
}

function findFn(data, name) {
  const fn = data.functions.find((f) => f.name === name);
  assert.ok(fn, `expected function "${name}" in [${data.functions.map((f) => f.name).join(', ')}]`);
  return fn;
}

describe('CLI flags, error handling, and exit codes', () => {
  it('prints help and exits 0 for --help and -h', () => {
    const expected = [
      'usage: lambda-ray <file> [--json]',
      'languages:',
      '  ts/js   .ts .tsx .mts .cts .js .mjs .cjs .jsx',
      '  cpp     .cpp .cc .cxx .hpp .hh .h .hxx',
      '  csharp  .cs',
      '  rust    .rs',
      '',
    ].join('\n');

    for (const flag of ['--help', '-h']) {
      const res = runCli([flag]);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, expected);
      assert.equal(res.stderr, '');
    }

    const withBadFile = runCli(['does-not-exist.ts', '--help']);
    assert.equal(withBadFile.status, 0);
    assert.equal(withBadFile.stdout, expected);
  });

  it('exits 2 with usage on stderr when file argument is missing', () => {
    for (const args of [[], ['--json'], ['-x']]) {
      const res = runCli(args);
      assert.equal(res.status, 2);
      assert.equal(res.stdout, '');
      assert.equal(res.stderr, 'usage: lambda-ray <file> [--json]\n');
    }
  });

  it('exits 2 when target file does not exist', () => {
    const missing = join(tmpRoot, 'missing-file.ts');
    const res = runCli([missing, '--json']);
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^lambda-ray: file not found: /);
  });

  it('exits 2 for unsupported extensions, extensionless files, and directories', () => {
    const dir = makeCaseDir('unsupported');
    const pyFile = writeSource(dir, 'script.py', 'def f(): pass\n');
    const noExt = writeSource(dir, 'README', 'hello\n');
    const dirNamedTs = join(dir, 'folder.ts');
    mkdirSync(dirNamedTs);

    const rPy = runCli([pyFile]);
    assert.equal(rPy.status, 2);
    assert.equal(rPy.stdout, '');
    assert.equal(rPy.stderr, 'lambda-ray: unsupported extension: .py\n');

    const rNoExt = runCli([noExt]);
    assert.equal(rNoExt.status, 2);
    assert.equal(rNoExt.stdout, '');
    assert.equal(rNoExt.stderr, 'lambda-ray: unsupported extension: (none)\n');

    const rDirNoExt = runCli([dir]);
    assert.equal(rDirNoExt.status, 2);
    assert.equal(rDirNoExt.stderr, 'lambda-ray: unsupported extension: (none)\n');

    const rDirTs = runCli([dirNamedTs]);
    assert.equal(rDirTs.status, 2);
    assert.match(rDirTs.stderr, /^lambda-ray: file not found: /);
  });

  it('accepts --json before or after the file path and ignores unknown dash flags', () => {
    const dir = makeCaseDir('flag-order');
    const file = writeSource(dir, 'sample.ts', 'export function id(x: number) { return x; }\n');

    const afterRes = runCli([file, '--json'], dir);
    const beforeRes = runCli(['--json', file], dir);
    const extraFlagRes = runCli(['--unknown-flag', file, '--json'], dir);

    assert.equal(afterRes.status, 0);
    assert.equal(beforeRes.status, 0);
    assert.equal(extraFlagRes.status, 0);
    assert.equal(beforeRes.stdout, afterRes.stdout);
    assert.equal(extraFlagRes.stdout, afterRes.stdout);

    const parsed = JSON.parse(afterRes.stdout);
    assert.equal(parsed.file, 'sample.ts');
    assert.equal(parsed.language, 'ts');
    assert.equal(parsed.functions.length, 1);
  });
});

describe('Path normalization and supported JS/TS extensions', () => {
  it('formats relative paths with forward slashes when inside cwd and absolute forward-slash paths when outside cwd', () => {
    const dir = makeCaseDir('paths');
    const nested = writeSource(dir, 'a/b/mod.ts', 'export function ok() {}\n');
    const outside = writeSource(dir, 'outside.ts', 'export function out() {}\n');
    const innerCwd = join(dir, 'a');

    // Relative path from dir
    const d1 = runJson('a/b/mod.ts', { cwd: dir });
    assert.equal(d1.file, 'a/b/mod.ts');

    // Absolute path that lies inside dir
    const d2 = runJson(nested, { cwd: dir });
    assert.equal(d2.file, 'a/b/mod.ts');

    // File outside cwd (relative would start with '..') -> absolute with '/'
    const d3 = runJson(outside, { cwd: innerCwd });
    assert.equal(d3.file, outside.split('\\').join('/'));
    assert.ok(!d3.file.includes('\\'));

    // File inside repo root using existing repo files
    for (const repoRel of ['src/js/ray.js', 'src/js/observe.js']) {
      const repoRes = runJson(repoRel, { cwd: REPO_ROOT });
      assert.equal(repoRes.file, repoRel);
      assert.equal(repoRes.language, 'ts');
      assert.ok(repoRes.functions.length > 0);
    }
    const rayData = runJson('src/js/ray.js', { cwd: REPO_ROOT });
    assert.ok(rayData.functions.some((f) => f.name === 'ray'));
    assert.ok(rayData.functions.some((f) => f.name === 'formatRay'));
  });

  it('analyzes all JS/TS extensions (.ts, .tsx, .mts, .cts, .js, .mjs, .cjs, .jsx) case-insensitively', () => {
    const dir = makeCaseDir('extensions');
    const cases = [
      ['a.ts', 'export function fnTs(x: number) { return x + 1; }\n', 'fnTs'],
      ['b.TS', 'export function fnUpperTs() { return 1; }\n', 'fnUpperTs'],
      ['c.mts', 'export function fnMts() { return 1; }\n', 'fnMts'],
      ['d.cts', 'export function fnCts() { return 1; }\n', 'fnCts'],
      ['e.js', 'function fnJs(a) { return a; }\n', 'fnJs'],
      ['f.mjs', 'export function fnMjs() { return 1; }\n', 'fnMjs'],
      ['g.cjs', 'module.exports = function fnCjs() { return 1; };\n', 'fnCjs'],
      ['h.tsx', 'const Box = () => null;\nexport function fnTsx() { return <Box />; }\n', 'fnTsx'],
      ['i.jsx', 'function Tag() { return <span />; }\nexport function fnJsx() { return <Tag />; }\n', 'fnJsx'],
    ];

    for (const [filename, code, fnName] of cases) {
      const f = writeSource(dir, filename, code);
      const data = runJson(f, { cwd: dir });
      assert.equal(data.language, 'ts');
      assert.equal(data.file, filename);
      findFn(data, fnName);
    }
  });
});

describe('Human-readable output formatting', () => {
  it('formats empty/declarations-only files and functions with no facts', () => {
    const dir = makeCaseDir('human-empty');
    const emptyFile = writeSource(dir, 'empty.ts', 'type A = string;\ninterface B { x: number; }\n');
    const noopFile = writeSource(dir, 'noop.ts', 'function noop(a: number, b = 2) {\n  const c = a + b;\n  return c;\n}\n');

    const emptyRes = runCli([emptyFile], dir);
    assert.equal(emptyRes.status, 0);
    assert.equal(emptyRes.stdout, 'empty.ts (ts)\n  (no functions)\n');

    const noopRes = runCli([noopFile], dir);
    assert.equal(noopRes.status, 0);
    assert.equal(
      noopRes.stdout,
      ['noop.ts (ts)', '', '  noop (L1:1, params: a, b)', '    (none)', ''].join('\n'),
    );
  });

  it('formats all 8 categories, label padding, arrows, scopes, truncation, and whitespace collapsing', () => {
    const dir = makeCaseDir('human-full');
    writeSource(dir, 'dep.ts', 'export function extCall(v: number) { return v; }\nexport const extVal = 7;\n');
    const mainFile = writeSource(
      dir,
      'main.ts',
      [
        "import { extCall, extVal } from './dep.ts';",
        'let modCount = 0;',
        'const modObj = { prop: 0 };',
        'const modArr = [10, 20];',
        'function localHelper() {}',
        'const longReceiverWithVeryLongVariableNameForTruncationTest = { methodNameThatPushesPastSixtyChars() {} };',
        'async function* fullDemo(cb: () => void) {',
        '  const a = extVal;',
        '  modCount = a;',
        '  modObj.prop = 1;',
        '  localHelper();',
        '  extCall(modArr[0]);',
        '  cb();',
        '  longReceiverWithVeryLongVariableNameForTruncationTest',
        '    .methodNameThatPushesPastSixtyChars();',
        '  while (false) {}',
        '  try { throw new Error("boom"); } catch (err) {}',
        '  await Promise.resolve(1);',
        '  yield 2;',
        '}',
        '',
      ].join('\n'),
    );

    const res = runCli([mainFile], dir);
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    const out = res.stdout;

    assert.match(out, /^main\.ts \(ts\)\n/);
    assert.match(out, /\n  fullDemo \(L7:1, params: cb\)\n/);
    assert.match(out, /\n    reads:       extVal \(import, import, from \.\/dep\.ts\) @8:13; modArr \(module, const\) @12:11\n/);
    assert.match(out, /\n    writes:      modCount \(module\) @9:3; modObj\.prop \(module \[modObj\.prop\]\) @10:3\n/);
    assert.match(
      out,
      /\n    calls:       localHelper \(local\) @11:3; extCall -> \.\/dep\.ts#extCall \(import \.\/dep\.ts\) @12:3; cb \(param, unresolved\) @13:3; longReceiverWithVeryLongVariableNameForTruncationTest \.me\.\.\. -> methodNameThatPushesPastSixtyChars \(local, recv: module\) @14:3; Error \(external\) @17:15; Promise\.resolve \(external, recv: global\) @18:9\n/,
    );
    assert.match(out, /\n    subscripts:  modArr\[0\] \(module\) @12:11\n/);
    assert.match(out, /\n    throws:      @17:9\n/);
    assert.match(out, /\n    catches:     @17:36\n/);
    assert.match(out, /\n    loops:       while @16:3\n/);
    assert.match(out, /\n    suspends:    await @18:3; yield @19:3\n/);
  });
});

describe('Functions, classes, closures, and modules', () => {
  it('labels declarations, named/anonymous expressions, arrows, nested functions, object methods, and parameter shapes', () => {
    const dir = makeCaseDir('fn-kinds');
    const file = writeSource(
      dir,
      'fns.ts',
      [
        'let outerVal = 1;',
        'function declFn(a: number, b = outerVal, ...rest: number[]) {',
        '  const arrowVar = ({ x, y }: { x: number; y: number }) => {',
        '    return x + y;',
        '  };',
        '  const namedExpr = function innerNamed() {',
        '    return arrowVar;',
        '  };',
        '  const anonExpr = function () {',
        '    return namedExpr();',
        '  };',
        '  const obj = {',
        '    objMethod() { return 1; },',
        '    propArrow: () => 2,',
        '  };',
        '  [1].map((item) => item + a + b + rest.length + obj.objMethod() + obj.propArrow());',
        '  return anonExpr();',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    const names = data.functions.map((f) => f.name);
    assert.deepEqual(names, [
      'declFn',
      'declFn/arrowVar',
      'declFn/innerNamed',
      'declFn/anonExpr',
      'declFn/objMethod',
      'declFn/propArrow',
      'declFn/<fn>@16:11',
    ]);

    const declFn = findFn(data, 'declFn');
    assert.deepEqual(declFn.params, ['a', 'b', 'rest']);
    // Default parameter initializer reads module variable outerVal
    assert.deepEqual(
      declFn.reads.map((r) => [r.name, r.scope, r.decl]),
      [['outerVal', 'module', 'mutable']],
    );

    const arrowVar = findFn(data, 'declFn/arrowVar');
    assert.deepEqual(arrowVar.params, ['{ x, y }']);

    const anonCallback = findFn(data, 'declFn/<fn>@16:11');
    // Outer params (a, b, rest) and outer local (obj) become 'closure' inside nested arrow
    assert.deepEqual(
      anonCallback.reads.map((r) => [r.name, r.scope, r.decl]),
      [
        ['a', 'closure', 'param'],
        ['b', 'closure', 'param'],
        ['rest', 'closure', 'param'],
      ],
    );
    assert.deepEqual(
      anonCallback.calls.map((c) => [c.expr, c.kind, c.target, c.receiverScope, c.receiverRoot]),
      [
        ['obj.objMethod', 'local', 'declFn/objMethod', 'closure', 'obj'],
        ['obj.propArrow', 'local', 'declFn/propArrow', 'closure', 'obj'],
      ],
    );
  });

  it('analyzes classes, constructors, methods, accessors, static members, anonymous classes, super, and new', () => {
    const dir = makeCaseDir('classes');
    const file = writeSource(
      dir,
      'cls.ts',
      [
        'class Base {',
        '  greet() { return "hi"; }',
        '}',
        'class Plain {}',
        'class Counter extends Base {',
        '  readonly id: number;',
        '  private count = 0;',
        '  constructor(id: number) {',
        '    super();',
        '    this.id = id;',
        '  }',
        '  get value() {',
        '    return this.count;',
        '  }',
        '  set value(v: number) {',
        '    this.count = v;',
        '  }',
        '  step() {',
        '    this.count += 1;',
        '    return this.helper() + super.greet().length;',
        '  }',
        '  private helper() {',
        '    return this.id;',
        '  }',
        '  static create(n: number) {',
        '    return new Counter(n);',
        '  }',
        '}',
        'const Anon = class {',
        '  ping() {}',
        '};',
        'function useClasses() {',
        '  const c = Counter.create(1);',
        '  const p = new Plain();',
        '  const a = new Anon();',
        '  c.step();',
        '  a.ping();',
        '  return p;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    assert.ok(data.functions.some((f) => f.name === 'Base.greet'));
    assert.ok(data.functions.some((f) => f.name === 'Counter.constructor'));
    assert.ok(data.functions.some((f) => f.name === 'Counter.get value'));
    assert.ok(data.functions.some((f) => f.name === 'Counter.set value'));
    assert.ok(data.functions.some((f) => f.name === 'Counter.step'));
    assert.ok(data.functions.some((f) => f.name === 'Counter.helper'));
    assert.ok(data.functions.some((f) => f.name === 'Counter.create'));
    assert.ok(data.functions.some((f) => f.name === '<class>.ping'));

    const ctor = findFn(data, 'Counter.constructor');
    assert.deepEqual(ctor.params, ['id']);
    assert.deepEqual(
      ctor.calls.map((c) => [c.expr, c.kind, c.resolved]),
      [['super', 'dynamic', false]],
    );
    assert.deepEqual(
      ctor.writes.map((w) => [w.target, w.root, w.scope, w.path]),
      [['this.id', 'this', 'member', ['id']]],
    );

    const getter = findFn(data, 'Counter.get value');
    assert.deepEqual(
      getter.reads.map((r) => [r.name, r.scope, r.decl]),
      [['this.count', 'member', 'mutable']],
    );

    const helper = findFn(data, 'Counter.helper');
    assert.deepEqual(
      helper.reads.map((r) => [r.name, r.scope, r.decl]),
      [['this.id', 'member', 'readonly']],
    );

    const step = findFn(data, 'Counter.step');
    assert.deepEqual(
      step.writes.map((w) => [w.target, w.scope, w.path]),
      [['this.count', 'member', ['count']]],
    );
    assert.deepEqual(
      step.reads.map((r) => [r.name, r.scope, r.decl]),
      [['this.count', 'member', 'mutable']],
    );
    assert.deepEqual(
      step.calls.map((c) => [c.expr, c.kind, c.target, c.receiverScope, c.receiverRoot]),
      [
        ['this.helper', 'local', 'Counter.helper', 'member', 'this'],
        ['super.greet', 'local', 'Base.greet', 'member', 'super'],
      ],
    );

    const create = findFn(data, 'Counter.create');
    assert.deepEqual(
      create.calls.map((c) => [c.expr, c.kind, c.target, c.resolved]),
      [['Counter', 'local', 'Counter.constructor', true]],
    );

    const useClasses = findFn(data, 'useClasses');
    assert.deepEqual(
      useClasses.calls.map((c) => [c.expr, c.kind, c.target, c.resolved, c.receiverScope ?? null]),
      [
        ['Counter.create', 'local', 'Counter.create', true, 'module'],
        ['Plain', 'local', 'Plain', true, null],
        ['Anon', 'dynamic', null, false, null],
        ['c.step', 'local', 'Counter.step', true, 'local'],
        ['a.ping', 'local', '<class>.ping', true, 'local'],
      ],
    );
  });

  it('tracks closure reads/writes while excluding shadowed locals', () => {
    const dir = makeCaseDir('closures');
    const file = writeSource(
      dir,
      'closure.ts',
      [
        'let modVar = 10;',
        'function outer(p: number) {',
        '  let captured = 1;',
        '  const capConst = 2;',
        '  let modVar = 99;',
        '  function inner() {',
        '    captured += p;',
        '    const capConst = 5;',
        '    return captured + capConst + modVar;',
        '  }',
        '  return inner() + captured + capConst + modVar;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    const outer = findFn(data, 'outer');
    assert.equal(outer.reads.length, 0);
    assert.equal(outer.writes.length, 0);

    const inner = findFn(data, 'outer/inner');
    assert.deepEqual(
      inner.writes.map((w) => [w.target, w.scope]),
      [['captured', 'closure']],
    );
    // capConst is shadowed locally inside inner; modVar inside inner refers to outer's local modVar (closure)
    assert.deepEqual(
      inner.reads.map((r) => [r.name, r.scope, r.decl]),
      [
        ['captured', 'closure', 'mutable'],
        ['p', 'closure', 'param'],
        ['captured', 'closure', 'mutable'],
        ['modVar', 'closure', 'mutable'],
      ],
    );
  });

  it('resolves named, aliased, default, namespace, and unresolved imports', () => {
    const dir = makeCaseDir('imports');
    writeSource(
      dir,
      'lib.ts',
      [
        'export function realFn(n: number) { return n * 2; }',
        'export const realConst = 42;',
        'export const nested = { sub(x: string) { return x.length; } };',
        'export default function defFn() { return 1; }',
        '',
      ].join('\n'),
    );
    const entry = writeSource(
      dir,
      'app.ts',
      [
        "import defFn, { realFn as aliasedFn, realConst } from './lib.ts';",
        "import * as ns from './lib.ts';",
        "import { missingFn, missingVal } from 'uninstalled-pkg';",
        'function run() {',
        '  const a = realConst + missingVal;',
        '  const b = defFn() + aliasedFn(a);',
        '  const c = ns.realFn(1) + ns.nested.sub("ok") + ns.realConst;',
        '  const d = missingFn();',
        '  return b + c + d;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(entry, { cwd: dir });
    // Only imports in app.ts; pure import declarations do not produce <module>
    assert.equal(data.functions.length, 1);
    const runFn = findFn(data, 'run');

    assert.deepEqual(
      runFn.reads.map((r) => [r.name, r.scope, r.decl, r.from]),
      [
        ['realConst', 'import', 'import', './lib.ts'],
        ['missingVal', 'import', 'import', 'uninstalled-pkg'],
        ['ns', 'import', 'import', './lib.ts'],
      ],
    );

    assert.deepEqual(
      runFn.calls.map((c) => [c.expr, c.kind, c.target, c.from, c.resolved, c.receiverScope ?? null, c.receiverRoot ?? null]),
      [
        ['defFn', 'import', './lib.ts#defFn', './lib.ts', true, null, null],
        ['aliasedFn', 'import', './lib.ts#realFn', './lib.ts', true, null, null],
        ['ns.realFn', 'import', './lib.ts#realFn', './lib.ts', true, 'import', 'ns'],
        ['ns.nested.sub', 'import', './lib.ts#nested.sub', './lib.ts', true, 'import', 'ns'],
        ['missingFn', 'import', 'uninstalled-pkg#missingFn', 'uninstalled-pkg', true, null, null],
      ],
    );
  });
});

describe('Reads, writes, destructuring, and compound/update operations', () => {
  it('handles module/global reads, object property values vs keys, computed keys, unwrapped parens/assertions, and JSX tags', () => {
    const dir = makeCaseDir('reads');
    const file = writeSource(
      dir,
      'reads.tsx',
      [
        'const modConst = 1;',
        'let modLet = 2;',
        'function modFn() { return 3; }',
        'const modArrow = () => 4;',
        'class ModCls {}',
        'enum ModEnum { A = 1 }',
        'const Box = (props: { children?: unknown }) => null;',
        'function inspect(p: number) {',
        '  const loc = 10;',
        '  const obj = { val: modConst, fixedKey: loc, [modLet]: p };',
        '  const x = (modArrow as any) + (modFn)!;',
        '  const y = Math.PI + undeclaredGlobalVar + ModEnum.A;',
        '  const z = new ModCls();',
        '  return <div><Box /><Box>{obj}{x}{y}{z}</Box></div>;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    const fn = findFn(data, 'inspect');

    assert.deepEqual(
      fn.reads.map((r) => [r.name, r.scope, r.decl]),
      [
        ['modConst', 'module', 'const'],
        ['modLet', 'module', 'mutable'],
        ['modArrow', 'module', 'function'],
        ['modFn', 'module', 'function'],
        ['Math', 'global', 'mutable'],
        ['undeclaredGlobalVar', 'global', 'unknown'],
        ['ModEnum', 'module', 'const'],
        ['Box', 'module', 'function'],
        ['Box', 'module', 'function'],
      ],
    );
    assert.deepEqual(
      fn.calls.map((c) => [c.expr, c.kind, c.target]),
      [['ModCls', 'local', 'ModCls']],
    );
  });

  it('tracks writes across scopes, paths, element writes, expr roots, delete, compound ops, and destructuring', () => {
    const dir = makeCaseDir('writes');
    const file = writeSource(
      dir,
      'writes.ts',
      [
        'let modN = 0;',
        'let modOther = 0;',
        'const modObj = { a: { b: 0 }, items: [1, 2] };',
        'function getBox() { return { prop: 0 }; }',
        'function mutate(paramN: number) {',
        '  let localN = 0;',
        '  const localObj = { nested: { v: 0 }, arr: [1] };',
        '  localN = 1;',
        '  localN += 2;',
        '  localN++;',
        '  paramN = 3;',
        '  paramN += 4;',
        '  paramN--;',
        '  modN = 5;',
        '  modN ??= 6;',
        '  modN ||= 1;',
        '  modN &&= 2;',
        '  ++modN;',
        '  localObj.nested.v = 7;',
        '  localObj.arr[0] = 8;',
        '  modObj.a.b += 9;',
        '  modObj.items[localN] = 10;',
        '  getBox().prop = 11;',
        '  delete (modObj as any).a;',
        '  [modN, localN] = [12, 13];',
        '  ({ a: modOther } = { a: 14 });',
        '  const { missing = modN } = modObj as any;',
        '  return missing;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    const fn = findFn(data, 'mutate');

    assert.deepEqual(
      fn.writes.map((w) => [w.target, w.root, w.scope, w.path]),
      [
        ['paramN', 'paramN', 'param', []],
        ['paramN', 'paramN', 'param', []],
        ['paramN', 'paramN', 'param', []],
        ['modN', 'modN', 'module', []],
        ['modN', 'modN', 'module', []],
        ['modN', 'modN', 'module', []],
        ['modN', 'modN', 'module', []],
        ['modN', 'modN', 'module', []],
        ['localObj.nested.v', 'localObj', 'local', ['nested', 'v']],
        ['localObj.arr[0]', 'localObj', 'local', ['arr', '(index)']],
        ['modObj.a.b', 'modObj', 'module', ['a', 'b']],
        ['modObj.items[localN]', 'modObj', 'module', ['items', '(index)']],
        ['getBox().prop', 'getBox()', 'expr', ['prop']],
        ['(modObj as any).a', 'modObj', 'module', ['a']],
        ['modN', 'modN', 'module', []],
        ['modOther', 'modOther', 'module', []],
      ],
    );

    assert.deepEqual(
      fn.reads.map((r) => [r.name, r.scope, r.line]),
      [
        ['modN', 'module', 15],
        ['modN', 'module', 16],
        ['modN', 'module', 17],
        ['modN', 'module', 18],
        ['modN', 'module', 27],
        ['modObj', 'module', 27],
      ],
    );
  });
});

describe('Calls, chains, subscripts, loops, throws/catches, and suspends', () => {
  it('classifies call kinds, chains, optional calls, and subscripts', () => {
    const dir = makeCaseDir('calls-subscripts');
    const file = writeSource(
      dir,
      'calls.ts',
      [
        'const modArr = ["a", "b"];',
        'const modIdx = 0;',
        'function leaf(x: string) { return { next() { return x.trim(); } }; }',
        'function runner(cb: (() => number) | undefined, dyn: any, items: string[]) {',
        '  let lateArrow: any;',
        '  lateArrow = () => 1;',
        '  const r1 = leaf(modArr[modIdx]).next();',
        '  const r2 = items[0].toUpperCase();',
        '  const r3 = cb?.();',
        '  const r4 = dyn.missing();',
        '  const r5 = lateArrow();',
        '  const r6 = (() => 7)();',
        '  const r7 = unknownFn();',
        '  const grid = [[1, 2]];',
        '  const cell = grid[0][modIdx];',
        '  return [r1, r2, r3, r4, r5, r6, r7, cell];',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    const runner = findFn(data, 'runner');

    assert.deepEqual(
      runner.calls.map((c) => [c.expr, c.kind, c.target, c.resolved, c.receiverScope ?? null]),
      [
        ['leaf(modArr[modIdx]).next', 'local', 'leaf/next', true, 'expr'],
        ['leaf', 'local', 'leaf', true, null],
        ['items[0].toUpperCase', 'external', 'string.toUpperCase', true, 'param'],
        ['cb', 'param', null, false, null],
        ['dyn.missing', 'opaque', null, false, 'param'],
        ['lateArrow', 'dynamic', null, false, null],
        ['() => 7', 'dynamic', null, false, null],
        ['unknownFn', 'external', 'unknownFn', false, null],
      ],
    );

    assert.deepEqual(
      runner.subscripts.map((s) => [s.root, s.scope, s.index, s.line]),
      [
        ['modArr', 'module', 'modIdx', 7],
        ['items', 'param', '0', 8],
        ['grid[0]', 'local', 'modIdx', 15],
        ['grid', 'local', '0', 15],
      ],
    );

    // Note: items[0].toUpperCase() skips reading items; modArr[modIdx] as argument records both modArr and modIdx
    assert.deepEqual(
      runner.reads.map((r) => [r.name, r.scope, r.line]),
      [
        ['modArr', 'module', 7],
        ['modIdx', 'module', 7],
        ['modIdx', 'module', 15],
      ],
    );
  });

  it('tracks unbounded loops, throws, catches, await, and yield while ignoring bounded loops', () => {
    const dir = makeCaseDir('control');
    const file = writeSource(
      dir,
      'control.ts',
      [
        'async function asyncLoops(xs: number[]) {',
        '  for (let i = 0; i < xs.length; i++) {}',
        '  for (const x of xs) {}',
        '  for (const k in xs) {}',
        '  while (xs.length > 0) { break; }',
        '  do { break; } while (true);',
        '  for (;;) { break; }',
        '  for (let i = 0; ; i++) { break; }',
        '  try {',
        '    throw new Error("x");',
        '  } catch (e) {',
        '    await Promise.resolve(e);',
        '  }',
        '  try {',
        '    throw "y";',
        '  } catch {}',
        '}',
        'function* gen(items: number[]) {',
        '  yield 1;',
        '  yield* items;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    const asyncFn = findFn(data, 'asyncLoops');
    assert.deepEqual(
      asyncFn.loops.map((l) => [l.kind, l.line]),
      [
        ['while', 5],
        ['do', 6],
        ['for(;;)', 7],
        ['for(;;)', 8],
      ],
    );
    assert.deepEqual(
      asyncFn.throws.map((t) => t.line),
      [10, 15],
    );
    assert.deepEqual(
      asyncFn.catches.map((c) => c.line),
      [11, 16],
    );
    assert.deepEqual(
      asyncFn.suspends.map((s) => [s.kind, s.line]),
      [['await', 12]],
    );

    const genFn = findFn(data, 'gen');
    assert.deepEqual(
      genFn.suspends.map((s) => [s.kind, s.line]),
      [
        ['yield', 19],
        ['yield', 20],
      ],
    );
  });
});

describe('Type-only constructs, top-level <module>, and determinism', () => {
  it('ignores type-only constructs across module and function bodies', () => {
    const dir = makeCaseDir('types-only');
    writeSource(dir, 'types.ts', 'export type Shared = { id: number };\nexport interface IShared { tag: string }\n');
    const file = writeSource(
      dir,
      'only-types.ts',
      [
        "import type { Shared, IShared } from './types.ts';",
        'const modVal = { id: 1, tag: "a" };',
        'type LocalAlias = Shared & typeof modVal;',
        'interface LocalIface extends IShared { extra: LocalAlias; }',
        'export type { LocalAlias, LocalIface };',
        "export { Shared } from './types.ts';",
        'function typedOnly<T extends Shared>(x: T): LocalIface {',
        '  type Inner = typeof modVal;',
        '  interface InnerIface { ref: Inner; }',
        '  const v = (<unknown>1) as LocalIface;',
        '  const checked = { id: 1, tag: "a", extra: { id: 1 } } satisfies LocalIface;',
        '  return v ?? checked;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    assert.deepEqual(
      data.functions.map((f) => f.name),
      ['typedOnly'],
    );
    const fn = findFn(data, 'typedOnly');
    assert.deepEqual(fn.reads, []);
    assert.deepEqual(fn.writes, []);
    assert.deepEqual(fn.calls, []);
    assert.deepEqual(fn.subscripts, []);
  });

  it('omits <module> when top-level has only declarations and emits <module> first when top-level has executable facts', () => {
    const dir = makeCaseDir('module-bucket');
    writeSource(dir, 'dep.ts', 'export const impVal = 5;\nexport function impCall() {}\n');
    const declOnly = writeSource(
      dir,
      'decl-only.ts',
      [
        "import { impVal } from './dep.ts';",
        'const topLocal = 1;',
        'let topMut = 2;',
        'export function f() { return impVal + topLocal + topMut; }',
        '',
      ].join('\n'),
    );
    const withTopFacts = writeSource(
      dir,
      'with-top.mjs',
      [
        "import { impVal, impCall } from './dep.ts';",
        'let topState = { count: 0, list: [10] };',
        'const used = impVal;',
        'topState.count = used;',
        'const elem = topState.list[0];',
        'impCall();',
        'console.log(elem);',
        'while (false) {}',
        'try { throw new Error("top"); } catch {}',
        'await Promise.resolve(1);',
        'export function afterTop() {}',
        '',
      ].join('\n'),
    );

    const d1 = runJson(declOnly, { cwd: dir });
    assert.deepEqual(
      d1.functions.map((f) => f.name),
      ['f'],
    );

    const d2 = runJson(withTopFacts, { cwd: dir });
    assert.deepEqual(
      d2.functions.map((f) => f.name),
      ['<module>', 'afterTop'],
    );
    const mod = d2.functions[0];
    assert.equal(mod.line, 1);
    assert.equal(mod.col, 1);
    assert.deepEqual(mod.params, []);
    // Top-level reads/writes of top-level variables (topState, used, elem) are scoped 'local' to <module> and omitted;
    // imports, property writes, subscripts, loops, throws, catches, calls, and suspends are recorded
    assert.deepEqual(
      mod.reads.map((r) => [r.name, r.scope, r.from ?? null]),
      [['impVal', 'import', './dep.ts']],
    );
    assert.deepEqual(
      mod.writes.map((w) => [w.target, w.root, w.scope, w.path]),
      [['topState.count', 'topState', 'local', ['count']]],
    );
    assert.deepEqual(
      mod.subscripts.map((s) => [s.root, s.scope, s.index]),
      [['topState.list', 'local', '0']],
    );
    assert.deepEqual(
      mod.calls.map((c) => [c.expr, c.kind]),
      [
        ['impCall', 'import'],
        ['console.log', 'external'],
        ['Error', 'external'],
        ['Promise.resolve', 'external'],
      ],
    );
    assert.deepEqual(mod.loops.map((l) => l.kind), ['while']);
    assert.equal(mod.throws.length, 1);
    assert.equal(mod.catches.length, 1);
    assert.deepEqual(
      mod.suspends.map((s) => s.kind),
      ['await'],
    );
  });

  it('produces deterministic byte-for-byte identical JSON and human-readable output across repeated runs', () => {
    const dir = makeCaseDir('determinism');
    const file = writeSource(
      dir,
      'det.ts',
      [
        'let acc = 0;',
        'export function step(n: number) {',
        '  acc += n;',
        '  if (acc < 0) throw new Error("neg");',
        '  return acc;',
        '}',
        '',
      ].join('\n'),
    );

    const j1 = runCli([file, '--json'], dir);
    const j2 = runCli([file, '--json'], dir);
    assert.equal(j1.status, 0);
    assert.equal(j2.status, 0);
    assert.equal(j1.stdout, j2.stdout);

    const h1 = runCli([file], dir);
    const h2 = runCli([file], dir);
    assert.equal(h1.status, 0);
    assert.equal(h2.status, 0);
    assert.equal(h1.stdout, h2.stdout);
  });

  it('handles shorthand reads, param-default arrows, overload signatures, subscript calls, extends, destructuring holes/bindings, nested objects, and for-await', async () => {
    const dir = makeCaseDir('edge-regressions');
    const file = writeSource(
      dir,
      'edges.ts',
      [
        'const modVal = 1;',
        'const { destrConst } = { destrConst: 2 };',
        'let { destrMut } = { destrMut: 3 };',
        'let modTarget = 0;',
        'const matrix = { row: ["a", "b"] };',
        'const handlers = [(n: number) => n + 1];',
        'class Base {}',
        'function overloaded(a: number): number;',
        'function overloaded(a: string): string;',
        'function overloaded(a: number | string) { return a; }',
        'class Derived extends Base {',
        '  helper = { m() { return modVal; } };',
        '}',
        'function makeDerived() {',
        '  class Inner extends Base {}',
        '  return Inner;',
        '}',
        'function pack(capParam: number, idx: number, cb = () => modVal) {',
        '  [, modTarget] = [1, 2];',
        '  const obj = { modVal, capParam, destrConst, destrMut };',
        '  const s = matrix.row[0].trim();',
        '  const r = handlers[idx](cb());',
        '  return { obj, s, r };',
        '}',
        'async function streamLoop(xs: AsyncIterable<number>) {',
        '  let sum = 0;',
        '  for await (const x of xs) { sum += x; }',
        '  return sum;',
        '}',
        '',
      ].join('\n'),
    );

    const data = runJson(file, { cwd: dir });
    assert.equal(data.functions.filter((f) => f.name === 'overloaded').length, 1);
    assert.ok(data.functions.some((f) => f.name === 'm'));
    assert.equal(data.functions.some((f) => f.name === 'Derived.m'), false);

    const makeDerived = findFn(data, 'makeDerived');
    assert.ok(makeDerived.reads.some((r) => r.name === 'Base' && r.scope === 'module' && r.decl === 'const'));

    const pack = findFn(data, 'pack');
    assert.ok(pack.reads.some((r) => r.name === 'modVal' && r.scope === 'module' && r.decl === 'const'));
    assert.ok(pack.reads.some((r) => r.name === 'destrConst' && r.scope === 'module' && r.decl === 'const'));
    assert.ok(pack.reads.some((r) => r.name === 'destrMut' && r.scope === 'module' && r.decl === 'mutable'));
    assert.equal(pack.writes.some((w) => w.target === ''), false);
    assert.deepEqual(
      pack.writes.map((w) => w.root),
      ['modTarget'],
    );
    assert.ok(pack.subscripts.some((s) => s.root === 'matrix.row' && s.scope === 'module'));
    assert.ok(pack.subscripts.some((s) => s.root === 'handlers' && s.scope === 'module' && s.index === 'idx'));

    const defArrow = data.functions.find((f) => f.name.startsWith('pack/<fn>@'));
    assert.ok(defArrow);
    assert.ok(defArrow.reads.some((r) => r.name === 'modVal' && r.scope === 'module'));

    const stream = findFn(data, 'streamLoop');
    assert.deepEqual(stream.suspends.map((s) => s.kind), ['await']);
  });
});
