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
        public readonly Profile Profile;
        private readonly ImmutableArray<INamedTypeSymbol> contracts;
        private readonly ImmutableArray<Profile.RootInterface> rootInterfaces;
        private readonly INamedTypeSymbol? shell;
        private readonly INamedTypeSymbol? shellBase;
        private readonly ImmutableArray<INamedTypeSymbol> engineObjects;
        private readonly Lazy<ImmutableArray<INamedTypeSymbol>> types;
        private readonly Lazy<ImmutableHashSet<ITypeSymbol>> states;
        private readonly ConcurrentDictionary<SyntaxTree, SemanticModel> models = new ConcurrentDictionary<SyntaxTree, SemanticModel>();
        private readonly ConcurrentDictionary<IMethodSymbol, ImmutableArray<IMethodSymbol>> implementations = new ConcurrentDictionary<IMethodSymbol, ImmutableArray<IMethodSymbol>>(SymbolEqualityComparer.Default);
        private readonly Lazy<ImmutableHashSet<INamedTypeSymbol>> attributeTypes;

        private Laws(Compilation compilation, Profile profile, ImmutableArray<INamedTypeSymbol> contracts, ImmutableArray<Profile.RootInterface> rootInterfaces)
        {
            Compilation = compilation;
            Profile = profile;
            this.contracts = contracts;
            this.rootInterfaces = rootInterfaces;
            shell = profile.ShellMarker == null ? null : compilation.GetTypeByMetadataName(profile.ShellMarker);
            shellBase = profile.ShellBase == null ? null : compilation.GetTypeByMetadataName(profile.ShellBase);
            engineObjects = profile.EngineObjects.Select(e => compilation.GetTypeByMetadataName(e)).Where(e => e != null).Cast<INamedTypeSymbol>().ToImmutableArray();
            types = new Lazy<ImmutableArray<INamedTypeSymbol>>(() => SourceTypes(compilation.Assembly.GlobalNamespace).ToImmutableArray());
            states = new Lazy<ImmutableHashSet<ITypeSymbol>>(() => types.Value.SelectMany(ContractsOf).Select(c => c.TypeArguments[rootInterfaces.First(r => Same.Equals(c.OriginalDefinition, r.TypeSymbol!)).StateArgument]).ToImmutableHashSet<ITypeSymbol>(SymbolEqualityComparer.Default));
            attributeTypes = new Lazy<ImmutableHashSet<INamedTypeSymbol>>(() =>
                profile.Attributes.SelectMany(FindAttribute).ToImmutableHashSet<INamedTypeSymbol>(Same));
        }

        private IEnumerable<INamedTypeSymbol> FindAttribute(string name)
        {
            var byMetadata = Compilation.GetTypeByMetadataName(name);
            if (byMetadata != null) yield return byMetadata;
            var simple = name.Split('.').Last();
            if (simple.EndsWith("Attribute")) simple = simple.Substring(0, simple.Length - "Attribute".Length);
            foreach (var type in types.Value)
            {
                if (type.Name == simple || type.Name == simple + "Attribute") yield return type;
            }
        }

        private readonly Dictionary<INamedTypeSymbol, Profile.RootInterface> interfaceMap = new Dictionary<INamedTypeSymbol, Profile.RootInterface>(SymbolEqualityComparer.Default);

        public static Laws? For(Compilation compilation, Profile profile)
        {
            var contracts = ImmutableArray.CreateBuilder<INamedTypeSymbol>();
            var roots = ImmutableArray.CreateBuilder<Profile.RootInterface>();
            var laws = new Laws(compilation, profile, ImmutableArray<INamedTypeSymbol>.Empty, ImmutableArray<Profile.RootInterface>.Empty);
            foreach (var root in profile.Interfaces)
            {
                var type = compilation.GetTypeByMetadataName(root.Type);
                if (type == null) continue;
                root.TypeSymbol = type;
                contracts.Add(type);
                roots.Add(root);
            }
            if (roots.Count == 0 && profile.Attributes.Length == 0) return null;
            return new Laws(compilation, profile, contracts.ToImmutable(), roots.ToImmutable());
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

        public IEnumerable<(INamedTypeSymbol Contract, Profile.RootInterface Root)> Contracts(INamedTypeSymbol type) =>
            type.AllInterfaces
                .Where(i => rootInterfaces.Any(r => Same.Equals(i.OriginalDefinition, r.TypeSymbol)))
                .Select(i => (i, rootInterfaces.First(r => Same.Equals(i.OriginalDefinition, r.TypeSymbol))));

        private IEnumerable<INamedTypeSymbol> ContractsOf(INamedTypeSymbol type) =>
            type.AllInterfaces.Where(i => rootInterfaces.Any(r => Same.Equals(i.OriginalDefinition, r.TypeSymbol)));

        public bool IsSimOrLayer(INamedTypeSymbol type) => Contracts(type).Any();

        public static bool InContract(ISymbol symbol) => symbol.ContainingNamespace?.ToDisplayString() == "Dog.Sim";

        public bool IsEngineObject(ITypeSymbol type)
        {
            if (engineObjects.Length == 0) return false;
            for (var t = type; t != null; t = t.BaseType)
            {
                if (engineObjects.Any(e => Same.Equals(t, e))) return true;
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
            if (contracts.Any(c => Same.Equals(owner.OriginalDefinition, c))) return true;
            foreach (var (contract, _) in Contracts(owner))
            {
                foreach (var step in contract.GetMembers("Step"))
                {
                    if (owner.FindImplementationForInterfaceMember(step) is IMethodSymbol impl && Same.Equals(impl.OriginalDefinition, method.OriginalDefinition)) return true;
                }
            }
            return false;
        }

        private bool MarkedPure(ISymbol symbol) =>
            attributeTypes.Value.Count > 0 &&
            symbol.GetAttributes().Any(a => a.AttributeClass != null && attributeTypes.Value.Contains(a.AttributeClass));

        public void CheckType(SymbolAnalysisContext context)
        {
            var type = (INamedTypeSymbol)context.Symbol;
            if (InContract(type)) return;
            CheckLog(context, type);
            CheckProject(context, type);
            if (type.IsAbstract || type.TypeKind == TypeKind.Interface) return;
            foreach (var (contract, root) in Contracts(type))
            {
                var isSim = root.Kind == "sim";
                new DataCheck(this, SimLawsAnalyzer.StateIsData, isSim ? "state" : "memory", type, context.ReportDiagnostic).Run(contract.TypeArguments[root.StateArgument]);
                new DataCheck(this, SimLawsAnalyzer.CommandsAreData, isSim ? "command" : "input", type, context.ReportDiagnostic).Run(contract.TypeArguments[root.CommandArgument]);
                var check = new StepCheck(this, type, context.ReportDiagnostic);
                foreach (var rootMethod in root.Methods)
                {
                    foreach (var member in contract.GetMembers(rootMethod))
                    {
                        if (type.FindImplementationForInterfaceMember(member) is IMethodSymbol impl) check.Run(impl, rootMethod);
                    }
                }
            }
        }

        public void CheckMethod(SymbolAnalysisContext context)
        {
            var method = (IMethodSymbol)context.Symbol;
            if (!MarkedPure(method)) return;
            var owner = method.ContainingType;
            if (InContract(method) || (owner != null && InContract(owner))) return;
            new StepCheck(this, owner ?? method.ContainingType, context.ReportDiagnostic).Run(method, method.Name);
        }

        private void CheckProject(SymbolAnalysisContext context, INamedTypeSymbol type)
        {
            if (shellBase == null || !Inherits(type, shellBase)) return;
            var method = Profile.ProjectMethod ?? "Project";
            foreach (var project in type.GetMembers(method).OfType<IMethodSymbol>().Where(m => m.IsOverride))
                new ProjectCheck(this, type, shellBase, context.ReportDiagnostic).Run(project);
        }

        private void CheckLog(SymbolAnalysisContext context, INamedTypeSymbol type)
        {
            if (Profile.MutableSequences.Count == 0) return;
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

        private bool IsMutableSequence(ITypeSymbol type, out ITypeSymbol element)
        {
            element = type;
            if (type is IArrayTypeSymbol array) { element = array.ElementType; return true; }
            if (type is INamedTypeSymbol named && named.IsGenericType && Profile.MutableSequences.Contains(named.OriginalDefinition.ToDisplayString()))
            {
                element = named.TypeArguments[0];
                return true;
            }
            return false;
        }

        private bool IsBatch(ITypeSymbol type, out ITypeSymbol command)
        {
            command = type;
            if (type is IArrayTypeSymbol array) { command = array.ElementType; return true; }
            if (type is INamedTypeSymbol named && named.IsGenericType && Profile.Batches.Contains(named.OriginalDefinition.ToDisplayString()))
            {
                command = named.TypeArguments[0];
                return true;
            }
            return false;
        }

        public void CheckWriteBack(OperationAnalysisContext context)
        {
            if (rootInterfaces.Length == 0) return;
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
