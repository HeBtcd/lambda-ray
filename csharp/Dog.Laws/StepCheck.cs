using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Operations;

namespace Dog.Laws
{
    internal sealed class StepCheck
    {
        private const string ClockFix = "pass time in as data (a tick count in the state, or a Dt field on the command) instead of reading a clock";
        private const string RandomFix = "keep a seed in the state and advance it inside Step (for example xorshift), so the same commands always replay the same";
        private const string EngineFix = "let the [SimShell] read the engine and hand Step what it needs as commands; Step only sees its state and commands";
        private const string WorldFix = "do I/O and threading in the [SimShell]; Step only computes the next state from its arguments";
        private const string HiddenFix = "move the value into the state, or make it a readonly field set once in the constructor";
        private const string WriteFix = "build a new value instead (a new List<T> you fill, or `with` on a record) and return it in the next state";

        private static readonly ImmutableHashSet<string> Mutators = ImmutableHashSet.Create(
            "Add", "AddRange", "AddFirst", "AddLast", "AddBefore", "AddAfter", "Insert", "InsertRange", "Remove", "RemoveAt", "RemoveAll",
            "RemoveRange", "RemoveWhere", "RemoveFirst", "RemoveLast", "Clear", "Sort", "Reverse", "Enqueue", "Dequeue", "Push", "Pop",
            "TryAdd", "TryRemove", "TryDequeue", "TryPop", "TryTake", "UnionWith", "IntersectWith", "ExceptWith", "SymmetricExceptWith",
            "Set", "SetValue", "Append", "AppendLine", "Replace", "TrimExcess", "EnsureCapacity", "CopyTo", "Fill");

        private static readonly ImmutableHashSet<string> Creators = ImmutableHashSet.Create(
            "ToList", "ToArray", "ToDictionary", "ToHashSet", "ToLookup");

        private readonly Laws laws;
        private readonly INamedTypeSymbol sim;
        private readonly Action<Diagnostic> report;
        private readonly HashSet<IMethodSymbol> visited = new HashSet<IMethodSymbol>(SymbolEqualityComparer.Default);
        private readonly HashSet<string> said = new HashSet<string>();

        public StepCheck(Laws laws, INamedTypeSymbol sim, Action<Diagnostic> report)
        {
            this.laws = laws;
            this.sim = sim;
            this.report = report;
        }

        public void Run(IMethodSymbol root, string name)
        {
            visited.Clear();
            Visit(root, $"via {name} of {sim.Name}");
        }

        private void Visit(IMethodSymbol method, string via)
        {
            method = method.OriginalDefinition;
            if (Laws.InContract(method.ContainingType) || !visited.Add(method)) return;
            foreach (var reference in method.DeclaringSyntaxReferences)
            {
                var node = reference.GetSyntax();
                if (!HasBody(node)) continue;
                var model = laws.Model(node.SyntaxTree);
                var body = model.GetOperation(node);
                if (body == null) continue;
                var fresh = FreshLocals(body);
                var constructor = method.MethodKind == MethodKind.Constructor;
                foreach (var operation in body.DescendantsAndSelf()) Inspect(operation, via, fresh, constructor);
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
            var text = $"{what}, {via}, but Step must be a pure function of its arguments. Fix: {fix}.";
            if (said.Add(text + at.Syntax.SpanStart + at.Syntax.SyntaxTree.FilePath))
                report(Diagnostic.Create(SimLawsAnalyzer.StepIsPure, at.Syntax.GetLocation(), text));
        }

        private void Inspect(IOperation operation, string via, HashSet<ILocalSymbol> fresh, bool constructor)
        {
            switch (operation)
            {
                case IInvocationOperation call:
                    Member(call, call.TargetMethod, "calls", via);
                    if (call.Instance != null && call.TargetMethod.ContainingType.IsReferenceType && Mutators.Contains(call.TargetMethod.Name)
                        && !call.TargetMethod.ContainingType.Locations.Any(l => l.IsInSource) && !IsImmutable(call.TargetMethod.ContainingType)
                        && !IsFresh(call.Instance, fresh, constructor))
                    {
                        Say(call, $"calls {call.TargetMethod.Name} on {call.Instance.Syntax}, which was not created in this step", via, WriteFix);
                    }
                    Follow(call.TargetMethod, via);
                    break;
                case IPropertyReferenceOperation property:
                    Member(property, property.Property, "reads", via);
                    if (property.Property.IsStatic && property.Property.SetMethod != null && property.Property.ContainingType.Locations.Any(l => l.IsInSource))
                        Say(property, $"touches the static property {property.Property.Name}", via, HiddenFix);
                    else if (!property.Property.IsStatic && Own(property.Property.ContainingType) && property.Property.SetMethod != null && !property.Property.SetMethod.IsInitOnly)
                        Say(property, $"touches the property {property.Property.Name} of the sim itself", via, HiddenFix);
                    if (property.Property.GetMethod != null) Follow(property.Property.GetMethod, via);
                    if (property.Property.SetMethod != null && IsTarget(property)) Follow(property.Property.SetMethod, via);
                    break;
                case IFieldReferenceOperation field:
                    Member(field, field.Field, "reads", via);
                    if (field.Field.IsConst) break;
                    if (field.Field.IsStatic)
                    {
                        if (!field.Field.IsReadOnly || !IsData(field.Field.Type))
                            Say(field, $"touches the static field {field.Field.Name}", via, HiddenFix);
                    }
                    else if (Own(field.Field.ContainingType) && !field.Field.IsReadOnly && !constructor)
                    {
                        Say(field, $"touches the field {field.Field.Name} of the sim itself", via, HiddenFix);
                    }
                    break;
                case IEventReferenceOperation @event:
                    Member(@event, @event.Event, "touches", via);
                    break;
                case IObjectCreationOperation creation when creation.Type != null:
                    var made = creation.Type.ToDisplayString();
                    if (made == "System.Random") Say(creation, "creates System.Random", via, RandomFix);
                    else if (laws.IsEngineObject(creation.Type)) Say(creation, $"creates the engine object {made}", via, EngineFix);
                    else if (World(creation.Type)) Say(creation, $"creates {made}", via, WorldFix);
                    if (creation.Constructor != null) Follow(creation.Constructor, via);
                    break;
            }
            foreach (var target in Laws.Targets(operation)) Write(target, via, fresh, constructor);
        }

        private bool IsTarget(IOperation operation) =>
            operation.Parent is IAssignmentOperation assignment && assignment.Target == operation;

        private bool Own(INamedTypeSymbol type)
        {
            for (var t = sim; t != null; t = t.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, type.OriginalDefinition)) return true;
            }
            return false;
        }

