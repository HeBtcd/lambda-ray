import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SYNTAX_ALLOWLISTS = {
  ts: [
    'SourceFile',
    'EndOfFileToken',
    'ImportDeclaration',
    'ImportClause',
    'NamedImports',
    'NamespaceImport',
    'ImportSpecifier',
    'ExportKeyword',
    'DefaultKeyword',
    'NamedExports',
    'ExportSpecifier',
    'TypeAliasDeclaration',
    'InterfaceDeclaration',
    'EnumDeclaration',
    'EnumMember',
    'PropertySignature',
    'IndexSignature',
    'TypeLiteral',
    'TupleType',
    'ArrayType',
    'UnionType',
    'IntersectionType',
    'LiteralType',
    'TypeReference',
    'TypeParameter',
    'TypeOperator',
    'TypeOfExpression',
    'IndexedAccessType',
    'ParenthesizedType',
    'FunctionType',
    'ReadonlyKeyword',
    'NumberKeyword',
    'StringKeyword',
    'BooleanKeyword',
    'UnknownKeyword',
    'VoidKeyword',
    'NeverKeyword',
    'NullKeyword',
    'UndefinedKeyword',
    'BigIntKeyword',
    'FunctionDeclaration',
    'ArrowFunction',
    'Parameter',
    'Block',
    'FirstStatement',
    'VariableStatement',
    'VariableDeclarationList',
    'VariableDeclaration',
    'ArrayBindingPattern',
    'ObjectBindingPattern',
    'BindingElement',
    'ExpressionStatement',
    'ReturnStatement',
    'IfStatement',
    'SwitchStatement',
    'CaseBlock',
    'CaseClause',
    'DefaultClause',
    'BreakStatement',
    'ContinueStatement',
    'ForStatement',
    'ForOfStatement',
    'ThrowStatement',
    'BinaryExpression',
    'PrefixUnaryExpression',
    'PostfixUnaryExpression',
    'ConditionalExpression',
    'CallExpression',
    'NewExpression',
    'PropertyAccessExpression',
    'ElementAccessExpression',
    'ParenthesizedExpression',
    'AsExpression',
    'ArrayLiteralExpression',
    'ObjectLiteralExpression',
    'PropertyAssignment',
    'ShorthandPropertyAssignment',
    'SpreadAssignment',
    'SpreadElement',
    'TemplateExpression',
    'TemplateHead',
    'TemplateMiddle',
    'TemplateSpan',
    'LastTemplateToken',
    'NoSubstitutionTemplateLiteral',
    'Identifier',
    'StringLiteral',
    'FirstLiteralToken',
    'NumericLiteral',
    'BigIntLiteral',
    'TrueKeyword',
    'FalseKeyword',
    'ColonToken',
    'QuestionToken',
    'QuestionDotToken',
    'QuestionQuestionToken',
    'FirstAssignment',
    'EqualsToken',
    'FirstCompoundAssignment',
    'PlusEqualsToken',
    'MinusEqualsToken',
    'AsteriskEqualsToken',
    'SlashEqualsToken',
    'PercentEqualsToken',
    'LessThanLessThanEqualsToken',
    'GreaterThanGreaterThanEqualsToken',
    'GreaterThanGreaterThanGreaterThanEqualsToken',
    'AmpersandEqualsToken',
    'CaretEqualsToken',
    'BarEqualsToken',
    'FirstBinaryOperator',
    'LastBinaryOperator',
    'PlusToken',
    'MinusToken',
    'AsteriskToken',
    'SlashToken',
    'PercentToken',
    'AsteriskAsteriskToken',
    'PlusPlusToken',
    'MinusMinusToken',
    'ExclamationToken',
    'TildeToken',
    'LessThanToken',
    'LessThanEqualsToken',
    'GreaterThanToken',
    'GreaterThanEqualsToken',
    'EqualsEqualsEqualsToken',
    'ExclamationEqualsEqualsToken',
    'LessThanLessThanToken',
    'GreaterThanGreaterThanToken',
    'GreaterThanGreaterThanGreaterThanToken',
    'AmpersandToken',
    'BarToken',
    'CaretToken',
    'AmpersandAmpersandToken',
    'BarBarToken',
  ],
  csharp: [
    'CompilationUnit',
    'UsingDirective',
    'NamespaceDeclaration',
    'FileScopedNamespaceDeclaration',
    'StructDeclaration',
    'RecordStructDeclaration',
    'EnumDeclaration',
    'EnumMemberDeclaration',
    'FieldDeclaration',
    'PropertyDeclaration',
    'AccessorList',
    'GetAccessorDeclaration',
    'InitAccessorDeclaration',
    'ConstructorDeclaration',
    'MethodDeclaration',
    'ParameterList',
    'Parameter',
    'ArgumentList',
    'Argument',
    'NameColon',
    'Block',
    'ArrowExpressionClause',
    'LocalDeclarationStatement',
    'VariableDeclaration',
    'VariableDeclarator',
    'EqualsValueClause',
    'ExpressionStatement',
    'ReturnStatement',
    'IfStatement',
    'ElseClause',
    'SwitchStatement',
    'SwitchSection',
    'CaseSwitchLabel',
    'DefaultSwitchLabel',
    'SwitchExpression',
    'SwitchExpressionArm',
    'BreakStatement',
    'ContinueStatement',
    'ForStatement',
    'ForEachStatement',
    'ThrowStatement',
    'ThrowExpression',
    'SimpleAssignmentExpression',
    'AddAssignmentExpression',
    'SubtractAssignmentExpression',
    'MultiplyAssignmentExpression',
    'DivideAssignmentExpression',
    'ModuloAssignmentExpression',
    'AndAssignmentExpression',
    'ExclusiveOrAssignmentExpression',
    'OrAssignmentExpression',
    'LeftShiftAssignmentExpression',
    'RightShiftAssignmentExpression',
    'PreIncrementExpression',
    'PreDecrementExpression',
    'PostIncrementExpression',
    'PostDecrementExpression',
    'UnaryPlusExpression',
    'UnaryMinusExpression',
    'LogicalNotExpression',
    'BitwiseNotExpression',
    'AddExpression',
    'SubtractExpression',
    'MultiplyExpression',
    'DivideExpression',
    'ModuloExpression',
    'LeftShiftExpression',
    'RightShiftExpression',
    'EqualsExpression',
    'NotEqualsExpression',
    'LessThanExpression',
    'LessThanOrEqualExpression',
    'GreaterThanExpression',
    'GreaterThanOrEqualExpression',
    'LogicalAndExpression',
    'LogicalOrExpression',
    'BitwiseAndExpression',
    'BitwiseOrExpression',
    'ExclusiveOrExpression',
    'CoalesceExpression',
    'ConditionalExpression',
    'CastExpression',
    'ParenthesizedExpression',
    'InvocationExpression',
    'ObjectCreationExpression',
    'ImplicitObjectCreationExpression',
    'ArrayCreationExpression',
    'ImplicitArrayCreationExpression',
    'InitializerExpression',
    'ArrayRankSpecifier',
    'SimpleMemberAccessExpression',
    'ElementAccessExpression',
    'BracketedArgumentList',
    'IsPatternExpression',
    'ConstantPattern',
    'DeclarationPattern',
    'DiscardPattern',
    'VarPattern',
    'SingleVariableDesignation',
    'TupleType',
    'TupleElement',
    'TupleExpression',
    'ArrayType',
    'NullableType',
    'GenericName',
    'TypeArgumentList',
    'QualifiedName',
    'PredefinedType',
    'IdentifierName',
    'ThisExpression',
    'NumericLiteralExpression',
    'StringLiteralExpression',
    'CharacterLiteralExpression',
    'TrueLiteralExpression',
    'FalseLiteralExpression',
    'NullLiteralExpression',
    'DefaultLiteralExpression',
    'DefaultExpression',
    'AttributeList',
    'Attribute',
    'AttributeArgumentList',
    'AttributeArgument',
    'StaticKeyword',
    'ReadOnlyKeyword',
    'ConstKeyword',
    'RefKeyword',
    'InKeyword',
    'OutKeyword',
  ],
  cpp: [
    'translation_unit',
    'preproc_include',
    'preproc_call',
    'preproc_directive',
    'preproc_arg',
    'namespace_definition',
    'namespace_identifier',
    'declaration_list',
    'struct_specifier',
    'enum_specifier',
    'enumerator_list',
    'enumerator',
    'field_declaration_list',
    'field_declaration',
    'field_identifier',
    'access_specifier',
    'function_definition',
    'function_declarator',
    'abstract_function_declarator',
    'parameter_list',
    'parameter_declaration',
    'optional_parameter_declaration',
    'template_declaration',
    'template_parameter_list',
    'type_parameter_declaration',
    'template_type',
    'template_argument_list',
    'type_alias_declaration',
    'alias_declaration',
    'type_descriptor',
    'type_identifier',
    'primitive_type',
    'sized_type_specifier',
    'placeholder_type_specifier',
    'auto',
    'qualified_identifier',
    'trailing_return_type',
    'reference_declarator',
    'abstract_reference_declarator',
    'array_declarator',
    'default_method_clause',
    'compound_statement',
    'declaration',
    'init_declarator',
    'initializer_list',
    'expression_statement',
    'return_statement',
    'if_statement',
    'else_clause',
    'condition_clause',
    'switch_statement',
    'case_statement',
    'break_statement',
    'continue_statement',
    'for_statement',
    'for_range_loop',
    'assignment_expression',
    'update_expression',
    'binary_expression',
    'unary_expression',
    'conditional_expression',
    'call_expression',
    'argument_list',
    'field_expression',
    'subscript_expression',
    'parenthesized_expression',
    'compound_literal_expression',
    'cast:static_cast',
    'identifier',
    'number_literal',
    'string_literal',
    'char_literal',
    'true',
    'false',
    'null',
    'this',
    'operator_name',
    'type_qualifier:const',
    'type_qualifier:constexpr',
    'type_qualifier:constinit',
    'storage_class_specifier:static',
    'storage_class_specifier:inline',
    'function_specifier',
  ],
  rust: [
    'ItemConst',
    'ItemEnum',
    'ItemFn',
    'ItemImpl',
    'ImplItemFn',
    'ItemMod',
    'ItemStruct',
    'ItemType',
    'ItemUse',
    'StmtLocal',
    'StmtExpr',
    'ExprArray',
    'ExprAssign',
    'ExprBinary',
    'ExprBlock',
    'ExprBreak',
    'ExprCall',
    'ExprCast',
    'ExprConst',
    'ExprContinue',
    'ExprField',
    'ExprForLoop',
    'ExprGroup',
    'ExprIf',
    'ExprIndex',
    'ExprLet',
    'ExprLit',
    'ExprMatch',
    'ExprMethodCall',
    'ExprParen',
    'ExprPath',
    'ExprRange',
    'ExprReference',
    'ExprRepeat',
    'ExprReturn',
    'ExprStruct',
    'ExprTuple',
    'ExprUnary',
    'PatIdent',
    'PatLit',
    'PatOr',
    'PatParen',
    'PatPath',
    'PatRange',
    'PatReference',
    'PatRest',
    'PatSlice',
    'PatStruct',
    'PatTuple',
    'PatTupleStruct',
    'PatType',
    'PatWild',
    'TypeArray',
    'TypeInfer',
    'TypeParen',
    'TypePath',
    'TypeReference',
    'TypeSlice',
    'TypeTuple',
  ],
};

