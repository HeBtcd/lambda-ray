import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');
const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = resolve(HERE, '../../profiles');

export const KERNEL = 'src/sim/sim.ts';
export const DEPOT = 'src/depot/schema.ts';

export const LAWS = {
  'state-is-data': 'the state of a sim is plain data: numbers, strings, booleans, null, arrays and records of them',
  'commands-are-data': 'a command is plain data, a defunctionalized function: one record per kind of change, interpreted by step',
  'step-is-pure': 'step reads only its state and commands and returns a new state: no clock, no Math.random, no engine, no hidden module state, no writes to anything it did not create',
  'log-is-append-only': 'a log only grows; to go back, start a new log from a prefix',
  'data-enters-through-schema': 'data in a JSON file reaches the code only through load(source, schema, data)',
  'project-never-writes-back': 'what draws the state never steps the sim and never writes into the state; it sends commands',
  'is-pure': 'a pure function reads only its arguments and returns a new value: no clock, no randomness, no IO, no hidden state, no writes to anything it did not create',
};

const FIX = {
  'state-is-data': 'replace the field with data that names it: a function becomes a tagged record that step interprets, a Map becomes a record or a list of pairs, a class instance becomes a record',
  'commands-are-data': 'give the command a kind field and the values it needs, and interpret it in step',
  'step-is-pure': 'move the effect out: randomness becomes a seed in the state (src/sim/random.ts), time is the tick, engine reads become commands, and changes are built as new values',
  'log-is-append-only': 'slice the prefix into a new log instead of shortening this one',
  'data-enters-through-schema': "import { load } from 'src/depot/schema' and pass the imported data through load with a schema",
  'project-never-writes-back': 'read the state useSim returns and send changes through the read() commands',
  'is-pure': 'move the effect out of the function: read the clock, draw the random or touch IO in the caller, and pass what the function needs as arguments',
};

const posix = (path) => path.split(sep).join('/');

