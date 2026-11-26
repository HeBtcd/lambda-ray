import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_PATH = resolve(REPO_ROOT, 'src/js/ray.js');

let tempRoot;

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'lambda-ray-rust-e2e-'));
});

after(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempFile(relPath, content) {
  const fullPath = join(tempRoot, relPath);
  mkdirSync(resolve(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function runCli(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function runJson(filePath, cwd = REPO_ROOT) {
  const res = runCli([filePath, '--json'], cwd);
  assert.equal(res.error, undefined, `spawn error: ${res.error?.message}`);
  assert.equal(res.status, 0, `CLI exited ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function runText(filePath, cwd = REPO_ROOT) {
  const res = runCli([filePath], cwd);
  assert.equal(res.error, undefined, `spawn error: ${res.error?.message}`);
  assert.equal(res.status, 0, `CLI exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

function findFn(data, name) {
  const fn = data.functions.find((f) => f.name === name);
  assert.ok(fn, `expected function "${name}" in [${data.functions.map((f) => f.name).join(', ')}]`);
  return fn;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

describe('lambda-ray Rust CLI basics and formatting', () => {
  it('supports --help and -h flags including rust .rs', () => {
    for (const flag of ['--help', '-h']) {
      const res = runCli([flag]);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /usage: lambda-ray <file> \[--json\]/);
      assert.match(res.stdout, /rust\s+\.rs/);
    }
  });

  it('exits with code 2 on missing arguments, missing files, unsupported extensions, and parse errors', () => {
    const noArgs = runCli([]);
    assert.equal(noArgs.status, 2);
    assert.match(noArgs.stderr, /usage: lambda-ray <file> \[--json\]/);

    const flagOnly = runCli(['--json']);
    assert.equal(flagOnly.status, 2);
    assert.match(flagOnly.stderr, /usage: lambda-ray <file> \[--json\]/);

    const missingPath = join(tempRoot, 'does_not_exist.rs');
    const missing = runCli([missingPath]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /lambda-ray: file not found:/);

    const txtFile = createTempFile('cli/notes.txt', 'fn main() {}\n');
    const unsupported = runCli([txtFile]);
    assert.equal(unsupported.status, 2);
    assert.match(unsupported.stderr, /lambda-ray: unsupported extension: \.txt/);

    const noExtFile = createTempFile('cli/README', 'fn main() {}\n');
    const noExt = runCli([noExtFile]);
    assert.equal(noExt.status, 2);
    assert.match(noExt.stderr, /lambda-ray: unsupported extension: \(none\)/);

    const brokenRs = createTempFile('cli/broken.rs', 'fn broken( {\n  let x = ;\n}\n');
    const parseErr = runCli([brokenRs]);
    assert.equal(parseErr.status, 2);
    assert.match(parseErr.stderr, /lambda-ray:/);
    assert.match(parseErr.stderr, /failed to parse/);
  });

  it('recognizes .rs and uppercase .RS extensions case-insensitively', () => {
    for (const ext of ['.rs', '.RS']) {
      const file = createTempFile(`exts/sample${ext}`, 'fn ping(v: i32) -> i32 { v }\n');
      const data = runJson(file);
      assert.equal(data.language, 'rust', `failed for extension ${ext}`);
      assert.equal(data.functions.length, 1);
      assert.equal(data.functions[0].name, 'ping');
      assert.deepEqual(data.functions[0].params, ['v']);
    }
  });

  it('normalizes relative (inside cwd) and outside-cwd file paths with forward slashes', () => {
    const file = createTempFile('paths/nested/unit.rs', 'fn noop() {}\n');
    const siblingSubdir = join(tempRoot, 'paths/sub');
    mkdirSync(siblingSubdir, { recursive: true });

    const outsideAbs = runJson(file, REPO_ROOT);
    assert.equal(outsideAbs.file, toPosix(resolve(file)));

    const outsideRel = runJson('../nested/unit.rs', siblingSubdir);
    assert.equal(outsideRel.file, toPosix(resolve(file)));

    const insideRel = runJson('paths/nested/unit.rs', tempRoot);
    assert.equal(insideRel.file, 'paths/nested/unit.rs');

    const reordered = runCli(['--json', 'paths/nested/unit.rs'], tempRoot);
    assert.equal(reordered.status, 0);
    assert.equal(JSON.parse(reordered.stdout).file, 'paths/nested/unit.rs');
  });

  it('handles files without functions in both json and text mode', () => {
    const declOnly = createTempFile('empty/decls.rs', [
      'use std::fmt;',
      'const LIMIT: usize = 10;',
      'static FLAG: bool = true;',
      'struct Config { port: u16 }',
      'trait Runnable { fn run(&self); }',
      'mod external_only;',
      '',
    ].join('\n'));

    const data = runJson(declOnly);
    assert.equal(data.language, 'rust');
    assert.deepEqual(data.functions, []);

    const text = runText(declOnly);
    assert.equal(text.trimEnd(), `${toPosix(resolve(declOnly))} (rust)\n  (no functions)`);
  });

  it('formats human-readable output accurately across categories including truncation and (none)', () => {
    const file = createTempFile('format/report.rs', [
      'use pkg::helper;',
      'static mut G_VAL: i32 = 1;',
      'fn untouched() {}',
      'fn local_fn(x: i32) -> i32 { x }',
      'async fn compute(mut p: i32, obj: BoxObj, arr: &mut [i32]) -> i32 {',
      '  arr[0] = G_VAL;',
      '  obj.run(p);',
      '  local_fn(p);',
      '  helper(p);',
      '  external_api_call_with_very_long_name_for_truncation_testing_1234567890(p);',
      '  while p > 0 { p -= 1; }',
      '  loop { break; }',
      '  let v = arr[0];',
      '  let _ = fetch_item().await?;',
      '  v',
      '}',
      '',
    ].join('\n'));

    const text = runText(file, REPO_ROOT);
    const lines = text.split(/\r?\n/);

    assert.equal(lines[0], `${toPosix(resolve(file))} (rust)`);
    assert.ok(text.includes('  untouched (L3:1)\n    (none)'));
    assert.ok(text.includes('  compute (L5:1, params: p, obj, arr)'));
    assert.ok(text.includes('    reads:       G_VAL (module, mutable) @6:12'));
    assert.ok(text.includes('    writes:      arr[0] (param [arr.(index)]) @6:3; p (param) @11:17'));
    assert.ok(
      text.includes(
        '    calls:       obj.run (opaque, unresolved, recv: param) @7:3; local_fn (local) @8:3; helper -> pkg#helper (import pkg) @9:3; external_api_call_with_very_long_name_for_truncation_test... (external, unresolved) @10:3; fetch_item (external, unresolved) @14:11'
      )
    );
    assert.ok(text.includes('    subscripts:  arr[0] (param) @13:11'));
    assert.ok(text.includes('    throws:      @14:29'));
    assert.ok(text.includes('    loops:       while @11:3; loop @12:3'));
    assert.ok(text.includes('    suspends:    await @14:24'));
  });
});

describe('lambda-ray Rust functions, modules, traits, impls, nested fns, closures, and shadowing', () => {
  it('analyzes free functions, inline nested mods, external mod skip, and qualified calls', () => {
    const file = createTempFile('mods/tree.rs', [
      'mod external_mod;',
      'static TOP_FLAG: i32 = 5;',
      'struct Tag;',
      'fn free_fn(a: i32, _: Tag, mut b: i32) -> i32 {',
      '  b += a;',
      '  a + b + TOP_FLAG',
      '}',
      'mod outer {',
      '  pub const LIMIT: i32 = 100;',
      '  pub mod inner {',
      '    const STEP_BASE: i32 = 1;',
      '    pub fn step(v: i32) -> i32 {',
      '      v + STEP_BASE + outer::LIMIT',
      '    }',
      '  }',
      '  pub fn call_free(x: i32) -> i32 {',
      '    free_fn(x, Tag {}, x) + LIMIT',
      '  }',
      '}',
      'fn combined(n: i32) -> i32 {',
      '  outer::inner::step(n) + outer::LIMIT',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(
      data.functions.map((f) => f.name),
      ['free_fn', 'outer::inner::step', 'outer::call_free', 'combined']
    );

    const freeFn = findFn(data, 'free_fn');
    assert.deepEqual(freeFn.params, ['a', '_', 'b']);
    assert.deepEqual(freeFn.writes, [
      { target: 'b', root: 'b', scope: 'param', path: [], line: 5, col: 3 },
    ]);
    assert.deepEqual(freeFn.reads, [
      { name: 'TOP_FLAG', scope: 'module', decl: 'static', line: 6, col: 11 },
    ]);

    const stepFn = findFn(data, 'outer::inner::step');
    assert.deepEqual(stepFn.reads, [
      { name: 'STEP_BASE', scope: 'module', decl: 'const', line: 13, col: 11 },
      { name: 'outer::LIMIT', scope: 'module', decl: 'const', line: 13, col: 23 },
    ]);

    const callFree = findFn(data, 'outer::call_free');
    assert.deepEqual(callFree.reads, [
      { name: 'LIMIT', scope: 'module', decl: 'const', line: 17, col: 29 },
    ]);
    assert.deepEqual(callFree.calls, [
      { expr: 'free_fn', kind: 'local', target: 'free_fn', resolved: true, line: 17, col: 5 },
    ]);

    const combined = findFn(data, 'combined');
    assert.deepEqual(combined.reads, [
      { name: 'outer::LIMIT', scope: 'module', decl: 'const', line: 21, col: 27 },
    ]);
    assert.deepEqual(combined.calls, [
      {
        expr: 'outer::inner::step',
        kind: 'local',
        target: 'outer::inner::step',
        resolved: true,
        line: 21,
        col: 3,
      },
    ]);
  });

  it('analyzes inherent impl methods, trait impl methods, trait default methods, and sibling disambiguation', () => {
    const file = createTempFile('traits/impls.rs', [
      'trait Greeter {',
      '  fn prefix(&self) -> i32 {',
      '    10',
      '  }',
      '  fn greet(&self) -> i32 {',
      '    self.prefix() + Self::prefix(self)',
      '  }',
      '  fn required(&self) -> i32;',
      '}',
      'struct Alpha<T> {',
      '  count: i32,',
      '  marker: T,',
      '}',
      'impl<T> Alpha<T> {',
      '  fn ping(&self) -> i32 {',
      '    self.count',
      '  }',
      '  fn bump(&mut self, d: i32) -> i32 {',
      '    self.count += d;',
      '    self.ping() + Self::ping(self) + self.required()',
      '  }',
      '}',
      'impl<T> Greeter for Alpha<T> {',
      '  fn required(&self) -> i32 {',
      '    self.count',
      '  }',
      '}',
      'struct Beta {',
      '  val: i32,',
      '}',
      'impl Beta {',
      '  fn ping(&self) -> i32 { self.val }',
      '  fn run(&self) -> i32 { self.ping() + Self::ping(self) }',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(
      data.functions.map((f) => f.name),
      [
        'Greeter::prefix',
        'Greeter::greet',
        'Alpha::ping',
        'Alpha::bump',
        '<Alpha as Greeter>::required',
        'Beta::ping',
        'Beta::run',
      ]
    );

    const greet = findFn(data, 'Greeter::greet');
    assert.deepEqual(greet.params, ['self']);
    assert.deepEqual(greet.calls, [
      {
        expr: 'self.prefix',
        kind: 'local',
        target: 'Greeter::prefix',
        resolved: true,
        receiverScope: 'member',
        receiverRoot: 'self',
        line: 6,
        col: 5,
      },
      {
        expr: 'Self::prefix',
        kind: 'local',
        target: 'Greeter::prefix',
        resolved: true,
        line: 6,
        col: 21,
      },
    ]);

    const alphaPing = findFn(data, 'Alpha::ping');
    assert.deepEqual(alphaPing.reads, [
      { name: 'self.count', scope: 'member', decl: 'readonly', line: 16, col: 5 },
    ]);

    const alphaBump = findFn(data, 'Alpha::bump');
    assert.deepEqual(alphaBump.params, ['self', 'd']);
    assert.deepEqual(alphaBump.writes, [
      { target: 'self.count', root: 'self', scope: 'member', path: ['count'], line: 19, col: 5 },
    ]);
    assert.deepEqual(alphaBump.reads, [
      { name: 'self.count', scope: 'member', decl: 'mutable', line: 19, col: 5 },
    ]);
    assert.deepEqual(alphaBump.calls, [
      {
        expr: 'self.ping',
        kind: 'local',
        target: 'Alpha::ping',
        resolved: true,
        receiverScope: 'member',
        receiverRoot: 'self',
        line: 20,
        col: 5,
      },
      {
        expr: 'Self::ping',
        kind: 'local',
        target: 'Alpha::ping',
        resolved: true,
        line: 20,
        col: 19,
      },
      {
        expr: 'self.required',
        kind: 'local',
        target: '<Alpha as Greeter>::required',
        resolved: true,
        receiverScope: 'member',
        receiverRoot: 'self',
        line: 20,
        col: 38,
      },
    ]);

    const betaRun = findFn(data, 'Beta::run');
    assert.deepEqual(
      betaRun.calls.map((c) => c.target),
      ['Beta::ping', 'Beta::ping']
    );
  });

  it('tracks nested fns, bound and inline closures, closure captures, and nested closure scopes', () => {
    const file = createTempFile('closures/nested.rs', [
      'static G_BASE: i32 = 5;',
      'fn with_nested_fn(p: i32) -> i32 {',
      '  let a = forward_inner(p);',
      '  fn forward_inner(x: i32) -> i32 {',
      '    x + G_BASE',
      '  }',
      '  fn second(y: i32) -> i32 {',
      '    y + forward_inner(y)',
      '  }',
      '  a + second(p)',
      '}',
      'struct Runner { factor: i32 }',
      'impl Runner {',
      '  fn run(&mut self, p: i32) -> i32 {',
      '    let loc = 10;',
      '    let mut mloc = 20;',
      '    static S_LOC: i32 = 1;',
      '    let helper_cl: fn(i32) -> i32 = |v: i32| v + 1;',
      '    let mut inner = |k: i32| {',
      '      let _ = S_LOC;',
      '      mloc = mloc + loc + p + self.factor + k;',
      '      let deep = || k + mloc + helper_cl(k);',
      '      deep()',
      '    };',
      '    let iife = (|z: i32| z + 1)(5);',
      '    inner(iife) + helper_cl(1)',
      '  }',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(
      data.functions.map((f) => f.name),
      [
        'with_nested_fn',
        'with_nested_fn/forward_inner',
        'with_nested_fn/second',
        'Runner::run',
        'Runner::run/helper_cl',
        'Runner::run/inner',
        'Runner::run/inner/deep',
        'Runner::run/<fn>@25:17',
      ]
    );

    const outerNested = findFn(data, 'with_nested_fn');
    assert.deepEqual(outerNested.calls, [
      {
        expr: 'forward_inner',
        kind: 'local',
        target: 'with_nested_fn/forward_inner',
        resolved: true,
        line: 3,
        col: 11,
      },
      {
        expr: 'second',
        kind: 'local',
        target: 'with_nested_fn/second',
        resolved: true,
        line: 10,
        col: 7,
      },
    ]);

    const fwdInner = findFn(data, 'with_nested_fn/forward_inner');
    assert.deepEqual(fwdInner.params, ['x']);
    assert.deepEqual(fwdInner.reads, [
      { name: 'G_BASE', scope: 'module', decl: 'static', line: 5, col: 9 },
    ]);

    const secondInner = findFn(data, 'with_nested_fn/second');
    assert.deepEqual(secondInner.calls, [
      {
        expr: 'forward_inner',
        kind: 'local',
        target: 'with_nested_fn/forward_inner',
        resolved: true,
        line: 8,
        col: 9,
      },
    ]);

    const runnerRun = findFn(data, 'Runner::run');
    assert.deepEqual(runnerRun.calls, [
      { expr: '|z: i32| z + 1', kind: 'dynamic', target: null, resolved: false, line: 25, col: 16 },
      { expr: 'inner', kind: 'local', target: 'Runner::run/inner', resolved: true, line: 26, col: 5 },
      {
        expr: 'helper_cl',
        kind: 'local',
        target: 'Runner::run/helper_cl',
        resolved: true,
        line: 26,
        col: 19,
      },
    ]);

    const innerCl = findFn(data, 'Runner::run/inner');
    assert.deepEqual(innerCl.params, ['k']);
    assert.deepEqual(innerCl.writes, [
      { target: 'mloc', root: 'mloc', scope: 'closure', path: [], line: 21, col: 7 },
    ]);
    assert.deepEqual(innerCl.reads, [
      { name: 'S_LOC', scope: 'module', decl: 'static', line: 20, col: 15 },
      { name: 'mloc', scope: 'closure', decl: 'mutable', line: 21, col: 14 },
      { name: 'loc', scope: 'closure', decl: 'const', line: 21, col: 21 },
      { name: 'p', scope: 'closure', decl: 'param', line: 21, col: 27 },
      { name: 'self.factor', scope: 'member', decl: 'mutable', line: 21, col: 31 },
    ]);
    assert.deepEqual(innerCl.calls, [
      { expr: 'deep', kind: 'local', target: 'Runner::run/inner/deep', resolved: true, line: 23, col: 7 },
    ]);

    const deepCl = findFn(data, 'Runner::run/inner/deep');
    assert.deepEqual(deepCl.params, []);
    assert.deepEqual(deepCl.reads, [
      { name: 'k', scope: 'closure', decl: 'param', line: 22, col: 21 },
      { name: 'mloc', scope: 'closure', decl: 'mutable', line: 22, col: 25 },
      { name: 'k', scope: 'closure', decl: 'param', line: 22, col: 42 },
    ]);
    assert.deepEqual(deepCl.calls, [
      { expr: 'helper_cl', kind: 'dynamic', target: null, resolved: false, line: 22, col: 32 },
    ]);

    const inlineIife = findFn(data, 'Runner::run/<fn>@25:17');
    assert.deepEqual(inlineIife.params, ['z']);
    assert.deepEqual(inlineIife.reads, []);
  });

  it('respects lexical block shadowing for let x = x + 1 and inner blocks', () => {
    const file = createTempFile('shadow/lexical.rs', [
      'static G_VAL: i32 = 10;',
      'const C_VAL: i32 = 20;',
      'fn shadowing() -> i32 {',
      '  let G_VAL = G_VAL + 1;',
      '  let a = G_VAL;',
      '  {',
      '    let C_VAL = C_VAL + 2;',
      '    let _b = C_VAL;',
      '  }',
      '  let cap = 5;',
      '  let cl = || {',
      '    let cap = cap + 1;',
      '    cap',
      '  };',
      '  a + C_VAL + cl()',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'shadowing');
    assert.deepEqual(fn.reads, [
      { name: 'G_VAL', scope: 'module', decl: 'static', line: 4, col: 15 },
      { name: 'C_VAL', scope: 'module', decl: 'const', line: 7, col: 17 },
      { name: 'C_VAL', scope: 'module', decl: 'const', line: 15, col: 7 },
    ]);

    const cl = findFn(data, 'shadowing/cl');
    assert.deepEqual(cl.reads, [
      { name: 'cap', scope: 'closure', decl: 'const', line: 12, col: 15 },
    ]);
  });

  it('scopes nested fn block items and lexical closure_vars shadowing accurately', () => {
    const file = createTempFile('shadow/nested_and_closure.rs', [
      'fn outer() -> i32 {',
      '  use pkg::blk_imp;',
      '  static BLK_STATIC: i32 = 3;',
      '  let local_only = 10;',
      '  fn helper(v: i32) -> i32 { v + 1 }',
      '  fn inner() -> i32 {',
      '    fn deep() -> i32 {',
      '      blk_imp() + helper(BLK_STATIC) + local_only',
      '    }',
      '    deep()',
      '  }',
      '  let cl = || 1;',
      '  {',
      '    let cl = get_fp();',
      '    let _a = cl();',
      '  }',
      '  let _b = cl();',
      '  let same_cl = || 2;',
      '  let same_cl = get_fp();',
      '  same_cl() + inner()',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const deep = findFn(data, 'outer/inner/deep');
    assert.deepEqual(deep.calls, [
      { expr: 'blk_imp', kind: 'import', target: 'pkg#blk_imp', from: 'pkg', resolved: true, line: 8, col: 7 },
      { expr: 'helper', kind: 'local', target: 'outer/helper', resolved: true, line: 8, col: 19 },
    ]);
    assert.deepEqual(deep.reads, [
      { name: 'BLK_STATIC', scope: 'module', decl: 'static', line: 8, col: 26 },
      { name: 'local_only', scope: 'global', decl: 'unknown', line: 8, col: 40 },
    ]);

    const outer = findFn(data, 'outer');
    assert.deepEqual(outer.calls, [
      { expr: 'get_fp', kind: 'external', target: 'get_fp', resolved: false, line: 14, col: 14 },
      { expr: 'cl', kind: 'dynamic', target: null, resolved: false, line: 15, col: 14 },
      { expr: 'cl', kind: 'local', target: 'outer/cl', resolved: true, line: 17, col: 12 },
      { expr: 'get_fp', kind: 'external', target: 'get_fp', resolved: false, line: 19, col: 17 },
      { expr: 'same_cl', kind: 'dynamic', target: null, resolved: false, line: 20, col: 3 },
      { expr: 'inner', kind: 'local', target: 'outer/inner', resolved: true, line: 20, col: 15 },
    ]);
  });
});

describe('lambda-ray Rust imports, module items, and local const/static', () => {
  it('resolves single, grouped, renamed, {self, item}, and local use imports across calls and reads', () => {
    const file = createTempFile('imports/uses.rs', [
      'use std::fs::read_to_string;',
      'use std::collections::{HashMap, BTreeSet};',
      'use pkg::orig_fn as alias_fn;',
      'use std::io::{self, Write as IoWrite};',
      'use pkg::sub::self as sub_mod;',
      'use pkg::{IMP_CONST, IMP_CLIENT};',
      '',
      'fn use_all() {',
      '  use local_pkg::local_imp;',
      '  let _ = read_to_string("a.txt");',
      '  let _m = HashMap::new();',
      '  let _s = BTreeSet::new();',
      '  alias_fn();',
      '  let _out = io::stdout();',
      '  sub_mod::ping();',
      '  local_imp();',
      '  IMP_CLIENT.send();',
      '  let _k = IMP_CONST + io::SEEK_SET + IoWrite;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'use_all');

    assert.deepEqual(fn.calls, [
      {
        expr: 'read_to_string',
        kind: 'import',
        target: 'std::fs#read_to_string',
        from: 'std::fs',
        resolved: true,
        line: 10,
        col: 11,
      },
      {
        expr: 'HashMap::new',
        kind: 'import',
        target: 'std::collections::HashMap#new',
        from: 'std::collections::HashMap',
        resolved: true,
        line: 11,
        col: 12,
      },
      {
        expr: 'BTreeSet::new',
        kind: 'import',
        target: 'std::collections::BTreeSet#new',
        from: 'std::collections::BTreeSet',
        resolved: true,
        line: 12,
        col: 12,
      },
      {
        expr: 'alias_fn',
        kind: 'import',
        target: 'pkg#orig_fn',
        from: 'pkg',
        resolved: true,
        line: 13,
        col: 3,
      },
      {
        expr: 'io::stdout',
        kind: 'import',
        target: 'std::io#stdout',
        from: 'std::io',
        resolved: true,
        line: 14,
        col: 14,
      },
      {
        expr: 'sub_mod::ping',
        kind: 'import',
        target: 'pkg::sub#ping',
        from: 'pkg::sub',
        resolved: true,
        line: 15,
        col: 3,
      },
      {
        expr: 'local_imp',
        kind: 'import',
        target: 'local_pkg#local_imp',
        from: 'local_pkg',
        resolved: true,
        line: 16,
        col: 3,
      },
      {
        expr: 'IMP_CLIENT.send',
        kind: 'import',
        target: 'pkg#IMP_CLIENT.send',
        from: 'pkg',
        resolved: true,
        receiverScope: 'import',
        receiverRoot: 'IMP_CLIENT',
        line: 17,
        col: 3,
      },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'IMP_CONST', scope: 'import', decl: 'import', from: 'pkg', line: 18, col: 12 },
      { name: 'io::SEEK_SET', scope: 'import', decl: 'import', from: 'std::io', line: 18, col: 24 },
      { name: 'IoWrite', scope: 'import', decl: 'import', from: 'std::io', line: 18, col: 39 },
    ]);
  });

  it('classifies module and local const, static, and static mut items', () => {
    const file = createTempFile('storage/items.rs', [
      'const M_CONST: i32 = 1;',
      'static M_STATIC: i32 = 2;',
      'static mut M_MUT: i32 = 3;',
      'mod nested {',
      '  pub const N_C: i32 = 4;',
      '  pub static N_S: i32 = 5;',
      '  pub static mut N_M: i32 = 6;',
      '}',
      'fn accumulate() -> i32 {',
      '  const L_CONST: i32 = M_CONST + 1;',
      '  static L_STATIC: i32 = 10;',
      '  static mut L_MUT: i32 = 20;',
      '  let cl = || L_CONST + L_STATIC;',
      '  L_MUT = L_CONST + L_STATIC + L_MUT + M_STATIC + M_MUT + nested::N_C + nested::N_S + nested::N_M;',
      '  nested::N_M = 9;',
      '  cl() + L_MUT',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'accumulate');

    assert.deepEqual(fn.writes, [
      { target: 'L_MUT', root: 'L_MUT', scope: 'module', path: [], line: 14, col: 3 },
      { target: 'nested::N_M', root: 'nested::N_M', scope: 'module', path: [], line: 15, col: 3 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'M_CONST', scope: 'module', decl: 'const', line: 10, col: 24 },
      { name: 'L_STATIC', scope: 'module', decl: 'static', line: 14, col: 21 },
      { name: 'L_MUT', scope: 'module', decl: 'mutable', line: 14, col: 32 },
      { name: 'M_STATIC', scope: 'module', decl: 'static', line: 14, col: 40 },
      { name: 'M_MUT', scope: 'module', decl: 'mutable', line: 14, col: 51 },
      { name: 'nested::N_C', scope: 'module', decl: 'const', line: 14, col: 59 },
      { name: 'nested::N_S', scope: 'module', decl: 'static', line: 14, col: 73 },
      { name: 'nested::N_M', scope: 'module', decl: 'mutable', line: 14, col: 87 },
      { name: 'L_MUT', scope: 'module', decl: 'mutable', line: 16, col: 10 },
    ]);

    const cl = findFn(data, 'accumulate/cl');
    assert.deepEqual(cl.reads, [
      { name: 'L_CONST', scope: 'closure', decl: 'const', line: 13, col: 15 },
      { name: 'L_STATIC', scope: 'module', decl: 'static', line: 13, col: 25 },
    ]);
  });
});

describe('lambda-ray Rust mutations, calls, and subscripts', () => {
  it('tracks &self vs &mut self reads, compound writes, deref/field/index/destructuring writes, and _ discard', () => {
    const file = createTempFile('writes/mutations.rs', [
      'static mut G_ACC: i32 = 0;',
      'static G_IDX: usize = 1;',
      'static G_DISCARD_RHS: i32 = 9;',
      'struct Node { v: i32 }',
      'struct Pair(i32);',
      'impl Pair {',
      '  fn read_tuple(&self) -> i32 { self.0 }',
      '}',
      'struct Bag {',
      '  count: i32,',
      '  arr: [i32; 2],',
      '}',
      'fn get_ptr() -> *mut i32 { core::ptr::null_mut() }',
      'impl Bag {',
      '  fn peek(&self) -> i32 { self.count }',
      '  fn mutate(&mut self, mut p: i32, ptr: *mut i32, pp: *mut *mut i32, node_ptr: *mut Node, arr: &mut [i32]) {',
      '    let mut loc = 0;',
      '    let mut loc_node = Node { v: 0 };',
      '    let mut loc_arr = [0, 1];',
      '    loc = 1;',
      '    loc += 1;',
      '    loc_node.v = 2;',
      '    loc_arr[0] = 3;',
      '    p += 1;',
      '    *ptr = 4;',
      '    **pp = 5;',
      '    (*node_ptr).v = 6;',
      '    *get_ptr() = 7;',
      '    self.count += 1;',
      '    self.arr[G_IDX] = 8;',
      '    G_ACC += 2;',
      '    (p, self.count, arr[0], _) = (1, 2, 3, 4);',
      '    [arr[1], _] = [5, 6];',
      '    _ = G_DISCARD_RHS;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);

    const readTuple = findFn(data, 'Pair::read_tuple');
    assert.deepEqual(readTuple.reads, [
      { name: 'self.0', scope: 'member', decl: 'readonly', line: 7, col: 33 },
    ]);

    const peek = findFn(data, 'Bag::peek');
    assert.deepEqual(peek.reads, [
      { name: 'self.count', scope: 'member', decl: 'readonly', line: 15, col: 27 },
    ]);

    const mutate = findFn(data, 'Bag::mutate');
    assert.deepEqual(mutate.writes, [
      { target: 'loc_node.v', root: 'loc_node', scope: 'local', path: ['v'], line: 22, col: 5 },
      { target: 'loc_arr[0]', root: 'loc_arr', scope: 'local', path: ['(index)'], line: 23, col: 5 },
      { target: 'p', root: 'p', scope: 'param', path: [], line: 24, col: 5 },
      { target: '*ptr', root: 'ptr', scope: 'param', path: ['*'], line: 25, col: 5 },
      { target: '**pp', root: 'pp', scope: 'param', path: ['*', '*'], line: 26, col: 5 },
      { target: '(*node_ptr).v', root: 'node_ptr', scope: 'param', path: ['*', 'v'], line: 27, col: 5 },
      { target: '*get_ptr()', root: 'get_ptr()', scope: 'expr', path: ['*'], line: 28, col: 5 },
      { target: 'self.count', root: 'self', scope: 'member', path: ['count'], line: 29, col: 5 },
      { target: 'self.arr[G_IDX]', root: 'self', scope: 'member', path: ['arr', '(index)'], line: 30, col: 5 },
      { target: 'G_ACC', root: 'G_ACC', scope: 'module', path: [], line: 31, col: 5 },
      { target: 'p', root: 'p', scope: 'param', path: [], line: 32, col: 6 },
      { target: 'self.count', root: 'self', scope: 'member', path: ['count'], line: 32, col: 9 },
      { target: 'arr[0]', root: 'arr', scope: 'param', path: ['(index)'], line: 32, col: 21 },
      { target: 'arr[1]', root: 'arr', scope: 'param', path: ['(index)'], line: 33, col: 6 },
    ]);

    assert.deepEqual(mutate.reads, [
      { name: 'self.count', scope: 'member', decl: 'mutable', line: 29, col: 5 },
      { name: 'G_IDX', scope: 'module', decl: 'static', line: 30, col: 14 },
      { name: 'G_ACC', scope: 'module', decl: 'mutable', line: 31, col: 5 },
      { name: 'G_DISCARD_RHS', scope: 'module', decl: 'static', line: 34, col: 9 },
    ]);

    assert.deepEqual(mutate.calls, [
      { expr: 'get_ptr', kind: 'local', target: 'get_ptr', resolved: true, line: 28, col: 6 },
    ]);
    assert.deepEqual(mutate.subscripts, []);
  });

  it('tracks local, import, param, dynamic, opaque (with receiverScope/Root), external, macro calls, and subscripts', () => {
    const file = createTempFile('calls/dispatch.rs', [
      'use pkg::imported_fn;',
      'mod api { pub fn helper(x: i32) -> i32 { x + 1 } }',
      'struct Worker { items: [i32; 4] }',
      'impl Worker {',
      '  fn ping(&self) -> i32 { 1 }',
      '}',
      'static G_WORKER: Worker = Worker { items: [1, 2, 3, 4] };',
      'static G_BUF: [i32; 4] = [1, 2, 3, 4];',
      'static G_LEN: usize = 2;',
      'fn make_worker() -> Worker { Worker { items: [0; 4] } }',
      'fn make_slice() -> [i32; 2] { [10, 20] }',
      'struct Holder { items: [i32; 2], helper: Worker }',
      'impl Holder {',
      '  fn dispatch(&self, cb: fn(i32) -> i32, p_worker: Worker, workers: [Worker; 2], mat: [[i32; 2]; 2], p_arr: [i32; 2], idx: usize, table: [fn(i32) -> i32; 1]) {',
      '    let l_worker = Worker { items: [0; 4] };',
      '    let l_fp: fn(i32) -> i32 = api::helper;',
      '    let l_arr = [10, 20];',
      '    let _a = api::helper(1);',
      '    let _b = imported_fn(2);',
      '    let _c = cb(3);',
      '    let _d = l_fp(4);',
      '    let _e = table[0](5);',
      '    let _f = ext_call(6);',
      '    let _g = std::cmp::min(1, 2);',
      '    l_worker.work();',
      '    p_worker.work();',
      '    G_WORKER.work();',
      '    self.helper.work();',
      '    make_worker().work();',
      '    workers[0].work();',
      '    self.ping();',
      '    Self::ping_missing();',
      '    println!("val={}", G_BUF[1]);',
      '    let _v = vec![G_BUF[0]; G_LEN];',
      '    assert_eq!(l_arr[0], p_arr[idx]);',
      '    let _sum = self.items[idx] + mat[0][1] + p_arr[l_arr[0] as usize] + make_slice()[0];',
      '    let cap_worker = Worker { items: [0; 4] };',
      '    let cl = || { cap_worker.work(); };',
      '    cl();',
      '    self.work();',
      '  }',
      '  fn work(&self) {}',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'Holder::dispatch');

    assert.deepEqual(fn.calls, [
      { expr: 'api::helper', kind: 'local', target: 'api::helper', resolved: true, line: 18, col: 14 },
      { expr: 'imported_fn', kind: 'import', target: 'pkg#imported_fn', from: 'pkg', resolved: true, line: 19, col: 14 },
      { expr: 'cb', kind: 'param', target: null, resolved: false, line: 20, col: 14 },
      { expr: 'l_fp', kind: 'dynamic', target: null, resolved: false, line: 21, col: 14 },
      { expr: 'table[0]', kind: 'dynamic', target: null, resolved: false, line: 22, col: 14 },
      { expr: 'ext_call', kind: 'external', target: 'ext_call', resolved: false, line: 23, col: 14 },
      { expr: 'std::cmp::min', kind: 'external', target: 'std::cmp::min', resolved: false, line: 24, col: 14 },
      {
        expr: 'l_worker.work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'local',
        receiverRoot: 'l_worker',
        line: 25,
        col: 5,
      },
      {
        expr: 'p_worker.work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'param',
        receiverRoot: 'p_worker',
        line: 26,
        col: 5,
      },
      {
        expr: 'G_WORKER.work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'module',
        receiverRoot: 'G_WORKER',
        line: 27,
        col: 5,
      },
      {
        expr: 'self.helper.work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'member',
        receiverRoot: 'self',
        line: 28,
        col: 5,
      },
      {
        expr: 'make_worker().work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'expr',
        line: 29,
        col: 5,
      },
      { expr: 'make_worker', kind: 'local', target: 'make_worker', resolved: true, line: 29, col: 5 },
      {
        expr: 'workers[0].work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'param',
        receiverRoot: 'workers',
        line: 30,
        col: 5,
      },
      {
        expr: 'self.ping',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'member',
        receiverRoot: 'self',
        line: 31,
        col: 5,
      },
      { expr: 'Self::ping_missing', kind: 'external', target: 'Self::ping_missing', resolved: false, line: 32, col: 5 },
      { expr: 'println!', kind: 'external', target: 'println!', resolved: false, line: 33, col: 5 },
      { expr: 'vec!', kind: 'external', target: 'vec!', resolved: false, line: 34, col: 14 },
      { expr: 'make_slice', kind: 'local', target: 'make_slice', resolved: true, line: 36, col: 73 },
      { expr: 'cl', kind: 'local', target: 'Holder::dispatch/cl', resolved: true, line: 39, col: 5 },
      {
        expr: 'self.work',
        kind: 'local',
        target: 'Holder::work',
        resolved: true,
        receiverScope: 'member',
        receiverRoot: 'self',
        line: 40,
        col: 5,
      },
    ]);

    assert.deepEqual(fn.throws, [{ line: 35, col: 5 }]);

    assert.deepEqual(fn.subscripts, [
      { root: 'table', scope: 'param', index: '0', line: 22, col: 14 },
      { root: 'workers', scope: 'param', index: '0', line: 30, col: 5 },
      { root: 'G_BUF', scope: 'module', index: '1', line: 33, col: 24 },
      { root: 'G_BUF', scope: 'module', index: '0', line: 34, col: 19 },
      { root: 'l_arr', scope: 'local', index: '0', line: 35, col: 16 },
      { root: 'p_arr', scope: 'param', index: 'idx', line: 35, col: 26 },
      { root: 'self.items', scope: 'member', index: 'idx', line: 36, col: 16 },
      { root: 'mat[0]', scope: 'param', index: '1', line: 36, col: 34 },
      { root: 'mat', scope: 'param', index: '0', line: 36, col: 34 },
      { root: 'p_arr', scope: 'param', index: 'l_arr[0] as usize', line: 36, col: 46 },
      { root: 'l_arr', scope: 'local', index: '0', line: 36, col: 52 },
      { root: 'make_slice()', scope: 'expr', index: '0', line: 36, col: 73 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'api::helper', scope: 'module', decl: 'function', line: 16, col: 32 },
      { name: 'G_BUF', scope: 'module', decl: 'static', line: 33, col: 24 },
      { name: 'G_BUF', scope: 'module', decl: 'static', line: 34, col: 19 },
      { name: 'G_LEN', scope: 'module', decl: 'static', line: 34, col: 29 },
      { name: 'self.items', scope: 'member', decl: 'readonly', line: 36, col: 16 },
    ]);

    const cl = findFn(data, 'Holder::dispatch/cl');
    assert.deepEqual(cl.calls, [
      {
        expr: 'cap_worker.work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'closure',
        receiverRoot: 'cap_worker',
        line: 38,
        col: 19,
      },
    ]);
  });
});

describe('lambda-ray Rust control flow, exclusions, and determinism', () => {
  it('tracks ? operator and panic/assert macros as throws, while/while let/loop as loops, excludes for, and tracks .await', () => {
    const file = createTempFile('control/flow.rs', [
      'static G_ITEMS: [i32; 3] = [1, 2, 3];',
      'async fn flow_cases(mut n: i32, mut iter: impl Iterator<Item = i32>) -> Result<i32, ()> {',
      '  let v = step_one(n)?;',
      '  while n > 0 { n -= 1; }',
      '  while let Some(item) = iter.next() {',
      '    let _keep = item;',
      '  }',
      '  loop { break; }',
      '  for elem in G_ITEMS {',
      '    let _copy = elem;',
      '  }',
      '  assert!(v > 0);',
      '  assert_eq!(v, 1);',
      '  assert_ne!(v, 0);',
      '  debug_assert!(v > 0);',
      '  debug_assert_eq!(v, 1);',
      '  debug_assert_ne!(v, 0);',
      '  if n < 0 { panic!("neg"); }',
      '  if n == 99 { todo!(); }',
      '  if n == 98 { unimplemented!(); }',
      '  if n == 97 { unreachable!(); }',
      '  let fut_val = async { fetch().await }.await;',
      '  Ok(fut_val)',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'flow_cases');

    assert.deepEqual(fn.throws, [
      { line: 3, col: 22 },
      { line: 12, col: 3 },
      { line: 13, col: 3 },
      { line: 14, col: 3 },
      { line: 15, col: 3 },
      { line: 16, col: 3 },
      { line: 17, col: 3 },
      { line: 18, col: 14 },
      { line: 19, col: 16 },
      { line: 20, col: 16 },
      { line: 21, col: 16 },
    ]);

    assert.deepEqual(fn.loops, [
      { kind: 'while', line: 4, col: 3 },
      { kind: 'while', line: 5, col: 3 },
      { kind: 'loop', line: 8, col: 3 },
    ]);

    assert.deepEqual(fn.suspends, [
      { kind: 'await', line: 22, col: 41 },
      { kind: 'await', line: 22, col: 33 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'G_ITEMS', scope: 'module', decl: 'static', line: 9, col: 15 },
    ]);

    // Panic/assert macros must not appear as calls
    assert.equal(
      fn.calls.some((c) => ['panic!', 'todo!', 'assert!', 'assert_eq!'].includes(c.expr)),
      false
    );
  });

  it('excludes type positions, struct literal names/fields, and pattern bindings while recording struct shorthand reads', () => {
    const file = createTempFile('types/exclusions.rs', [
      'use pkg::IMP_V;',
      'mod types {',
      '  pub struct Point { pub x: i32, pub y: i32 }',
      '  pub struct Vec<T> { pub inner: T }',
      '}',
      'const C_LIMIT: i32 = 8;',
      'static G_VAL: i32 = 10;',
      'static G_BASE: types::Point = types::Point { x: 0, y: 0 };',
      '',
      'fn inspect_types<T>(arg: types::Point, raw: i32, opt: Option<i32>) -> Option<types::Point> {',
      '  let typed: types::Vec<types::Point> = types::Vec { inner: arg };',
      '  let _casted = raw as i64;',
      '  let _parsed = raw.to_string().parse::<types::Point>();',
      '  let explicit = types::Point { x: raw, y: 2 };',
      '  let x = 1;',
      '  let cap_v = 3;',
      '  let _shorthand = types::Point { x, y: G_VAL };',
      '  let _shorthand_mod = types::Point { x, ..G_BASE };',
      '  let types::Point { x: px, y } = explicit;',
      '  let (pa, mut pb) = (px, y);',
      '  pb += pa;',
      '  if let Some(opt_v) = opt { let _k = opt_v; }',
      '  let _m = match opt {',
      '    Some(mv) => mv,',
      '    None => 0,',
      '  };',
      '  let _c = match raw {',
      '    C_LIMIT => 1,',
      '    other => other,',
      '  };',
      '  let Some(else_v) = opt else { return opt; };',
      '  let _cl = || types::Point { x: cap_v, y: IMP_V };',
      '  let _cl_sh = || { let _p = types::Point { x: cap_v, y: unknown_var }; };',
      '  let _sh_all = || types::Point { x: 0, y: 0 };',
      '  let _sh_reads = || {',
      '    let _p1 = types::Point { x, y: G_VAL };',
      '    let _p2 = types::Point { x: cap_v, y: 0 };',
      '  };',
      '  let _direct_sh = types::Point { x, y: 0 };',
      '  let _mod_sh = {',
      '    let G_VAL = G_VAL;',
      '    G_VAL + else_v + typed.inner.x + pb',
      '  };',
      '  opt',
      '}',
      'fn shorthand_reads_only() {',
      '  let local_v = 1;',
      '  let cap_v = 2;',
      '  let _s1 = types::Point { x: local_v, y: 0 };',
      '  let _s2 = types::Point { local_v, G_VAL };',
      '  let cl = || types::Point { cap_v, IMP_V, unknown_sh };',
      '  cl();',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'inspect_types');

    assert.deepEqual(fn.writes, []);
    assert.deepEqual(fn.reads, [
      { name: 'G_VAL', scope: 'module', decl: 'static', line: 17, col: 41 },
      { name: 'G_BASE', scope: 'module', decl: 'static', line: 18, col: 44 },
      { name: 'G_VAL', scope: 'module', decl: 'static', line: 41, col: 17 },
    ]);

    const shFn = findFn(data, 'shorthand_reads_only');
    assert.deepEqual(shFn.reads, [
      { name: 'G_VAL', scope: 'module', decl: 'static', line: 50, col: 37 },
    ]);

    const shCl = findFn(data, 'shorthand_reads_only/cl');
    assert.deepEqual(shCl.reads, [
      { name: 'cap_v', scope: 'closure', decl: 'const', line: 51, col: 30 },
      { name: 'IMP_V', scope: 'import', decl: 'import', from: 'pkg', line: 51, col: 37 },
      { name: 'unknown_sh', scope: 'global', decl: 'unknown', line: 51, col: 44 },
    ]);
  });

  it('produces byte-for-byte deterministic JSON and human-readable output across repeated runs', () => {
    const file = createTempFile('determinism/full.rs', [
      'use pkg::sync_step;',
      'mod sim {',
      '  pub const SCALE: i32 = 2;',
      '  pub static mut G_TICKS: i32 = 0;',
      '  pub struct Engine { pub rpm: i32, pub slots: [i32; 2] }',
      '  impl Engine {',
      '    pub async fn step(&mut self, delta: i32) -> Result<i32, ()> {',
      '      self.rpm += delta * SCALE;',
      '      G_TICKS += 1;',
      '      let logger = |code: i32| code + self.rpm + G_TICKS;',
      '      let base = self.slots[0];',
      '      while self.rpm < 10 { self.rpm += 1; }',
      '      sync_step(base).await?;',
      '      Ok(logger(1))',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));

    const jsonRuns = [runCli([file, '--json']), runCli([file, '--json']), runCli([file, '--json'])];
    const textRuns = [runCli([file]), runCli([file]), runCli([file])];

    for (const r of jsonRuns) assert.equal(r.status, 0);
    for (const r of textRuns) assert.equal(r.status, 0);

    assert.equal(jsonRuns[0].stdout, jsonRuns[1].stdout);
    assert.equal(jsonRuns[1].stdout, jsonRuns[2].stdout);
    assert.equal(textRuns[0].stdout, textRuns[1].stdout);
    assert.equal(textRuns[1].stdout, textRuns[2].stdout);
  });
});
