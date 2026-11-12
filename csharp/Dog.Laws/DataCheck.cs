using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;

namespace Dog.Laws
{
    internal sealed class DataCheck
    {
        private static readonly ImmutableHashSet<string> Unordered = ImmutableHashSet.Create(
            "System.Collections.Generic.Dictionary<TKey, TValue>", "System.Collections.Generic.HashSet<T>",
            "System.Collections.Generic.IDictionary<TKey, TValue>", "System.Collections.Generic.IReadOnlyDictionary<TKey, TValue>",
            "System.Collections.Generic.ISet<T>", "System.Collections.Generic.IReadOnlySet<T>",
            "System.Collections.Concurrent.ConcurrentDictionary<TKey, TValue>", "System.Collections.Concurrent.ConcurrentBag<T>",
            "System.Collections.Immutable.ImmutableDictionary<TKey, TValue>", "System.Collections.Immutable.ImmutableHashSet<T>",
            "System.Collections.Immutable.IImmutableDictionary<TKey, TValue>", "System.Collections.Immutable.IImmutableSet<T>",
            "System.Collections.Hashtable");

        private static readonly ImmutableHashSet<string> Mutable = ImmutableHashSet.Create(
            "System.Collections.Generic.List<T>", "System.Collections.Generic.Queue<T>", "System.Collections.Generic.Stack<T>",
            "System.Collections.Generic.LinkedList<T>", "System.Collections.Generic.SortedList<TKey, TValue>",
            "System.Collections.Generic.SortedDictionary<TKey, TValue>", "System.Collections.Generic.SortedSet<T>",
            "System.Collections.Generic.IList<T>", "System.Collections.Generic.ICollection<T>",
            "System.Collections.ObjectModel.Collection<T>", "System.Collections.ObjectModel.ObservableCollection<T>",
            "System.Collections.ArrayList", "System.Collections.IList", "System.Text.StringBuilder");

        private static readonly ImmutableHashSet<string> ReadOnly = ImmutableHashSet.Create(
            "System.Collections.Generic.IReadOnlyList<T>", "System.Collections.Generic.IReadOnlyCollection<T>",
            "System.Collections.Generic.IEnumerable<T>", "System.Collections.Generic.KeyValuePair<TKey, TValue>",
            "System.Collections.Immutable.ImmutableArray<T>", "System.Collections.Immutable.ImmutableList<T>",
            "System.Collections.Immutable.IImmutableList<T>", "System.Collections.Immutable.ImmutableQueue<T>",
            "System.Collections.Immutable.ImmutableStack<T>", "System.Collections.Immutable.ImmutableSortedSet<T>",
            "System.Collections.Immutable.ImmutableSortedDictionary<TKey, TValue>", "System.Nullable<T>",
            "System.Collections.ObjectModel.ReadOnlyCollection<T>", "Dog.Sim.Log<T>");

        private readonly Laws laws;
        private readonly DiagnosticDescriptor rule;
        private readonly string role;
        private readonly INamedTypeSymbol owner;
        private readonly Action<Diagnostic> report;
        private readonly HashSet<ITypeSymbol> seen = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
        private readonly HashSet<string> said = new HashSet<string>();
        public int Found { get; private set; }

        public DataCheck(Laws laws, DiagnosticDescriptor rule, string role, INamedTypeSymbol owner, Action<Diagnostic> report)
        {
            this.laws = laws;
            this.rule = rule;
            this.role = role;
            this.owner = owner;
            this.report = report;
        }

        private string Law => rule.Id == "DOG002"
            ? $"the {role} of {owner.Name} must be plain data: one immutable record per change, interpreted by Step"
            : $"the {role} of {owner.Name} must be plain immutable data that Step copies forward";

        public void Run(ITypeSymbol type) => Check(type, $"the {role} of {owner.Name}", owner.Locations.FirstOrDefault(l => l.IsInSource) ?? Location.None);

        private void Report(string path, string problem, string fix, Location where)
        {
            var text = $"{path} {problem}, but {Law}. Fix: {fix}.";
            Found++;
            if (said.Add(text + where)) report(Diagnostic.Create(rule, where, text));
        }

