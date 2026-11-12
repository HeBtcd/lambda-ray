$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$check = Join-Path $root 'csharp/Dog.Laws.Check/bin/Debug/net10.0/Dog.Laws.Check.exe'
$work = Join-Path $root '.cache/systest/dotnet-pure'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
@'
using System;
using System.Collections.Generic;
using System.Diagnostics.Contracts;

public sealed class Math
{
    private static int calls;

    [Pure]
    public static int Add(int a, int b) => a + b;

    [Pure]
    public static int Clock() => DateTime.Now.Second;

    [Pure]
    public static int Roll() => new Random().Next();

    [Pure]
    public static int Hidden() => calls++;

    [Pure]
    public static int Write(List<int> into) { into.Add(1); return into.Count; }

    public static int NotChecked() => DateTime.Now.Second;
}
'@ | Set-Content (Join-Path $work 'Lib.cs')

$out = & $check --profile dotnet-pure $work 2>&1
$text = "$out"
foreach ($expect in @('System.DateTime.Now', 'System.Random', 'static field calls', 'calls Add on into')) {
    if (-not $text.Contains($expect)) { Write-Error "missing: $expect`n$text"; exit 1 }
}
if ($text.Contains('NotChecked') -or $text.Contains('Add of Math')) { Write-Error "lawful methods flagged`n$text"; exit 1 }
Write-Output "dotnet-pure: ok"
