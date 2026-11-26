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
  tempRoot = mkdtempSync(join(tmpdir(), 'lambda-ray-cpp-e2e-'));
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

describe('lambda-ray C++ CLI basics and formatting', () => {
  it('supports --help and -h flags', () => {
    for (const flag of ['--help', '-h']) {
      const res = runCli([flag]);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /usage: lambda-ray <file> \[--json\]/);
      assert.match(res.stdout, /cpp\s+\.cpp \.cc \.cxx \.hpp \.hh \.h \.hxx/);
    }
  });

  it('exits with code 2 on missing file argument, missing file, and unsupported extensions', () => {
    const noArgs = runCli([]);
    assert.equal(noArgs.status, 2);
    assert.match(noArgs.stderr, /usage: lambda-ray <file> \[--json\]/);

    const flagOnly = runCli(['--json']);
    assert.equal(flagOnly.status, 2);
    assert.match(flagOnly.stderr, /usage: lambda-ray <file> \[--json\]/);

    const missingPath = join(tempRoot, 'does_not_exist.cpp');
    const missing = runCli([missingPath]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /lambda-ray: file not found:/);

    const txtFile = createTempFile('cli/notes.txt', 'int main() { return 0; }\n');
    const unsupported = runCli([txtFile]);
    assert.equal(unsupported.status, 2);
    assert.match(unsupported.stderr, /lambda-ray: unsupported extension: \.txt/);

    const noExtFile = createTempFile('cli/README', 'int main() { return 0; }\n');
    const noExt = runCli([noExtFile]);
    assert.equal(noExt.status, 2);
    assert.match(noExt.stderr, /lambda-ray: unsupported extension: \(none\)/);
  });

  it('recognizes all supported C++ extensions including uppercase variants', () => {
    const exts = ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.h', '.hxx', '.CPP'];
    for (const ext of exts) {
      const file = createTempFile(`exts/sample${ext}`, 'int ping(int v) { return v; }\n');
      const data = runJson(file);
      assert.equal(data.language, 'cpp', `failed for extension ${ext}`);
      assert.equal(data.functions.length, 1);
      assert.equal(data.functions[0].name, 'ping');
    }
  });

  it('normalizes relative and absolute file paths with forward slashes', () => {
    const file = createTempFile('paths/nested/unit.cpp', 'void noop() {}\n');

    const absOut = runJson(file, REPO_ROOT);
    assert.equal(absOut.file, toPosix(resolve(file)));

    const relOut = runJson('paths/nested/unit.cpp', tempRoot);
    assert.equal(relOut.file, 'paths/nested/unit.cpp');

    const reordered = runCli(['--json', 'paths/nested/unit.cpp'], tempRoot);
    assert.equal(reordered.status, 0);
    assert.equal(JSON.parse(reordered.stdout).file, 'paths/nested/unit.cpp');
  });

  it('handles files with no function definitions in both json and text mode', () => {
    const declOnly = createTempFile('empty/decls.hpp', [
      '#pragma once',
      'struct Config { int port; };',
      'int declared_only(int x);',
      'extern int global_counter;',
      '',
    ].join('\n'));

    const data = runJson(declOnly);
    assert.equal(data.language, 'cpp');
    assert.deepEqual(data.functions, []);

    const text = runText(declOnly);
    assert.equal(text.trimEnd(), `${toPosix(resolve(declOnly))} (cpp)\n  (no functions)`);
  });

  it('formats text output accurately including params, writes, calls, truncation, suspends, and (none)', () => {
    const file = createTempFile('format/report.cpp', [
      'int g_val = 1;',
      'int helper(int x) { return x; }',
      'void untouched() {}',
      'struct Box {',
      '  void run(int a) {',
      '    if (a > 0) {}',
      '  }',
      '};',
      'struct Task {};',
      'Task compute(int p, Box b, int* arr) {',
      '  arr[0] = g_val;',
      '  b.run(p);',
      '  helper(p);',
      '  external_api_call_with_very_long_name_for_truncation_testing_1234567890(p);',
      '  while (p > 0) { --p; }',
      '  try { throw 1; } catch (int e) {}',
      '  int v = co_await arr[0];',
      '  co_yield v;',
      '}',
      '',
    ].join('\n'));

    const text = runText(file, REPO_ROOT);
    const lines = text.split(/\r?\n/);

    assert.equal(lines[0], `${toPosix(resolve(file))} (cpp)`);
    assert.ok(text.includes('  untouched (L3:1)\n    (none)'));
    assert.ok(text.includes('  compute (L10:1, params: p, b, arr)'));
    assert.ok(text.includes('reads:       g_val (module, mutable) @11:12'));
    assert.ok(text.includes('writes:      arr[0] (param [arr.(index)]) @11:3; p (param) @15:19'));
    assert.ok(text.includes('b.run (opaque, unresolved, recv: param) @12:3'));
    assert.ok(text.includes('helper (local) @13:3'));
    assert.ok(text.includes('external_api_call_with_very_long_name_for_truncation_test... (external, unresolved) @14:3'));
    assert.ok(text.includes('subscripts:  arr[0] (param) @17:20'));
    assert.ok(text.includes('throws:      @16:9'));
    assert.ok(text.includes('catches:     @16:20'));
    assert.ok(text.includes('loops:       while @15:3'));
    assert.ok(text.includes('suspends:    co_await @17:11; co_yield @18:3'));
  });
});

