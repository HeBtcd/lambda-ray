import { createRequire } from 'node:module';
import { relative, sep } from 'node:path';

const ts = createRequire(import.meta.url)('typescript');
const K = ts.SyntaxKind;

const FN_LIKE = new Set([
  K.FunctionDeclaration,
  K.FunctionExpression,
  K.ArrowFunction,
  K.MethodDeclaration,
  K.GetAccessor,
  K.SetAccessor,
  K.Constructor,
]);

const ASSIGN_OPS = new Set([
  K.EqualsToken,
  K.PlusEqualsToken,
  K.MinusEqualsToken,
  K.AsteriskEqualsToken,
  K.AsteriskAsteriskEqualsToken,
  K.SlashEqualsToken,
  K.PercentEqualsToken,
  K.LessThanLessThanEqualsToken,
  K.GreaterThanGreaterThanEqualsToken,
  K.GreaterThanGreaterThanGreaterThanEqualsToken,
  K.AmpersandEqualsToken,
  K.CaretEqualsToken,
  K.BarEqualsToken,
  K.QuestionQuestionEqualsToken,
  K.AmpersandAmpersandEqualsToken,
  K.BarBarEqualsToken,
]);

const locOf = (sf, node) => {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, col: character + 1 };
};

function containingFn(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (FN_LIKE.has(n.kind)) return n;
  }
  return null;
}

function enclosingClassName(node) {
  return ts.isClassLike(node.parent) ? (node.parent.name?.text ?? '<class>') : null;
}

function fnLabel(node, parentFnName, sf) {
  let base;
  if (node.kind === K.Constructor) {
    base = `${enclosingClassName(node) ?? '<class>'}.constructor`;
  } else if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    const prefix = node.kind === K.GetAccessor ? 'get ' : node.kind === K.SetAccessor ? 'set ' : '';
    const cls = enclosingClassName(node);
    const prop = node.name.getText(sf);
    base = cls ? `${cls}.${prefix}${prop}` : `${prefix}${prop}`;
  } else if (node.name?.text) {
    base = node.name.text;
  } else if (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) {
    base = node.parent.name.getText(sf);
  } else if (ts.isPropertyAssignment(node.parent) && node.parent.initializer === node) {
    base = node.parent.name.getText(sf);
  } else {
    const { line, col } = locOf(sf, node);
    base = `<fn>@${line}:${col}`;
  }
  return parentFnName ? `${parentFnName}/${base}` : base;
}

function paramNames(node, sf) {
  return (node.parameters ?? []).map((p) => p.name.getText(sf));
}

function unwrapExpr(expr) {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function unwrapChain(expr) {
  const path = [];
  let cur = unwrapExpr(expr);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    path.unshift(ts.isPropertyAccessExpression(cur) ? cur.name.text : '(index)');
    cur = unwrapExpr(cur.expression);
  }
  return { root: cur, path };
}

function isTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) {
      if (
        ts.isExpressionWithTypeArguments(p) &&
        ts.isHeritageClause(p.parent) &&
        p.parent.token === K.ExtendsKeyword &&
        ts.isClassLike(p.parent.parent)
      ) {
        return false;
      }
      return true;
    }
    if (ts.isTypeParameterDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p)) return true;
    if (ts.isHeritageClause(p) && (p.token !== K.ExtendsKeyword || !ts.isClassLike(p.parent))) return true;
  }
  return false;
}

function isValueReadIdentifier(id) {
  if (isTypePosition(id)) return false;
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isPropertyDeclaration(p)) {
    if (p.name === id) return false;
  }
  if (ts.isFunctionLike(p) && p.name === id) return false;
  if ((ts.isClassLike(p) || ts.isEnumDeclaration(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p) || ts.isMetaProperty(p)) return false;
  if (ts.isJsxAttribute(p) && p.name === id) return false;
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === id) {
    return /^[A-Z]/.test(id.text);
  }
  if (ts.isJsxClosingElement(p) && p.tagName === id) return false;
  if (ts.isCallExpression(p) && p.expression === id) return false;
  if (ts.isNewExpression(p) && p.expression === id) return false;
  return true;
}

function importSourceOf(decl) {
  for (let n = decl; n; n = n.parent) {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      return n.moduleSpecifier.text;
    }
  }
  return null;
}