        private void Check(ITypeSymbol type, string path, Location where)
        {
            if (type.TypeKind == TypeKind.Delegate)
            {
                Report(path, "is a delegate", "store the data the function would close over, or an enum naming the behaviour, and let Step decide what to do with it", where);
                return;
            }
            if (laws.IsEngineObject(type))
            {
                Report(path, $"is the engine object {type.ToDisplayString()}", "keep plain data (ids, positions, numbers) and let the [SimShell] map it to and from engine objects", where);
                return;
            }
            if (type is IArrayTypeSymbol array)
            {
                Report(path, "is an array, so whoever holds it can overwrite its elements", "use IReadOnlyList<T> (build a new List<T> inside Step) or ImmutableArray<T>", where);
                Check(array.ElementType, path + "'s element", where);
                return;
            }
            if (Plain(type)) return;
            var definition = type.OriginalDefinition.ToDisplayString();
            if (Unordered.Contains(definition))
            {
                Report(path, $"is {type.ToDisplayString()}, an unordered container whose iteration order is not part of the data", "use an IReadOnlyList of records sorted by a key, or ImmutableSortedDictionary", where);
                Arguments(type, path, where);
                return;
            }
            if (Mutable.Contains(definition))
            {
                Report(path, $"is {type.ToDisplayString()}, a mutable collection", "declare it IReadOnlyList<T> and build a fresh List<T> inside Step", where);
                Arguments(type, path, where);
                return;
            }
            if (ReadOnly.Contains(definition))
            {
                Arguments(type, path, where);
                return;
            }
            if (type is ITypeParameterSymbol || type.TypeKind == TypeKind.Interface || type.TypeKind == TypeKind.Dynamic
                || type.TypeKind == TypeKind.Pointer || type.TypeKind == TypeKind.FunctionPointer || type.SpecialType == SpecialType.System_Object
                || type.TypeKind == TypeKind.Error || !(type is INamedTypeSymbol named))
            {
                Report(path, $"is {type.ToDisplayString()}, whose structure the law cannot see", "use a concrete sealed record or struct of plain data", where);
                return;
            }
            var inSource = named.Locations.Any(l => l.IsInSource);
            if (named.IsReferenceType && !inSource)
            {
                Report(path, $"is {type.ToDisplayString()}, a class from another assembly whose structure the law cannot see", "copy what you need into a sealed record of plain data", where);
                return;
            }
            if (named.IsValueType && named.IsTupleType)
            {
                foreach (var element in named.TupleElements) Check(element.Type, $"{path}.{element.Name}", where);
                return;
            }
            Members(named);
            if (named.IsReferenceType && !named.IsSealed)
            {
                foreach (var derived in laws.Derived(named)) Members(derived);
            }
        }

        private static bool Plain(ITypeSymbol type) =>
            type.TypeKind == TypeKind.Enum
            || type.SpecialType >= SpecialType.System_Boolean && type.SpecialType <= SpecialType.System_String
            || type.SpecialType == SpecialType.System_DateTime || type.SpecialType == SpecialType.System_IntPtr || type.SpecialType == SpecialType.System_UIntPtr;

        private void Arguments(ITypeSymbol type, string path, Location where)
        {
            if (!(type is INamedTypeSymbol named)) return;
            foreach (var argument in named.TypeArguments) Check(argument, path + "'s element", where);
        }

        private void Members(INamedTypeSymbol type)
        {
            if (!seen.Add(type)) return;
            for (var t = type; t != null && t.SpecialType != SpecialType.System_Object && t.SpecialType != SpecialType.System_ValueType; t = t.BaseType)
            {
                foreach (var (member, memberType) in Laws.StoredMembers(t))
                {
                    if (member.IsStatic) continue;
                    var path = $"{t.Name}.{member.Name}";
                    var where = member.Locations.FirstOrDefault(l => l.IsInSource) ?? owner.Locations.FirstOrDefault(l => l.IsInSource) ?? Location.None;
                    if (type.IsReferenceType && Writable(member))
                    {
                        Report(path, "can be written after it is made", "make it readonly, get-only or init (a positional record parameter), and produce changes with `with` inside Step", where);
                    }
                    Check(memberType, path, where);
                }
            }
        }

        private static bool Writable(ISymbol member) => member switch
        {
            IPropertySymbol property => property.SetMethod != null && !property.SetMethod.IsInitOnly,
            IFieldSymbol field => !field.IsReadOnly,
            _ => false
        };
    }
}
