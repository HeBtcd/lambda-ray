using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Operations;

namespace Dog.Laws
{
    internal sealed class Laws
    {
        private static readonly SymbolEqualityComparer Same = SymbolEqualityComparer.Default;

        public readonly Compilation Compilation;
        private readonly INamedTypeSymbol sim;
        private readonly INamedTypeSymbol layer;
        private readonly INamedTypeSymbol? shell;
        private readonly INamedTypeSymbol? shellBase;
        private readonly INamedTypeSymbol? engineObject;
        private readonly Lazy<ImmutableArray<INamedTypeSymbol>> types;
        private readonly Lazy<ImmutableHashSet<ITypeSymbol>> states;
        private readonly ConcurrentDictionary<SyntaxTree, SemanticModel> models = new ConcurrentDictionary<SyntaxTree, SemanticModel>();
        private readonly ConcurrentDictionary<IMethodSymbol, ImmutableArray<IMethodSymbol>> implementations = new ConcurrentDictionary<IMethodSymbol, ImmutableArray<IMethodSymbol>>(SymbolEqualityComparer.Default);

        private Laws(Compilation compilation, INamedTypeSymbol sim, INamedTypeSymbol layer)
        {
            Compilation = compilation;
            this.sim = sim;
            this.layer = layer;
            shell = compilation.GetTypeByMetadataName("Dog.Sim.SimShellAttribute");
            engineObject = compilation.GetTypeByMetadataName("UnityEngine.Object");
            shellBase = compilation.GetTypeByMetadataName("Dog.Sim.SimShell`2");
            types = new Lazy<ImmutableArray<INamedTypeSymbol>>(() => SourceTypes(compilation.Assembly.GlobalNamespace).ToImmutableArray());
            states = new Lazy<ImmutableHashSet<ITypeSymbol>>(() => types.Value.SelectMany(Contracts).Select(c => c.TypeArguments[0]).ToImmutableHashSet<ITypeSymbol>(SymbolEqualityComparer.Default));
        }

        public static Laws? For(Compilation compilation)
        {
            var sim = compilation.GetTypeByMetadataName("Dog.Sim.ISim`2");
            var layer = compilation.GetTypeByMetadataName("Dog.Sim.ILayer`3");
            return sim == null || layer == null ? null : new Laws(compilation, sim, layer);
        }

        private static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceOrTypeSymbol container)
        {
            foreach (var member in container.GetMembers())
            {
                if (member is INamespaceSymbol space)
                {
                    foreach (var type in SourceTypes(space)) yield return type;
                }
                else if (member is INamedTypeSymbol type && type.Locations.Any(l => l.IsInSource))
                {
                    yield return type;
                    foreach (var nested in SourceTypes(type)) yield return nested;
                }
            }
        }

        public ImmutableArray<INamedTypeSymbol> Types => types.Value;

        public SemanticModel Model(SyntaxTree tree) => models.GetOrAdd(tree, t => Compilation.GetSemanticModel(t));

        public IEnumerable<INamedTypeSymbol> Contracts(INamedTypeSymbol type) =>
            type.AllInterfaces.Where(i => Same.Equals(i.OriginalDefinition, sim) || Same.Equals(i.OriginalDefinition, layer));

        public bool IsSimOrLayer(INamedTypeSymbol type) => Contracts(type).Any();

        public static bool InContract(ISymbol symbol) => symbol.ContainingNamespace?.ToDisplayString() == "Dog.Sim";

        public bool IsEngineObject(ITypeSymbol type)
        {
            if (engineObject == null) return false;
            for (var t = type; t != null; t = t.BaseType)
            {
                if (Same.Equals(t, engineObject)) return true;
            }
            return false;
        }

        public bool IsShell(INamedTypeSymbol type)
        {
            if (shell == null) return false;
            for (var t = type; t != null; t = t.ContainingType)
            {
                if (t.GetAttributes().Any(a => Same.Equals(a.AttributeClass, shell))) return true;
            }
            return false;
        }

        public IEnumerable<INamedTypeSymbol> Derived(INamedTypeSymbol type) =>
            Types.Where(t => !Same.Equals(t, type) && Inherits(t, type));

        private static bool Inherits(INamedTypeSymbol type, INamedTypeSymbol root)
        {
            for (var t = type.BaseType; t != null; t = t.BaseType)
            {
                if (Same.Equals(t.OriginalDefinition, root.OriginalDefinition)) return true;
            }
            return false;
        }