describe('lambda-ray C++ functions, namespaces, classes, and templates', () => {
  it('analyzes free functions (including unnamed/ref params), namespaces, and qualified calls', () => {
    const file = createTempFile('ns/namespaces.cpp', [
      'int top_global = 5;',
      'struct Tag {};',
      'int free_fn(int a, Tag, int& ref, int b = 2) {',
      '  return a + b + ref + top_global;',
      '}',
      'namespace outer {',
      '  const int limit = 100;',
      '  namespace inner {',
      '    int step(int v) {',
      '      return v + limit;',
      '    }',
      '  }',
      '  namespace {',
      '    int anon_fn(int x) { return x + free_fn(x, Tag{}, x); }',
      '  }',
      '}',
      'namespace a::b {',
      '  int combined(int n) {',
      '    return outer::inner::step(n) + outer::limit;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(
      data.functions.map((f) => f.name),
      ['free_fn', 'outer::inner::step', 'outer::anon_fn', 'a::b::combined']
    );

    const freeFn = findFn(data, 'free_fn');
    assert.deepEqual(freeFn.params, ['a', 'ref', 'b']);
    assert.deepEqual(freeFn.reads, [{ name: 'top_global', scope: 'module', decl: 'mutable', line: 4, col: 24 }]);

    const stepFn = findFn(data, 'outer::inner::step');
    assert.deepEqual(stepFn.reads, [{ name: 'limit', scope: 'module', decl: 'const', line: 10, col: 18 }]);

    const anonFn = findFn(data, 'outer::anon_fn');
    assert.deepEqual(anonFn.calls, [
      { expr: 'free_fn', kind: 'local', target: 'free_fn', resolved: true, line: 14, col: 37 },
    ]);

    const combinedFn = findFn(data, 'a::b::combined');
    assert.deepEqual(combinedFn.reads, [
      { name: 'outer::limit', scope: 'module', decl: 'const', line: 19, col: 36 },
    ]);
    assert.deepEqual(combinedFn.calls, [
      {
        expr: 'outer::inner::step',
        kind: 'local',
        target: 'outer::inner::step',
        resolved: true,
        line: 19,
        col: 12,
      },
    ]);
  });

  it('tracks struct/class member fields (implicit and this->), static fields, and out-of-line methods', () => {
    const file = createTempFile('classes/counter.cpp', [
      'class PlainAccount {',
      '  int balance = 0;',
      'public:',
      '  void deposit(int amount);',
      '  int get() const { return balance; }',
      '};',
      'void PlainAccount::deposit(int amount) {',
      '  balance += amount;',
      '  this->balance++;',
      '}',
      '',
      'namespace metrics {',
      'struct Counter {',
      '  int count = 0;',
      '  const int step = 2;',
      '  static int instances;',
      '',
      '  int peek() const {',
      '    return count + this->step;',
      '  }',
      '',
      '  void bump(int delta);',
      '  void reset();',
      '};',
      '',
      'int Counter::instances = 0;',
      '',
      'void Counter::bump(int delta) {',
      '  count += delta;',
      '  this->count += step;',
      '  instances += 1;',
      '  int cur = peek();',
      '  int cur2 = this->peek();',
      '}',
      '}',
      '',
      'void metrics::Counter::reset() {',
      '  this->count = 0;',
      '  count = 1;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(
      data.functions.map((f) => f.name),
      [
        'PlainAccount::get',
        'PlainAccount::deposit',
        'metrics::Counter::peek',
        'metrics::Counter::bump',
        'metrics::Counter::reset',
      ]
    );

    const deposit = findFn(data, 'PlainAccount::deposit');
    assert.deepEqual(deposit.writes, [
      { target: 'balance', root: 'balance', scope: 'member', path: [], line: 8, col: 3 },
      { target: 'this->balance', root: 'this', scope: 'member', path: ['balance'], line: 9, col: 3 },
    ]);
    assert.deepEqual(deposit.reads, [
      { name: 'balance', scope: 'member', decl: 'mutable', line: 8, col: 3 },
      { name: 'this->balance', scope: 'member', decl: 'mutable', line: 9, col: 3 },
    ]);

    const peek = findFn(data, 'metrics::Counter::peek');
    assert.deepEqual(peek.reads, [
      { name: 'count', scope: 'member', decl: 'mutable', line: 19, col: 12 },
      { name: 'this->step', scope: 'member', decl: 'const', line: 19, col: 20 },
    ]);

    const bump = findFn(data, 'metrics::Counter::bump');
    assert.deepEqual(bump.writes, [
      { target: 'count', root: 'count', scope: 'member', path: [], line: 29, col: 3 },
      { target: 'this->count', root: 'this', scope: 'member', path: ['count'], line: 30, col: 3 },
      { target: 'instances', root: 'instances', scope: 'module', path: [], line: 31, col: 3 },
    ]);
    assert.deepEqual(bump.reads, [
      { name: 'count', scope: 'member', decl: 'mutable', line: 29, col: 3 },
      { name: 'this->count', scope: 'member', decl: 'mutable', line: 30, col: 3 },
      { name: 'step', scope: 'member', decl: 'const', line: 30, col: 18 },
      { name: 'instances', scope: 'module', decl: 'mutable', line: 31, col: 3 },
    ]);
    assert.deepEqual(bump.calls, [
      { expr: 'peek', kind: 'local', target: 'metrics::Counter::peek', resolved: true, line: 32, col: 13 },
      {
        expr: 'this->peek',
        kind: 'local',
        target: 'metrics::Counter::peek',
        resolved: true,
        receiverScope: 'member',
        receiverRoot: 'this',
        line: 33,
        col: 14,
      },
    ]);

    const reset = findFn(data, 'metrics::Counter::reset');
    assert.deepEqual(reset.writes, [
      { target: 'this->count', root: 'this', scope: 'member', path: ['count'], line: 38, col: 3 },
      { target: 'count', root: 'count', scope: 'member', path: [], line: 39, col: 3 },
    ]);
  });

  it('disambiguates identically named sibling methods per owning class', () => {
    const file = createTempFile('classes/siblings.cpp', [
      'struct Alpha {',
      '  int ping() { return 1; }',
      '  int run() { return this->ping() + ping(); }',
      '};',
      'struct Beta {',
      '  int ping() { return 2; }',
      '  int run() { return ping() + this->ping(); }',
      '};',
      '',
    ].join('\n'));

    const data = runJson(file);
    const alphaRun = findFn(data, 'Alpha::run');
    assert.deepEqual(
      alphaRun.calls.map((c) => c.target),
      ['Alpha::ping', 'Alpha::ping']
    );

    const betaRun = findFn(data, 'Beta::run');
    assert.deepEqual(
      betaRun.calls.map((c) => c.target),
      ['Beta::ping', 'Beta::ping']
    );
  });

  it('handles function templates and class templates with inline methods', () => {
    const file = createTempFile('templates/box.hpp', [
      'template <typename T>',
      'T identity(T val) {',
      '  return val;',
      '}',
      '',
      'template <typename T, int N>',
      'struct Box {',
      '  T item;',
      '  T get() const {',
      '    return identity(item);',
      '  }',
      '  void set(T next) {',
      '    this->item = next;',
      '  }',
      '};',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(
      data.functions.map((f) => f.name),
      ['identity', 'Box::get', 'Box::set']
    );

    const idFn = findFn(data, 'identity');
    assert.deepEqual(idFn.params, ['val']);
    assert.deepEqual(idFn.reads, []);

    const getFn = findFn(data, 'Box::get');
    assert.deepEqual(getFn.reads, [{ name: 'item', scope: 'member', decl: 'mutable', line: 10, col: 21 }]);
    assert.deepEqual(getFn.calls, [
      { expr: 'identity', kind: 'local', target: 'identity', resolved: true, line: 10, col: 12 },
    ]);

    const setFn = findFn(data, 'Box::set');
    assert.deepEqual(setFn.params, ['next']);
    assert.deepEqual(setFn.writes, [
      { target: 'this->item', root: 'this', scope: 'member', path: ['item'], line: 13, col: 5 },
    ]);
  });
});

describe('lambda-ray C++ storage durations, globals, externals, and lambdas', () => {
  it('classifies const, constexpr, constinit, mutable, extern globals and static/thread_local locals', () => {
    const file = createTempFile('storage/vars.cpp', [
      'extern int ext_global;',
      'int g_mut = 1;',
      'const int g_const = 2;',
      'constexpr int g_cxpr = 3;',
      'constinit int g_cinit = 4;',
      '',
      'int accumulate(int p) {',
      '  int loc = 10;',
      '  const int cloc = 20;',
      '  static int s_count = 0;',
      '  thread_local int tl_acc = 1;',
      '  static thread_local int stl_flag = 0;',
      '  loc += cloc;',
      '  p = loc + g_mut + g_const + g_cxpr + g_cinit + ext_global;',
      '  s_count += 1;',
      '  tl_acc = tl_acc + s_count + stl_flag;',
      '  return p + tl_acc;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'accumulate');

    assert.deepEqual(fn.writes, [
      { target: 'p', root: 'p', scope: 'param', path: [], line: 14, col: 3 },
      { target: 's_count', root: 's_count', scope: 'module', path: [], line: 15, col: 3 },
      { target: 'tl_acc', root: 'tl_acc', scope: 'module', path: [], line: 16, col: 3 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'g_mut', scope: 'module', decl: 'mutable', line: 14, col: 13 },
      { name: 'g_const', scope: 'module', decl: 'const', line: 14, col: 21 },
      { name: 'g_cxpr', scope: 'module', decl: 'const', line: 14, col: 31 },
      { name: 'g_cinit', scope: 'module', decl: 'const', line: 14, col: 40 },
      { name: 'ext_global', scope: 'module', decl: 'mutable', line: 14, col: 50 },
      { name: 's_count', scope: 'module', decl: 'static', line: 15, col: 3 },
      { name: 'tl_acc', scope: 'module', decl: 'static', line: 16, col: 12 },
      { name: 's_count', scope: 'module', decl: 'static', line: 16, col: 21 },
      { name: 'stl_flag', scope: 'module', decl: 'static', line: 16, col: 31 },
      { name: 'tl_acc', scope: 'module', decl: 'static', line: 17, col: 14 },
    ]);
  });

  it('marks external/header symbols as global/unknown reads and external unresolved calls while analyzing header directly', () => {
    const hppFile = createTempFile('headers/ext.hpp', [
      '#pragma once',
      'constexpr int EXT_LIMIT = 42;',
      'inline int header_inline(int v) { return v + EXT_LIMIT; }',
      '',
    ].join('\n'));

    const cppFile = createTempFile('headers/consumer.cpp', [
      '#include "ext.hpp"',
      '#include <algorithm>',
      'int use_external(int a, int b) {',
      '  int m = std::max(a, b);',
      '  int h = header_inline(m);',
      '  return h + EXT_LIMIT;',
      '}',
      '',
    ].join('\n'));

    const cppData = runJson(cppFile);
    const fn = findFn(cppData, 'use_external');

    assert.deepEqual(fn.calls, [
      { expr: 'std::max', kind: 'external', target: 'std::max', resolved: false, line: 4, col: 11 },
      { expr: 'header_inline', kind: 'external', target: 'header_inline', resolved: false, line: 5, col: 11 },
    ]);
    assert.deepEqual(fn.reads, [
      { name: 'EXT_LIMIT', scope: 'global', decl: 'unknown', line: 6, col: 14 },
    ]);

    const hppData = runJson(hppFile);
    const headerFn = findFn(hppData, 'header_inline');
    assert.deepEqual(headerFn.reads, [
      { name: 'EXT_LIMIT', scope: 'module', decl: 'const', line: 3, col: 46 },
    ]);
  });

  it('tracks lambdas, closure captures, static/member visibility inside lambdas, and nested lambdas', () => {
    const file = createTempFile('lambdas/closures.cpp', [
      'struct Runner {',
      '  int factor = 3;',
      '  int run(int p) {',
      '    int loc = 10;',
      '    const int c_loc = 20;',
      '    static int s_loc = 1;',
      '    auto helper_lam = [](int v) { return v + 1; };',
      '    auto inner = [&](int k) {',
      '      s_loc += 1;',
      '      loc = loc + c_loc + p + factor + k;',
      '      loc++;',
      '      auto deep = [&]() { return k + loc + helper_lam(k); };',
      '      return deep();',
      '    };',
      '    int iife = [](int z) { return z + 1; }(5);',
      '    return inner(iife) + helper_lam(1);',
      '  }',
      '};',
      '',
    ].join('\n'));

    const data = runJson(file);
    assert.deepEqual(data.functions.map((f) => f.name), [
      'Runner::run',
      'Runner::run/<fn>@7:23',
      'Runner::run/<fn>@8:18',
      'Runner::run/<fn>@8:18/<fn>@12:19',
      'Runner::run/<fn>@15:16',
    ]);

    const outer = findFn(data, 'Runner::run');
    assert.deepEqual(outer.calls, [
      { expr: '[](int z) { return z + 1; }', kind: 'dynamic', target: null, resolved: false, line: 15, col: 16 },
      { expr: 'inner', kind: 'local', target: 'Runner::run/<fn>@8:18', resolved: true, line: 16, col: 12 },
      { expr: 'helper_lam', kind: 'local', target: 'Runner::run/<fn>@7:23', resolved: true, line: 16, col: 26 },
    ]);

    const inner = findFn(data, 'Runner::run/<fn>@8:18');
    assert.deepEqual(inner.params, ['k']);
    assert.deepEqual(inner.writes, [
      { target: 's_loc', root: 's_loc', scope: 'module', path: [], line: 9, col: 7 },
      { target: 'loc', root: 'loc', scope: 'closure', path: [], line: 10, col: 7 },
      { target: 'loc', root: 'loc', scope: 'closure', path: [], line: 11, col: 7 },
    ]);
    assert.deepEqual(inner.reads, [
      { name: 's_loc', scope: 'module', decl: 'static', line: 9, col: 7 },
      { name: 'loc', scope: 'closure', decl: 'mutable', line: 10, col: 13 },
      { name: 'c_loc', scope: 'closure', decl: 'const', line: 10, col: 19 },
      { name: 'p', scope: 'closure', decl: 'param', line: 10, col: 27 },
      { name: 'factor', scope: 'member', decl: 'mutable', line: 10, col: 31 },
      { name: 'loc', scope: 'closure', decl: 'mutable', line: 11, col: 7 },
    ]);
    assert.deepEqual(inner.calls, [
      { expr: 'deep', kind: 'local', target: 'Runner::run/<fn>@8:18/<fn>@12:19', resolved: true, line: 13, col: 14 },
    ]);

    const deep = findFn(data, 'Runner::run/<fn>@8:18/<fn>@12:19');
    assert.deepEqual(deep.params, []);
    assert.deepEqual(deep.reads, [
      { name: 'k', scope: 'closure', decl: 'param', line: 12, col: 34 },
      { name: 'loc', scope: 'closure', decl: 'mutable', line: 12, col: 38 },
      { name: 'k', scope: 'closure', decl: 'param', line: 12, col: 55 },
    ]);
    // Outer lambda variable captured in a nested lambda resolves as dynamic call
    assert.deepEqual(deep.calls, [
      { expr: 'helper_lam', kind: 'dynamic', target: null, resolved: false, line: 12, col: 44 },
    ]);

    const iife = findFn(data, 'Runner::run/<fn>@15:16');
    assert.deepEqual(iife.params, ['z']);
    assert.deepEqual(iife.reads, []);
  });
});

describe('lambda-ray C++ mutations, subscripts, and call resolution kinds', () => {
  it('tracks pointer dereference writes, compound assignments, and ++/-- across scopes', () => {
    const file = createTempFile('writes/mutations.cpp', [
      'int g_acc = 0;',
      'int g_idx = 1;',
      'int* g_ptr = &g_acc;',
      'struct Node { int v; };',
      'int* get_ptr() { return &g_acc; }',
      '',
      'void mutate(int param_n, int* param_ptr, int** pp, Node* node_ptr, int local_arr[4]) {',
      '  int loc = 0;',
      '  int* loc_ptr = &loc;',
      '  *loc_ptr = 5;',
      '  **pp = 6;',
      '  *g_ptr = 7;',
      '  *get_ptr() = 8;',
      '  (*node_ptr).v = 9;',
      '  node_ptr->v += 2;',
      '  local_arr[g_idx] = 10;',
      '  ++loc;',
      '  loc += 1;',
      '  param_n += 3;',
      '  param_n--;',
      '  g_acc *= 2;',
      '  ++g_acc;',
      '  g_acc--;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'mutate');

    assert.deepEqual(fn.writes, [
      { target: '*loc_ptr', root: 'loc_ptr', scope: 'local', path: ['*'], line: 10, col: 3 },
      { target: '**pp', root: 'pp', scope: 'param', path: ['*', '*'], line: 11, col: 3 },
      { target: '*g_ptr', root: 'g_ptr', scope: 'module', path: ['*'], line: 12, col: 3 },
      { target: '*get_ptr()', root: 'get_ptr()', scope: 'expr', path: ['*'], line: 13, col: 3 },
      { target: '(*node_ptr).v', root: 'node_ptr', scope: 'param', path: ['*', 'v'], line: 14, col: 3 },
      { target: 'node_ptr->v', root: 'node_ptr', scope: 'param', path: ['v'], line: 15, col: 3 },
      { target: 'local_arr[g_idx]', root: 'local_arr', scope: 'param', path: ['(index)'], line: 16, col: 3 },
      { target: 'param_n', root: 'param_n', scope: 'param', path: [], line: 19, col: 3 },
      { target: 'param_n', root: 'param_n', scope: 'param', path: [], line: 20, col: 3 },
      { target: 'g_acc', root: 'g_acc', scope: 'module', path: [], line: 21, col: 3 },
      { target: 'g_acc', root: 'g_acc', scope: 'module', path: [], line: 22, col: 3 },
      { target: 'g_acc', root: 'g_acc', scope: 'module', path: [], line: 23, col: 3 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'g_idx', scope: 'module', decl: 'mutable', line: 16, col: 13 },
      { name: 'g_acc', scope: 'module', decl: 'mutable', line: 21, col: 3 },
      { name: 'g_acc', scope: 'module', decl: 'mutable', line: 22, col: 3 },
      { name: 'g_acc', scope: 'module', decl: 'mutable', line: 23, col: 3 },
    ]);

    assert.deepEqual(fn.calls, [
      { expr: 'get_ptr', kind: 'local', target: 'get_ptr', resolved: true, line: 13, col: 4 },
    ]);
    assert.deepEqual(fn.subscripts, []);
  });

  it('tracks subscripts on locals, params, globals, members, 2D arrays, and call expressions', () => {
    const file = createTempFile('subscripts/indexing.cpp', [
      'int g_buf[4] = {1, 2, 3, 4};',
      'int* make_arr() { return g_buf; }',
      'struct Holder {',
      '  int items[4];',
      '  int read_at(int p_arr[4], int mat[2][2], int idx) {',
      '    int l_arr[2] = {10, 20};',
      '    return l_arr[0] + p_arr[idx] + g_buf[1] + this->items[idx] + items[0] + mat[0][1] + make_arr()[0];',
      '  }',
      '};',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'Holder::read_at');

    assert.deepEqual(fn.subscripts, [
      { root: 'l_arr', scope: 'local', index: '0', line: 7, col: 12 },
      { root: 'p_arr', scope: 'param', index: 'idx', line: 7, col: 23 },
      { root: 'g_buf', scope: 'module', index: '1', line: 7, col: 36 },
      { root: 'this->items', scope: 'member', index: 'idx', line: 7, col: 47 },
      { root: 'items', scope: 'member', index: '0', line: 7, col: 66 },
      { root: 'mat[0]', scope: 'param', index: '1', line: 7, col: 77 },
      { root: 'mat', scope: 'param', index: '0', line: 7, col: 77 },
      { root: 'make_arr()', scope: 'expr', index: '0', line: 7, col: 89 },
    ]);
    assert.deepEqual(fn.calls, [
      { expr: 'make_arr', kind: 'local', target: 'make_arr', resolved: true, line: 7, col: 89 },
    ]);
  });

  it('distinguishes direct, qualified, member, param, function-pointer, lambda-var, and dynamic calls', () => {
    const file = createTempFile('calls/dispatch.cpp', [
      'namespace api {',
      '  int helper(int x) { return x + 1; }',
      '}',
      'struct Worker {',
      '  int ping() { return 1; }',
      '  void work(int idx) {}',
      '};',
      'Worker g_worker;',
      'Worker make_worker() { return g_worker; }',
      'using FnPtr = int(*)(int);',
      'FnPtr g_fp = api::helper;',
      '',
      'int dispatch(int (*cb)(int), Worker p_worker, Worker workers[2], FnPtr table[2]) {',
      '  Worker l_worker;',
      '  FnPtr l_fp = &api::helper;',
      '  auto l_lam = [](int x) { return x * 2; };',
      '',
      '  int a = api::helper(1);',
      '  int b = cb(2);',
      '  int c = l_fp(3);',
      '  int d = (*l_fp)(4);',
      '  int e = g_fp(5);',
      '  int f = l_lam(6);',
      '  int g = table[0](7);',
      '',
      '  l_worker.ping();',
      '  p_worker.ping();',
      '  g_worker.ping();',
      '  make_worker().ping();',
      '  workers[0].work(1);',
      '',
      '  return a + b + c + d + e + f + g;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'dispatch');

    assert.deepEqual(fn.calls, [
      { expr: 'api::helper', kind: 'local', target: 'api::helper', resolved: true, line: 18, col: 11 },
      { expr: 'cb', kind: 'param', target: null, resolved: false, line: 19, col: 11 },
      { expr: 'l_fp', kind: 'dynamic', target: null, resolved: false, line: 20, col: 11 },
      { expr: '(*l_fp)', kind: 'dynamic', target: null, resolved: false, line: 21, col: 11 },
      { expr: 'g_fp', kind: 'dynamic', target: null, resolved: false, line: 22, col: 11 },
      { expr: 'l_lam', kind: 'local', target: 'dispatch/<fn>@16:16', resolved: true, line: 23, col: 11 },
      { expr: 'table[0]', kind: 'dynamic', target: null, resolved: false, line: 24, col: 11 },
      {
        expr: 'l_worker.ping',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'local',
        receiverRoot: 'l_worker',
        line: 26,
        col: 3,
      },
      {
        expr: 'p_worker.ping',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'param',
        receiverRoot: 'p_worker',
        line: 27,
        col: 3,
      },
      {
        expr: 'g_worker.ping',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'module',
        receiverRoot: 'g_worker',
        line: 28,
        col: 3,
      },
      {
        expr: 'make_worker().ping',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'expr',
        line: 29,
        col: 3,
      },
      {
        expr: 'make_worker',
        kind: 'local',
        target: 'make_worker',
        resolved: true,
        line: 29,
        col: 3,
      },
      {
        expr: 'workers[0].work',
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: 'param',
        receiverRoot: 'workers',
        line: 30,
        col: 3,
      },
    ]);

    assert.deepEqual(fn.subscripts, [
      { root: 'table', scope: 'param', index: '0', line: 24, col: 11 },
      { root: 'workers', scope: 'param', index: '0', line: 30, col: 3 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'api::helper', scope: 'global', decl: 'unknown', line: 15, col: 17 },
    ]);
  });
});

describe('lambda-ray C++ control flow, coroutines, type exclusions, and determinism', () => {
  it('distinguishes while, do, and for(;;) loops from bounded for and range-for loops', () => {
    const file = createTempFile('control/loops.cpp', [
      'int g_items[3] = {1, 2, 3};',
      'void loop_cases(int n) {',
      '  while (n > 0) { --n; }',
      '  do { ++n; } while (n < 2);',
      '  for (;;) { break; }',
      '  for (int i = 0; ; ++i) { if (i > 1) break; }',
      '  for (int j = 0; j < n; ++j) {}',
      '  for (const auto& item : g_items) {',
      '    int copy = item;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'loop_cases');

    assert.deepEqual(fn.loops, [
      { kind: 'while', line: 3, col: 3 },
      { kind: 'do', line: 4, col: 3 },
      { kind: 'for(;;)', line: 5, col: 3 },
      { kind: 'for(;;)', line: 6, col: 3 },
    ]);

    assert.deepEqual(fn.reads, [
      { name: 'g_items', scope: 'module', decl: 'mutable', line: 8, col: 27 },
    ]);
  });

  it('tracks throw, rethrow, and catch clauses without treating catch variables as global', () => {
    const file = createTempFile('control/exceptions.cpp', [
      'struct MyErr { int code; };',
      'void risky(int x) {',
      '  try {',
      '    if (x < 0) throw MyErr{x};',
      '  } catch (const MyErr& err) {',
      '    int c = err.code;',
      '    if (c < -1) throw;',
      '  } catch (...) {',
      '  }',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'risky');

    assert.deepEqual(fn.throws, [
      { line: 4, col: 16 },
      { line: 7, col: 17 },
    ]);
    assert.deepEqual(fn.catches, [
      { line: 5, col: 5 },
      { line: 8, col: 5 },
    ]);
    assert.deepEqual(fn.reads, []);
  });

  it('tracks co_await and co_yield suspends while excluding co_return', () => {
    const file = createTempFile('control/coro.cpp', [
      'struct Task {};',
      'Task async_gen(int seed) {',
      '  int v = co_await seed;',
      '  co_yield v + 1;',
      '  co_return v;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'async_gen');

    assert.deepEqual(fn.suspends, [
      { kind: 'co_await', line: 3, col: 11 },
      { kind: 'co_yield', line: 4, col: 3 },
    ]);
  });

  it('excludes type positions, using/alias declarations, C-style casts, template args, static_assert, sizeof/alignof, field names, and labels from reads', () => {
    const file = createTempFile('types/exclusions.cpp', [
      'namespace types {',
      '  struct Base {};',
      '  struct Target { int x; };',
      '  template <typename T, int N> struct Vec {};',
      '  enum Mode { FAST = 1 };',
      '}',
      'int g_val = 0;',
      'constexpr int BUF_SZ = 8;',
      'constexpr bool OK_FLAG = true;',
      'struct Derived : types::Base {};',
      'using ShortTarget = types::Target;',
      'using types::Base;',
      '',
      'int inspect_types(types::Target arg, int raw) {',
      '  using LocalAlias = types::Target;',
      '  using types::Vec;',
      '  static_assert(OK_FLAG, "ok");',
      '  types::Vec<types::Target, BUF_SZ> v;',
      '  auto a = (types::Target)arg;',
      '  auto s1 = sizeof(types::Target);',
      '  auto s2 = sizeof g_val;',
      '  auto s3 = alignof(types::Target);',
      '  int b = (int)raw;',
      '  if (b < 0) goto done;',
      'done:',
      '  return a.x + (int)(s1 + s2 + s3 + b);',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);
    const fn = findFn(data, 'inspect_types');

    assert.deepEqual(fn.reads, []);
    assert.deepEqual(fn.writes, []);
    assert.deepEqual(fn.calls, []);
  });

  it('produces byte-for-byte deterministic JSON and text output across repeated runs', () => {
    const file = createTempFile('determinism/full.cpp', [
      'namespace sim {',
      '  constexpr int SCALE = 2;',
      '  int g_ticks = 0;',
      '  struct Engine {',
      '    int rpm = 0;',
      '    void step(int delta) {',
      '      rpm += delta * SCALE;',
      '      g_ticks++;',
      '      auto logger = [&](int code) { return code + rpm + g_ticks; };',
      '      logger(1);',
      '    }',
      '  };',
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

  it('handles named casts, parenthesized sizeof, class method prototypes, template out-of-line methods, nested structs, operators, and static pointer locals', () => {
    const file = createTempFile('regressions/edges.cpp', [
      'int g_val = 42;',
      'struct ProtoBox {',
      '  void declared_only();',
      '  int use_proto(int x) {',
      '    declared_only();',
      '    auto a = static_cast<long>(x);',
      '    auto b = const_cast<const int*>(&x);',
      '    auto s = sizeof(g_val);',
      '    return static_cast<int>(a) + (b != nullptr ? 1 : 0) + static_cast<int>(s);',
      '  }',
      '};',
      'template <typename T>',
      'struct TBox {',
      '  T item;',
      '  void reset();',
      '};',
      'template <typename T>',
      'void TBox<T>::reset() {',
      '  item = T{};',
      '}',
      'struct Outer {',
      '  struct Inner {',
      '    int m = 1;',
      '    int get() { return m; }',
      '  };',
      '};',
      'struct Vec {',
      '  int v = 0;',
      '  Vec operator+(const Vec& rhs) { return Vec{v + rhs.v}; }',
      '};',
      'void static_ptr() {',
      '  static int* sp = nullptr;',
      '  (void)sp;',
      '}',
      '',
    ].join('\n'));

    const data = runJson(file);

    const useProto = findFn(data, 'ProtoBox::use_proto');
    assert.equal(useProto.reads.some((r) => r.name === 'static_cast' || r.name === 'const_cast' || r.name === 'g_val'), false);
    assert.deepEqual(
      useProto.calls.map((c) => [c.expr, c.kind]),
      [['declared_only', 'external']],
    );

    const tReset = findFn(data, 'TBox<T>::reset');
    assert.deepEqual(
      tReset.writes.map((w) => [w.root, w.scope]),
      [['item', 'member']],
    );

    const innerGet = findFn(data, 'Outer::Inner::get');
    assert.deepEqual(
      innerGet.reads.map((r) => [r.name, r.scope]),
      [['m', 'member']],
    );

    const opPlus = findFn(data, 'Vec::operator+');
    assert.deepEqual(opPlus.params, ['rhs']);

    const spFn = findFn(data, 'static_ptr');
    assert.deepEqual(
      spFn.reads.map((r) => [r.name, r.scope, r.decl, r.line]),
      [['sp', 'module', 'static', 33]],
    );
  });
});