function declKindOf(decl) {
  if (!decl) return 'unknown';
  if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) return 'import';
  if (ts.isParameter(decl)) return 'param';
  if (ts.isBindingElement(decl)) {
    for (let n = decl.parent; n; n = n.parent) {
      if (ts.isParameter(n)) return 'param';
      if (ts.isVariableDeclaration(n)) {
        const flags = ts.getCombinedNodeFlags(n);
        return flags & ts.NodeFlags.Const ? 'const' : 'mutable';
      }
      if (FN_LIKE.has(n.kind)) break;
    }
    return 'unknown';
  }
  if (FN_LIKE.has(decl.kind)) return 'function';
  if (ts.isVariableDeclaration(decl)) {
    if (decl.initializer && FN_LIKE.has(decl.initializer.kind)) return 'function';
    const flags = ts.getCombinedNodeFlags(decl);
    return flags & ts.NodeFlags.Const ? 'const' : 'mutable';
  }
  if (ts.isClassDeclaration(decl) || ts.isEnumDeclaration(decl)) return 'const';
  if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) {
    const ro = decl.modifiers?.some((m) => m.kind === K.ReadonlyKeyword);
    return ro ? 'readonly' : 'mutable';
  }
  return 'unknown';
}

function isPureDeclarationOnly(node) {
  return (
    ts.isImportDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    node.kind === K.EndOfFileToken
  );
}

