#!/usr/bin/env node
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observe as observeTs } from './observe.js';
import { evaluateGate, formatGateViolations, loadPolicy } from './gate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const LANGS = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.mjs': 'ts', '.cjs': 'ts', '.jsx': 'ts',
  '.cs': 'csharp',
  '.rs': 'rust',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.h': 'cpp', '.hxx': 'cpp',
};

function runSubprocess(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, env });
  if (r.error || r.status !== 0) {
    throw new Error(`${cmd} ${args[0]} failed: ${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  }
  return r.stdout;
}

function ensureCsharpDll() {
  const projDir = resolve(ROOT, 'src/csharp/LambdaRay.Observe');
  const csproj = resolve(projDir, 'LambdaRay.Observe.csproj');
  const programCs = resolve(projDir, 'Program.cs');
  const releaseDll = resolve(projDir, 'bin/Release/net10.0/LambdaRay.Observe.dll');
  const env = { ...process.env, NUGET_PACKAGES: resolve(ROOT, 'src/.cache/nuget') };

  const stale = !existsSync(releaseDll) ||
    statSync(releaseDll).mtimeMs < Math.max(statSync(csproj).mtimeMs, statSync(programCs).mtimeMs);

  if (stale) {
    runSubprocess('dotnet', ['build', csproj, '-c', 'Release', '--nologo', '-v', 'q'], env);
  }
  return { dll: releaseDll, env };
}

function newestRsMtime(dir) {
  let maxMtime = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      maxMtime = Math.max(maxMtime, newestRsMtime(full));
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      maxMtime = Math.max(maxMtime, statSync(full).mtimeMs);
    }
  }
  return maxMtime;
}

function ensureRustBin() {
  const rustDir = resolve(ROOT, 'src/rust');
  const cargoToml = resolve(rustDir, 'Cargo.toml');
  const srcDir = resolve(rustDir, 'src');
  const binName = process.platform === 'win32' ? 'lambda-ray-observe.exe' : 'lambda-ray-observe';
  const releaseBin = resolve(rustDir, 'target/release', binName);

  const srcMtime = Math.max(statSync(cargoToml).mtimeMs, newestRsMtime(srcDir));
  const stale = !existsSync(releaseBin) || statSync(releaseBin).mtimeMs < srcMtime;

  if (stale) {
    runSubprocess('cargo', ['build', '--release', '--manifest-path', cargoToml, '--quiet']);
  }
  return releaseBin;
}

function normalizeFilePath(targetFile, root) {
  const abs = resolve(targetFile);
  const rel = relative(resolve(root), abs);
  const chosen = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
  return chosen.split(sep).join('/');
}

export function ray(file, root = process.cwd()) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`file not found: ${file}`);
  const language = LANGS[extname(abs).toLowerCase()];
  if (!language) throw new Error(`unsupported extension: ${extname(abs) || '(none)'}`);

  let result;
  if (language === 'ts') {
    result = observeTs(abs, root);
  } else if (language === 'cpp') {
    const out = runSubprocess('python', [resolve(ROOT, 'src/cpp/observe.py'), abs]);
    result = JSON.parse(out);
  } else if (language === 'csharp') {
    const { dll, env } = ensureCsharpDll();
    const out = runSubprocess('dotnet', [dll, abs], env);
    result = JSON.parse(out);
  } else if (language === 'rust') {
    const bin = ensureRustBin();
    const out = runSubprocess(bin, [abs]);
    result = JSON.parse(out);
  }

  return {
    file: normalizeFilePath(abs, root),
    language: result.language,
    functions: result.functions,
    ...(result.declarations !== undefined ? { declarations: result.declarations } : {}),
    ...(result.comments !== undefined ? { comments: result.comments } : {}),
    ...(result.imports !== undefined ? { imports: result.imports } : {}),
    ...(result.hazards !== undefined ? { hazards: result.hazards } : {}),
    ...(result.syntaxKinds !== undefined ? { syntaxKinds: result.syntaxKinds } : {}),
  };
}

function fmtRead(r) {
  const from = r.from ? `, from ${r.from}` : '';
  return `${r.name} (${r.scope}, ${r.decl}${from}) @${r.line}:${r.col}`;
}

function fmtWrite(w) {
  const path = w.path?.length ? ` [${w.root}.${w.path.join('.')}]` : '';
  return `${w.target} (${w.scope}${path}) @${w.line}:${w.col}`;
}

function fmtCall(c) {
  const expr = c.expr.replace(/\s+/g, ' ');
  const shortExpr = expr.length > 60 ? `${expr.slice(0, 57)}...` : expr;
  const target = c.target && c.target !== c.expr ? ` -> ${c.target}` : '';
  const status = c.resolved ? c.kind : `${c.kind}, unresolved`;
  const from = c.from ? ` ${c.from}` : '';
  const recv = c.receiverScope ? `, recv: ${c.receiverScope}` : '';
  return `${shortExpr}${target} (${status}${from}${recv}) @${c.line}:${c.col}`;
}

function fmtSubscript(s) {
  return `${s.root}[${s.index}] (${s.scope}) @${s.line}:${s.col}`;
}

export function formatRay(data) {
  const lines = [`${data.file} (${data.language})`];
  if (!data.functions.length) {
    lines.push('  (no functions)');
    return lines.join('\n');
  }
  for (const fn of data.functions) {
    lines.push('');
    const params = fn.params.length ? `, params: ${fn.params.join(', ')}` : '';
    lines.push(`  ${fn.name} (L${fn.line}:${fn.col}${params})`);
    const rows = [
      ['reads', fn.reads.map(fmtRead)],
      ['writes', fn.writes.map(fmtWrite)],
      ['calls', fn.calls.map(fmtCall)],
      ['subscripts', fn.subscripts.map(fmtSubscript)],
      ['throws', fn.throws.map((t) => `@${t.line}:${t.col}`)],
      ['catches', fn.catches.map((c) => `@${c.line}:${c.col}`)],
      ['loops', fn.loops.map((l) => `${l.kind} @${l.line}:${l.col}`)],
      ['suspends', fn.suspends.map((s) => `${s.kind} @${s.line}:${s.col}`)],
    ].filter(([, items]) => items.length > 0);
    if (!rows.length) {
      lines.push('    (none)');
      continue;
    }
    for (const [label, items] of rows) {
      lines.push(`    ${`${label}:`.padEnd(12)} ${items.join('; ')}`);
    }
  }
  return lines.join('\n');
}

export function gate(files, policySpec, root = process.cwd()) {
  const { name, policy } = loadPolicy(policySpec, root);
  const fileList = Array.isArray(files) ? files : [files];
  if (fileList.length === 0) {
    throw new Error('gate requires at least one file');
  }
  const normalizedFiles = [];
  const violations = [];
  for (const f of fileList) {
    const data = ray(f, root);
    normalizedFiles.push(data.file);
    violations.push(...evaluateGate(data, policy));
  }
  return {
    passed: violations.length === 0,
    profile: name,
    files: normalizedFiles,
    violations,
  };
}

function parseCliArgs(args) {
  let help = false;
  let json = false;
  let hasGate = false;
  let gateSpec = null;
  let gateError = null;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--json') {
      json = true;
    } else if (a === '--gate') {
      hasGate = true;
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        gateError = 'missing value for --gate <profile|policy.json>';
      } else {
        gateSpec = next;
        i += 1;
      }
    } else if (a.startsWith('--gate=')) {
      hasGate = true;
      gateSpec = a.slice('--gate='.length);
      if (!gateSpec) gateError = 'missing value for --gate <profile|policy.json>';
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  return { help, json, hasGate, gateSpec, gateError, positional };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    if (parsed.hasGate) {
      console.log(`usage: lambda-ray --gate <profile|policy.json> [--json] <files...>
profiles:
  strict-sim            denylist + metrics + comments + forbidden imports
  strict-sim-allowlist  strict-sim + 4-language AST syntaxKinds & allowedExternalCalls allowlist`);
    } else {
      console.log(`usage: lambda-ray <file> [--json]
languages:
  ts/js   .ts .tsx .mts .cts .js .mjs .cjs .jsx
  cpp     .cpp .cc .cxx .hpp .hh .h .hxx
  csharp  .cs
  rust    .rs`);
    }
    process.exit(0);
  }
  if (parsed.hasGate) {
    if (parsed.gateError) {
      console.error(`lambda-ray: ${parsed.gateError}`);
      process.exit(2);
    }
    if (parsed.positional.length === 0) {
      console.error('usage: lambda-ray --gate <profile|policy.json> [--json] <files...>');
      process.exit(2);
    }
    try {
      const report = gate(parsed.positional, parsed.gateSpec, process.cwd());
      if (parsed.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatGateViolations(report.violations, report.files));
      }
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      console.error(`lambda-ray: ${err.message}`);
      process.exit(2);
    }
  }
  const [file] = parsed.positional;
  if (!file) {
    console.error('usage: lambda-ray <file> [--json]');
    process.exit(2);
  }
  try {
    const data = ray(file, process.cwd());
    console.log(parsed.json ? JSON.stringify(data, null, 2) : formatRay(data));
    process.exit(0);
  } catch (err) {
    console.error(`lambda-ray: ${err.message}`);
    process.exit(2);
  }
}