        public ImmutableArray<IMethodSymbol> Implementations(IMethodSymbol method) => implementations.GetOrAdd(method, m =>
        {
            var found = new List<IMethodSymbol>();
            foreach (var type in Types)
            {
                if (m.ContainingType.TypeKind == TypeKind.Interface)
                {
                    if (!type.AllInterfaces.Contains(m.ContainingType, Same)) continue;
                    if (type.FindImplementationForInterfaceMember(m) is IMethodSymbol impl) found.Add(impl);
                }
                else
                {
                    foreach (var candidate in type.GetMembers(m.Name).OfType<IMethodSymbol>())
                    {
                        for (var o = candidate.OverriddenMethod; o != null; o = o.OverriddenMethod)
                        {
                            if (Same.Equals(o.OriginalDefinition, m.OriginalDefinition)) { found.Add(candidate); break; }
                        }
                    }
                }
            }
            return found.Distinct<IMethodSymbol>(Same).ToImmutableArray();
        });

        public bool IsStep(IMethodSymbol method)
        {
            if (method.Name != "Step") return false;
            var owner = method.ContainingType;
            if (Same.Equals(owner.OriginalDefinition, sim) || Same.Equals(owner.OriginalDefinition, layer)) return true;
            foreach (var contract in Contracts(owner))
            {
                foreach (var step in contract.GetMembers("Step"))
                {
                    if (owner.FindImplementationForInterfaceMember(step) is IMethodSymbol impl && Same.Equals(impl.OriginalDefinition, method.OriginalDefinition)) return true;
                }
            }
            return false;
        }

        public void CheckType(SymbolAnalysisContext context)
        {
            var type = (INamedTypeSymbol)context.Symbol;
            if (InContract(type)) return;
            CheckLog(context, type);
            CheckProject(context, type);
            if (type.IsAbstract || type.TypeKind == TypeKind.Interface) return;
            foreach (var contract in Contracts(type))
            {
                var isSim = Same.Equals(contract.OriginalDefinition, sim);
                new DataCheck(this, SimLawsAnalyzer.StateIsData, isSim ? "state" : "memory", type, context.ReportDiagnostic).Run(contract.TypeArguments[0]);
                new DataCheck(this, SimLawsAnalyzer.CommandsAreData, isSim ? "command" : "input", type, context.ReportDiagnostic).Run(contract.TypeArguments[1]);
                var roots = isSim ? new[] { "Step" } : new[] { "Step", "Out" };
                var check = new StepCheck(this, type, context.ReportDiagnostic);
                foreach (var root in roots)
                {
                    foreach (var member in contract.GetMembers(root))
                    {
                        if (type.FindImplementationForInterfaceMember(member) is IMethodSymbol impl) check.Run(impl, root);
                    }
                }
            }
        }

        private void CheckProject(SymbolAnalysisContext context, INamedTypeSymbol type)
        {
            if (shellBase == null || !Inherits(type, shellBase)) return;
            foreach (var project in type.GetMembers("Project").OfType<IMethodSymbol>().Where(m => m.IsOverride))
                new ProjectCheck(this, type, shellBase, context.ReportDiagnostic).Run(project);
        }

        private void CheckLog(SymbolAnalysisContext context, INamedTypeSymbol type)
        {
            foreach (var (member, memberType) in StoredMembers(type))
            {
                if (!IsMutableSequence(memberType, out var element) || !IsBatch(element, out var command)) continue;
                var where = member.Locations.FirstOrDefault(l => l.IsInSource) ?? type.Locations[0];
                context.ReportDiagnostic(Diagnostic.Create(SimLawsAnalyzer.LogIsAppendOnly, where,
                    $"{type.Name}.{member.Name} keeps a command log in {memberType.ToDisplayString()}, which can be edited or reordered after the fact. Fix: hold a Dog.Sim.Log<{command.ToDisplayString()}> and replace it each tick with log = log.Append(commands); replay or rewind with log.Prefix(tick)."));
            }
        }

        public static IEnumerable<(ISymbol member, ITypeSymbol type)> StoredMembers(INamedTypeSymbol type)
        {
            foreach (var member in type.GetMembers())
            {
                if (member is IFieldSymbol field && !field.IsConst)
                {
                    if (field.IsImplicitlyDeclared && field.AssociatedSymbol == null) continue;
                    yield return (field.AssociatedSymbol ?? field, field.Type);
                }
            }
        }