        private bool IsData(ITypeSymbol type)
        {
            var check = new DataCheck(laws, SimLawsAnalyzer.StateIsData, "value", sim, _ => { });
            check.Run(type);
            return check.Found == 0;
        }

        private static bool IsImmutable(INamedTypeSymbol type) =>
            type.ContainingNamespace?.ToDisplayString() == "System.Collections.Immutable" && !type.Name.EndsWith("Builder")
            || type.SpecialType == SpecialType.System_String;

        private void Member(IOperation at, ISymbol member, string verb, string via)
        {
            var type = member.ContainingType;
            if (type == null) return;
            var space = type.ContainingNamespace?.ToDisplayString() ?? "";
            var name = $"{type.ToDisplayString()}.{member.Name}";
            if (space == "UnityEngine" && type.Name == "Time"
                || (type.SpecialType == SpecialType.System_DateTime || name.StartsWith("System.DateTimeOffset.")) && (member.Name == "Now" || member.Name == "UtcNow" || member.Name == "Today")
                || name.StartsWith("System.Diagnostics.Stopwatch.") || name.StartsWith("System.Environment.Tick"))
            {
                Say(at, $"{verb} {name}", via, ClockFix);
            }
            else if (space == "UnityEngine" && type.Name == "Random" || name == "System.Guid.NewGuid" || name.StartsWith("System.Random."))
            {
                Say(at, $"{verb} {name}", via, RandomFix);
            }
            else if (laws.IsEngineObject(type) || IsEngine(space) && !type.IsValueType && type.Name != "Mathf")
            {
                Say(at, $"{verb} {name}, which belongs to the engine", via, EngineFix);
            }
            else if (World(type))
            {
                Say(at, $"{verb} {name}, which reaches outside the sim", via, WorldFix);
            }
        }

        private static bool IsEngine(string space) =>
            space == "UnityEngine" || space.StartsWith("UnityEngine.") || space == "UnityEditor" || space.StartsWith("UnityEditor.");

        private static bool World(ITypeSymbol type)
        {
            var space = type.ContainingNamespace?.ToDisplayString() ?? "";
            var name = type.ToDisplayString();
            return space == "System.IO" || space.StartsWith("System.Net") || space == "System.Threading" || space == "System.Threading.Tasks"
                || name == "System.Console" || name == "System.Environment" || name == "System.Diagnostics.Process";
        }

        private void Follow(IMethodSymbol method, string via)
        {
            if (method.MethodKind == MethodKind.LocalFunction || method.MethodKind == MethodKind.AnonymousFunction) return;
            var next = $"{via} -> {Label(method)}";
            if (method.IsAbstract || method.IsVirtual || method.IsOverride || method.ContainingType.TypeKind == TypeKind.Interface)
            {
                foreach (var impl in laws.Implementations(method.OriginalDefinition)) Visit(impl, $"{via} -> {Label(impl)}");
            }
            if (method.DeclaringSyntaxReferences.Length > 0) Visit(method, next);
        }

        private static string Label(IMethodSymbol method) => method.MethodKind switch
        {
            MethodKind.Constructor => "new " + method.ContainingType.Name,
            MethodKind.PropertyGet => method.AssociatedSymbol?.Name ?? method.Name,
            MethodKind.PropertySet => method.AssociatedSymbol?.Name ?? method.Name,
            _ => method.Name
        };