export const EXTERNAL_CALL_ALLOWLISTS = {
  ts: [
    /^Math\.(abs|acos|acosh|asin|asinh|atan|atan2|atanh|cbrt|ceil|clz32|cos|cosh|exp|expm1|floor|fround|hypot|imul|log|log1p|log2|log10|max|min|pow|round|sign|sin|sinh|sqrt|tan|tanh|trunc)$/,
    /^Number(\.(isFinite|isInteger|isNaN|isSafeInteger|parseFloat|parseInt))?$/,
    /^String(\.fromCharCode|\.fromCodePoint)?$/,
    /^Boolean$/,
    /^BigInt(\.(asIntN|asUintN))?$/,
    /^Error$/,
    /^Object\.(entries|keys|values|fromEntries|is)$/,
    /^Array(\.(isArray|from))?$/,
    /^(Array|.*\[\]|ReadonlyArray<.*>)\.(push|pop|slice|concat|map|filter|reduce|find|findIndex|some|every|includes|indexOf|join|sort|reverse|flat|flatMap|fill|at)$/,
    /^string\.(trim|trimStart|trimEnd|slice|substring|split|toLowerCase|toUpperCase|startsWith|endsWith|includes|indexOf|lastIndexOf|replace|replaceAll|padStart|padEnd|charAt|charCodeAt|at)$/,
    /^(Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64)Array\.(constructor|from|of|slice|subarray|fill|set|at)$/,
  ],
  csharp: [
    /^Math\.(Abs|Acos|Acosh|Asin|Asinh|Atan|Atan2|Atanh|BigMul|BitDecrement|BitIncrement|Cbrt|Ceiling|Clamp|CopySign|Cos|Cosh|DivRem|Exp|Floor|FusedMultiplyAdd|IEEERemainder|Log|Log2|Log10|Max|Min|Pow|Round|ScaleB|Sign|Sin|SinCos|Sqrt|Tan|Tanh|Truncate)$/,
    /^MathF\.(Abs|Acos|Asin|Atan|Atan2|Cbrt|Ceiling|Clamp|Cos|Cosh|Exp|Floor|Log|Log2|Log10|Max|Min|Pow|Round|Sign|Sin|Sqrt|Tan|Tanh|Truncate)$/,
    /^(Int32|Int64|UInt32|UInt64|Single|Double|Byte|SByte|Int16|UInt16)\.(Clamp|Min|Max|Abs|TryParse|Parse)$/,
    /^(int|long|uint|ulong|float|double|byte|sbyte|short|ushort)\.(Clamp|Min|Max|Abs|TryParse|Parse)$/,
    /^HashCode\.Combine$/,
    /^BitOperations\./,
    /^BinaryPrimitives\./,
    /^Array\.(Empty|Copy|Fill|Clear|Sort|IndexOf|Reverse)$/,
    /^(Span|ReadOnlySpan|Memory|ReadOnlyMemory)\./,
    /^Convert\.(ToInt32|ToInt64|ToUInt32|ToUInt64|ToDouble|ToSingle|ToByte|ToBoolean)$/,
    /^string\.(IsNullOrEmpty|IsNullOrWhiteSpace|Concat|Join|Equals|CompareOrdinal)$/,
    /^String\.(IsNullOrEmpty|IsNullOrWhiteSpace|Concat|Join|Equals|CompareOrdinal)$/,
  ],
  cpp: [
    /^std::(min|max|clamp|minmax|abs|fabs|labs|llabs|round|lround|llround|floor|ceil|trunc|sqrt|cbrt|pow|exp|log|log2|log10|sin|cos|tan|asin|acos|atan|atan2|hypot|fmod|fma|copysign|isnan|isinf|isfinite|swap|move|forward|sort|stable_sort|fill|copy|equal|lexicographical_compare|lower_bound|upper_bound|binary_search)$/,
  ],
  rust: [
    /^(Some|None|Ok|Err)$/,
    /^(std|core)::(cmp|mem)::(min|max|swap|replace|take)$/,
    /^(Vec|String)::(new|with_capacity|from)$/,
  ],
};

