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
    public class ProjectLawsTests
    {
        private const string Engine = @"
namespace UnityEngine
{
    public class Object { }
    [System.AttributeUsage(System.AttributeTargets.Field)] public sealed class SerializeField : System.Attribute { }
    public class Component : Object { public Transform transform => null!; public T GetComponent<T>() => default!; }
    public class Behaviour : Component { public bool enabled { get; set; } }
    public class MonoBehaviour : Behaviour { }
    public class Transform : Component { public Vector3 position { get; set; } public Transform GetChild(int i) => this; public int childCount => 0; }
    public class Material : Object { public Color color { get; set; } }
    public class Renderer : Component { public Material material { get; set; } = null!; }
    public static class Time { public static float time => 0; public static int frameCount => 0; }
    public static class Random { public static float value => 0; }
    public static class Mathf { public static float Sin(float x) => x; }
    public struct Vector3 { public float x, y, z; public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; } }
    public struct Color { public float r, g, b, a; public Color(float r, float g, float b) { this.r = r; this.g = g; this.b = b; a = 1; } }
}
namespace Dog.Sim
{
    using System.Collections.Generic;
    using UnityEngine;
    [SimShell]
    public abstract class SimShell<TState, TCommand> : MonoBehaviour
    {
        public Log<TCommand> Log { get; private set; } = Log<TCommand>.Empty;
        public TState State { get; private set; } = default!;
        public int Tick => Log.Count;
        protected abstract ISim<TState, TCommand> Create();
        protected virtual void Read(List<TCommand> commands) { }
        protected abstract void Project(TState state);
        public void Send(TCommand command) { }
    }
}";

        private const string Usings = "using System; using System.Collections.Generic; using System.Linq; using Dog.Sim; using UnityEngine;\n";

        private const string World = @"
public sealed record Box(float X, int Hue);
public sealed record World(int Tick, IReadOnlyList<Box> Boxes, IReadOnlyList<float> Speeds);
public sealed class Spin : ISim<World, int>
{
    public int StepsPerSecond => 60;
    public World Init => new World(0, new[] { new Box(0, 1), new Box(2, 2) }, Array.Empty<float>());
    public World Step(World w, IReadOnlyList<int> c) => w with { Tick = w.Tick + 1, Boxes = w.Boxes.Select(b => b with { X = b.X + Mathf.Sin(w.Tick) }).ToList(), Speeds = w.Speeds.Append(w.Tick).ToList() };
}
public sealed record Trail(float Sum);
public sealed class Smooth : ILayer<Trail, float, float>
{
    public Trail Init => new Trail(0);
    public Trail Step(Trail m, float x) => new Trail(m.Sum * 0.9f + x * 0.1f);
    public float Out(Trail m) => m.Sum;
}";

        private static async Task<ImmutableArray<Diagnostic>> Laws(string source)
        {
            var contract = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contract", "Dog.Sim.cs"));
            var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator).Select(path => MetadataReference.CreateFromFile(path));
            var compilation = CSharpCompilation.Create("Fixture",
                new[] { contract, Engine, Usings + World + source }.Select(text => CSharpSyntaxTree.ParseText(text, new CSharpParseOptions(LanguageVersion.Latest))),
                references, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
            var errors = compilation.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToList();
            Assert.True(errors.Count == 0, string.Join("\n", errors));
            return await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new SimLawsAnalyzer())).GetAnalyzerDiagnosticsAsync();
        }

        private static string Shell(string fields, string project, string helpers = "") => $@"
public sealed class Show : SimShell<World, int>
{{
    private readonly Smooth smooth = new Smooth();
    private readonly float scale = 2;
    {fields}
    protected override ISim<World, int> Create() => new Spin();
    protected override void Read(List<int> commands) {{ if (Time.time > 1) commands.Add((int)(UnityEngine.Random.value * 10)); }}
    protected override void Project(World state) {{ {project} }}
    {helpers}
}}";

        private const string Lawful = @"