export function loadProfile(nameOrPath) {
  const path = nameOrPath.endsWith('.json') || nameOrPath.includes('/') || nameOrPath.includes('\\')
    ? resolve(nameOrPath)
    : join(PROFILE_DIR, `${nameOrPath}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sourcesUnder(dir, suffixes) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesUnder(path, suffixes);
    return new RegExp(`\\.(${suffixes.join('|')})$`).test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

const isTest = (path) => /\.test\.(ts|tsx)$/.test(path);

export function checkLaws({ root, files, profile } = {}) {
  const p = profile ?? loadProfile('ts-fold');
  const scan = p.scan ?? {};
  const shell = p.shell ?? {};
  const hidden = p.hidden ?? {};
  const data = p.data ?? {};
  const roots = p.roots ?? {};
  const suffixes = scan.suffixes ?? ['ts', 'tsx'];
  const scanRoots = scan.roots ?? ['src'];
  const relevance = scan.relevance ? new RegExp(scan.relevance) : null;
  const MUTATORS = new Set(scan.mutators ?? []);
  const OBJECT_MUTATORS = new Set(scan.objectMutators ?? []);
  const ENGINE_MODULES = new Set(hidden.engine ?? []);
  const IMPURE_GLOBALS = new Set([...(hidden.clock ?? []), ...(hidden.random ?? []), ...(hidden.io ?? []), ...(hidden.global ?? []), ...(hidden.thread ?? [])]);
  const OPAQUE = new Set(data.opaque ?? []);
  const SHELLS = new Set(shell.exempt ?? []);
  const STEP_CALLS = new Set(shell.stepCalls ?? []);
  const LOG_WRITE = /\blog\.(length\s*=[^=]|splice\(|pop\(|shift\(|unshift\(|reverse\(|sort\()|\blog\[[^\]]+\]\s*=[^=]/;
  const kernelModule = (roots.interfaces ?? []).find((i) => i.kind === 'sim')?.module ?? KERNEL;
  const depotModule = shell.loader?.module ?? DEPOT;
  const loaderFn = shell.loader?.function ?? 'load';
  const useSimName = shell.useSim ?? 'useSim';
  const foldMode = (roots.interfaces ?? []).length > 0;
  const pureCalls = new Set(roots.calls ?? []);
  const pureModules = new Set(roots.modules ?? []);

  const repoRoot = resolve(root ?? process.cwd());
  const candidates = files ?? scanRoots.flatMap((dir) => sourcesUnder(join(repoRoot, dir), suffixes));
  const all = candidates.filter((path) => relevance ? relevance.test(readFileSync(path, 'utf8')) : true);
  const program = ts.createProgram(all, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    allowArbitraryExtensions: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const rel = (sourceFile) => posix(relative(repoRoot, sourceFile.fileName));
  const ours = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.includes('node_modules') && scanRoots.some((dir) => rel(file).startsWith(dir)));
  const violations = [];

  const where = (node) => {
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return `${rel(file)}:${line + 1}:${character + 1}`;
  };
  const report = (law, node, message, via = []) => violations.push({ law, at: where(node), message, via, fix: FIX[law] });

  const resolved = (symbol) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const declarationFile = (symbol) => symbol?.declarations?.[0]?.getSourceFile();
  const fromModule = (symbol, name, modulePath) => {
    const target = resolved(symbol);
    const file = declarationFile(target);
    return target?.getName() === name && file && rel(file) === modulePath;
  };
  const importedFrom = (symbol) => {
    const declaration = symbol?.declarations?.[0];
    if (!declaration) return null;
    let node = declaration;
    while (node && !ts.isImportDeclaration(node)) node = node.parent;
    return node && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
  };

  function dataProblems(type, path, seen = new Set()) {
    if (seen.has(type)) return [];
    seen.add(type);
    const flags = type.flags;
    if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return [{ path, what: `${checker.typeToString(type)}, which says nothing about its shape` }];
    if (flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void)) return [{ path, what: checker.typeToString(type) }];
    if (flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.StringLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.EnumLike)) return [];
    if (type.isUnionOrIntersection()) return type.types.flatMap((part) => dataProblems(part, path, seen));
    if (flags & ts.TypeFlags.TypeParameter) return [];
    if (!(flags & ts.TypeFlags.Object)) return [{ path, what: checker.typeToString(type) }];
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return [{ path, what: `a function (${checker.typeToString(type)})` }];
    if (checker.isArrayType(type) || checker.isTupleType(type)) return checker.getTypeArguments(type).flatMap((item, index) => dataProblems(item, `${path}[${checker.isTupleType(type) ? index : ''}]`, seen));
    const name = type.getSymbol()?.getName();
    if (name && OPAQUE.has(name)) return [{ path, what: `a ${name}` }];
    if (type.getSymbol()?.flags & ts.SymbolFlags.Class) return [{ path, what: `an instance of the class ${name}` }];
    const indexed = [type.getStringIndexType(), type.getNumberIndexType()].filter(Boolean).flatMap((item) => dataProblems(item, `${path}[key]`, seen));
    const fields = type.getProperties().flatMap((property) => {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) return [];
      return dataProblems(checker.getTypeOfSymbolAtLocation(property, declaration), `${path}.${property.getName()}`, seen);
    });
    return [...indexed, ...fields];
  }

  const isFunctionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

  function bodyOf(symbol) {
    const target = resolved(symbol);
    const declaration = target?.valueDeclaration ?? target?.declarations?.[0];
    if (!declaration) return null;
    const file = declaration.getSourceFile();
    if (file.isDeclarationFile || file.fileName.includes('node_modules') || rel(file) === kernelModule) return null;
    if (isFunctionLike(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer && isFunctionLike(declaration.initializer)) return declaration.initializer;
    return null;
  }

  const rootOf = (node) => {
    let current = node;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) current = current.expression;
    return current;
  };
  const within = (node, ancestor) => {
    for (let current = node; current; current = current.parent) if (current === ancestor) return true;
    return false;
  };
  const ownedBy = (identifier, fn) => {
    if (ts.isArrayLiteralExpression(identifier) || ts.isObjectLiteralExpression(identifier) || ts.isCallExpression(identifier) || ts.isNewExpression(identifier)) return true;
    if (!ts.isIdentifier(identifier)) return false;
    const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration;
    return Boolean(declaration && ts.isVariableDeclaration(declaration) && within(declaration, fn));
  };
  const isMutableModuleBinding = (symbol) => {
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.getSourceFile().isDeclarationFile) return false;
    const list = declaration.parent;
    return ts.isVariableDeclarationList(list) && !(list.flags & ts.NodeFlags.Const) && ts.isSourceFile(list.parent.parent);
  };
  const nameOf = (fn) => {
    if (fn.name) return fn.name.getText();
    if (ts.isVariableDeclaration(fn.parent)) return fn.parent.name.getText();
    if (ts.isPropertyAssignment(fn.parent)) return fn.parent.name.getText();
    return 'a function';
  };

  function checkStep(step, label, law = 'step-is-pure') {
    const visited = new Set();
    const queue = [{ fn: step, via: [label] }];
    while (queue.length > 0) {
      const { fn, via } = queue.shift();
      if (visited.has(fn)) continue;
      visited.add(fn);
      const impure = (node, message) => report(law, node, message, via);
      const visit = (node) => {
        if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'Math' && node.name.text === 'random') impure(node, 'draws Math.random');
        if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent) || (ts.isIdentifier(node) && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
          const symbol = checker.getSymbolAtLocation(node);
          const target = resolved(symbol);
          const module = importedFrom(symbol);
          if (module && ENGINE_MODULES.has(module)) impure(node, `reaches the engine through '${module}' (${node.text})`);
          else if (IMPURE_GLOBALS.has(node.text) && declarationFile(target)?.isDeclarationFile) impure(node, `reads ${node.text}`);
          else if (isMutableModuleBinding(target) && !within(target.valueDeclaration, fn)) impure(node, `reads the module variable ${node.text}, state the log does not carry`);
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) written(node.left, node);
        if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) written(node.operand, node);
        if (ts.isDeleteExpression(node)) written(node.expression, node);
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if (ts.isPropertyAccessExpression(callee) && MUTATORS.has(callee.name.text) && !ownedBy(rootOf(callee.expression), fn)) impure(node, `calls ${callee.name.text} on ${rootOf(callee.expression).getText()}, which step did not create`);
          if (ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Object' && OBJECT_MUTATORS.has(callee.name.text) && node.arguments[0] && !ownedBy(rootOf(node.arguments[0]), fn)) impure(node, `writes into ${node.arguments[0].getText()} with Object.${callee.name.text}`);
          const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
          const body = bodyOf(symbol);
          if (body && !visited.has(body)) queue.push({ fn: body, via: [...via, `${nameOf(body)} (${where(body)})`] });
        }
        ts.forEachChild(node, visit);
      };
      const written = (target, node) => {
        const root = rootOf(target);
        if (root === target && ts.isIdentifier(target)) {
          const symbol = resolved(checker.getSymbolAtLocation(target));
          const declaration = symbol?.valueDeclaration;
          if (declaration && !within(declaration, fn)) impure(node, `assigns ${target.text}, which lives outside step`);
          return;
        }
        if (!ownedBy(root, fn)) impure(node, `writes into ${target.getText()}, which step did not create`);
      };
      if (fn.body) visit(fn.body);
    }
  }

  function typeOf(node, name, arity, modulePath) {
    const type = checker.getContextualType(node) ?? checker.getTypeAtLocation(node);
    const target = type?.aliasSymbol ?? type?.getSymbol();
    if (!target || !fromModule(target, name, modulePath)) return null;
    const args = type.aliasTypeArguments ?? checker.getTypeArguments(type);
    return args.length === arity ? args : null;
  }
  const simIfaces = (roots.interfaces ?? []).filter((i) => i.kind === 'sim');
  const simOf = (node) => {
    for (const sim of simIfaces) {
      const args = typeOf(node, sim.type, 2, sim.module ?? kernelModule);
      if (args) return { args, iface: sim };
    }
    return null;
  };
  const layerOf = (node) => {
    const layer = (roots.interfaces ?? []).find((i) => i.kind === 'layer');
    return layer ? typeOf(node, layer.type, 3, layer.module ?? kernelModule) : null;
  };
  const functionOf = (node, name) => {
    const member = node.properties.find((property) => property.name?.getText() === name);
    if (!member) return null;
    if (ts.isMethodDeclaration(member)) return member;
    if (ts.isPropertyAssignment(member)) return isFunctionLike(member.initializer) ? member.initializer : bodyOf(checker.getSymbolAtLocation(member.initializer));
    return null;
  };

  const pureRoots = [];
  for (const file of ours) {
    const path = rel(file);
    if (isTest(path)) continue;
    file.text.split('\n').forEach((line, index) => {
      if (LOG_WRITE.test(line)) violations.push({ law: 'log-is-append-only', at: `${path}:${index + 1}:1`, message: `shortens, reorders or overwrites a log: ${line.trim()}`, via: [], fix: FIX['log-is-append-only'] });
    });
    if (path === kernelModule) continue;
    const simCallers = new Set();
    const visit = (node) => {
      if (foldMode) {
        if (ts.isObjectLiteralExpression(node) && layerOf(node)) {
          const [memory, input] = layerOf(node);
          const label = `the layer at ${where(node)}`;
          for (const problem of dataProblems(memory, checker.typeToString(memory))) report('state-is-data', node, `${problem.path} is ${problem.what}`, [label]);
          for (const problem of dataProblems(input, checker.typeToString(input))) report('commands-are-data', node, `${problem.path} is ${problem.what}`, [label]);
          const layerIface = (roots.interfaces ?? []).find((i) => i.kind === 'layer');
          for (const name of layerIface?.methods ?? ['step', 'out']) {
            const fn = functionOf(node, name);
            if (fn) checkStep(fn, `${name} of ${label}`);
          }
        }
        if (ts.isObjectLiteralExpression(node)) {
          const hit = simOf(node);
          if (hit) {
            const { args, iface: simIface } = hit;
            const [state, command] = args;
            const label = `the sim at ${where(node)}`;
            for (const problem of dataProblems(state, checker.typeToString(state))) report('state-is-data', node, `${problem.path} is ${problem.what}`, [label]);
            for (const problem of dataProblems(command, checker.typeToString(command))) report('commands-are-data', node, `${problem.path} is ${problem.what}`, [label]);
            const methodNames = simIface?.methods ?? ['step'];
            for (const name of methodNames) {
              const member = node.properties.find((property) => property.name?.getText() === name);
              const fn = member && (ts.isMethodDeclaration(member) ? member : ts.isPropertyAssignment(member) && isFunctionLike(member.initializer) ? member.initializer : null);
              if (fn) checkStep(fn, `${name} of ${label}`);
              else if (member && ts.isPropertyAssignment(member)) {
                const body = bodyOf(checker.getSymbolAtLocation(member.initializer));
                if (body) checkStep(body, `${name} of ${label}`);
              }
            }
          }
        }
      }
      if (pureCalls.size > 0 && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && pureCalls.has(node.expression.text)) {
        for (const arg of node.arguments) {
          if (isFunctionLike(arg)) pureRoots.push({ fn: arg, label: `the function passed to ${node.expression.text} at ${where(node)}` });
          else if (ts.isIdentifier(arg)) {
            const body = bodyOf(checker.getSymbolAtLocation(arg));
            if (body) pureRoots.push({ fn: body, label: `${arg.text} passed to ${node.expression.text}` });
          }
        }
      }
      if (foldMode && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith('.json') && node.importClause?.name && posix(relative(repoRoot, resolve(file.fileName, '..', node.moduleSpecifier.text))).startsWith('src/')) {
        const data = checker.getSymbolAtLocation(node.importClause.name);
        let loaded = false;
        const find = (inner) => {
          if (ts.isCallExpression(inner)) {
            const callee = resolved(checker.getSymbolAtLocation(inner.expression));
            const calleeFile = declarationFile(callee);
            if (callee?.getName() === loaderFn && calleeFile && rel(calleeFile) === depotModule && inner.arguments.some((arg) => ts.isIdentifier(arg) && checker.getSymbolAtLocation(arg) === data)) loaded = true;
          }
          ts.forEachChild(inner, find);
        };
        find(file);
        if (!loaded) report('data-enters-through-schema', node, `${node.moduleSpecifier.text} is imported but never passed through ${loaderFn}`);
      }
      if (foldMode && !SHELLS.has(path) && ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (STEP_CALLS.size > 0 && [...STEP_CALLS].some((name) => fromModule(symbol, name, kernelModule)) && ts.isCallExpression(node.parent) && node.parent.expression === node) report('project-never-writes-back', node, `calls ${node.text} outside the shell`);
      }
      if (foldMode && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === useSimName && ts.isVariableDeclaration(node.parent)) simCallers.add(checker.getSymbolAtLocation(node.parent.name));
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (simCallers.size > 0) {
      const writes = (node) => {
        const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
          : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? node.operand
          : ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && MUTATORS.has(node.expression.name.text) ? node.expression.expression
          : null;
        if (target && target !== rootOf(target) && ts.isIdentifier(rootOf(target)) && simCallers.has(checker.getSymbolAtLocation(rootOf(target)))) report('project-never-writes-back', node, `writes into the sim state through ${target.getText()}`);
        ts.forEachChild(node, writes);
      };
      writes(file);
    }
  }
  for (const { fn, label } of pureRoots) checkStep(fn, label, 'is-pure');

  const seen = new Set();
  return violations.filter((violation) => {
    const key = `${violation.law}|${violation.at}|${violation.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatted(violations) {
  return violations.map(({ law, at, message, via, fix }) => [`${at} ${law}: ${message}`, ...(via.length ? [`  via ${via.join(' -> ')}`] : []), `  law: ${LAWS[law]}`, `  fix: ${fix}`].join('\n')).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  let profileName = 'ts-fold';
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && i + 1 < args.length) { profileName = args[++i]; }
    else paths.push(args[i]);
  }
  const root = paths[0] ?? process.cwd();
  const violations = checkLaws({ root, profile: loadProfile(profileName) });
  if (violations.length === 0) {
    console.log(`laws (${profileName}): clean`);
  } else {
    console.log(formatted(violations));
    console.log(`\n${violations.length} violation(s)`);
    process.exitCode = 1;
  }
}