const STRICT_SIM_BASE = {
  noClasses: true,
  noInheritance: true,
  noPolymorphism: true,
  noReflection: true,
  noUnsafe: true,
  noEval: true,
  noDynamicBlackboards: true,
  noDynamicCalls: true,
  noGlobalWrites: true,
  noModuleWrites: true,
  noClosureWrites: true,
  noSuspends: true,
  noImpureCalls: true,
  noComments: true,
  forbiddenImports: [
    'node:fs',
    'fs',
    'node:http',
    'http',
    'node:https',
    'https',
    'node:net',
    'net',
    'node:dgram',
    'dgram',
    'node:child_process',
    'child_process',
    'node:process',
    'process',
    'node:os',
    'os',
    'node:vm',
    'vm',
    'node:worker_threads',
    'worker_threads',
    'System.IO',
    'System.Net',
    'System.Diagnostics.Process',
    'System.Reflection',
    'System.Environment',
    'System.Threading.Tasks',
    'UnityEngine',
    '<fstream>',
    '<filesystem>',
    '<iostream>',
    '<cstdio>',
    '<thread>',
    '<mutex>',
    '<winsock2.h>',
    '<sys/socket.h>',
    '<unistd.h>',
    '<cstdlib>',
    'std::fs',
    'std::net',
    'std::io',
    'std::env',
    'std::process',
    'std::thread',
    'std::time',
    'std::sync',
    'tokio',
    'rand',
  ],
  maxFunctionLines: 120,
  maxBranches: 24,
  maxNesting: 6,
  maxFunctionsPerFile: 24,
  noThrows: false,
  noCatches: false,
  noLoops: false,
};