for (var i = 0; i < state.Boxes.Count; i++)
{
    var box = transform.GetChild(i);
    box.position = new Vector3(state.Boxes[i].X * scale, Ease(state.Tick), 0);
    box.GetComponent<Renderer>().material.color = Tint(state.Boxes[i].Hue);
}
transform.position = new Vector3(Run.View(smooth, state.Speeds, state.Speeds.Count, 30), 0, 0);";

        private const string LawfulHelpers = "private static float Ease(int tick) => Mathf.Sin(tick / 60f); private Color Tint(int hue) => new Color(hue * scale, 0, 1);";

        [Fact]
        public async Task PassAProjectThatReadsOnlyItsStateReadonlyFieldsAndLayersAndWritesTheEngine()
        {
            var found = await Laws(Shell("", Lawful, LawfulHelpers));
            Assert.Empty(found);
        }

        [Theory]
        [InlineData("", "transform.position = new Vector3(Time.time, 0, 0);", "reads UnityEngine.Time.time")]
        [InlineData("", "transform.position = new Vector3(Time.frameCount, 0, 0);", "reads UnityEngine.Time.frameCount")]
        [InlineData("", "transform.position = new Vector3(DateTime.Now.Second, 0, 0);", "reads System.DateTime.Now")]
        [InlineData("", "transform.position = new Vector3(UnityEngine.Random.value, 0, 0);", "reads UnityEngine.Random.value")]
        [InlineData("", "transform.position = new Vector3(new System.Random(state.Tick).Next(), 0, 0);", "creates System.Random")]
        [InlineData("private static int frames;", "frames++; transform.position = new Vector3(frames, 0, 0);", "touches the static field frames")]
        [InlineData("private float last;", "transform.position = new Vector3(last, 0, 0); last = state.Tick;", "touches the field last of the shell itself")]
        [InlineData("private float Glow { get; set; }", "transform.position = new Vector3(Glow, 0, 0);", "touches the property Glow of the shell itself")]
        [InlineData("", "transform.position = new Vector3(State.Tick, 0, 0);", "reads State of the shell itself")]
        [InlineData("", "transform.position = new Vector3(Tick, 0, 0);", "reads Tick of the shell itself")]
        public async Task RefuseTheClockRandomStaticsAndTheShellsOwnMemory(string fields, string project, string expected)
        {
            var found = await Laws(Shell(fields, project));
            Assert.All(found, d => Assert.Equal("DOG006", d.Id));
            Assert.Contains(found, d => d.GetMessage().Contains(expected + ", via Project of Show,"));
        }

        [Fact]
        public async Task LetProjectReadMutableFieldsThatHoldEngineObjects()
        {
            var found = await Laws(Shell("[SerializeField] private Transform target = null!; [SerializeField] private Transform[] bodies = null!; private List<Renderer> paints = new List<Renderer>(); private Transform Eye { get; set; } = null!;",
                "target.position = new Vector3(state.Tick, 0, 0); for (var i = 0; i < bodies.Length; i++) bodies[i].position = new Vector3(state.Boxes[i].X, 0, 0); paints[0].material.color = new Color(1, 0, 0); Eye.position = target.position = new Vector3(0, 0, 0);"));
            Assert.Empty(found);
        }

        [Fact]
        public async Task StillRefuseAMutableIntFieldNextToAnEngineObjectField()
        {
            var found = await Laws(Shell("[SerializeField] private Transform target = null!; [SerializeField] private int lane;", "target.position = new Vector3(lane, state.Tick, 0);"));
            var hit = Assert.Single(found);
            Assert.Equal("DOG006", hit.Id);
            Assert.Contains("touches the field lane of the shell itself, via Project of Show,", hit.GetMessage());
        }

        [Theory]
        [InlineData("target.position = new Vector3(target.position.x + state.Tick, 0, 0);", "reads back engine state Transform.position")]
        [InlineData("target.GetComponent<Renderer>().material.color = new Color(target.childCount, 0, 0);", "reads back engine state Transform.childCount")]
        [InlineData("if (enabled) target.position = new Vector3(state.Tick, 0, 0);", "reads back engine state Behaviour.enabled")]
        [InlineData("var tint = target.GetComponent<Renderer>().material.color; target.GetComponent<Renderer>().material.color = new Color(tint.r, state.Tick, 0);", "reads back engine state Material.color")]
        public async Task RefuseReadingEngineStateBack(string project, string expected)
        {
            var found = await Laws(Shell("[SerializeField] private Transform target = null!;", project));
            Assert.All(found, d => Assert.Equal("DOG006", d.Id));
            Assert.Contains(found, d => d.GetMessage().Contains(expected + ", via Project of Show,"));
        }

        [Fact]
        public async Task FollowProjectIntoHelpersAndOtherTypesAndNameThePath()
        {
            var found = await Laws(Shell("", "Paint(state);", "private void Paint(World w) => transform.position = new Vector3(Pulse.At(w.Tick), 0, 0);")
                + "public static class Pulse { public static float At(int tick) => tick + Time.time; }");
            var hit = Assert.Single(found);
            Assert.Equal("DOG006", hit.Id);
            Assert.Contains("reads UnityEngine.Time.time, via Project of Show -> Paint -> At", hit.GetMessage());
        }

        [Fact]
        public async Task LetTheShellUseHiddenInputsOutsideProject()
        {
            var found = await Laws(Shell("private float seen;", Lawful, LawfulHelpers + " private void Update() { seen = Time.time; }"));
            Assert.Empty(found);
        }

        [Fact]
        public async Task CheckProjectOnEveryLevelOfAShellHierarchy()
        {
            var found = await Laws(@"
public abstract class Base : SimShell<World, int>
{
    protected override ISim<World, int> Create() => new Spin();
}
public sealed class Leaf : Base
{
    protected override void Project(World state) => transform.position = new Vector3(state.Tick + UnityEngine.Random.value, 0, 0);
}");
            var hit = Assert.Single(found);
            Assert.Contains("reads UnityEngine.Random.value, via Project of Leaf", hit.GetMessage());
        }
    }
}
