using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Dog.Laws;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;

var stdin = Console.IsInputRedirected ? Console.In.ReadToEnd() : "";
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
if (args.Length > 0) edited = args[0];
if (string.IsNullOrEmpty(edited) || !edited.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return 0;

var file = Path.GetFullPath(Path.IsPathRooted(edited) ? edited : Path.Combine(cwd ?? Environment.CurrentDirectory, edited));
var project = FindProject(file);
if (project == null) return 0;
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

static string? FindProject(string file)
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