export function observe(entryFile, root = process.cwd()) {
  const program = ts.createProgram({
    rootNames: [entryFile],
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: [],
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entryFile);
  if (!sf) throw new Error(`file not found: ${entryFile}`);

  const file = relative(root, entryFile).split(sep).join('/');
  const functions = [];
  const declarations = [];
  const imports = [];
  const hazards = [];
  const syntaxKinds = [];

  const scanSyntaxKinds = (node) => {
    const { line, col } = locOf(sf, node);
    if (FN_LIKE.has(node.kind) && node.asteriskToken) {
      syntaxKinds.push({ kind: 'GeneratorFunction', line, col });
    }
    if (ts.isVariableDeclarationList(node)) {
      const flags = ts.getCombinedNodeFlags(node);
      if (!(flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) {
        syntaxKinds.push({ kind: 'VarKeyword', line, col });
      }
    }
    const kname = ts.SyntaxKind[node.kind];
    if (kname) syntaxKinds.push({ kind: kname, line, col });
    ts.forEachChild(node, scanSyntaxKinds);
  };
  scanSyntaxKinds(sf);

  const commentMap = new Map();
  const addCommentRanges = (ranges) => {
    if (!ranges) return;
    for (const r of ranges) {
      if (commentMap.has(r.pos)) continue;
      const start = sf.getLineAndCharacterOfPosition(r.pos);
      const end = sf.getLineAndCharacterOfPosition(r.end);
      commentMap.set(r.pos, {
        kind: r.kind === K.SingleLineCommentTrivia ? 'line' : 'block',
        line: start.line + 1,
        endLine: end.line + 1,
        col: start.character + 1,
      });
    }
  };
  const scanComments = (node) => {
    addCommentRanges(ts.getLeadingCommentRanges(sf.text, node.pos));
    addCommentRanges(ts.getTrailingCommentRanges(sf.text, node.end));
    for (const child of node.getChildren(sf)) {
      scanComments(child);
    }
  };
  scanComments(sf);
  const commentSpans = [...commentMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  const comments = { count: commentSpans.length, spans: commentSpans };

  const spanLines = (node) => {
    const s = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const e = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    return e - s + 1;
  };

  const computeBodyMetrics = (bodyNode) => {
    let branches = 0;
    let maxNesting = 0;
    const walk = (n, depth) => {
      if (!n || FN_LIKE.has(n.kind)) return;
      let nextDepth = depth;
      const isElseIf =
        ts.isIfStatement(n) &&
        n.parent &&
        ts.isIfStatement(n.parent) &&
        n.parent.elseStatement === n;
      if (
        ts.isIfStatement(n) ||
        ts.isForStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n) ||
        ts.isSwitchStatement(n) ||
        ts.isTryStatement(n)
      ) {
        if (!isElseIf) {
          nextDepth = depth + 1;
          if (nextDepth > maxNesting) maxNesting = nextDepth;
        }
      }
      if (
        ts.isIfStatement(n) ||
        ts.isCaseClause(n) ||
        ts.isCatchClause(n) ||
        ts.isConditionalExpression(n) ||
        ts.isForStatement(n) ||
        ts.isForInStatement(n) ||
        ts.isForOfStatement(n) ||
        ts.isWhileStatement(n) ||
        ts.isDoStatement(n)
      ) {
        branches += 1;
      }
      ts.forEachChild(n, (c) => walk(c, nextDepth));
    };
    if (bodyNode) walk(bodyNode, 0);
    return { branches, maxNesting };
  };

  const modifierNames = (node) =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : node.modifiers)
      ?.map((m) => ts.tokenToString(m.kind))
      .filter(Boolean) ?? [];

  const heritageBases = (node) => {
    const out = [];
    for (const clause of node.heritageClauses ?? []) {
      for (const t of clause.types ?? []) {
        out.push(t.expression.getText(sf));
      }
    }
    return out;
  };

  const collectBindingNames = (nameNode, out = []) => {
    if (ts.isIdentifier(nameNode)) {
      out.push(nameNode.text);
    } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) {
        if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
      }
    }
    return out;
  };

  const BLACKBOARD_TYPE_RE = /^(Map|WeakMap|Blackboard|GameplayTag|GameplayTagContainer|FGameplayTagContainer|UAbilitySystemComponent|UAttributeSet|AttributeSet)$/i;
  const REFLECTION_PROPS = new Set([
    'defineProperty',
    'defineProperties',
    'setPrototypeOf',
    'getOwnPropertyDescriptor',
    'getOwnPropertyDescriptors',
  ]);

  const scanStructural = (node, inFn) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        source: node.moduleSpecifier.text,
        kind: 'import',
        ...(node.importClause?.isTypeOnly ? { typeOnly: true } : {}),
        ...locOf(sf, node),
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        source: node.moduleSpecifier.text,
        kind: 'export-from',
        ...(node.isTypeOnly ? { typeOnly: true } : {}),
        ...locOf(sf, node),
      });
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const clsName = node.name?.text ??
        (ts.isVariableDeclaration(node.parent) && node.parent.initializer === node ? node.parent.name.getText(sf) : '<class>');
      const mods = modifierNames(node).filter((m) => m === 'abstract' || m === 'declare');
      declarations.push({
        kind: 'class',
        name: clsName,
        bases: heritageBases(node),
        modifiers: mods,
        ...locOf(sf, node),
      });
      for (const m of node.members ?? []) {
        const mMods = modifierNames(m);
        if (ts.isPropertyDeclaration(m)) {
          const propName = `${clsName}.${m.name.getText(sf)}`;
          if (mMods.includes('static') && !mMods.includes('readonly')) {
            declarations.push({
              kind: 'field',
              name: propName,
              bases: [],
              modifiers: ['static', 'mutable'],
              ...locOf(sf, m),
            });
          } else if (mMods.includes('abstract') || mMods.includes('override')) {
            declarations.push({
              kind: 'property',
              name: propName,
              bases: [],
              modifiers: mMods.filter((x) => x === 'abstract' || x === 'override'),
              ...locOf(sf, m),
            });
          }
        } else if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
          const sigMods = mMods.filter((x) => x === 'abstract' || x === 'override');
          if (sigMods.length) {
            declarations.push({
              kind: 'method',
              name: `${clsName}.${m.name.getText(sf)}`,
              bases: [],
              modifiers: sigMods,
              ...locOf(sf, m),
            });
          }
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      declarations.push({
        kind: 'interface',
        name: node.name.text,
        bases: heritageBases(node),
        modifiers: [],
        ...locOf(sf, node),
      });
    } else if (ts.isEnumDeclaration(node)) {
      const mods = modifierNames(node).filter((m) => m === 'const');
      declarations.push({
        kind: 'enum',
        name: node.name.text,
        bases: [],
        modifiers: mods,
        ...locOf(sf, node),
      });
    } else if (!inFn && ts.isVariableStatement(node)) {
      const flags = ts.getCombinedNodeFlags(node.declarationList);
      const isConst = Boolean(flags & ts.NodeFlags.Const);
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && FN_LIKE.has(decl.initializer.kind)) continue;
        for (const vname of collectBindingNames(decl.name)) {
          declarations.push({
            kind: 'variable',
            name: vname,
            bases: [],
            modifiers: ['module', isConst ? 'const' : 'mutable'],
            ...locOf(sf, decl),
          });
        }
      }
    } else if (ts.isWithStatement(node)) {
      hazards.push({ kind: 'eval', detail: 'with', ...locOf(sf, node) });
    } else if (ts.isDeleteExpression(node)) {
      hazards.push({ kind: 'blackboard', detail: `delete ${node.expression.getText(sf)}`, ...locOf(sf, node) });
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expr = unwrapExpr(node.expression);
      if (ts.isCallExpression(node) && expr.kind === K.ImportKeyword) {
        const arg0 = node.arguments?.[0];
        imports.push({
          source: arg0 && ts.isStringLiteral(arg0) ? arg0.text : '<dynamic>',
          kind: 'dynamic-import',
          ...locOf(sf, node),
        });
      } else if (ts.isCallExpression(node) && ts.isIdentifier(expr) && expr.text === 'require') {
        const arg0 = node.arguments?.[0];
        if (arg0 && ts.isStringLiteral(arg0)) {
          imports.push({ source: arg0.text, kind: 'require', ...locOf(sf, node) });
        }
      }
      if (ts.isIdentifier(expr)) {
        if (expr.text === 'eval' || expr.text === 'Function') {
          hazards.push({ kind: 'eval', detail: expr.text, ...locOf(sf, node) });
        } else if (expr.text === 'Proxy') {
          hazards.push({ kind: 'reflection', detail: 'Proxy', ...locOf(sf, node) });
        } else if (BLACKBOARD_TYPE_RE.test(expr.text)) {
          hazards.push({ kind: 'blackboard', detail: expr.text, ...locOf(sf, node) });
        }
      } else if (ts.isPropertyAccessExpression(expr)) {
        const objText = unwrapExpr(expr.expression).getText(sf);
        const propText = expr.name.text;
        if (objText === 'Reflect') {
          hazards.push({ kind: 'reflection', detail: `Reflect.${propText}`, ...locOf(sf, node) });
        } else if (objText === 'Object' && REFLECTION_PROPS.has(propText)) {
          hazards.push({ kind: 'reflection', detail: `Object.${propText}`, ...locOf(sf, node) });
        } else if ((objText === 'globalThis' || objText === 'window') && propText === 'eval') {
          hazards.push({ kind: 'eval', detail: `${objText}.eval`, ...locOf(sf, node) });
        }
      }
    } else if (ts.isTypeReferenceNode(node)) {
      const tName = node.typeName.getText(sf);
      if (tName === 'Record' && node.typeArguments?.length === 2 && node.typeArguments[1].kind === K.AnyKeyword) {
        hazards.push({ kind: 'blackboard', detail: node.getText(sf), ...locOf(sf, node) });
      } else if (BLACKBOARD_TYPE_RE.test(tName)) {
        const isParamOrInterface = (() => {
          for (let p = node.parent; p; p = p.parent) {
            if (ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) return true;
          }
          return false;
        })();
        if (!isParamOrInterface || tName !== 'Map') {
          hazards.push({ kind: 'blackboard', detail: tName, ...locOf(sf, node) });
        }
      }
    }

    const nextInFn = inFn || FN_LIKE.has(node.kind);
    ts.forEachChild(node, (c) => scanStructural(c, nextInFn));
  };
  ts.forEachChild(sf, (c) => scanStructural(c, false));

  const emptyBucket = (name, line, col, params, metrics) => ({
    name,
    line,
    col,
    params,
    metrics,
    reads: [],
    writes: [],
    calls: [],
    subscripts: [],
    throws: [],
    catches: [],
    loops: [],
    suspends: [],
  });

  const moduleBucket = emptyBucket('<module>', 1, 1, [], { lines: 0, branches: 0, maxNesting: 0 });
  const fnNameMap = new Map();

  function symInfo(id, curFn) {
    const rawSym =
      id.parent && ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(id.parent) ?? checker.getSymbolAtLocation(id)
        : checker.getSymbolAtLocation(id);
    const rawDecl = rawSym?.valueDeclaration ?? rawSym?.getDeclarations()?.[0];
    if (rawDecl && (ts.isImportSpecifier(rawDecl) || ts.isImportClause(rawDecl) || ts.isNamespaceImport(rawDecl))) {
      const aliased = rawSym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(rawSym) : null;
      const resolvedDecl = aliased?.valueDeclaration ?? aliased?.getDeclarations()?.[0];
      return {
        scope: 'import',
        decl: resolvedDecl && FN_LIKE.has(resolvedDecl.kind) ? 'function' : 'import',
        from: importSourceOf(rawDecl),
        rawDecl,
        resolvedDecl,
      };
    }
    const decl = rawDecl;
    if (!decl) return { scope: 'global', decl: 'unknown', from: null, rawDecl: null, resolvedDecl: null };
    if (decl.getSourceFile() !== sf) {
      return { scope: 'global', decl: declKindOf(decl), from: null, rawDecl: decl, resolvedDecl: decl };
    }
    if (ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl) || ts.isTypeParameterDeclaration(decl)) {
      return { scope: 'type', decl: 'type', from: null, rawDecl: decl, resolvedDecl: decl };
    }
    const dk = declKindOf(decl);
    if (decl.kind === K.Parameter || dk === 'param') {
      const owner = containingFn(decl);
      return { scope: owner === curFn ? 'param' : 'closure', decl: 'param', from: null, rawDecl: decl, resolvedDecl: decl };
    }
    const owner = containingFn(decl);
    const scope = owner === curFn ? 'local' : !owner ? 'module' : 'closure';
    return { scope, decl: dk, from: null, rawDecl: decl, resolvedDecl: decl };
  }

  function exprScope(expr, curFn) {
    const u = unwrapExpr(expr);
    if (u.kind === K.ThisKeyword || u.kind === K.SuperKeyword) return { scope: 'member', root: u.kind === K.ThisKeyword ? 'this' : 'super' };
    if (ts.isIdentifier(u)) return { scope: symInfo(u, curFn).scope, root: u.text };
    return { scope: 'expr', root: null };
  }

  function recordWriteTarget(target, curFn, bucket, isCompound = false) {
    const u = unwrapExpr(target);
    if (u.kind === K.OmittedExpression) return;
    if (ts.isArrayLiteralExpression(u)) {
      for (const el of u.elements) {
        if (el.kind === K.OmittedExpression) continue;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === K.EqualsToken) {
          recordWriteTarget(el.left, curFn, bucket, isCompound);
        } else {
          recordWriteTarget(ts.isSpreadElement(el) ? el.expression : el, curFn, bucket, isCompound);
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(u)) {
      for (const prop of u.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) recordWriteTarget(prop.name, curFn, bucket, isCompound);
        else if (ts.isPropertyAssignment(prop)) {
          const rhs = prop.initializer;
          if (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === K.EqualsToken) {
            recordWriteTarget(rhs.left, curFn, bucket, isCompound);
          } else {
            recordWriteTarget(rhs, curFn, bucket, isCompound);
          }
        } else if (ts.isSpreadAssignment(prop)) recordWriteTarget(prop.expression, curFn, bucket, isCompound);
      }
      return;
    }
    const { root, path } = unwrapChain(u);
    const { line, col } = locOf(sf, target);
    if (root.kind === K.ThisKeyword) {
      bucket.writes.push({ target: target.getText(sf), root: 'this', scope: 'member', path, line, col });
      if (isCompound) {
        const memName = path.length ? `this.${path[0]}` : 'this';
        bucket.reads.push({ name: memName, scope: 'member', decl: 'mutable', line, col });
      }
      return;
    }
    if (ts.isIdentifier(root)) {
      const info = symInfo(root, curFn);
      if (info.scope !== 'local' || path.length > 0) {
        bucket.writes.push({ target: target.getText(sf), root: root.text, scope: info.scope, path, line, col });
      }
      if (isCompound && info.scope !== 'local' && info.scope !== 'param' && path.length === 0) {
        bucket.reads.push({ name: root.text, scope: info.scope, decl: info.decl, ...(info.from ? { from: info.from } : {}), line, col });
      }
      return;
    }
    bucket.writes.push({ target: target.getText(sf), root: root.getText(sf), scope: 'expr', path, line, col });
  }

  function visitWriteSubexprs(target, curFn, bucket) {
    let cur = unwrapExpr(target);
    if (cur.kind === K.OmittedExpression) return;
    if (ts.isArrayLiteralExpression(cur)) {
      for (const el of cur.elements) {
        if (el.kind === K.OmittedExpression) continue;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === K.EqualsToken) {
          visitWriteSubexprs(el.left, curFn, bucket);
          visitNode(el.right, curFn, bucket);
        } else {
          visitWriteSubexprs(ts.isSpreadElement(el) ? el.expression : el, curFn, bucket);
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(cur)) {
      for (const prop of cur.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          if (prop.objectAssignmentInitializer) visitNode(prop.objectAssignmentInitializer, curFn, bucket);
        } else if (ts.isPropertyAssignment(prop)) {
          if (ts.isComputedPropertyName(prop.name)) visitNode(prop.name.expression, curFn, bucket);
          const rhs = prop.initializer;
          if (ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === K.EqualsToken) {
            visitWriteSubexprs(rhs.left, curFn, bucket);
            visitNode(rhs.right, curFn, bucket);
          } else {
            visitWriteSubexprs(rhs, curFn, bucket);
          }
        } else if (ts.isSpreadAssignment(prop)) {
          visitWriteSubexprs(prop.expression, curFn, bucket);
        }
      }
      return;
    }
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      if (ts.isElementAccessExpression(cur) && cur.argumentExpression) {
        visitNode(cur.argumentExpression, curFn, bucket);
      }
      cur = unwrapExpr(cur.expression);
    }
    if (!ts.isIdentifier(cur) && cur.kind !== K.ThisKeyword) {
      visitNode(cur, curFn, bucket);
    }
  }

  function recordCall(node, curFn, bucket) {
    const expr = unwrapExpr(node.expression);
    const { line, col } = locOf(sf, node);

    if (ts.isIdentifier(expr)) {
      const info = symInfo(expr, curFn);
      if (info.scope === 'param') {
        bucket.calls.push({ expr: expr.text, kind: 'param', target: null, resolved: false, line, col });
        return;
      }
      if (info.scope === 'import') {
        const impName = info.rawDecl && ts.isImportSpecifier(info.rawDecl)
          ? (info.rawDecl.propertyName?.text ?? info.rawDecl.name.text)
          : expr.text;
        bucket.calls.push({
          expr: expr.text,
          kind: 'import',
          target: info.from ? `${info.from}#${impName}` : expr.text,
          from: info.from,
          resolved: true,
          line,
          col,
        });
        return;
      }
      const localName = info.resolvedDecl && fnNameMap.get(info.resolvedDecl);
      if (localName) {
        bucket.calls.push({ expr: expr.text, kind: 'local', target: localName, resolved: true, line, col });
        return;
      }
      if (ts.isNewExpression(node) && info.resolvedDecl && ts.isClassLike(info.resolvedDecl) && info.resolvedDecl.getSourceFile() === sf) {
        const ctor = info.resolvedDecl.members?.find((m) => m.kind === K.Constructor);
        const ctorName = (ctor && fnNameMap.get(ctor)) ?? expr.text;
        bucket.calls.push({ expr: expr.text, kind: 'local', target: ctorName, resolved: true, line, col });
        return;
      }
      if (info.resolvedDecl && info.resolvedDecl.getSourceFile() !== sf) {
        bucket.calls.push({ expr: expr.text, kind: 'external', target: expr.text, resolved: true, line, col });
        return;
      }
      if (info.scope === 'global') {
        bucket.calls.push({ expr: expr.text, kind: 'external', target: expr.text, resolved: false, line, col });
        return;
      }
      bucket.calls.push({ expr: expr.text, kind: 'dynamic', target: null, resolved: false, line, col });
      return;
    }

    if (ts.isPropertyAccessExpression(expr)) {
      const recvChain = unwrapChain(expr.expression);
      const recv = exprScope(recvChain.root, curFn);
      const propName = expr.name.text;
      const exprSym = checker.getSymbolAtLocation(expr.name);
      const decl = exprSym?.valueDeclaration ?? exprSym?.getDeclarations()?.[0];

      if (recv.scope === 'import') {
        const recvSym = ts.isIdentifier(recvChain.root) ? symInfo(recvChain.root, curFn) : null;
        const from = recvSym?.from ?? null;
        const prefix = recvChain.path.length ? `${recvChain.path.join('.')}.` : '';
        bucket.calls.push({
          expr: expr.getText(sf),
          kind: 'import',
          target: from ? `${from}#${prefix}${propName}` : expr.getText(sf),
          from,
          resolved: true,
          receiverScope: 'import',
          receiverRoot: recv.root,
          line,
          col,
        });
        return;
      }

      const localName = decl && fnNameMap.get(decl);
      if (localName) {
        bucket.calls.push({
          expr: expr.getText(sf),
          kind: 'local',
          target: localName,
          resolved: true,
          receiverScope: recv.scope,
          ...(recv.root ? { receiverRoot: recv.root } : {}),
          line,
          col,
        });
        return;
      }

      if (decl) {
        const ownerType = checker.typeToString(checker.getTypeAtLocation(expr.expression));
        const target = recv.scope === 'global' && ts.isIdentifier(expr.expression)
          ? `${expr.expression.text}.${propName}`
          : `${ownerType}.${propName}`;
        bucket.calls.push({
          expr: expr.getText(sf),
          kind: 'external',
          target,
          resolved: true,
          receiverScope: recv.scope,
          ...(recv.root ? { receiverRoot: recv.root } : {}),
          line,
          col,
        });
        return;
      }

      bucket.calls.push({
        expr: expr.getText(sf),
        kind: 'opaque',
        target: null,
        resolved: false,
        receiverScope: recv.scope,
        ...(recv.root ? { receiverRoot: recv.root } : {}),
        line,
        col,
      });
      return;
    }

    bucket.calls.push({ expr: expr.getText(sf), kind: 'dynamic', target: null, resolved: false, line, col });
  }

  function visitReceiverSubexprs(expr, curFn, bucket) {
    let cur = unwrapExpr(expr);
    while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      if (ts.isElementAccessExpression(cur)) {
        const { line, col } = locOf(sf, cur);
        const { root: rNode } = unwrapChain(cur.expression);
        const r = exprScope(rNode, curFn);
        bucket.subscripts.push({
          root: cur.expression.getText(sf),
          scope: r.scope,
          index: cur.argumentExpression.getText(sf),
          line,
          col,
        });
        visitNode(cur.argumentExpression, curFn, bucket);
      }
      cur = unwrapExpr(cur.expression);
    }
    if (!ts.isIdentifier(cur) && cur.kind !== K.ThisKeyword && cur.kind !== K.SuperKeyword) {
      visitNode(cur, curFn, bucket);
    }
  }

  function registerFn(node, parentFnName) {
    const name = fnLabel(node, parentFnName, sf);
    fnNameMap.set(node, name);
    if (
      (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) &&
      node.parent.initializer === node
    ) {
      fnNameMap.set(node.parent, name);
    }
    const { line, col } = locOf(sf, node);
    const bodyMetrics = computeBodyMetrics(node.body);
    const metrics = {
      lines: spanLines(node),
      branches: bodyMetrics.branches,
      maxNesting: bodyMetrics.maxNesting,
    };
    const bucket = emptyBucket(name, line, col, paramNames(node, sf), metrics);
    functions.push({ node, bucket });
    return name;
  }

  function collectFns(node, parentFnName) {
    if (FN_LIKE.has(node.kind)) {
      if (!node.body) return;
      const name = registerFn(node, parentFnName);
      for (const param of node.parameters ?? []) {
        if (param.initializer) collectFns(param.initializer, name);
      }
      if (ts.isBlock(node.body)) ts.forEachChild(node.body, (c) => collectFns(c, name));
      else collectFns(node.body, name);
      return;
    }
    ts.forEachChild(node, (c) => collectFns(c, parentFnName));
  }
  ts.forEachChild(sf, (c) => collectFns(c, ''));

  const bucketByNode = new Map(functions.map((f) => [f.node, f.bucket]));

  function visitNode(node, curFn, bucket) {
    if (isPureDeclarationOnly(node)) return;
    if (FN_LIKE.has(node.kind)) {
      const childBucket = bucketByNode.get(node);
      if (childBucket) {
        for (const param of node.parameters ?? []) {
          if (param.initializer) visitNode(param.initializer, node, childBucket);
        }
        if (node.body) {
          if (ts.isBlock(node.body)) ts.forEachChild(node.body, (c) => visitNode(c, node, childBucket));
          else visitNode(node.body, node, childBucket);
        }
      }
      return;
    }
    if (ts.isBinaryExpression(node) && ASSIGN_OPS.has(node.operatorToken.kind)) {
      const isCompound = node.operatorToken.kind !== K.EqualsToken;
      recordWriteTarget(node.left, curFn, bucket, isCompound);
      visitWriteSubexprs(node.left, curFn, bucket);
      visitNode(node.right, curFn, bucket);
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken)
    ) {
      recordWriteTarget(node.operand, curFn, bucket, true);
      visitWriteSubexprs(node.operand, curFn, bucket);
      return;
    }
    if (ts.isDeleteExpression(node)) {
      recordWriteTarget(node.expression, curFn, bucket, false);
      visitWriteSubexprs(node.expression, curFn, bucket);
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      recordCall(node, curFn, bucket);
      const callee = unwrapExpr(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        visitReceiverSubexprs(callee.expression, curFn, bucket);
      } else if (ts.isElementAccessExpression(callee)) {
        visitReceiverSubexprs(callee, curFn, bucket);
      } else if (!ts.isIdentifier(callee)) {
        visitNode(node.expression, curFn, bucket);
      }
      node.arguments?.forEach((a) => visitNode(a, curFn, bucket));
      return;
    }
    if (ts.isThrowStatement(node)) {
      bucket.throws.push(locOf(sf, node));
    } else if (ts.isCatchClause(node)) {
      bucket.catches.push(locOf(sf, node));
    } else if (ts.isWhileStatement(node)) {
      bucket.loops.push({ kind: 'while', ...locOf(sf, node) });
    } else if (ts.isDoStatement(node)) {
      bucket.loops.push({ kind: 'do', ...locOf(sf, node) });
    } else if (ts.isForStatement(node) && !node.condition) {
      bucket.loops.push({ kind: 'for(;;)', ...locOf(sf, node) });
    } else if (ts.isForOfStatement(node) && node.awaitModifier) {
      bucket.suspends.push({ kind: 'await', ...locOf(sf, node.awaitModifier) });
    } else if (ts.isAwaitExpression(node)) {
      bucket.suspends.push({ kind: 'await', ...locOf(sf, node) });
    } else if (ts.isYieldExpression(node)) {
      bucket.suspends.push({ kind: 'yield', ...locOf(sf, node) });
    } else if (ts.isElementAccessExpression(node)) {
      const { root: rNode } = unwrapChain(node.expression);
      const r = exprScope(rNode, curFn);
      bucket.subscripts.push({
        root: node.expression.getText(sf),
        scope: r.scope,
        index: node.argumentExpression.getText(sf),
        ...locOf(sf, node),
      });
    } else if (ts.isPropertyAccessExpression(node) && unwrapExpr(node.expression).kind === K.ThisKeyword) {
      bucket.reads.push({ name: `this.${node.name.text}`, scope: 'member', decl: declKindOf(checker.getSymbolAtLocation(node.name)?.getDeclarations()?.[0]), ...locOf(sf, node) });
    } else if (ts.isIdentifier(node) && isValueReadIdentifier(node)) {
      const info = symInfo(node, curFn);
      if (info.scope !== 'local' && info.scope !== 'param' && info.scope !== 'type') {
        bucket.reads.push({
          name: node.text,
          scope: info.scope,
          decl: info.decl,
          ...(info.from ? { from: info.from } : {}),
          ...locOf(sf, node),
        });
      }
    }
    ts.forEachChild(node, (c) => visitNode(c, curFn, bucket));
  }

  ts.forEachChild(sf, (c) => visitNode(c, null, moduleBucket));

  let modLines = 0;
  let modBranches = 0;
  let modMaxNesting = 0;
  for (const stmt of sf.statements) {
    if (isPureDeclarationOnly(stmt) || ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) {
      continue;
    }
    if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.every((d) => !d.initializer || FN_LIKE.has(d.initializer.kind))) {
      continue;
    }
    modLines += spanLines(stmt);
    const m = computeBodyMetrics(stmt);
    modBranches += m.branches;
    if (m.maxNesting > modMaxNesting) modMaxNesting = m.maxNesting;
  }
  moduleBucket.metrics = { lines: modLines, branches: modBranches, maxNesting: modMaxNesting };

  const hasFacts = (b) =>
    b.reads.length || b.writes.length || b.calls.length || b.subscripts.length ||
    b.throws.length || b.catches.length || b.loops.length || b.suspends.length;

  const out = [];
  if (hasFacts(moduleBucket)) out.push(moduleBucket);
  for (const { bucket } of functions) out.push(bucket);

  return { file, language: 'ts', functions: out, declarations, comments, imports, hazards, syntaxKinds };
}
