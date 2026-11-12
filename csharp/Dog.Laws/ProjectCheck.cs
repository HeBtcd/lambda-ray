using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Dog.Laws
{
    internal sealed class ProjectCheck
    {
        private const string ClockFix = "draw from the tick or time the state carries; if motion must be smoother than a tick, let Step keep that value in the state, and leave interpolation to a leaf that never feeds back";
        private const string RandomFix = "derive any noise from the state (a seed Step advances, or a hash of the tick and an id), so the same state always draws the same frame";
        private const string HiddenFix = "read the value from the state argument, or keep it in a readonly field set once; memory a renderer needs over time belongs in a layer driven through Run.View";

        private const string ReadBackFix = "compute the output from the state alone and only write it to the engine; an engine value read back carries whatever the engine did since, so it is a hidden input";

        private readonly Laws laws;
        private readonly INamedTypeSymbol shell;
        private readonly INamedTypeSymbol contract;
        private readonly Action<Diagnostic> report;
        private readonly HashSet<IMethodSymbol> visited = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        private readonly HashSet<string> said = new HashSet<string>();

        public ProjectCheck(Laws laws, INamedTypeSymbol shell, INamedTypeSymbol contract, Action<Diagnostic> report)
        {
            this.laws = laws;
            this.shell = shell;
            this.contract = contract;
            this.report = report;
        }

        public void Run(IMethodSymbol project) => Visit(project, $"via Project of {shell.Name}");

        private void Visit(IMethodSymbol method, string via)
        {
            method = method.OriginalDefinition;
            if (Laws.InContract(method.ContainingType) || !visited.Add(method)) return;
            foreach (var reference in method.DeclaringSyntaxReferences)
            {
                var node = reference.GetSyntax();
                if (!HasBody(node)) continue;
                var body = laws.Model(node.SyntaxTree).GetOperation(node);
                if (body == null) continue;
                foreach (var operation in body.DescendantsAndSelf()) Inspect(operation, via);
            }
        }

        private static bool HasBody(SyntaxNode node) => node switch
        {
            BaseMethodDeclarationSyntax m => m.Body != null || m.ExpressionBody != null,
            AccessorDeclarationSyntax a => a.Body != null || a.ExpressionBody != null,
            ArrowExpressionClauseSyntax _ => true,
            _ => false
        };

        private void Say(IOperation at, string what, string via, string fix)
        {
            var text = $"{what}, {via}, but Project must be a function of the state it is given. Fix: {fix}.";
            if (said.Add(text + at.Syntax.SpanStart + at.Syntax.SyntaxTree.FilePath))
                report(Diagnostic.Create(SimLawsAnalyzer.ProjectIsAFunctionOfState, at.Syntax.GetLocation(), text));
        }

        private void Inspect(IOperation operation, string via)
        {
            switch (operation)
            {
                case IInvocationOperation call:
                    Member(call, call.TargetMethod, "calls", via);
                    var m = call.TargetMethod;
                    if (!m.IsStatic && call.Instance != null && IsEngine(m.ContainingType) && !m.ReturnsVoid && !HoldsEngineObject(m.ReturnType))
                        Say(call, $"reads back engine state through {m.ContainingType.Name}.{m.Name}", via, ReadBackFix);
                    Follow(m, via);
                    break;
                case IPropertyReferenceOperation property:
                    Member(property, property.Property, "reads", via);
                    var p = property.Property;
                    if (p.IsStatic && p.SetMethod != null && p.ContainingType.Locations.Any(l => l.IsInSource) && !Laws.InContract(p.ContainingType))
                        Say(property, $"touches the static property {p.Name}", via, HiddenFix);
                    else if (!p.IsStatic && Own(p.ContainingType) && p.SetMethod != null && !p.SetMethod.IsInitOnly && !HoldsEngineObject(p.Type))
                        Say(property, $"touches the property {p.Name} of the shell itself", via, HiddenFix);
                    else if (!p.IsStatic && IsEngine(p.ContainingType) && !HoldsEngineObject(p.Type) && !IsWrittenOnly(property))
                        Say(property, $"reads back engine state {p.ContainingType.Name}.{p.Name}", via, ReadBackFix);
                    if (p.GetMethod != null) Follow(p.GetMethod, via);
                    if (p.SetMethod != null) Follow(p.SetMethod, via);
                    break;
                case IFieldReferenceOperation field:
                    Member(field, field.Field, "reads", via);
                    var f = field.Field;
                    if (!f.IsStatic && !f.IsConst && IsEngine(f.ContainingType) && !HoldsEngineObject(f.Type) && !IsWrittenOnly(field))
                        Say(field, $"reads back engine state {f.ContainingType.Name}.{f.Name}", via, ReadBackFix);
                    if (f.IsConst || f.IsReadOnly || !f.IsStatic && HoldsEngineObject(f.Type)) break;
                    if (f.IsStatic) Say(field, $"touches the static field {f.Name}", via, HiddenFix);
                    else if (Own(f.ContainingType)) Say(field, $"touches the field {f.Name} of the shell itself", via, HiddenFix);
                    break;
                case IObjectCreationOperation creation when creation.Type != null:
                    if (creation.Type.ToDisplayString() == "System.Random") Say(creation, "creates System.Random", via, RandomFix);
                    if (creation.Constructor != null) Follow(creation.Constructor, via);
                    break;
            }
        }

        private bool HoldsEngineObject(ITypeSymbol type)
        {
            if (type is IArrayTypeSymbol array) return laws.IsEngineObject(array.ElementType);
            if (type is INamedTypeSymbol named && named.IsGenericType && named.TypeArguments.Length == 1 && laws.IsEngineObject(named.TypeArguments[0])) return true;
            return laws.IsEngineObject(type);
        }

        private bool IsEngine(INamedTypeSymbol type)
        {
            var space = type.ContainingNamespace?.ToDisplayString() ?? "";
            return laws.IsEngineObject(type) && (space == "UnityEngine" || space.StartsWith("UnityEngine.") || space == "UnityEditor" || space.StartsWith("UnityEditor."));
        }

        private static bool IsWrittenOnly(IOperation operation) =>
            operation.Parent is ISimpleAssignmentOperation assignment && assignment.Target == operation;

        private bool Own(INamedTypeSymbol type)
        {
            for (var t = shell; t != null; t = t.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, type.OriginalDefinition)) return t.Locations.Any(l => l.IsInSource) && !Laws.InContract(t) && !IsEngine(t);
            }
            return false;
        }

        private void Member(IOperation at, ISymbol member, string verb, string via)
        {
            var type = member.ContainingType;
            if (type == null) return;
            var space = type.ContainingNamespace?.ToDisplayString() ?? "";
            var name = $"{type.ToDisplayString()}.{member.Name}";
            if (!member.IsStatic && SymbolEqualityComparer.Default.Equals(type.OriginalDefinition, contract))
            {
                Say(at, $"{verb} {member.Name} of the shell itself", via, HiddenFix);
            }
            else if (space == "UnityEngine" && type.Name == "Time"
                || (type.SpecialType == SpecialType.System_DateTime || name.StartsWith("System.DateTimeOffset.")) && (member.Name == "Now" || member.Name == "UtcNow" || member.Name == "Today")
                || name.StartsWith("System.Diagnostics.Stopwatch.") || name.StartsWith("System.Environment.Tick"))
            {
                Say(at, $"{verb} {name}", via, ClockFix);
            }
            else if (space == "UnityEngine" && type.Name == "Random" || name == "System.Guid.NewGuid" || name.StartsWith("System.Random."))
            {
                Say(at, $"{verb} {name}", via, RandomFix);
            }
        }

        private void Follow(IMethodSymbol method, string via)
        {
            if (method.MethodKind == MethodKind.LocalFunction || method.MethodKind == MethodKind.AnonymousFunction) return;
            if (method.IsAbstract || method.IsVirtual || method.IsOverride || method.ContainingType.TypeKind == TypeKind.Interface)
            {
                foreach (var impl in laws.Implementations(method.OriginalDefinition)) Visit(impl, $"{via} -> {Label(impl)}");
            }
            if (method.DeclaringSyntaxReferences.Length > 0) Visit(method, $"{via} -> {Label(method)}");
        }

        private static string Label(IMethodSymbol method) => method.MethodKind switch
        {
            MethodKind.Constructor => "new " + method.ContainingType.Name,
            MethodKind.PropertyGet => method.AssociatedSymbol?.Name ?? method.Name,
            MethodKind.PropertySet => method.AssociatedSymbol?.Name ?? method.Name,
            _ => method.Name
        };
    }
}
