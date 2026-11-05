# ClippyAI persistent PowerShell host (v0.24, plan sec. 2.4 / sec. 2.5 / sec. 3.5).
#
# Started once by src/main/win-host.ts as
#   powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File ps-bridge.ps1 -ScriptsDir <dir>
# and kept alive for the whole app session.
#
# Protocol - one JSON object per line, UTF-8 both ways:
#   in : {"id":7,"cmd":"run","script":"get-foreground-window.ps1","args":{"ExcludeProcessId":123}}
#        {"id":8,"cmd":"eval","code":"[System.Windows.Forms.Cursor]::Position.X"}
#        {"id":9,"cmd":"ping"}
#        EXIT                      (or stdin EOF) -> clean exit
#   out: <RS>{"ready":true,...}    once, after start-up
#        <RS>{"id":7,"ok":true,"exitCode":0,"ms":12,"out":"..."}
#        <RS>{"id":8,"ok":false,"error":"..."}
# <RS> is ASCII 0x1E. Lines without it (Write-Host, stray console writes)
# are ignored by the client.
#
# `run` executes a bundled script IN THIS PROCESS with [Console]::Out
# redirected into a buffer, so `out` is exactly the stdout a one-shot
# `powershell.exe -File` spawn of the same script would have printed. A
# script's `exit N` only ends that script (N becomes exitCode). Inline
# Add-Type blocks compile on first use and are reused for the rest of the
# session - that is the "compile once" half of plan sec. 2.5.

param([string]$ScriptsDir = $PSScriptRoot)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $false
$RS = [string][char]0x1E
try { [Console]::OutputEncoding = $utf8 } catch { }

$startErr = ''
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch { $startErr = "assembly load: $($_.Exception.Message)" }

# Host helper: per-monitor-v2 DPI awareness (plan sec. 3.5) + a fast JSON string
# quoter (ConvertTo-Json is slow on multi-MB screenshot payloads).
$native = 'none'
try {
    if (-not ('ClippyHost.Native' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace ClippyHost {
    public static class Native {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
        static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        // Returns which levels took: "process+thread", "thread", "process" or "unaware".
        public static string EnablePerMonitorV2() {
            string r = "";
            try { if (SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)) r = "process"; } catch { }
            try { if (SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2) != IntPtr.Zero) r = r.Length > 0 ? r + "+thread" : "thread"; } catch { }
            return r.Length > 0 ? r : "unaware";
        }

        public static string Quote(string s) {
            if (s == null) return "null";
            StringBuilder b = new StringBuilder(s.Length + 16);
            b.Append('"');
            foreach (char c in s) {
                switch (c) {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029) b.Append("\\u").Append(((int)c).ToString("x4"));
                        else b.Append(c);
                        break;
                }
            }
            b.Append('"');
            return b.ToString();
        }
    }
}
"@
    }
    $native = 'compiled'
} catch { $startErr = "$startErr native: $($_.Exception.Message)".Trim() }

$dpi = 'unknown'
if ($native -ne 'none') { try { $dpi = [ClippyHost.Native]::EnablePerMonitorV2() } catch { } }

# Touch UI Automation from compiled code BEFORE any script binds it through
# PowerShell. Measured on Win11 26100: when the first UIA call in a process
# goes through PowerShell's method binder, the managed client-side Win32
# proxies never register, so every Win32 / WinForms control reads back as
# ControlType.Pane (no Button, Edit, CheckBox...) for the rest of the
# process. A first touch from C# registers them for the whole process.
$uia = 'cold'
try {
    if (-not ('ClippyHost.UiaWarm' -as [type])) {
        $uiaRefs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location)
        Add-Type -ReferencedAssemblies $uiaRefs -TypeDefinition @"
namespace ClippyHost {
    public static class UiaWarm {
        public static int Touch() { return System.Windows.Automation.AutomationElement.RootElement.Current.ProcessId; }
    }
}
"@
    }
    [void][ClippyHost.UiaWarm]::Touch()
    $uia = 'warm'
} catch { $startErr = "$startErr uia: $($_.Exception.Message)".Trim() }

function Q([string]$s) {
    if ($native -ne 'none') { return [ClippyHost.Native]::Quote($s) }
    return ($s | ConvertTo-Json -Compress)
}

function Send-Line([string]$json) {
    $stdout.Write($RS + $json + "`n")
    $stdout.Flush()
}

# Run a script block or script path with [Console]::Out captured; returns @(text, exitCode).
function Invoke-Captured($Block, [hashtable]$ArgTable) {
    $cap = New-Object System.IO.StringWriter
    $prevOut = [Console]::Out
    [Console]::SetOut($cap)
    $global:LASTEXITCODE = 0
    $items = @()
    try {
        if ($ArgTable) { $items = @(& $Block @ArgTable) } else { $items = @(& $Block) }
    } finally {
        [Console]::SetOut($prevOut)
    }
    $exitCode = 0
    if ($global:LASTEXITCODE -is [int]) { $exitCode = $global:LASTEXITCODE }
    $pipe = ($items | ForEach-Object {
        if ($null -eq $_) { '' }
        elseif ($_ -is [string] -or $_ -is [ValueType]) { [string]$_ }
        else { ($_ | Out-String).TrimEnd() }
    }) -join "`n"
    $console = $cap.ToString()
    $text = if ($console -and $pipe) { "$console`n$pipe" } elseif ($console) { $console } else { $pipe }
    return @($text, $exitCode)
}

$readyJson = '{"ready":true,"pid":' + $PID + ',"native":' + (Q $native) + ',"dpi":' + (Q $dpi) + ',"uia":' + (Q $uia) + ',"psVersion":' + (Q $PSVersionTable.PSVersion.ToString())
if ($startErr) { $readyJson += ',"warning":' + (Q $startErr) }
Send-Line ($readyJson + '}')

$scriptsRoot = [System.IO.Path]::GetFullPath($ScriptsDir)

while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -eq 'EXIT') { break }

    $id = 0
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $req = $line | ConvertFrom-Json
        $id = [int64]$req.id
        $result = $null
        switch ([string]$req.cmd) {
            'ping' { $result = @('pong', 0) }
            'run' {
                $name = [string]$req.script
                if ($name -notmatch '^[A-Za-z0-9_.-]+\.ps1$') { throw "invalid script name: $name" }
                $full = [System.IO.Path]::Combine($scriptsRoot, $name)
                if (-not [System.IO.File]::Exists($full)) { throw "script not found: $name" }
                $argTable = @{}
                if ($req.args) {
                    foreach ($p in $req.args.PSObject.Properties) {
                        $v = $p.Value
                        if ($v -is [bool] -and -not $v) { continue }   # false switch -> omit
                        $argTable[$p.Name] = $v
                    }
                }
                $result = Invoke-Captured $full $argTable
            }
            'eval' {
                $code = [string]$req.code
                $block = [scriptblock]::Create($code)
                $result = Invoke-Captured $block $null
            }
            default { throw "unknown command: $($req.cmd)" }
        }
        $ms = $sw.ElapsedMilliseconds
        Send-Line ('{"id":' + $id + ',"ok":true,"exitCode":' + [int]$result[1] + ',"ms":' + $ms + ',"out":' + (Q ([string]$result[0])) + '}')
    } catch {
        $ms = $sw.ElapsedMilliseconds
        Send-Line ('{"id":' + $id + ',"ok":false,"ms":' + $ms + ',"error":' + (Q $_.Exception.Message) + '}')
    }
}
$stdout.Flush()
