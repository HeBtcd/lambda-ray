using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Xunit;

namespace Dog.Laws.Tests
{
    public class LawsTests
    {
        private const string Engine = @"
namespace UnityEngine
{
    public class Object { }
    public class MonoBehaviour : Object { }
    public static class Time { public static float time => 0; }
    public static class Random { public static float value => 0; }
    public static class Mathf { public static float Sin(float x) => x; }
    public struct Vector3 { public float x, y, z; public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; } }
}";

        private const string Usings = "using System; using System.Collections.Generic; using System.Linq; using Dog.Sim; using UnityEngine;\n";

        private static async Task<ImmutableArray<Diagnostic>> Laws(string source)
        {
            var contract = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "Dog.Sim.cs"));
            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Select(path => MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create("Fixture",
                new[] { contract, Engine, Usings + source }.Select(text => CSharpSyntaxTree.ParseText(text, new CSharpParseOptions(LanguageVersion.Latest))),
                references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
            var errors = compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToList();
            Assert.True(errors.Count == 0, string.Join("\n", errors));
            return await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new SimLawsAnalyzer())).GetAnalyzerDiagnosticsAsync();
        }

        private static async Task<string[]> Ids(string source) => (await Laws(source)).Select(diagnostic => diagnostic.Id).Distinct().OrderBy(id => id).ToArray();

        private const string Good = @"
