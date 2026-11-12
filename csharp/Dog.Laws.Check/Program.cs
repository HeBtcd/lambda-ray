using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Text.Json.Nodes;
using Dog.Laws;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Text;

var argsList = args.ToList();
var stdin = argsList.Count == 0 && Console.IsInputRedirected ? Console.In.ReadToEnd() : "";
string? profileArg = null;
var rest = new List<string>();
for (var i = 0; i < argsList.Count; i++)
{
    if (argsList[i] == "--profile" && i + 1 < argsList.Count) { profileArg = argsList[++i]; }
    else rest.Add(argsList[i]);
}

string? edited = null;
string? cwd = null;
try
{
    var payload = JsonNode.Parse(stdin);
    edited = (string?)payload?["tool_input"]?["file_path"] ?? (string?)payload?["tool_input"]?["notebook_path"];
    cwd = (string?)payload?["cwd"];
}
catch (JsonException)
{
}
var hook = !string.IsNullOrEmpty(edited);
if (rest.Count > 0 && edited == null) edited = rest[0];

if (rest.Count > 0 && !edited!.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) && !File.Exists(edited))
{
    var dir = Path.GetFullPath(Path.IsPathRooted(edited!) ? edited! : Path.Combine(cwd ?? Environment.CurrentDirectory, edited!));
    var result = CheckDirectory(dir, profileArg);
    if (result.Count == 0) return 0;
    foreach (var line in result) Console.Out.WriteLine(line);
    return 1;
}

if (string.IsNullOrEmpty(edited) || !edited.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return 0;

var file = Path.GetFullPath(Path.IsPathRooted(edited) ? edited : Path.Combine(cwd ?? Environment.CurrentDirectory, edited));
var project = FindUnityProject(file);
if (project == null)
{
    var dir = Path.GetDirectoryName(file)!;
    var lines = CheckDirectory(dir, profileArg);
    if (lines.Count == 0) return 0;
    if (hook)
    {
        Console.Out.Write(JsonSerializer.Serialize(new Dictionary<string, string> { ["decision"] = "block", ["reason"] = string.Join("\n", lines) }));
        return 0;
    }
    foreach (var line in lines) Console.Out.WriteLine(line);
    return 1;
}

var assets = Path.Combine(project, "Assets");
if (!file.StartsWith(assets + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return 0;

var editor = Environment.GetEnvironmentVariable("DOG_UNITY_EDITOR") ?? EditorFor(project);
var data = Path.Combine(editor, "Data");
var references = new List<string>();
references.Add(Path.Combine(data, "NetStandard", "ref", "2.1.0", "netstandard.dll"));
references.AddRange(Directory.EnumerateFiles(Path.Combine(data, "Managed", "UnityEngine"), "*.dll"));
var scriptAssemblies = Path.Combine(project, "Library", "ScriptAssemblies");
if (Directory.Exists(scriptAssemblies))
{
    references.AddRange(Directory.EnumerateFiles(scriptAssemblies, "*.dll")
        .Where(path => !Path.GetFileName(path).StartsWith("Assembly-CSharp", StringComparison.OrdinalIgnoreCase)));
}

var options = new CSharpParseOptions(LanguageVersion.CSharp9, preprocessorSymbols: new[] { "UNITY_EDITOR", "UNITY_EDITOR_WIN", "UNITY_STANDALONE", "UNITY_STANDALONE_WIN", "UNITY_6000_0_OR_NEWER", "UNITY_2023_1_OR_NEWER", "UNITY_2022_1_OR_NEWER", "UNITY_2021_1_OR_NEWER", "UNITY_2020_1_OR_NEWER", "NET_STANDARD_2_1", "NET_STANDARD", "CSHARP_7_3_OR_NEWER" });
var sources = Directory.EnumerateFiles(assets, "*.cs", SearchOption.AllDirectories).ToList();
var trees = sources.AsParallel().Select(path => CSharpSyntaxTree.ParseText(File.ReadAllText(path), options, path, Encoding.UTF8)).ToList();
var compilation = CSharpCompilation.Create("Dog.Laws.Check", trees,
    references.Where(File.Exists).Select(path => MetadataReference.CreateFromFile(path)),
    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, allowUnsafe: true, concurrentBuild: true));
var found = await compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new SimLawsAnalyzer())).GetAnalyzerDiagnosticsAsync();
var laws = found.Where(d => d.Id.StartsWith("DOG")).OrderBy(d => d.Location.SourceTree?.FilePath).ThenBy(d => d.Location.SourceSpan.Start).ToList();
if (laws.Count == 0) return 0;