export const PROFILES = {
  'strict-sim': STRICT_SIM_BASE,
  'strict-sim-allowlist': {
    ...STRICT_SIM_BASE,
    syntaxAllowlist: SYNTAX_ALLOWLISTS,
    allowedExternalCalls: EXTERNAL_CALL_ALLOWLISTS,
  },
};

const IMPURE_CALL_PATTERNS = [
  /^Math\.random$/,
  /^Date\.now$/,
  /^Date\.constructor$/,
  /^Date$/,
  /^performance\.now$/,
  /^crypto\.(randomUUID|getRandomValues)$/,
  /^console\./,
  /^(alert|prompt|confirm|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|setImmediate)$/,
  /^process\.(exit|hrtime|uptime|cwd|chdir)$/,
  /^(readFile|readFileSync|writeFile|writeFileSync|appendFileSync|unlinkSync|mkdirSync|readdirSync|statSync)$/,
  /^(Random(\.|$)|Guid\.NewGuid$)/,
  /^(DateTime|DateTimeOffset)\.(Now|UtcNow|Today)$/,
  /^Environment\.(TickCount|TickCount64|GetEnvironmentVariable|GetEnvironmentVariables|Exit|CurrentDirectory)$/,
  /^Stopwatch\.(GetTimestamp|StartNew)$/,
  /^Console\./,
  /^Debug\.Log/,
  /^(File|Directory)\./,
  /^(StreamReader|StreamWriter|FileStream|HttpClient|WebClient|Socket|TcpClient|UdpClient)(\.|$)/,
  /^Process\.Start$/,
  /^Task\.(Run|Delay)$/,
  /^Thread\.Sleep$/,
  /^(std::)?(rand|srand|time|clock|getenv|system|popen|exit|abort|fopen|fclose|fread|fwrite|printf|fprintf|sprintf|scanf|puts|putchar)$/,
  /^std::(random_device|chrono::(system_clock|steady_clock|high_resolution_clock))/,
  /^std::(ifstream|ofstream|fstream)/,
  /^(println|eprintln|print|eprint|dbg)!$/,
  /^(std::)?(time|fs|env|process|net|thread)::/,
  /^(SystemTime|Instant)::/,
  /^rand::/,
];

