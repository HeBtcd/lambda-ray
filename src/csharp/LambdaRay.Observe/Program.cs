using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

var fileArg = Path.GetFullPath(args[0]);
var fileStr = fileArg.Replace('\\', '/');
var sourceText = await File.ReadAllTextAsync(fileArg);
var tree = CSharpSyntaxTree.ParseText(sourceText, new CSharpParseOptions(LanguageVersion.Latest), path: fileArg);

var trees = new List<SyntaxTree> { tree };
if (HasImplicitUsings(Path.GetDirectoryName(fileArg)))
{
    const string implicitUsings = """
        global using System;
        global using System.Collections.Generic;
        global using System.IO;
        global using System.Linq;
        global using System.Net.Http;
        global using System.Threading;
        global using System.Threading.Tasks;
        """;
    trees.Add(CSharpSyntaxTree.ParseText(implicitUsings, new CSharpParseOptions(LanguageVersion.Latest), path: "__ImplicitUsings.g.cs"));
}

var refs = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "")
    .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
    .Where(p =>
    {
        var n = Path.GetFileName(p);
        return n.StartsWith("System.", StringComparison.Ordinal) || n is "mscorlib.dll" or "netstandard.dll" or "Microsoft.CSharp.dll";
    })
    .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p));

var comp = CSharpCompilation.Create(
    "LambdaRayObserve",
    trees,
    refs,
    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
var model = comp.GetSemanticModel(tree);
var root = tree.GetRoot();
var sameSym = SymbolEqualityComparer.Default;

static bool HasImplicitUsings(string? startDir)
{
    for (var dir = startDir; !string.IsNullOrEmpty(dir); dir = Path.GetDirectoryName(dir))
    {
        foreach (var csproj in Directory.EnumerateFiles(dir, "*.csproj"))
        {
            var xml = File.ReadAllText(csproj);
            if (xml.Contains("<ImplicitUsings>enable</ImplicitUsings>", StringComparison.OrdinalIgnoreCase) ||
                xml.Contains("<ImplicitUsings>true</ImplicitUsings>", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
    }
    return false;
}

static (int line, int col) LocOf(SyntaxNode n)
{
    var p = n.GetLocation().GetLineSpan().StartLinePosition;
    return (p.Line + 1, p.Character + 1);
}

static (int line, int endLine, int col) SpanOf(SyntaxNode n)
{
    var span = n.GetLocation().GetLineSpan();
    return (span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1, span.StartLinePosition.Character + 1);
}

static (int line, int endLine, int col) TriviaSpanOf(SyntaxTrivia t)
{
    var span = t.GetLocation().GetLineSpan();
    return (span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1, span.StartLinePosition.Character + 1);
}

static FnMetrics ComputeBodyMetrics(SyntaxNode? body, int lines)
{
    var branches = 0;
    var maxNesting = 0;
    void Walk(SyntaxNode n, int depth)
    {
        if (n is LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax) return;
        var nextDepth = depth;
        var isElseIf = n is IfStatementSyntax ifs && ifs.Parent is ElseClauseSyntax;
        if (n is IfStatementSyntax or SwitchStatementSyntax or ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax or WhileStatementSyntax or DoStatementSyntax or TryStatementSyntax)
        {
            if (!isElseIf)
            {
                nextDepth = depth + 1;
                if (nextDepth > maxNesting) maxNesting = nextDepth;
            }
        }
        if (n is IfStatementSyntax or SwitchSectionSyntax or SwitchExpressionArmSyntax or CatchClauseSyntax or ConditionalExpressionSyntax or ForStatementSyntax or ForEachStatementSyntax or ForEachVariableStatementSyntax or WhileStatementSyntax or DoStatementSyntax)
        {
            branches++;
        }
        foreach (var c in n.ChildNodes()) Walk(c, nextDepth);
    }
    if (body != null) Walk(body, 0);
    return new FnMetrics(lines, branches, maxNesting);
}

static string EnclosingTypePrefix(SyntaxNode node)
{
    var parts = new Stack<string>();
    for (var p = node.Parent; p != null; p = p.Parent)
    {
        if (p is BaseTypeDeclarationSyntax td) parts.Push(td.Identifier.Text);
    }
    return string.Join(".", parts);
}

static string[] ParamNames(SyntaxNode fnNode) => fnNode switch
{
    BaseMethodDeclarationSyntax m => m.ParameterList.Parameters.Select(p => p.Identifier.Text).ToArray(),
    LocalFunctionStatementSyntax l => l.ParameterList.Parameters.Select(p => p.Identifier.Text).ToArray(),
    SimpleLambdaExpressionSyntax sl => new[] { sl.Parameter.Identifier.Text },
    ParenthesizedLambdaExpressionSyntax pl => pl.ParameterList.Parameters.Select(p => p.Identifier.Text).ToArray(),
    AnonymousMethodExpressionSyntax am => am.ParameterList?.Parameters.Select(p => p.Identifier.Text).ToArray() ?? Array.Empty<string>(),
    _ => Array.Empty<string>(),
};

static string MethodBaseName(SyntaxNode node)
{
    var prefix = EnclosingTypePrefix(node);
    var own = node switch
    {
        MethodDeclarationSyntax m => m.Identifier.Text,
        ConstructorDeclarationSyntax => "constructor",
        AccessorDeclarationSyntax a => $"{(a.Parent?.Parent is PropertyDeclarationSyntax prop ? prop.Identifier.Text : "indexer")}.{a.Keyword.Text}",
        _ => "<fn>",
    };
    return string.IsNullOrEmpty(prefix) ? own : $"{prefix}.{own}";
}

var localMethodMap = new Dictionary<ISymbol, string>(sameSym);
var overloadCount = new Dictionary<string, int>();
var topDecls = root.DescendantNodes()
    .Where(n => n is MethodDeclarationSyntax or ConstructorDeclarationSyntax ||
                (n is AccessorDeclarationSyntax acc && (acc.Body != null || acc.ExpressionBody != null)))
    .ToList();

foreach (var d in topDecls)
{
    var baseName = MethodBaseName(d);
    overloadCount[baseName] = overloadCount.GetValueOrDefault(baseName) + 1;
}

var fnBuckets = new List<FunctionBucket>();

string RegisterCallable(SyntaxNode node, string name)
{
    if (model.GetDeclaredSymbol(node) is IMethodSymbol sym)
    {
        localMethodMap[sym] = name;
    }
    return name;
}

void CollectLocalFunctions(SyntaxNode? body, string parentName)
{
    if (body == null) return;
    foreach (var child in body.ChildNodes())
    {
        if (child is LocalFunctionStatementSyntax lf)
        {
            var lname = $"{parentName}/{lf.Identifier.Text}";
            RegisterCallable(lf, lname);
            CollectLocalFunctions((SyntaxNode?)lf.Body ?? lf.ExpressionBody, lname);
        }
        else if (child is AnonymousFunctionExpressionSyntax af)
        {
            var (l, c) = LocOf(af);
            var aname = $"{parentName}/<fn>@{l}:{c}";
            CollectLocalFunctions(af.Body, aname);
        }
        else
        {
            CollectLocalFunctions(child, parentName);
        }
    }
}

var topNames = new Dictionary<SyntaxNode, string>();
foreach (var d in topDecls)
{
    var baseName = MethodBaseName(d);
    var name = overloadCount[baseName] > 1 && d is BaseMethodDeclarationSyntax bm
        ? $"{baseName}({string.Join(",", bm.ParameterList.Parameters.Select(p => p.Type?.ToString() ?? "?"))})"
        : baseName;
    topNames[d] = RegisterCallable(d, name);
    var body = d switch
    {
        BaseMethodDeclarationSyntax bm2 => (SyntaxNode?)bm2.Body ?? bm2.ExpressionBody,
        AccessorDeclarationSyntax acc2 => (SyntaxNode?)acc2.Body ?? acc2.ExpressionBody,
        _ => null,
    };
    CollectLocalFunctions(body, name);
}

foreach (var g in root.ChildNodes().OfType<GlobalStatementSyntax>())
{
    CollectLocalFunctions(g, "<module>");
}

ISymbol? Sym(SyntaxNode n) => model.GetSymbolInfo(n).Symbol ?? model.GetDeclaredSymbol(n);

string ScopeOf(ISymbol? sym, IMethodSymbol? cur)
{
    if (sym == null) return "global";
    if (sym is IParameterSymbol p)
    {
        if (p.IsThis) return "member";
        return sameSym.Equals(p.ContainingSymbol, cur) ? "param" : "closure";
    }
    if (sym is ILocalSymbol l)
    {
        return sameSym.Equals(l.ContainingSymbol, cur) ? "local" : "closure";
    }
    if (sym is IFieldSymbol f)
    {
        if (!sameSym.Equals(f.ContainingAssembly, comp.Assembly)) return "global";
        return f.IsStatic || f.IsConst ? "module" : "member";
    }
    if (sym is IPropertySymbol prop)
    {
        if (!sameSym.Equals(prop.ContainingAssembly, comp.Assembly)) return "global";
        return prop.IsStatic ? "module" : "member";
    }
    if (sym is IMethodSymbol m)
    {
        return sameSym.Equals(m.ContainingAssembly, comp.Assembly) ? "module" : "global";
    }
    return "global";
}

string DeclOf(ISymbol? sym) => sym switch
{
    IParameterSymbol => "param",
    ILocalSymbol l => l.IsConst ? "const" : "mutable",
    IFieldSymbol f => f.IsConst ? "const" : f.IsReadOnly ? "readonly" : "mutable",
    IPropertySymbol p => p.SetMethod == null || p.SetMethod.IsInitOnly ? "readonly" : "mutable",
    IMethodSymbol => "function",
    _ => "unknown",
};

static ExpressionSyntax UnwrapParens(ExpressionSyntax e)
{
    while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
    return e;
}

static (ExpressionSyntax root, List<string> path) UnwrapChain(ExpressionSyntax target)
{
    var path = new List<string>();
    var cur = UnwrapParens(target);
    while (cur is MemberAccessExpressionSyntax or ElementAccessExpressionSyntax)
    {
        if (cur is MemberAccessExpressionSyntax ma)
        {
            path.Insert(0, ma.Name.Identifier.Text);
            cur = UnwrapParens(ma.Expression);
        }
        else if (cur is ElementAccessExpressionSyntax ea)
        {
            path.Insert(0, "(index)");
            cur = UnwrapParens(ea.Expression);
        }
    }
    return (cur, path);
}

(string scope, string? root) ExprScope(ExpressionSyntax expr, IMethodSymbol? cur)
{
    var u = UnwrapParens(expr);
    if (u is ThisExpressionSyntax) return ("member", "this");
    if (u is BaseExpressionSyntax) return ("member", "base");
    if (u is PredefinedTypeSyntax pt) return ("global", pt.Keyword.Text);
    if (u is IdentifierNameSyntax id)
    {
        var s = Sym(id);
        if (s is INamedTypeSymbol or INamespaceSymbol) return ("global", id.Identifier.Text);
        return (ScopeOf(s, cur), id.Identifier.Text);
    }
    return ("expr", null);
}

bool IsTypeOrDeclName(IdentifierNameSyntax id)
{
    if (id.IsVar) return true;
    for (var p = id.Parent; p != null; p = p.Parent)
    {
        if (p is ArrayRankSpecifierSyntax) break;
        if (p is TypeSyntax && p is not IdentifierNameSyntax)
        {
            if (p is QualifiedNameSyntax or GenericNameSyntax or ArrayTypeSyntax or NullableTypeSyntax or PointerTypeSyntax or TupleTypeSyntax or RefTypeSyntax)
                return true;
        }
        if (p is TypeOfExpressionSyntax or SizeOfExpressionSyntax or DefaultExpressionSyntax or UsingDirectiveSyntax or NamespaceDeclarationSyntax or FileScopedNamespaceDeclarationSyntax)
            return true;
        if (p is CastExpressionSyntax cast && cast.Type == id) return true;
        if (p is BinaryExpressionSyntax bin && bin.Kind() is SyntaxKind.AsExpression or SyntaxKind.IsExpression && bin.Right == id) return true;
        if (p is DeclarationPatternSyntax dp && dp.Type == id) return true;
        if (p is TypePatternSyntax tp && tp.Type == id) return true;
        if (p is ObjectCreationExpressionSyntax oc && oc.Type == id) return true;
        if (p is VariableDeclarationSyntax vd && vd.Type == id) return true;
        if (p is ParameterSyntax ps && ps.Type == id) return true;
        if (p is MethodDeclarationSyntax md && md.ReturnType == id) return true;
        if (p is LocalFunctionStatementSyntax lfs && lfs.ReturnType == id) return true;
        if (p is PropertyDeclarationSyntax pd && pd.Type == id) return true;
        if (p is ForEachStatementSyntax fe && fe.Type == id) return true;
        if (p is FieldDeclarationSyntax) break;
    }
    return id.Parent is MemberBindingExpressionSyntax or NameColonSyntax or NameEqualsSyntax
        or VariableDeclaratorSyntax or ParameterSyntax or TypeParameterSyntax
        or BaseTypeDeclarationSyntax or MethodDeclarationSyntax or LocalFunctionStatementSyntax
        or PropertyDeclarationSyntax or CatchDeclarationSyntax;
}

void WalkInto(SyntaxNode body, string fnName, IMethodSymbol? cur, FunctionBucket bucket)
{
    void RecordWrite(ExpressionSyntax target, SyntaxNode locNode, bool isCompound)
    {
        var (rootExpr, path) = UnwrapChain(target);
        var (line, col) = LocOf(locNode);
        if (rootExpr is ThisExpressionSyntax or BaseExpressionSyntax)
        {
            var rName = rootExpr is ThisExpressionSyntax ? "this" : "base";
            bucket.Writes.Add(new WriteFact(target.ToString(), rName, "member", path, line, col));
            if (isCompound)
            {
                var mName = path.Count > 0 ? $"{rName}.{path[0]}" : rName;
                bucket.Reads.Add(new ReadFact(mName, "member", "mutable", line, col));
            }
            return;
        }
        if (rootExpr is IdentifierNameSyntax id)
        {
            var sym = Sym(id);
            if (sym is IDiscardSymbol) return;
            if (sym is INamedTypeSymbol or INamespaceSymbol)
            {
                ExpressionSyntax curTarget = UnwrapParens(target);
                ISymbol? staticMember = null;
                while (curTarget is MemberAccessExpressionSyntax maTarget)
                {
                    var ms = Sym(maTarget.Name);
                    if (ms is IFieldSymbol or IPropertySymbol && ms.IsStatic)
                    {
                        staticMember = ms;
                        break;
                    }
                    curTarget = UnwrapParens(maTarget.Expression);
                }
                if (staticMember != null)
                {
                    var msc = ScopeOf(staticMember, cur);
                    bucket.Writes.Add(new WriteFact(target.ToString(), id.Identifier.Text, msc, path, line, col));
                    if (isCompound && ReferenceEquals(curTarget, UnwrapParens(target)) && msc is not ("local" or "param"))
                    {
                        bucket.Reads.Add(new ReadFact(target.ToString(), msc, DeclOf(staticMember), line, col));
                    }
                    return;
                }
            }
            var sc = ScopeOf(sym, cur);
            if (sc != "local" || path.Count > 0)
            {
                bucket.Writes.Add(new WriteFact(target.ToString(), id.Identifier.Text, sc, path, line, col));
            }
            if (isCompound && sc is not ("local" or "param") && path.Count == 0)
            {
                bucket.Reads.Add(new ReadFact(id.Identifier.Text, sc, DeclOf(sym), line, col));
            }
            return;
        }
        bucket.Writes.Add(new WriteFact(target.ToString(), rootExpr.ToString(), "expr", path, line, col));
    }

    void VisitWriteSubexprs(ExpressionSyntax target)
    {
        var curExpr = UnwrapParens(target);
        while (curExpr is MemberAccessExpressionSyntax or ElementAccessExpressionSyntax)
        {
            if (curExpr is ElementAccessExpressionSyntax ea)
            {
                foreach (var arg in ea.ArgumentList.Arguments) Visit(arg.Expression);
                curExpr = UnwrapParens(ea.Expression);
            }
            else if (curExpr is MemberAccessExpressionSyntax ma)
            {
                curExpr = UnwrapParens(ma.Expression);
            }
        }
        if (curExpr is not (IdentifierNameSyntax or ThisExpressionSyntax or BaseExpressionSyntax))
        {
            Visit(curExpr);
        }
    }

    void VisitReceiverSubexprs(ExpressionSyntax expr)
    {
        var curExpr = UnwrapParens(expr);
        while (curExpr is MemberAccessExpressionSyntax or ElementAccessExpressionSyntax)
        {
            if (curExpr is ElementAccessExpressionSyntax ea)
            {
                var (rootExpr, _) = UnwrapChain(ea.Expression);
                var (sc, _) = ExprScope(rootExpr, cur);
                var (line, col) = LocOf(ea);
                bucket.Subscripts.Add(new SubscriptFact(ea.Expression.ToString(), sc, ea.ArgumentList.Arguments.ToString(), line, col));
                foreach (var arg in ea.ArgumentList.Arguments) Visit(arg.Expression);
                curExpr = UnwrapParens(ea.Expression);
            }
            else if (curExpr is MemberAccessExpressionSyntax ma)
            {
                curExpr = UnwrapParens(ma.Expression);
            }
        }
        if (curExpr is not (IdentifierNameSyntax or ThisExpressionSyntax or BaseExpressionSyntax))
        {
            Visit(curExpr);
        }
    }

    void Visit(SyntaxNode node)
    {
        if (node is LocalFunctionStatementSyntax lf)
        {
            var lName = $"{fnName}/{lf.Identifier.Text}";
            var lSym = model.GetDeclaredSymbol(lf) as IMethodSymbol;
            var lBody = (SyntaxNode?)lf.Body ?? lf.ExpressionBody;
            var (ls, le, _) = SpanOf(lf);
            var lBucket = NewBucket(lName, lf, ParamNames(lf), ComputeBodyMetrics(lBody, le - ls + 1));
            fnBuckets.Add(lBucket);
            if (lBody != null) WalkInto(lBody, lName, lSym, lBucket);
            return;
        }
        if (node is AnonymousFunctionExpressionSyntax af)
        {
            var (al, ac) = LocOf(af);
            var aName = $"{fnName}/<fn>@{al}:{ac}";
            var aSym = model.GetSymbolInfo(af).Symbol as IMethodSymbol;
            var (asLine, aeLine, _) = SpanOf(af);
            var aBucket = NewBucket(aName, af, ParamNames(af), ComputeBodyMetrics(af.Body, aeLine - asLine + 1));
            fnBuckets.Add(aBucket);
            WalkInto(af.Body, aName, aSym, aBucket);
            return;
        }

        switch (node)
        {
            case AssignmentExpressionSyntax a when a.Parent is InitializerExpressionSyntax:
                Visit(a.Right);
                return;

            case AssignmentExpressionSyntax a:
                RecordWrite(a.Left, a, !a.IsKind(SyntaxKind.SimpleAssignmentExpression));
                VisitWriteSubexprs(a.Left);
                Visit(a.Right);
                return;

            case PrefixUnaryExpressionSyntax pre when pre.Kind() is SyntaxKind.PreIncrementExpression or SyntaxKind.PreDecrementExpression:
                RecordWrite(pre.Operand, pre, true);
                VisitWriteSubexprs(pre.Operand);
                return;

            case PostfixUnaryExpressionSyntax post when post.Kind() is SyntaxKind.PostIncrementExpression or SyntaxKind.PostDecrementExpression:
                RecordWrite(post.Operand, post, true);
                VisitWriteSubexprs(post.Operand);
                return;

            case InvocationExpressionSyntax inv:
            {
                if (inv.Expression is IdentifierNameSyntax { Identifier.Text: "nameof" } &&
                    model.GetSymbolInfo(inv).Symbol == null &&
                    model.GetConstantValue(inv).HasValue)
                {
                    return;
                }
                var (line, col) = LocOf(inv);
                var callee = UnwrapParens(inv.Expression);
                if (callee is IdentifierNameSyntax or GenericNameSyntax)
                {
                    var sym = Sym(callee);
                    var cname = callee is IdentifierNameSyntax idn ? idn.Identifier.Text : callee.ToString();
                    if (sym is IParameterSymbol or ILocalSymbol)
                    {
                        bucket.Calls.Add(new CallFact(cname, "param", null, false, null, null, line, col));
                    }
                    else if (sym is IMethodSymbol ms)
                    {
                        var orig = ms.OriginalDefinition;
                        if (localMethodMap.TryGetValue(orig, out var localTarget) || localMethodMap.TryGetValue(ms, out localTarget))
                        {
                            bucket.Calls.Add(new CallFact(cname, "local", localTarget, true, null, null, line, col));
                        }
                        else
                        {
                            var tgt = $"{ms.ContainingType?.Name ?? ""}.{ms.Name}".TrimStart('.');
                            bucket.Calls.Add(new CallFact(cname, "external", tgt, true, null, null, line, col));
                        }
                    }
                    else
                    {
                        bucket.Calls.Add(new CallFact(cname, "dynamic", null, false, null, null, line, col));
                    }
                }
                else if (callee is MemberAccessExpressionSyntax ma)
                {
                    var ms = Sym(ma) as IMethodSymbol;
                    var (rootExpr, _) = UnwrapChain(ma.Expression);
                    var (recvSc, recvRoot) = ExprScope(rootExpr, cur);
                    if (ms != null)
                    {
                        var orig = ms.OriginalDefinition;
                        if (localMethodMap.TryGetValue(orig, out var localTarget) || localMethodMap.TryGetValue(ms, out localTarget))
                        {
                            bucket.Calls.Add(new CallFact(callee.ToString(), "local", localTarget, true, recvSc, recvRoot, line, col));
                        }
                        else
                        {
                            var tgt = $"{ms.ContainingType?.Name ?? ma.Expression.ToString()}.{ms.Name}";
                            bucket.Calls.Add(new CallFact(callee.ToString(), "external", tgt, true, recvSc, recvRoot, line, col));
                        }
                    }
                    else
                    {
                        bucket.Calls.Add(new CallFact(callee.ToString(), "opaque", null, false, recvSc, recvRoot, line, col));
                    }
                    VisitReceiverSubexprs(ma.Expression);
                }
                else
                {
                    bucket.Calls.Add(new CallFact(callee.ToString(), "dynamic", null, false, null, null, line, col));
                    Visit(callee);
                }
                foreach (var a in inv.ArgumentList.Arguments)
                {
                    if (a.RefOrOutKeyword.Kind() is SyntaxKind.RefKeyword or SyntaxKind.OutKeyword && Sym(a.Expression) is not IDiscardSymbol)
                    {
                        var (argLine, argCol) = LocOf(a);
                        var (rExpr, wPath) = UnwrapChain(a.Expression);
                        var tag = a.RefOrOutKeyword.IsKind(SyntaxKind.OutKeyword) ? "(out)" : "(ref)";
                        wPath.Add(tag);
                        var (rSc, rName) = ExprScope(rExpr, cur);
                        bucket.Writes.Add(new WriteFact(a.Expression.ToString(), rName ?? a.Expression.ToString(), rSc, wPath, argLine, argCol));
                    }
                    Visit(a.Expression);
                }
                return;
            }

            case BaseObjectCreationExpressionSyntax oc:
            {
                var (line, col) = LocOf(oc);
                var ctor = Sym(oc) as IMethodSymbol;
                if (ctor != null)
                {
                    var orig = ctor.OriginalDefinition;
                    if (localMethodMap.TryGetValue(orig, out var localTarget) || localMethodMap.TryGetValue(ctor, out localTarget))
                    {
                        bucket.Calls.Add(new CallFact(oc.ToString(), "local", localTarget, true, null, null, line, col));
                    }
                    else if (sameSym.Equals(ctor.ContainingAssembly, comp.Assembly))
                    {
                        bucket.Calls.Add(new CallFact($"{ctor.ContainingType?.Name ?? "new"}.constructor", "local", $"{ctor.ContainingType?.Name}.constructor", true, null, null, line, col));
                    }
                    else
                    {
                        bucket.Calls.Add(new CallFact($"{ctor.ContainingType?.Name ?? "new"}.constructor", "external", $"{ctor.ContainingType?.Name}.constructor", true, null, null, line, col));
                    }
                }
                else
                {
                    bucket.Calls.Add(new CallFact(oc is ObjectCreationExpressionSyntax o ? $"new {o.Type}" : "new()", "opaque", null, false, null, null, line, col));
                }
                if (oc.ArgumentList != null)
                {
                    foreach (var a in oc.ArgumentList.Arguments) Visit(a.Expression);
                }
                if (oc.Initializer != null) Visit(oc.Initializer);
                return;
            }

            case ThrowStatementSyntax or ThrowExpressionSyntax:
            {
                var (line, col) = LocOf(node);
                bucket.Throws.Add(new LocFact(line, col));
                break;
            }
            case CatchClauseSyntax:
            {
                var (line, col) = LocOf(node);
                bucket.Catches.Add(new LocFact(line, col));
                break;
            }
            case WhileStatementSyntax:
            {
                var (line, col) = LocOf(node);
                bucket.Loops.Add(new KindLocFact("while", line, col));
                break;
            }
            case DoStatementSyntax:
            {
                var (line, col) = LocOf(node);
                bucket.Loops.Add(new KindLocFact("do", line, col));
                break;
            }
            case ForStatementSyntax fs when fs.Condition == null:
            {
                var (line, col) = LocOf(node);
                bucket.Loops.Add(new KindLocFact("for(;;)", line, col));
                break;
            }
            case AwaitExpressionSyntax:
            {
                var (line, col) = LocOf(node);
                bucket.Suspends.Add(new KindLocFact("await", line, col));
                break;
            }
            case YieldStatementSyntax:
            {
                var (line, col) = LocOf(node);
                bucket.Suspends.Add(new KindLocFact("yield", line, col));
                break;
            }
            case ElementAccessExpressionSyntax ea:
            {
                var (rootExpr, _) = UnwrapChain(ea.Expression);
                var (sc, _) = ExprScope(rootExpr, cur);
                var (line, col) = LocOf(ea);
                bucket.Subscripts.Add(new SubscriptFact(ea.Expression.ToString(), sc, ea.ArgumentList.Arguments.ToString(), line, col));
                break;
            }
            case MemberAccessExpressionSyntax ma when ma.Expression is ThisExpressionSyntax or BaseExpressionSyntax:
            {
                var sym = Sym(ma.Name);
                if (sym is IFieldSymbol or IPropertySymbol)
                {
                    var (line, col) = LocOf(ma);
                    var prefix = ma.Expression is ThisExpressionSyntax ? "this" : "base";
                    bucket.Reads.Add(new ReadFact($"{prefix}.{ma.Name.Identifier.Text}", "member", DeclOf(sym), line, col));
                }
                return;
            }
            case MemberAccessExpressionSyntax ma when ma.Expression is PredefinedTypeSyntax || Sym(ma.Expression) is INamedTypeSymbol:
            {
                var sym = Sym(ma.Name);
                if (sym is IFieldSymbol or IPropertySymbol)
                {
                    var (line, col) = LocOf(ma);
                    bucket.Reads.Add(new ReadFact(ma.ToString(), ScopeOf(sym, cur), DeclOf(sym), line, col));
                }
                return;
            }
            case IdentifierNameSyntax readId when !IsTypeOrDeclName(readId):
            {
                if (readId.Parent is MemberAccessExpressionSyntax maParent && maParent.Name == readId) break;
                var rs = Sym(readId);
                if (rs is INamedTypeSymbol or ITypeParameterSymbol or INamespaceSymbol or IAliasSymbol) break;
                var sc = ScopeOf(rs, cur);
                if (sc is not ("local" or "param"))
                {
                    var (line, col) = LocOf(readId);
                    bucket.Reads.Add(new ReadFact(readId.Identifier.Text, sc, DeclOf(rs), line, col));
                }
                break;
            }
        }

        foreach (var c in node.ChildNodes()) Visit(c);
    }

    Visit(body);
}

static FunctionBucket NewBucket(string name, SyntaxNode node, string[] parms, FnMetrics metrics)
{
    var (line, col) = LocOf(node);
    return new FunctionBucket(name, line, col, parms, metrics);
}

var commentSpans = root.DescendantTrivia(descendIntoTrivia: true)
    .Where(t => t.Kind() is SyntaxKind.SingleLineCommentTrivia
        or SyntaxKind.MultiLineCommentTrivia
        or SyntaxKind.SingleLineDocumentationCommentTrivia
        or SyntaxKind.MultiLineDocumentationCommentTrivia)
    .Select(t =>
    {
        var (line, endLine, col) = TriviaSpanOf(t);
        var kind = t.Kind() is SyntaxKind.MultiLineCommentTrivia or SyntaxKind.MultiLineDocumentationCommentTrivia ? "block" : "line";
        return new CommentSpan(kind, line, endLine, col);
    })
    .ToList();
var commentsInfo = new CommentsInfo(commentSpans.Count, commentSpans);

var importsList = root.DescendantNodes()
    .OfType<UsingDirectiveSyntax>()
    .Select(u =>
    {
        var (line, col) = LocOf(u);
        var kind = u.StaticKeyword.IsKind(SyntaxKind.StaticKeyword) ? "using-static" : "using";
        var src = u.Name?.ToString() ?? u.Alias?.ToString() ?? "";
        return new ImportFact(src, kind, line, col);
    })
    .ToList();

var declarationsList = new List<DeclarationFact>();
foreach (var td in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
{
    var kind = td switch
    {
        RecordDeclarationSyntax r => r.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) ? "struct" : "record",
        StructDeclarationSyntax => "struct",
        InterfaceDeclarationSyntax => "interface",
        EnumDeclarationSyntax => "enum",
        _ => "class",
    };
    var bases = td.BaseList?.Types.Select(t => t.Type.ToString()).ToList() ?? new List<string>();
    var mods = td.Modifiers.Select(m => m.Text).ToList();
    if (td is RecordDeclarationSyntax rd && rd.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) && !mods.Contains("record"))
    {
        mods.Add("record");
    }
    var prefix = EnclosingTypePrefix(td);
    var fullName = string.IsNullOrEmpty(prefix) ? td.Identifier.Text : $"{prefix}.{td.Identifier.Text}";
    var (line, col) = LocOf(td);
    declarationsList.Add(new DeclarationFact(kind, fullName, bases, mods, line, col));
}

foreach (var member in root.DescendantNodes().OfType<MemberDeclarationSyntax>())
{
    var mods = member.Modifiers.Select(m => m.Text).ToList();
    var prefix = EnclosingTypePrefix(member);
    if (member is FieldDeclarationSyntax f)
    {
        if (mods.Contains("static"))
        {
            var mutMod = mods.Contains("readonly") || mods.Contains("const") ? "readonly" : "mutable";
            var (line, col) = LocOf(f);
            foreach (var v in f.Declaration.Variables)
            {
                var fname = string.IsNullOrEmpty(prefix) ? v.Identifier.Text : $"{prefix}.{v.Identifier.Text}";
                declarationsList.Add(new DeclarationFact("field", fname, new List<string>(), new List<string> { "static", mutMod }, line, col));
            }
        }
        else if (mods.Contains("const"))
        {
            var (line, col) = LocOf(f);
            foreach (var v in f.Declaration.Variables)
            {
                var fname = string.IsNullOrEmpty(prefix) ? v.Identifier.Text : $"{prefix}.{v.Identifier.Text}";
                declarationsList.Add(new DeclarationFact("field", fname, new List<string>(), new List<string> { "const" }, line, col));
            }
        }
        continue;
    }
    var polyMods = mods.Where(m => m is "virtual" or "abstract" or "override").ToList();
    if (member is PropertyDeclarationSyntax prop)
    {
        if (mods.Contains("static") && prop.AccessorList != null &&
            prop.AccessorList.Accessors.Any(a => a.Keyword.IsKind(SyntaxKind.SetKeyword)))
        {
            var (line, col) = LocOf(prop);
            var pname = string.IsNullOrEmpty(prefix) ? prop.Identifier.Text : $"{prefix}.{prop.Identifier.Text}";
            declarationsList.Add(new DeclarationFact("property", pname, new List<string>(), new List<string> { "static", "mutable" }, line, col));
        }
        if (polyMods.Count > 0)
        {
            var (line, col) = LocOf(prop);
            var pname = string.IsNullOrEmpty(prefix) ? prop.Identifier.Text : $"{prefix}.{prop.Identifier.Text}";
            declarationsList.Add(new DeclarationFact("property", pname, new List<string>(), polyMods, line, col));
        }
    }
    else if (polyMods.Count > 0 && member is MethodDeclarationSyntax m)
    {
        var (line, col) = LocOf(m);
        var mname = string.IsNullOrEmpty(prefix) ? m.Identifier.Text : $"{prefix}.{m.Identifier.Text}";
        declarationsList.Add(new DeclarationFact("method", mname, new List<string>(), polyMods, line, col));
    }
    else if (polyMods.Count > 0 && member is IndexerDeclarationSyntax idx)
    {
        var (line, col) = LocOf(idx);
        var iname = string.IsNullOrEmpty(prefix) ? "indexer" : $"{prefix}.indexer";
        declarationsList.Add(new DeclarationFact("indexer", iname, new List<string>(), polyMods, line, col));
    }
}

var hazardsList = new List<HazardFact>();
var reflectionCallNames = new HashSet<string>(StringComparer.Ordinal)
{
    "GetType", "GetMethod", "GetMethods", "GetProperty", "GetProperties",
    "GetField", "GetFields", "GetConstructor", "GetConstructors", "InvokeMember",
    "CreateInstance", "Load", "LoadFrom", "LoadFile",
};
var blackboardTypeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
{
    "Hashtable", "ExpandoObject", "DynamicObject", "Blackboard",
    "GameplayTag", "GameplayTagContainer", "AbilitySystemComponent", "AttributeSet",
};
foreach (var node in root.DescendantNodes())
{
    if (node is UnsafeStatementSyntax or FixedStatementSyntax or StackAllocArrayCreationExpressionSyntax or ImplicitStackAllocArrayCreationExpressionSyntax or PointerTypeSyntax)
    {
        var (line, col) = LocOf(node);
        hazardsList.Add(new HazardFact("unsafe", node.Kind().ToString(), line, col));
    }
    else if (node is MemberDeclarationSyntax md && md.Modifiers.Any(m => m.IsKind(SyntaxKind.UnsafeKeyword)))
    {
        var (line, col) = LocOf(md);
        hazardsList.Add(new HazardFact("unsafe", "unsafe", line, col));
    }
    else if (node is IdentifierNameSyntax id && id.Identifier.Text == "dynamic" &&
             (Sym(id) is ITypeSymbol { TypeKind: TypeKind.Dynamic } ||
              (id.Parent is VariableDeclarationSyntax vd && vd.Type == id) ||
              (id.Parent is ParameterSyntax ps && ps.Type == id) ||
              (id.Parent is MethodDeclarationSyntax mtd && mtd.ReturnType == id) ||
              (id.Parent is PropertyDeclarationSyntax prd && prd.Type == id) ||
              id.Parent is TypeArgumentListSyntax or CastExpressionSyntax))
    {
        var (line, col) = LocOf(id);
        hazardsList.Add(new HazardFact("dynamic", "dynamic", line, col));
    }
    else if (node is GenericNameSyntax gn)
    {
        var gname = gn.Identifier.Text;
        if (gname is "Dictionary" or "ConcurrentDictionary" && gn.TypeArgumentList.Arguments.Count == 2)
        {
            var vType = gn.TypeArgumentList.Arguments[1].ToString();
            if (vType is "object" or "object?" or "dynamic" or "System.Object")
            {
                var (line, col) = LocOf(gn);
                hazardsList.Add(new HazardFact("blackboard", gn.ToString(), line, col));
            }
        }
        else if (blackboardTypeNames.Contains(gname))
        {
            var (line, col) = LocOf(gn);
            hazardsList.Add(new HazardFact("blackboard", gn.ToString(), line, col));
        }
    }
    else if (node is IdentifierNameSyntax bId && blackboardTypeNames.Contains(bId.Identifier.Text) && bId.Parent is ObjectCreationExpressionSyntax or VariableDeclarationSyntax or ParameterSyntax or FieldDeclarationSyntax or PropertyDeclarationSyntax)
    {
        var (line, col) = LocOf(bId);
        hazardsList.Add(new HazardFact("blackboard", bId.Identifier.Text, line, col));
    }
    else if (node is InvocationExpressionSyntax inv)
    {
        var sym = Sym(inv.Expression) as IMethodSymbol;
        var ns = sym?.ContainingNamespace?.ToDisplayString() ?? "";
        var typeName = sym?.ContainingType?.Name ?? (inv.Expression is MemberAccessExpressionSyntax maType ? maType.Expression.ToString() : "");
        var mName = sym?.Name ?? (inv.Expression is MemberAccessExpressionSyntax ma ? ma.Name.Identifier.Text : inv.Expression.ToString());
        if (ns.StartsWith("System.Reflection", StringComparison.Ordinal) ||
            mName is "GetType" or "GetMethod" or "GetMethods" or "GetProperty" or "GetProperties"
                or "GetField" or "GetFields" or "GetConstructor" or "GetConstructors"
                or "InvokeMember" or "CreateInstance" ||
            (typeName is "Assembly" && mName is "Load" or "LoadFrom" or "LoadFile"))
        {
            var (line, col) = LocOf(inv);
            hazardsList.Add(new HazardFact("reflection", inv.Expression.ToString(), line, col));
        }
        else if (ns.StartsWith("System.Runtime.InteropServices", StringComparison.Ordinal) && typeName is "Marshal" or "GCHandle")
        {
            var (line, col) = LocOf(inv);
            hazardsList.Add(new HazardFact("unsafe", inv.Expression.ToString(), line, col));
        }
    }
    else if (node is UsingDirectiveSyntax u && (u.Name?.ToString().StartsWith("System.Reflection", StringComparison.Ordinal) == true))
    {
        var (line, col) = LocOf(u);
        hazardsList.Add(new HazardFact("reflection", u.Name.ToString(), line, col));
    }
}

var syntaxKindsList = new List<SyntaxKindFact>();
foreach (var sn in root.DescendantNodesAndSelf())
{
    var (sl, sc) = LocOf(sn);
    syntaxKindsList.Add(new SyntaxKindFact(sn.Kind().ToString(), sl, sc));
}
foreach (var tok in root.DescendantTokens())
{
    if (tok.IsKeyword() && tok.Kind() is SyntaxKind.UnsafeKeyword or SyntaxKind.AsyncKeyword
        or SyntaxKind.VirtualKeyword or SyntaxKind.AbstractKeyword or SyntaxKind.OverrideKeyword
        or SyntaxKind.VolatileKeyword or SyntaxKind.ExternKeyword or SyntaxKind.FixedKeyword
        or SyntaxKind.StackAllocKeyword or SyntaxKind.DelegateKeyword or SyntaxKind.EventKeyword
        or SyntaxKind.ParamsKeyword)
    {
        var tp = tok.GetLocation().GetLineSpan().StartLinePosition;
        syntaxKindsList.Add(new SyntaxKindFact(tok.Kind().ToString(), tp.Line + 1, tp.Character + 1));
    }
}

var globals = root.ChildNodes().OfType<GlobalStatementSyntax>().ToList();
if (globals.Count > 0)
{
    var modLines = globals.Sum(g => { var (s, e, _) = SpanOf(g); return e - s + 1; });
    var modBranches = 0;
    var modNesting = 0;
    foreach (var g in globals)
    {
        var gm = ComputeBodyMetrics(g, 0);
        modBranches += gm.Branches;
        if (gm.MaxNesting > modNesting) modNesting = gm.MaxNesting;
    }
    var modBucket = new FunctionBucket("<module>", 1, 1, Array.Empty<string>(), new FnMetrics(modLines, modBranches, modNesting));
    fnBuckets.Add(modBucket);
    var modSym = model.GetEnclosingSymbol(globals[0].SpanStart) as IMethodSymbol;
    foreach (var g in globals) WalkInto(g, "<module>", modSym, modBucket);
    if (!modBucket.HasFacts()) fnBuckets.Remove(modBucket);
}

foreach (var d in topDecls)
{
    var name = topNames[d];
    var sym = model.GetDeclaredSymbol(d) as IMethodSymbol;
    var (dStart, dEnd, _) = SpanOf(d);
    var body = d switch
    {
        BaseMethodDeclarationSyntax bm => (SyntaxNode?)bm.Body ?? bm.ExpressionBody,
        AccessorDeclarationSyntax acc => (SyntaxNode?)acc.Body ?? acc.ExpressionBody,
        _ => null,
    };
    var metrics = ComputeBodyMetrics(body, dEnd - dStart + 1);
    var bucket = NewBucket(name, d, ParamNames(d), metrics);
    fnBuckets.Add(bucket);
    if (body != null) WalkInto(body, name, sym, bucket);
}

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};
Console.WriteLine(JsonSerializer.Serialize(new RayOutput(fileStr, "csharp", fnBuckets, declarationsList, commentsInfo, importsList, hazardsList, syntaxKindsList), jsonOptions));

sealed record RayOutput(
    string File,
    string Language,
    List<FunctionBucket> Functions,
    List<DeclarationFact> Declarations,
    CommentsInfo Comments,
    List<ImportFact> Imports,
    List<HazardFact> Hazards,
    List<SyntaxKindFact> SyntaxKinds);
sealed record FnMetrics(int Lines, int Branches, int MaxNesting);
sealed record DeclarationFact(string Kind, string Name, List<string> Bases, List<string> Modifiers, int Line, int Col);
sealed record CommentSpan(string Kind, int Line, int EndLine, int Col);
sealed record CommentsInfo(int Count, List<CommentSpan> Spans);
sealed record ImportFact(string Source, string Kind, int Line, int Col);
sealed record HazardFact(string Kind, string Detail, int Line, int Col);
sealed record SyntaxKindFact(string Kind, int Line, int Col);
sealed record FunctionBucket(string Name, int Line, int Col, string[] Params, FnMetrics Metrics)
{
    public List<ReadFact> Reads { get; } = new();
    public List<WriteFact> Writes { get; } = new();
    public List<CallFact> Calls { get; } = new();
    public List<SubscriptFact> Subscripts { get; } = new();
    public List<LocFact> Throws { get; } = new();
    public List<LocFact> Catches { get; } = new();
    public List<KindLocFact> Loops { get; } = new();
    public List<KindLocFact> Suspends { get; } = new();
    public bool HasFacts() =>
        Reads.Count > 0 || Writes.Count > 0 || Calls.Count > 0 || Subscripts.Count > 0 ||
        Throws.Count > 0 || Catches.Count > 0 || Loops.Count > 0 || Suspends.Count > 0;
}
sealed record ReadFact(string Name, string Scope, string Decl, int Line, int Col);
sealed record WriteFact(string Target, string Root, string Scope, List<string> Path, int Line, int Col);
sealed record CallFact(string Expr, string Kind, string? Target, bool Resolved, string? ReceiverScope, string? ReceiverRoot, int Line, int Col);
sealed record SubscriptFact(string Root, string Scope, string Index, int Line, int Col);
sealed record LocFact(int Line, int Col);
sealed record KindLocFact(string Kind, int Line, int Col);