var reason = new StringBuilder();
reason.AppendLine($"The dog laws refuse {laws.Count} thing(s) in this Unity project. Fix each one before going on:");
foreach (var diagnostic in laws)
{
    var span = diagnostic.Location.GetLineSpan();
    var relative = Path.GetRelativePath(project, span.Path).Replace('\\', '/');
    reason.AppendLine($"{relative}:{span.StartLinePosition.Line + 1}: {diagnostic.Id} {diagnostic.GetMessage()}");
}
Console.Out.Write(JsonSerializer.Serialize(new Dictionary<string, string> { ["decision"] = "block", ["reason"] = reason.ToString().TrimEnd() }));
return 0;

static string? FindUnityProject(string file)
{
    for (var dir = Path.GetDirectoryName(file); dir != null; dir = Path.GetDirectoryName(dir))
    {
        if (Directory.Exists(Path.Combine(dir, "Assets")) && Directory.Exists(Path.Combine(dir, "ProjectSettings"))) return dir;
    }
    return null;
}

static string EditorFor(string project)
{
    var version = "6000.3.11f1";
    var file = Path.Combine(project, "ProjectSettings", "ProjectVersion.txt");
    if (File.Exists(file))
    {
        var line = File.ReadLines(file).FirstOrDefault(l => l.StartsWith("m_EditorVersion:"));
        if (line != null) version = line.Substring("m_EditorVersion:".Length).Trim();
    }
    return Path.Combine("C:/Program Files/Unity/Hub/Editor", version, "Editor");
}

static List<string> CheckDirectory(string dir, string? profileArg)
{
    var files = Directory.EnumerateFiles(dir, "*.cs", SearchOption.AllDirectories)
        .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
        .ToList();
    if (files.Count == 0) return new List<string>();
    var options = new CSharpParseOptions(LanguageVersion.Latest);
    var trees = files.AsParallel().Select(path => CSharpSyntaxTree.ParseText(File.ReadAllText(path), options, path, Encoding.UTF8)).ToList();
    var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
        .Select(path => MetadataReference.CreateFromFile(path));
    var additional = new List<AdditionalText>();
    if (profileArg != null)
    {
        var profilePath = profileArg.EndsWith(".json", StringComparison.OrdinalIgnoreCase) ? profileArg : Path.Combine(ProfilesDir(), profileArg + ".json");
        if (File.Exists(profilePath)) additional.Add(new FileText(profilePath));
    }
    var compilation = CSharpCompilation.Create("Dog.Laws.Check", trees, references,
        new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, nullableContextOptions: NullableContextOptions.Enable));
    var analyzerOptions = new AnalyzerOptions(additional.ToImmutableArray());
    var found = compilation.WithAnalyzers(ImmutableArray.Create<DiagnosticAnalyzer>(new SimLawsAnalyzer()), analyzerOptions)
        .GetAnalyzerDiagnosticsAsync().GetAwaiter().GetResult();
    return found.Where(d => d.Id.StartsWith("DOG") || d.Id.StartsWith("AD"))
        .OrderBy(d => d.Location.SourceTree?.FilePath).ThenBy(d => d.Location.SourceSpan.Start)
        .Select(d =>
        {
            var span = d.Location.GetLineSpan();
            var relative = Path.GetRelativePath(dir, span.Path).Replace('\\', '/');
            return $"{relative}:{span.StartLinePosition.Line + 1}: {d.Id} {d.GetMessage()}";
        }).ToList();
}

static string ProfilesDir() => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "profiles"));

sealed class FileText : AdditionalText
{
    private readonly string file;
    public FileText(string file) { this.file = file; }
    public override string Path => file;
    public override SourceText? GetText(CancellationToken cancellationToken = default) => SourceText.From(File.ReadAllText(file), Encoding.UTF8);
}
