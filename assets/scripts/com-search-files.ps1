# com-search-files.ps1
# Searches file contents for a pattern.
# Args: -pattern (required), -path (default ~), -glob (default *.txt,*.md,*.csv,*.log,*.json,*.ps1,*.py,*.js,*.ts)
# Outputs JSON on the last line.

param(
    [string]$pattern = "",
    [string]$path = "",
    [string]$glob = "*.txt,*.md,*.csv,*.log,*.json,*.ps1,*.py,*.js,*.ts,*.html,*.xml"
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($pattern)) { Fail "pattern is required" }

if ([string]::IsNullOrWhiteSpace($path)) {
    $path = $env:USERPROFILE
}
if ($path.StartsWith('~')) { $path = $path -replace '^~', $env:USERPROFILE }
$path = [System.Environment]::ExpandEnvironmentVariables($path)
$path = $path.Replace('/', '\')

# v0.12.3 — block recursive content search through system + secret dirs.
# Per security audit finding #3: a model-driven `search_files_content` could
# previously scan C:\ and return content snippets from any world-readable
# file (browser SQLite DBs, jump lists, etc).
. "$PSScriptRoot\_path-guard.ps1"
$guard = Test-PathAllowedForRead $path
if (-not $guard.allowed) {
    Out-Result @{ ok = $false; error = 'path_blocked'; reason = $guard.reason; resolved = $guard.resolved }
    exit 1
}
$path = $guard.resolved

if (-not (Test-Path $path)) { Fail "path not found: $path" }

$globs = $glob.Split(',') | ForEach-Object { $_.Trim() }
$matchesList = @()
$filesScanned = 0
$maxResults = 30
$maxFiles = 2000

try {
    $files = Get-ChildItem -Path $path -Recurse -File -Include $globs -ErrorAction SilentlyContinue |
             Select-Object -First $maxFiles
    foreach ($f in $files) {
        $filesScanned++
        try {
            $hits = Select-String -Path $f.FullName -Pattern $pattern -SimpleMatch -ErrorAction SilentlyContinue |
                    Select-Object -First 3
            foreach ($h in $hits) {
                if ($matchesList.Count -ge $maxResults) { break }
                $line = $h.Line.Trim()
                if ($line.Length -gt 200) { $line = $line.Substring(0, 200) + "..." }
                $matchesList += @{
                    file = $h.Path
                    lineNumber = $h.LineNumber
                    line = $line
                }
            }
        } catch { continue }
        if ($matchesList.Count -ge $maxResults) { break }
    }
    Out-Result @{
        ok = $true
        pattern = $pattern
        searchPath = $path
        filesScanned = $filesScanned
        matchCount = $matchesList.Count
        matches = $matchesList
    }
} catch {
    Fail "search_files failed: $($_.Exception.Message)"
}