        private static readonly ImmutableHashSet<string> MutableSequences = ImmutableHashSet.Create(
            "System.Collections.Generic.List<T>", "System.Collections.Generic.Queue<T>", "System.Collections.Generic.Stack<T>",
            "System.Collections.Generic.LinkedList<T>", "System.Collections.Generic.IList<T>", "System.Collections.Generic.ICollection<T>",
            "System.Collections.ObjectModel.Collection<T>", "System.Collections.ObjectModel.ObservableCollection<T>");

        private static readonly ImmutableHashSet<string> Batches = ImmutableHashSet.Create(
            "System.Collections.Generic.IReadOnlyList<T>", "System.Collections.Generic.IReadOnlyCollection<T>", "System.Collections.Generic.IEnumerable<T>",
            "System.Collections.Generic.List<T>", "System.Collections.Generic.IList<T>", "System.Collections.Generic.ICollection<T>",
            "System.Collections.Immutable.ImmutableArray<T>", "System.Collections.Immutable.ImmutableList<T>", "System.Collections.Immutable.IImmutableList<T>");

        private static bool IsMutableSequence(ITypeSymbol type, out ITypeSymbol element)
        {
            element = type;
            if (type is IArrayTypeSymbol array) { element = array.ElementType; return true; }
            if (type is INamedTypeSymbol named && named.IsGenericType && MutableSequences.Contains(named.OriginalDefinition.ToDisplayString()))
            {
                element = named.TypeArguments[0];
                return true;
            }
            return false;
        }

        private static bool IsBatch(ITypeSymbol type, out ITypeSymbol command)
        {
            command = type;
            if (type is IArrayTypeSymbol array) { command = array.ElementType; return true; }
            if (type is INamedTypeSymbol named && named.IsGenericType && Batches.Contains(named.OriginalDefinition.ToDisplayString()))
            {
                command = named.TypeArguments[0];
                return true;
            }
            return false;
        }

        public void CheckWriteBack(OperationAnalysisContext context)
        {
            var owner = context.ContainingSymbol as INamedTypeSymbol ?? context.ContainingSymbol.ContainingType;
            if (owner == null || InContract(owner) || IsShell(owner) || IsSimOrLayer(owner)) return;
            var where = context.ContainingSymbol.Name;
            if (context.Operation is IInvocationOperation call)
            {
                if (!IsStep(call.TargetMethod)) return;
                context.ReportDiagnostic(Diagnostic.Create(SimLawsAnalyzer.ProjectNeverWritesBack, call.Syntax.GetLocation(),
                    $"{owner.Name}.{where} calls Step of {call.TargetMethod.ContainingType.Name} outside a [SimShell] type, so the project drives the sim behind the shell's back. Fix: step the sim only in the one type marked [SimShell]; other code reads the state the shell exposes and hands commands to the shell."));
                return;
            }
            foreach (var target in Targets(context.Operation))
            {
                var stripped = Strip(target);
                ITypeSymbol? written = null;
                IOperation? instance = null;
                if (stripped is IFieldReferenceOperation field) { written = field.Type; instance = field.Instance; }
                else if (stripped is IPropertyReferenceOperation property) { written = property.Type; instance = property.Instance; }
                if (written == null || Strip(instance) is IInstanceReferenceOperation) continue;
                var intoState = instance?.Type != null && states.Value.Contains(instance.Type);
                if (!states.Value.Contains(written) && !intoState) continue;
                context.ReportDiagnostic(Diagnostic.Create(SimLawsAnalyzer.ProjectNeverWritesBack, stripped!.Syntax.GetLocation(),
                    $"{owner.Name}.{where} writes sim state {stripped!.Syntax} outside a [SimShell] type. Fix: only the [SimShell] type replaces the state, with the result of Step; everything else sends commands."));
            }
        }

        public static IEnumerable<IOperation> Targets(IOperation operation)
        {
            switch (operation)
            {
                case IDeconstructionAssignmentOperation deconstruction:
                    return Flatten(deconstruction.Target);
                case IAssignmentOperation assignment:
                    return new[] { assignment.Target };
                case IIncrementOrDecrementOperation step:
                    return new[] { step.Target };
                default:
                    return Array.Empty<IOperation>();
            }
        }

        private static IEnumerable<IOperation> Flatten(IOperation target)
        {
            if (Strip(target) is ITupleOperation tuple) return tuple.Elements.SelectMany(Flatten);
            return new[] { target };
        }

        public static IOperation? Strip(IOperation? operation)
        {
            while (true)
            {
                if (operation is IConversionOperation conversion) operation = conversion.Operand;
                else if (operation is IParenthesizedOperation parenthesized) operation = parenthesized.Operand;
                else return operation;
            }
        }
    }
}
