# com-kill-process.ps1
# Terminate a process by PID, by name, or by window title.
# Args: -procPid (int) OR -name (string) OR -windowB64 (base64 UTF-8 substring
#       of a main window title; case-insensitive, spaces ignored). One required.
#       -resolveOnly: kill nothing; report the processes this call WOULD end
#       (targets = [] when it would end nothing). Used by the approval gate.
# A window that matches more than one app kills nothing and returns the
# matches so the caller can pick one.
# Outputs JSON on the last line.

param(
    [int]$procPid = 0,
    [string]$name = "",
    [string]$windowB64 = "",
    [switch]$resolveOnly
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    if ($resolveOnly) { Out-Result @{ ok = $true; targets = @(); note = $msg }; exit 0 }
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

function Norm($s) { return (([string]$s) -replace '\s', '').ToLower() }

function Describe($p) {
    $d = ""; $prod = ""
    try { $d = [string]$p.Description } catch {}
    try { $prod = [string]$p.Product } catch {}
    if ($d -and $prod -and $d -ne $prod) { return "$d ($prod)" }
    if ($d) { return $d }
    return $prod
}

function Row($p) {
    return @{
        pid = $p.Id
        name = $p.ProcessName
        window = if ($p.MainWindowTitle) { $p.MainWindowTitle } else { "" }
        description = (Describe $p)
    }
}

$window = ""
if ($windowB64) {
    try { $window = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($windowB64)) }
    catch { Fail "invalid window" }
}

if ($procPid -eq 0 -and [string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($window)) {
    Fail "either pid, name or window is required"
}

# Whitelist sanity: never let the model kill OS-critical processes.
$BLOCKLIST = @('system','smss','csrss','wininit','services','lsass','winlogon','dwm','explorer','svchost','clippyai','clippy','electron')

try {
    $targets = @()
    if ($procPid -gt 0) {
        $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
        if (-not $proc) { Fail "no process with PID $procPid" }
        $pname = $proc.ProcessName.ToLower()
        if ($BLOCKLIST -contains $pname) { Fail "refusing to kill protected process '$pname'" }
        $targets = @($proc)
    } elseif (-not [string]::IsNullOrWhiteSpace($name)) {
        $cleanName = $name.Trim().ToLower() -replace '\.exe$', ''
        if ($BLOCKLIST -contains $cleanName) { Fail "refusing to kill protected process '$cleanName'" }
        $targets = @(Get-Process -Name $cleanName -ErrorAction SilentlyContinue)
        if ($targets.Count -eq 0) {
            Fail "no process named '$cleanName'. The app may run under another process name: retry with window (its window title) or find it with list_processes(query)"
        }
    } else {
        $q = Norm $window
        $targets = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowTitle -and (Norm $_.MainWindowTitle).Contains($q) -and ($BLOCKLIST -notcontains $_.ProcessName.ToLower())
        })
        if ($targets.Count -eq 0) {
            Fail "no window title contains '$window'. Find the app with list_processes(query)"
        }
        $apps = @($targets | ForEach-Object { $_.ProcessName.ToLower() } | Sort-Object -Unique)
        if ($apps.Count -gt 1) {
            # Several apps match: kill none, let the caller choose.
            if ($resolveOnly) { Out-Result @{ ok = $true; targets = @(); note = "several apps match" }; exit 0 }
            $rows = @($targets | ForEach-Object { Row $_ })
            Out-Result @{ ok = $true; killed = @(); count = 0; needsChoice = $true; matches = $rows; message = "Several apps have a window matching '$window'. Nothing was terminated. Call kill_process again with the procPid of the one the user means." }
            exit 0
        }
    }

    if ($resolveOnly) {
        $rows = @($targets | ForEach-Object { Row $_ })
        Out-Result @{ ok = $true; targets = $rows }
        exit 0
    }

    $killed = @()
    foreach ($p in $targets) {
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            $killed += @{ pid = $p.Id; name = $p.ProcessName }
        } catch {
            if ($procPid -gt 0) { throw }
            continue
        }
    }

    if ($killed.Count -eq 0) { Fail "no processes were terminated" }
    Out-Result @{ ok = $true; killed = @($killed); count = $killed.Count }
} catch {
    Fail "kill_process failed: $($_.Exception.Message)"
}
