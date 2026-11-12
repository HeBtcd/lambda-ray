using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Dog.Laws
{
    internal sealed class Profile
    {
        public readonly string Name;
        public ImmutableArray<RootInterface> Interfaces;
        public ImmutableArray<string> Attributes;
        public ImmutableDictionary<string, ImmutableArray<string>> Hidden;
        public ImmutableHashSet<string> EngineObjects;
        public ImmutableHashSet<string> Unordered;
        public ImmutableHashSet<string> Mutable;
        public ImmutableHashSet<string> ReadOnly;
        public ImmutableHashSet<string> MutableSequences;
        public ImmutableHashSet<string> Batches;
        public string? ShellMarker;
        public string? ShellBase;
        public string? ProjectMethod;
        public bool ReadBack;
        public ImmutableDictionary<string, string> Diagnostics;

        public sealed class RootInterface
        {
            public string Type = "";
            public string[] Methods = Array.Empty<string>();
            public int StateArgument;
            public int CommandArgument = 1;
            public string Kind = "sim";
            public INamedTypeSymbol? TypeSymbol;
        }

        private Profile(string name)
        {
            Name = name;
            Interfaces = ImmutableArray<RootInterface>.Empty;
            Attributes = ImmutableArray<string>.Empty;
            Hidden = ImmutableDictionary<string, ImmutableArray<string>>.Empty;
            EngineObjects = ImmutableHashSet<string>.Empty;
            Unordered = ImmutableHashSet<string>.Empty;
            Mutable = ImmutableHashSet<string>.Empty;
            ReadOnly = ImmutableHashSet<string>.Empty;
            MutableSequences = ImmutableHashSet<string>.Empty;
            Batches = ImmutableHashSet<string>.Empty;
            Diagnostics = ImmutableDictionary<string, string>.Empty;
        }

        public static readonly Profile Unity = FromJson(Json.Object(Json.Parse(UnityJson))!);

        private const string UnityJson = @"
{
  ""name"": ""unity"",
  ""language"": ""csharp"",
  ""diagnostics"": {
    ""state-is-data"": ""DOG001"",
    ""commands-are-data"": ""DOG002"",
    ""step-is-pure"": ""DOG003"",
    ""log-is-append-only"": ""DOG004"",
    ""project-never-writes-back"": ""DOG005"",
    ""project-is-a-function-of-state"": ""DOG006""
  },
  ""roots"": {
    ""interfaces"": [
      { ""type"": ""Dog.Sim.ISim`2"", ""methods"": [""Step""], ""stateArgument"": 0, ""commandArgument"": 1, ""kind"": ""sim"" },
      { ""type"": ""Dog.Sim.ILayer`3"", ""methods"": [""Step"", ""Out""], ""stateArgument"": 0, ""commandArgument"": 1, ""kind"": ""layer"" }
    ]
  },
  ""hidden"": {
    ""clock"": [
      ""UnityEngine.Time."",
      ""System.DateTime.Now"", ""System.DateTime.UtcNow"", ""System.DateTime.Today"",
      ""System.DateTimeOffset.Now"", ""System.DateTimeOffset.UtcNow"",
      ""System.Diagnostics.Stopwatch."", ""System.Environment.Tick""
    ],
    ""random"": [""UnityEngine.Random."", ""System.Guid.NewGuid"", ""System.Random.""],
    ""io"": [""System.IO."", ""System.Console."", ""System.Environment"", ""System.Diagnostics.Process""],
    ""engine"": [""UnityEngine."", ""UnityEditor.""],
    ""thread"": [""System.Net."", ""System.Threading."", ""System.Threading.Tasks.""]
  },
  ""data"": {
    ""engineObjects"": [""UnityEngine.Object""],
    ""unordered"": [
      ""System.Collections.Generic.Dictionary<TKey, TValue>"", ""System.Collections.Generic.HashSet<T>"",
      ""System.Collections.Generic.IDictionary<TKey, TValue>"", ""System.Collections.Generic.IReadOnlyDictionary<TKey, TValue>"",
      ""System.Collections.Generic.ISet<T>"", ""System.Collections.Generic.IReadOnlySet<T>"",
      ""System.Collections.Concurrent.ConcurrentDictionary<TKey, TValue>"", ""System.Collections.Concurrent.ConcurrentBag<T>"",
      ""System.Collections.Immutable.ImmutableDictionary<TKey, TValue>"", ""System.Collections.Immutable.ImmutableHashSet<T>"",
      ""System.Collections.Immutable.IImmutableDictionary<TKey, TValue>"", ""System.Collections.Immutable.IImmutableSet<T>"",
      ""System.Collections.Hashtable""
    ],
    ""mutable"": [
      ""System.Collections.Generic.List<T>"", ""System.Collections.Generic.Queue<T>"", ""System.Collections.Generic.Stack<T>"",
      ""System.Collections.Generic.LinkedList<T>"", ""System.Collections.Generic.SortedList<TKey, TValue>"",
      ""System.Collections.Generic.SortedDictionary<TKey, TValue>"", ""System.Collections.Generic.SortedSet<T>"",
      ""System.Collections.Generic.IList<T>"", ""System.Collections.Generic.ICollection<T>"",
      ""System.Collections.ObjectModel.Collection<T>"", ""System.Collections.ObjectModel.ObservableCollection<T>"",
      ""System.Collections.ArrayList"", ""System.Collections.IList"", ""System.Text.StringBuilder""
    ],
    ""readonly"": [
      ""System.Collections.Generic.IReadOnlyList<T>"", ""System.Collections.Generic.IReadOnlyCollection<T>"",
      ""System.Collections.Generic.IEnumerable<T>"", ""System.Collections.Generic.KeyValuePair<TKey, TValue>"",
      ""System.Collections.Immutable.ImmutableArray<T>"", ""System.Collections.Immutable.ImmutableList<T>"",
      ""System.Collections.Immutable.IImmutableList<T>"", ""System.Collections.Immutable.ImmutableQueue<T>"",
      ""System.Collections.Immutable.ImmutableStack<T>"", ""System.Collections.Immutable.ImmutableSortedSet<T>"",
      ""System.Collections.Immutable.ImmutableSortedDictionary<TKey, TValue>"", ""System.Nullable<T>"",
      ""System.Collections.ObjectModel.ReadOnlyCollection<T>"", ""Dog.Sim.Log<T>""
    ]
  },
  ""log"": {
    ""appendOnlyType"": ""Dog.Sim.Log`1"",
    ""mutableSequences"": [
      ""System.Collections.Generic.List<T>"", ""System.Collections.Generic.Queue<T>"", ""System.Collections.Generic.Stack<T>"",
      ""System.Collections.Generic.LinkedList<T>"", ""System.Collections.Generic.IList<T>"", ""System.Collections.Generic.ICollection<T>"",
      ""System.Collections.ObjectModel.Collection<T>"", ""System.Collections.ObjectModel.ObservableCollection<T>""
    ],
    ""batches"": [
      ""System.Collections.Generic.IReadOnlyList<T>"", ""System.Collections.Generic.IReadOnlyCollection<T>"", ""System.Collections.Generic.IEnumerable<T>"",
      ""System.Collections.Generic.List<T>"", ""System.Collections.Generic.IList<T>"", ""System.Collections.Generic.ICollection<T>"",
      ""System.Collections.Immutable.ImmutableArray<T>"", ""System.Collections.Immutable.ImmutableList<T>"", ""System.Collections.Immutable.IImmutableList<T>""
    ]
  },
  ""shell"": {
    ""marker"": ""Dog.Sim.SimShellAttribute"",
    ""baseType"": ""Dog.Sim.SimShell`2"",
    ""stepCalls"": [""Step""],
    ""projectMethod"": ""Project""
  },
  ""projection"": { ""readBack"": true }
}";

        public static Profile? FromAdditionalFiles(AnalyzerOptions options)
        {
            foreach (var file in options.AdditionalFiles)
            {
                if (!file.Path.EndsWith(".dogpurity.json", StringComparison.OrdinalIgnoreCase) && !file.Path.EndsWith("dog-purity.json", StringComparison.OrdinalIgnoreCase))
                    continue;
                var text = file.GetText()?.ToString();
                if (text == null) continue;
                var parsed = Json.Parse(text);
                if (parsed is Json.Obj obj) return FromJson(obj);
            }
            return null;
        }

        public static Profile FromJson(Json.Obj json)
        {
            var profile = new Profile(Json.Text(json["name"]) ?? "custom");
            var roots = Json.Object(json["roots"]);
            if (Json.Array(roots?["interfaces"]) is Json.Arr interfaces)
            {
                profile.Interfaces = interfaces.Items.OfType<Json.Obj>().Select(i => new RootInterface
                {
                    Type = Json.Text(i["type"])!,
                    Methods = Json.Array(i["methods"])?.Items.Select(m => Json.Text(m)!).ToArray() ?? Array.Empty<string>(),
                    StateArgument = Json.Int(i["stateArgument"]) ?? 0,
                    CommandArgument = Json.Int(i["commandArgument"]) ?? 1,
                    Kind = Json.Text(i["kind"]) ?? "sim",
                }).ToImmutableArray();
            }
            if (Json.Array(roots?["attributes"]) is Json.Arr attributes)
                profile.Attributes = attributes.Items.Select(a => Json.Text(a)!).ToImmutableArray();
            if (Json.Object(json["hidden"]) is Json.Obj hidden)
            {
                var map = ImmutableDictionary.CreateBuilder<string, ImmutableArray<string>>();
                foreach (var pair in hidden.Map)
                    if (pair.Value is Json.Arr list)
                        map[pair.Key] = list.Items.Select(x => Json.Text(x)!).ToImmutableArray();
                profile.Hidden = map.ToImmutable();
            }
            if (Json.Object(json["data"]) is Json.Obj data)
            {
                profile.EngineObjects = Strings(data, "engineObjects");
                profile.Unordered = Strings(data, "unordered");
                profile.Mutable = Strings(data, "mutable");
                profile.ReadOnly = Strings(data, "readonly");
            }
            if (Json.Object(json["log"]) is Json.Obj log)
            {
                profile.MutableSequences = Strings(log, "mutableSequences");
                profile.Batches = Strings(log, "batches");
            }
            if (Json.Object(json["shell"]) is Json.Obj shell)
            {
                profile.ShellMarker = Json.Text(shell["marker"]);
                profile.ShellBase = Json.Text(shell["baseType"]);
                profile.ProjectMethod = Json.Text(shell["projectMethod"]);
            }
            if (Json.Object(json["projection"]) is Json.Obj projection)
                profile.ReadBack = Json.Flag(projection["readBack"]) ?? false;
            if (Json.Object(json["diagnostics"]) is Json.Obj diagnostics)
            {
                var map = ImmutableDictionary.CreateBuilder<string, string>();
                foreach (var pair in diagnostics.Map)
                    if (Json.Text(pair.Value) is string id)
                        map[pair.Key] = id;
                profile.Diagnostics = map.ToImmutable();
            }
            return profile;
        }

        private static ImmutableHashSet<string> Strings(Json.Obj node, string key) =>
            Json.Array(node[key]) is Json.Arr list ? list.Items.Select(x => Json.Text(x)!).ToImmutableHashSet() : ImmutableHashSet<string>.Empty;

        public IEnumerable<string> HiddenOf(string category) =>
            Hidden.TryGetValue(category, out var list) ? list : Enumerable.Empty<string>();
    }
}
