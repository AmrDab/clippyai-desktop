# com-list-files.ps1
# List files and folders in a directory.
# Args: -path (required), -filter (default *), -recurse (true/false, default false), -top (default 100)
# Outputs JSON on the last line.

param(
    [string]$path = "",
    [string]$filter = "*",
    [string]$recurse = "false",
    [int]$top = 100
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($path)) { Fail "path is required" }
if ($path.StartsWith('~')) { $path = $path -replace '^~', $env:USERPROFILE }
$path = [System.Environment]::ExpandEnvironmentVariables($path)
$path = $path.Replace('/', '\')

# v0.12.3 — block enumeration of system dirs and user-secret dirs
# (~/.ssh, browser cookie/login DBs, etc). Per security audit finding #3.
. "$PSScriptRoot\_path-guard.ps1"
$guard = Test-PathAllowedForRead $path
if (-not $guard.allowed) {
    Out-Result @{ ok = $false; error = 'path_blocked'; reason = $guard.reason; resolved = $guard.resolved }
    exit 1
}
$path = $guard.resolved

if (-not (Test-Path $path)) { Fail "path not found: $path" }
if (-not (Get-Item $path).PSIsContainer) { Fail "path is a file, not a directory" }

if ($top -lt 1) { $top = 1 }
if ($top -gt 1000) { $top = 1000 }
$doRecurse = ($recurse -eq "true" -or $recurse -eq "1")

try {
    $params = @{ Path = $path; Filter = $filter; Force = $false; ErrorAction = 'SilentlyContinue' }
    if ($doRecurse) { $params.Recurse = $true }
    $items = Get-ChildItem @params | Select-Object -First $top

    $entries = @()
    foreach ($it in $items) {
        $entries += @{
            name = $it.Name
            fullPath = $it.FullName
            isDir = $it.PSIsContainer
            sizeBytes = if ($it.PSIsContainer) { $null } else { [int64]$it.Length }
            modified = $it.LastWriteTime.ToString("o")
        }
    }

    Out-Result @{
        ok = $true
        path = $path
        filter = $filter
        recurse = $doRecurse
        count = $entries.Count
        entries = $entries
    }
} catch {
    Fail "list_files failed: $($_.Exception.Message)"
}