const IMPURE_READ_PATTERNS = [
  /^DateTime\.(Now|UtcNow|Today)$/,
  /^DateTimeOffset\.(Now|UtcNow)$/,
  /^Environment\.(TickCount|TickCount64)$/,
  /^Random\.Shared$/,
  /^process$/,
  /^console$/,
  /^performance$/,
  /^std::(cout|cerr|cin)$/,
];

function isImpureName(name, patterns) {
  if (!name) return false;
  return patterns.some((re) => re.test(name));
}

function compileAllowPattern(pat) {
  if (pat instanceof RegExp) return pat;
  if (typeof pat === 'string' && pat.startsWith('/') && pat.endsWith('/') && pat.length > 2) {
    return new RegExp(pat.slice(1, -1));
  }
  return pat;
}

function matchesExternalAllow(name, patterns) {
  if (!name) return false;
  return patterns.some((p) => {
    const c = compileAllowPattern(p);
    return c instanceof RegExp ? c.test(name) : c === name;
  });
}

function resolveLangAllowlist(spec, language) {
  if (!spec) return null;
  if (Array.isArray(spec)) return spec;
  if (typeof spec === 'object' && Array.isArray(spec[language])) return spec[language];
  return null;
}

export function loadPolicy(spec, cwd = process.cwd()) {
  if (!spec || typeof spec !== 'string') {
    throw new Error('gate requires a profile name or policy.json path');
  }
  if (Object.hasOwn(PROFILES, spec)) {
    return { name: spec, policy: { ...PROFILES[spec] } };
  }
  const policyPath = resolve(cwd, spec);
  let raw;
  try {
    raw = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to load policy '${spec}': ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid policy '${spec}': expected JSON object`);
  }
  let base = {};
  if (raw.extends !== undefined) {
    if (typeof raw.extends !== 'string' || !Object.hasOwn(PROFILES, raw.extends)) {
      throw new Error(`unknown base profile in policy.extends: ${String(raw.extends)}`);
    }
    base = { ...PROFILES[raw.extends] };
  }
  const merged = { ...base, ...raw };
  if (Array.isArray(base.forbiddenImports) && Array.isArray(raw.extraForbiddenImports)) {
    merged.forbiddenImports = [...base.forbiddenImports, ...raw.extraForbiddenImports];
  }
  return { name: spec, policy: merged };
}

function matchesImportPattern(source, pattern) {
  if (!source || !pattern) return false;
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    return new RegExp(pattern.slice(1, -1)).test(source);
  }
  const src = source.replace(/^<|>$/g, '');
  const pat = pattern.replace(/^<|>$/g, '');
  if (pat.includes('*')) {
    const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return re.test(source) || re.test(src);
  }
  if (source === pattern || src === pat) return true;
  if (src.startsWith(`${pat}/`) || src.startsWith(`${pat}.`) || src.startsWith(`${pat}::`)) return true;
  if (src.endsWith(`/${pat}`)) return true;
  if (src.split('/').includes(pat)) return true;
  return false;
}

export function evaluateGate(data, policy) {
  const violations = [];
  const file = data.file;
  const push = (line, col, rule, message) => {
    violations.push({ file, line: line ?? 1, col: col ?? 1, rule, message });
  };

  const declarations = data.declarations ?? [];
  const comments = data.comments ?? { count: 0, spans: [] };
  const imports = data.imports ?? [];
  const hazards = data.hazards ?? [];
  const functions = data.functions ?? [];
  const syntaxKinds = data.syntaxKinds ?? [];

  for (const d of declarations) {
    const mods = d.modifiers ?? [];
    const bases = d.bases ?? [];
    if (policy.noClasses && (d.kind === 'class' || d.kind === 'record')) {
      push(d.line, d.col, 'no-classes', `${d.kind} declaration '${d.name}' is forbidden`);
    }
    if (policy.noInheritance && bases.length > 0 && (d.kind === 'class' || d.kind === 'record' || (data.language === 'cpp' && d.kind === 'struct'))) {
      push(d.line, d.col, 'no-inheritance', `'${d.name}' inherits from [${bases.join(', ')}]`);
    }
    if (policy.noPolymorphism) {
      const poly = mods.filter((m) => m === 'virtual' || m === 'abstract' || m === 'override');
      if (poly.length > 0) {
        push(d.line, d.col, 'no-polymorphism', `'${d.name}' uses ${poly.join('/')} dispatch`);
      }
    }
    if (policy.noModuleWrites && (d.kind === 'variable' || d.kind === 'field' || d.kind === 'property')) {
      if (mods.includes('mutable') && (mods.includes('module') || mods.includes('static'))) {
        push(d.line, d.col, 'no-module-writes', `mutable ${mods.includes('static') ? 'static' : 'module'} state '${d.name}' is forbidden`);
      }
    }
  }

  for (const h of hazards) {
    if (h.kind === 'reflection' && policy.noReflection) {
      push(h.line, h.col, 'no-reflection', `reflection construct '${h.detail}' is forbidden`);
    } else if (h.kind === 'unsafe' && policy.noUnsafe) {
      push(h.line, h.col, 'no-unsafe', `unsafe construct '${h.detail}' is forbidden`);
    } else if (h.kind === 'eval' && policy.noEval) {
      push(h.line, h.col, 'no-eval', `dynamic eval/with '${h.detail}' is forbidden`);
    } else if (h.kind === 'blackboard' && policy.noDynamicBlackboards) {
      push(h.line, h.col, 'no-dynamic-blackboards', `dynamic blackboard '${h.detail}' is forbidden`);
    } else if (h.kind === 'dynamic' && policy.noDynamicCalls) {
      push(h.line, h.col, 'no-dynamic-calls', `dynamic construct '${h.detail}' is forbidden`);
    }
  }

  const syntaxAllow = resolveLangAllowlist(policy.syntaxAllowlist, data.language);
  if (syntaxAllow) {
    const allowedSet = new Set(syntaxAllow);
    for (const sk of syntaxKinds) {
      if (!allowedSet.has(sk.kind)) {
        push(sk.line, sk.col, 'disallowed-syntax', `syntax kind '${sk.kind}' is not in ${data.language} syntax allowlist`);
      }
    }
  }

  if (policy.noComments) {
    for (const c of comments.spans ?? []) {
      push(c.line, c.col, 'no-comments', `${c.kind} comment is forbidden`);
    }
  }

  if (Array.isArray(policy.forbiddenImports) && policy.forbiddenImports.length > 0) {
    for (const imp of imports) {
      const hit = policy.forbiddenImports.find((pat) => matchesImportPattern(imp.source, pat));
      if (hit) {
        push(imp.line, imp.col, 'forbidden-import', `import '${imp.source}' matches forbidden pattern '${hit}'`);
      }
    }
  }

  if (typeof policy.maxFunctionsPerFile === 'number' && functions.length > policy.maxFunctionsPerFile) {
    push(1, 1, 'max-functions-per-file', `${functions.length} functions exceeds limit of ${policy.maxFunctionsPerFile}`);
  }

  const extAllow = resolveLangAllowlist(policy.allowedExternalCalls, data.language);

  for (const fn of functions) {
    for (const w of fn.writes ?? []) {
      if (w.scope === 'global' && policy.noGlobalWrites) {
        push(w.line, w.col, 'no-global-writes', `global write to '${w.target}' in '${fn.name}'`);
      } else if (w.scope === 'module' && policy.noModuleWrites) {
        push(w.line, w.col, 'no-module-writes', `module/static write to '${w.target}' in '${fn.name}'`);
      } else if (w.scope === 'closure' && policy.noClosureWrites) {
        push(w.line, w.col, 'no-closure-writes', `closure write to '${w.target}' in '${fn.name}'`);
      }
    }

    if (policy.noSuspends) {
      for (const s of fn.suspends ?? []) {
        push(s.line, s.col, 'no-suspends', `suspend '${s.kind}' in '${fn.name}' is forbidden`);
      }
    }

    if (policy.noThrows) {
      for (const t of fn.throws ?? []) {
        push(t.line, t.col, 'no-throws', `throw in '${fn.name}' is forbidden`);
      }
    }

    if (policy.noCatches) {
      for (const c of fn.catches ?? []) {
        push(c.line, c.col, 'no-catches', `catch in '${fn.name}' is forbidden`);
      }
    }

    if (policy.noLoops) {
      for (const l of fn.loops ?? []) {
        push(l.line, l.col, 'no-loops', `unbounded loop '${l.kind}' in '${fn.name}' is forbidden`);
      }
    }

    for (const c of fn.calls ?? []) {
      const target = c.target ?? '';
      const expr = c.expr ?? '';
      const impHit = Array.isArray(policy.forbiddenImports) && c.from
        ? policy.forbiddenImports.find((pat) => matchesImportPattern(c.from, pat))
        : null;
      const isImpure = Boolean(
        impHit || isImpureName(target, IMPURE_CALL_PATTERNS) || isImpureName(expr, IMPURE_CALL_PATTERNS)
      );
      if (policy.noImpureCalls && isImpure) {
        push(c.line, c.col, 'impure-call', `impure call '${c.expr}'${target && target !== expr ? ` (${target})` : ''} in '${fn.name}'`);
      }
      if (policy.noDynamicCalls && (c.kind === 'dynamic' || (c.kind === 'opaque' && data.language === 'ts' && !isImpure))) {
        push(c.line, c.col, 'no-dynamic-calls', `${c.kind} call '${c.expr}' in '${fn.name}'`);
      }
      if (extAllow && c.kind === 'external') {
        const ok = matchesExternalAllow(target, extAllow) || matchesExternalAllow(expr, extAllow);
        if (!ok) {
          push(c.line, c.col, 'disallowed-external-call', `external call '${target || expr}' in '${fn.name}' is not in allowedExternalCalls`);
        }
      }
    }

    if (policy.noImpureCalls) {
      for (const r of fn.reads ?? []) {
        if (isImpureName(r.name, IMPURE_READ_PATTERNS)) {
          push(r.line, r.col, 'impure-call', `impure read '${r.name}' in '${fn.name}'`);
        }
      }
    }

    if (fn.metrics) {
      if (typeof policy.maxFunctionLines === 'number' && fn.metrics.lines > policy.maxFunctionLines) {
        push(fn.line, fn.col, 'max-function-lines', `function '${fn.name}' has ${fn.metrics.lines} lines (limit ${policy.maxFunctionLines})`);
      }
      if (typeof policy.maxBranches === 'number' && fn.metrics.branches > policy.maxBranches) {
        push(fn.line, fn.col, 'max-branches', `function '${fn.name}' has ${fn.metrics.branches} branches (limit ${policy.maxBranches})`);
      }
      if (typeof policy.maxNesting === 'number' && fn.metrics.maxNesting > policy.maxNesting) {
        push(fn.line, fn.col, 'max-nesting', `function '${fn.name}' has nesting depth ${fn.metrics.maxNesting} (limit ${policy.maxNesting})`);
      }
    }
  }

  violations.sort((a, b) =>
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.col - b.col ||
    a.rule.localeCompare(b.rule) ||
    a.message.localeCompare(b.message)
  );
  return violations;
}

export function formatGateViolations(violations, files = []) {
  if (!violations.length) {
    return `PASS ${files.join(', ')}`;
  }
  return violations.map((v) => `${v.file}:${v.line}:${v.col} [${v.rule}] ${v.message}`).join('\n');
}
