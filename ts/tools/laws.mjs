import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ts = createRequire(import.meta.url)('typescript');

export const KERNEL = 'src/sim/sim.ts';
export const DEPOT = 'src/depot/schema.ts';
const SHELLS = new Set([KERNEL]);
const ENGINE_MODULES = new Set(['ue', 'puerts', 'react', 'react-dom']);
const IMPURE_GLOBALS = new Set(['Date', 'performance', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'queueMicrotask', 'crypto', 'process', 'globalThis', 'window', 'document', 'console', 'fetch', 'localStorage']);
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'delete', 'add', 'clear']);
const LOG_WRITE = /\blog\.(length\s*=[^=]|splice\(|pop\(|shift\(|unshift\(|reverse\(|sort\()|\blog\[[^\]]+\]\s*=[^=]/;
const OPAQUE_CLASSES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Promise', 'RegExp', 'Error', 'ArrayBuffer', 'DataView']);

export const LAWS = {
  'state-is-data': 'the state of a sim is plain data: numbers, strings, booleans, null, arrays and records of them',
  'commands-are-data': 'a command is plain data, a defunctionalized function: one record per kind of change, interpreted by step',
  'step-is-pure': 'step reads only its state and commands and returns a new state: no clock, no Math.random, no engine, no hidden module state, no writes to anything it did not create',
  'log-is-append-only': 'a log only grows; to go back, start a new log from a prefix',
  'data-enters-through-schema': 'data in a JSON file reaches the code only through load(source, schema, data)',
  'project-never-writes-back': 'what draws the state never steps the sim and never writes into the state; it sends commands',
};

const FIX = {
  'state-is-data': 'replace the field with data that names it: a function becomes a tagged record that step interprets, a Map becomes a record or a list of pairs, a class instance becomes a record',
  'commands-are-data': 'give the command a kind field and the values it needs, and interpret it in step',
  'step-is-pure': 'move the effect out: randomness becomes a seed in the state (src/sim/random.ts), time is the tick, engine reads become commands, and changes are built as new values',
  'log-is-append-only': 'slice the prefix into a new log instead of shortening this one',
  'data-enters-through-schema': "import { load } from 'src/depot/schema' and pass the imported data through load with a schema",
  'project-never-writes-back': 'read the state useSim returns and send changes through the read() commands',
};

const posix = (path) => path.split(sep).join('/');

function sourcesUnder(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesUnder(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

const isTest = (path) => /\.test\.(ts|tsx)$/.test(path);

export function checkLaws({ root, files } = {}) {
  const repoRoot = resolve(root ?? process.cwd());
  const all = (files ?? sourcesUnder(join(repoRoot, 'src'))).filter((path) => {
    const relevant = /\bSim\b|\bLayer\b|useSim|\.json['"]|\blog\b|stepOnce|replay/;
    return relevant.test(readFileSync(path, 'utf8'));
  });
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
  const ours = program.getSourceFiles().filter((file) => !file.isDeclarationFile && !file.fileName.includes('node_modules') && rel(file).startsWith('src/'));
  const violations = [];

  const where = (node) => {
    const file = node.getSourceFile();
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    return `${rel(file)}:${line + 1}:${character + 1}`;
  };
  const report = (law, node, message, via = []) => violations.push({ law, at: where(node), message, via, fix: FIX[law] });

  const resolved = (symbol) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const declarationFile = (symbol) => symbol?.declarations?.[0]?.getSourceFile();
  const fromKernel = (symbol, name) => {
    const target = resolved(symbol);
    const file = declarationFile(target);
    return target?.getName() === name && file && rel(file) === KERNEL;
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
    if (name && OPAQUE_CLASSES.has(name)) return [{ path, what: `a ${name}` }];
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
    if (file.isDeclarationFile || file.fileName.includes('node_modules') || rel(file) === KERNEL) return null;
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

  function checkStep(step, label) {
    const visited = new Set();
    const queue = [{ fn: step, via: [label] }];
    while (queue.length > 0) {
      const { fn, via } = queue.shift();
      if (visited.has(fn)) continue;
      visited.add(fn);
      const impure = (node, message) => report('step-is-pure', node, message, via);
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
          if (ts.isPropertyAccessExpression(callee) && callee.expression.getText() === 'Object' && ['assign', 'defineProperty', 'setPrototypeOf'].includes(callee.name.text) && node.arguments[0] && !ownedBy(rootOf(node.arguments[0]), fn)) impure(node, `writes into ${node.arguments[0].getText()} with Object.${callee.name.text}`);
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

  function kernelTypeOf(node, name, arity) {
    const type = checker.getContextualType(node) ?? checker.getTypeAtLocation(node);
    const target = type?.aliasSymbol ?? type?.getSymbol();
    if (!target || !fromKernel(target, name)) return null;
    const args = type.aliasTypeArguments ?? checker.getTypeArguments(type);
    return args.length === arity ? args : null;
  }
  const simOf = (node) => kernelTypeOf(node, 'Sim', 2);
  const layerOf = (node) => kernelTypeOf(node, 'Layer', 3);
  const functionOf = (node, name) => {
    const member = node.properties.find((property) => property.name?.getText() === name);
    if (!member) return null;
    if (ts.isMethodDeclaration(member)) return member;
    if (ts.isPropertyAssignment(member)) return isFunctionLike(member.initializer) ? member.initializer : bodyOf(checker.getSymbolAtLocation(member.initializer));
    return null;
  };

  for (const file of ours) {
    const path = rel(file);
    if (isTest(path)) continue;
    file.text.split('\n').forEach((line, index) => {
      if (LOG_WRITE.test(line)) violations.push({ law: 'log-is-append-only', at: `${path}:${index + 1}:1`, message: `shortens, reorders or overwrites a log: ${line.trim()}`, via: [], fix: FIX['log-is-append-only'] });
    });
    if (path === KERNEL) continue;
    const simCallers = new Set();
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node) && layerOf(node)) {
        const [memory, input] = layerOf(node);
        const label = `the layer at ${where(node)}`;
        for (const problem of dataProblems(memory, checker.typeToString(memory))) report('state-is-data', node, `${problem.path} is ${problem.what}`, [label]);
        for (const problem of dataProblems(input, checker.typeToString(input))) report('commands-are-data', node, `${problem.path} is ${problem.what}`, [label]);
        for (const name of ['step', 'out']) {
          const fn = functionOf(node, name);
          if (fn) checkStep(fn, `${name} of ${label}`);
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const args = simOf(node);
        if (args) {
          const [state, command] = args;
          const label = `the sim at ${where(node)}`;
          for (const problem of dataProblems(state, checker.typeToString(state))) report('state-is-data', node, `${problem.path} is ${problem.what}`, [label]);
          for (const problem of dataProblems(command, checker.typeToString(command))) report('commands-are-data', node, `${problem.path} is ${problem.what}`, [label]);
          const step = node.properties.find((property) => property.name?.getText() === 'step');
          const fn = step && (ts.isMethodDeclaration(step) ? step : ts.isPropertyAssignment(step) && isFunctionLike(step.initializer) ? step.initializer : null);
          if (fn) checkStep(fn, `step of ${label}`);
          else if (step && ts.isPropertyAssignment(step)) {
            const body = bodyOf(checker.getSymbolAtLocation(step.initializer));
            if (body) checkStep(body, `step of ${label}`);
          }
        }
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.endsWith('.json') && node.importClause?.name && posix(relative(repoRoot, resolve(file.fileName, '..', node.moduleSpecifier.text))).startsWith('src/')) {
        const data = checker.getSymbolAtLocation(node.importClause.name);
        let loaded = false;
        const find = (inner) => {
          if (ts.isCallExpression(inner)) {
            const callee = resolved(checker.getSymbolAtLocation(inner.expression));
            const calleeFile = declarationFile(callee);
            if (callee?.getName() === 'load' && calleeFile && rel(calleeFile) === DEPOT && inner.arguments.some((arg) => ts.isIdentifier(arg) && checker.getSymbolAtLocation(arg) === data)) loaded = true;
          }
          ts.forEachChild(inner, find);
        };
        find(file);
        if (!loaded) report('data-enters-through-schema', node, `${node.moduleSpecifier.text} is imported but never passed through load`);
      }
      if (!SHELLS.has(path) && ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (['stepOnce', 'replay'].some((name) => fromKernel(symbol, name)) && ts.isCallExpression(node.parent) && node.parent.expression === node) report('project-never-writes-back', node, `calls ${node.text} outside the shell`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useSim' && ts.isVariableDeclaration(node.parent)) simCallers.add(checker.getSymbolAtLocation(node.parent.name));
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
  const root = process.argv[2] ?? process.cwd();
  const violations = checkLaws({ root });
  if (violations.length === 0) {
    console.log('laws: every sim keeps append, fold and project');
  } else {
    console.log(formatted(violations));
    console.log(`\n${violations.length} violation(s)`);
    process.exitCode = 1;
  }
}