public enum Kind { Move, Reset }
public sealed record Command(Kind Kind, float By);
public sealed record Body(Vector3 At, IReadOnlyList<float> Trail);
public sealed record Level(float Speed);
public sealed class Runner : ISim<Body, Command>
{
    private readonly Level level;
    public Runner(Level level) { this.level = level; }
    public int StepsPerSecond => 60;
    public Body Init => new Body(new Vector3(0, 0, 0), Array.Empty<float>());
    public Body Step(Body state, IReadOnlyList<Command> commands)
    {
        var trail = new List<float>(state.Trail);
        var at = state.At;
        foreach (var command in commands)
        {
            if (command.Kind == Kind.Reset) return Init;
            at.x += Ease(command.By) * level.Speed;
            trail.Add(at.x);
        }
        trail.Sort();
        return state with { At = at, Trail = trail };
    }
    private static float Ease(float x) => Mathf.Sin(x);
}
[SimShell]
public sealed class Shell : MonoBehaviour
{
    private Log<Command> log = Log<Command>.Empty;
    private Body state = new Runner(new Level(1)).Init;
    public void Tick(Runner sim, IReadOnlyList<Command> commands) { log = log.Append(commands); state = sim.Step(state, commands); }
}";

        [Fact]
        public async Task PassAPureSimOverImmutableDataWithAShell() => Assert.Empty(await Laws(Good));

        [Fact]
        public async Task RefuseADelegateInTheState()
        {
            var found = await Laws("public sealed record S(Action OnHit); public sealed class X : ISim<S, int> { public int StepsPerSecond => 60; public S Init => new S(() => { }); public S Step(S s, IReadOnlyList<int> c) => s; }");
            Assert.Equal(new[] { "DOG001" }, found.Select(d => d.Id).Distinct());
            Assert.Contains("S.OnHit is a delegate", found[0].GetMessage());
        }

        [Fact]
        public async Task RefuseAnEngineObjectAMutableFieldAnArrayAndADictionaryInTheState()
        {
            var found = await Laws("public sealed class S { public int N; public MonoBehaviour Who = null!; public int[] Xs = null!; public Dictionary<int, int> D = null!; } public sealed class X : ISim<S, int> { public int StepsPerSecond => 60; public S Init => new S(); public S Step(S s, IReadOnlyList<int> c) => s; }");
            var messages = found.Select(d => d.GetMessage()).ToList();
            Assert.All(found, d => Assert.Equal("DOG001", d.Id));
            Assert.Contains(messages, m => m.StartsWith("S.N can be written"));
            Assert.Contains(messages, m => m.StartsWith("S.Who is the engine object"));
            Assert.Contains(messages, m => m.StartsWith("S.Xs is an array"));
            Assert.Contains(messages, m => m.StartsWith("S.D is System.Collections.Generic.Dictionary"));
        }

        [Fact]
        public async Task RefuseACommandThatIsAFunction() =>
            Assert.Equal(new[] { "DOG002" }, await Ids("public sealed record S(int N); public sealed class X : ISim<S, Func<S, S>> { public int StepsPerSecond => 60; public S Init => new S(0); public S Step(S s, IReadOnlyList<Func<S, S>> c) => c.Aggregate(s, (a, f) => f(a)); }"));

        [Fact]
        public async Task FollowStepIntoHelpersAndNameThePath()
        {
            var found = await Laws("public sealed record S(float N); public sealed class X : ISim<S, int> { public int StepsPerSecond => 60; public S Init => new S(0); public S Step(S s, IReadOnlyList<int> c) => new S(Roll()); private static float Roll() => UnityEngine.Random.value; }");
            Assert.Equal(new[] { "DOG003" }, found.Select(d => d.Id).Distinct());
            Assert.Contains("reads UnityEngine.Random.value, via Step of X -> Roll", found[0].GetMessage());
        }

        [Theory]
        [InlineData("new S((float)DateTime.Now.Ticks)", "reads System.DateTime.Now")]
        [InlineData("new S(Time.time)", "reads UnityEngine.Time.time")]
        [InlineData("new S(new System.Random(1).Next())", "creates System.Random")]
        [InlineData("new S(calls++)", "touches the static field calls")]
        [InlineData("new S(seen)", "touches the field seen of the sim itself")]
        public async Task RefuseTheClockRandomTheEngineAndHiddenState(string made, string expected)
        {
            var found = await Laws($"public sealed record S(float N); public sealed class X : ISim<S, int> {{ private static int calls; private float seen; public int StepsPerSecond => 60; public S Init => new S(0); public S Step(S s, IReadOnlyList<int> c) => {made}; }}");
            Assert.Contains(found, d => d.Id == "DOG003" && d.GetMessage().Contains(expected));
        }

        [Fact]
        public async Task RefuseAWriteIntoTheInput()
        {
            var found = await Laws("public sealed class Bag { public readonly List<int> Items = new List<int>(); } public sealed record S(int N); public sealed class X : ISim<S, Bag> { public int StepsPerSecond => 60; public S Init => new S(0); public S Step(S s, IReadOnlyList<Bag> c) { c[0].Items.Add(1); return s; } }");
            Assert.Contains(found, d => d.Id == "DOG003" && d.GetMessage().Contains("calls Add on c[0].Items"));
        }

        [Fact]
        public async Task HoldALayerToTheSameLawsItsOutIncluded()
        {
            Assert.Empty(await Laws("public sealed record Gait(int Ticks); public sealed class G : ILayer<Gait, float, int> { public Gait Init => new Gait(0); public Gait Step(Gait m, float speed) => m with { Ticks = m.Ticks + 1 }; public int Out(Gait m) => m.Ticks % 30; }"));
            var found = await Laws("public sealed record Gait(int Ticks); public sealed class G : ILayer<Gait, float, float> { public Gait Init => new Gait(0); public Gait Step(Gait m, float speed) => m; public float Out(Gait m) => Time.time; }");
            Assert.Contains(found, d => d.Id == "DOG003" && d.GetMessage().Contains("via Out of G"));
        }

        [Fact]
        public async Task RefuseALogKeptInAList() =>
            Assert.Equal(new[] { "DOG004" }, await Ids("public sealed class Recorder { public readonly List<IReadOnlyList<int>> Log = new List<IReadOnlyList<int>>(); }"));

        [Fact]
        public async Task RefuseAViewThatStepsTheSim() =>
            Assert.Equal(new[] { "DOG005" }, await Ids(Good.Replace("[SimShell]", "")));
    }
}
