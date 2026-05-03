# com-kill-process.ps1
# Terminate a process by PID or by name.
# Args: -procPid (optional, int) OR -name (optional, string). One required.
# Outputs JSON on the last line.

param(
    [int]$procPid = 0,
    [string]$name = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ($procPid -eq 0 -and [string]::IsNullOrWhiteSpace($name)) {
    Fail "either pid or name is required"
}

# Whitelist sanity — never let the model kill OS-critical processes.
$BLOCKLIST = @('system','smss','csrss','wininit','services','lsass','winlogon','dwm','explorer','svchost','clippyai','clippy','electron')

try {
    $killed = @()
    if ($procPid -gt 0) {
        $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
        if (-not $proc) { Fail "no process with PID $procPid" }
        $pname = $proc.ProcessName.ToLower()
        if ($BLOCKLIST -contains $pname) { Fail "refusing to kill protected process '$pname'" }
        Stop-Process -Id $procPid -Force -ErrorAction Stop
        $killed += @{ pid = $procPid; name = $proc.ProcessName }
    } else {
        $cleanName = $name.Trim().ToLower() -replace '\.exe$', ''
        if ($BLOCKLIST -contains $cleanName) { Fail "refusing to kill protected process '$cleanName'" }
        $matches = Get-Process -Name $cleanName -ErrorAction SilentlyContinue
        if (-not $matches) { Fail "no process named '$cleanName'" }
        foreach ($p in $matches) {
            try {
                Stop-Process -Id $p.Id -Force -ErrorAction Stop
                $killed += @{ pid = $p.Id; name = $p.ProcessName }
            } catch { continue }
        }
    }

    if ($killed.Count -eq 0) { Fail "no processes were terminated" }
    Out-Result @{ ok = $true; killed = $killed; count = $killed.Count }
} catch {
    Fail "kill_process failed: $($_.Exception.Message)"
}