        private void Write(IOperation target, string via, HashSet<ILocalSymbol> fresh, bool constructor)
        {
            var stripped = Laws.Strip(target);
            switch (stripped)
            {
                case IFieldReferenceOperation field when !field.Field.IsStatic:
                    if (Own(field.Field.ContainingType) && !constructor || field.Instance == null || IsFresh(field.Instance, fresh, constructor)) return;
                    break;
                case IPropertyReferenceOperation property:
                    if (property.Instance == null)
                    {
                        if (property.Property.ContainingType.Locations.Any(l => l.IsInSource)) return;
                        break;
                    }
                    if (Own(property.Property.ContainingType) && !constructor || IsFresh(property.Instance, fresh, constructor)) return;
                    break;
                case IArrayElementReferenceOperation element:
                    if (IsFresh(element.ArrayReference, fresh, constructor)) return;
                    break;
                default:
                    return;
            }
            Say(stripped!, $"writes {stripped!.Syntax}, which was not created in this step", via, WriteFix);
        }

        private static bool IsFresh(IOperation? receiver, HashSet<ILocalSymbol> fresh, bool constructor)
        {
            switch (Laws.Strip(receiver))
            {
                case ILocalReferenceOperation local:
                    return local.Local.Type.IsValueType && !local.Local.IsRef || fresh.Contains(local.Local);
                case IInstanceReferenceOperation self:
                    return self.ReferenceKind == InstanceReferenceKind.ImplicitReceiver || constructor || self.Type?.IsValueType == true;
                case IFieldReferenceOperation field:
                    return field.Type!.IsValueType && !field.Field.IsStatic && IsFresh(field.Instance, fresh, constructor);
                case IPropertyReferenceOperation property:
                    return property.Type!.IsValueType && property.Instance != null && IsFresh(property.Instance, fresh, constructor);
                case IArrayElementReferenceOperation element:
                    return element.Type?.IsValueType == true && IsFresh(element.ArrayReference, fresh, constructor);
                case IObjectCreationOperation _:
                case IArrayCreationOperation _:
                case IAnonymousObjectCreationOperation _:
                case ITypeParameterObjectCreationOperation _:
                    return true;
                default:
                    return false;
            }
        }

        private static HashSet<ILocalSymbol> FreshLocals(IOperation body)
        {
            var verdict = new Dictionary<ILocalSymbol, bool>(SymbolEqualityComparer.Default);
            void Mark(ILocalSymbol local, bool created) => verdict[local] = verdict.TryGetValue(local, out var old) ? old && created : created;
            foreach (var operation in body.DescendantsAndSelf())
            {
                switch (operation)
                {
                    case IVariableDeclaratorOperation declarator:
                        var initializer = declarator.GetVariableInitializer();
                        if (initializer != null) Mark(declarator.Symbol, Creates(initializer.Value, verdict));
                        else if (declarator.Parent?.Parent is IForEachLoopOperation || declarator.Parent is IForEachLoopOperation) Mark(declarator.Symbol, false);
                        break;
                    case IForEachLoopOperation loop:
                        foreach (var local in loop.Locals) Mark(local, false);
                        break;
                    case IDeclarationPatternOperation pattern when pattern.DeclaredSymbol is ILocalSymbol declared:
                        Mark(declared, false);
                        break;
                    case ISimpleAssignmentOperation assignment when Laws.Strip(assignment.Target) is ILocalReferenceOperation target:
                        Mark(target.Local, Creates(assignment.Value, verdict));
                        break;
                    case IDeconstructionAssignmentOperation deconstruction:
                        foreach (var target in Laws.Targets(deconstruction))
                        {
                            if (Laws.Strip(target) is ILocalReferenceOperation local) Mark(local.Local, false);
                            if (Laws.Strip(target) is IDeclarationExpressionOperation declaration)
                            {
                                foreach (var inner in declaration.Descendants().OfType<ILocalReferenceOperation>()) Mark(inner.Local, false);
                            }
                        }
                        break;
                }
            }
            return new HashSet<ILocalSymbol>(verdict.Where(v => v.Value).Select(v => v.Key), SymbolEqualityComparer.Default);
        }

        private static bool Creates(IOperation? value, Dictionary<ILocalSymbol, bool> verdict)
        {
            switch (Laws.Strip(value))
            {
                case IObjectCreationOperation _:
                case IArrayCreationOperation _:
                case IAnonymousObjectCreationOperation _:
                case ITypeParameterObjectCreationOperation _:
                case IWithOperation _:
                    return true;
                case ILiteralOperation literal:
                    return literal.ConstantValue.HasValue && literal.ConstantValue.Value == null;
                case IDefaultValueOperation _:
                    return true;
                case ILocalReferenceOperation local:
                    return verdict.TryGetValue(local.Local, out var created) && created;
                case IConditionalOperation conditional:
                    return Creates(conditional.WhenTrue, verdict) && Creates(conditional.WhenFalse, verdict);
                case ICoalesceOperation coalesce:
                    return Creates(coalesce.Value, verdict) && Creates(coalesce.WhenNull, verdict);
                case IInvocationOperation call:
                    return Creators.Contains(call.TargetMethod.Name) && call.TargetMethod.ContainingNamespace?.ToDisplayString() == "System.Linq";
                default:
                    return false;
            }
        }
    }
}
