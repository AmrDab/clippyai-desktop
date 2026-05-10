# unzip-files.ps1
# v0.12.4 — Decompress a ZIP archive into a destination directory.
# Args:
#   -input     (required) .zip path
#   -output    (required) destination directory
#   -overwrite (optional, "true" to replace existing files at output)
# Outputs JSON: {ok:true, dir:<path>, items:<n>} or {ok:false, error:<code>}

param(
    [string]$input = "",
    [string]$output = "",
    [string]$overwrite = "false"
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 3) }
function Fail($code, $msg) { Out-Result @{ ok = $false; error = $code; message = $msg }; exit 1 }

if ([string]::IsNullOrWhiteSpace($input))  { Fail 'missing_input' 'input is required (.zip path)' }
if ([string]::IsNullOrWhiteSpace($output)) { Fail 'missing_output' 'output is required (directory)' }

. "$PSScriptRoot\_path-guard.ps1"
$inGuard = Test-PathAllowedForRead $input
if (-not $inGuard.allowed) { Fail 'path_blocked' ("Input blocked: " + $inGuard.reason) }
$outGuard = Test-PathAllowedForRead $output
if (-not $outGuard.allowed) { Fail 'path_blocked' ("Output blocked: " + $outGuard.reason) }

$input = $inGuard.resolved
$output = $outGuard.resolved

if (-not (Test-Path $input)) { Fail 'input_not_found' "Input file not found: $input" }
if ([System.IO.Path]::GetExtension($input).ToLower() -ne '.zip') {
    Fail 'not_a_zip' "Input must have .zip extension; got: $input"
}

if (-not (Test-Path $output)) {
    try { New-Item -ItemType Directory -Path $output -Force | Out-Null }
    catch { Fail 'mkdir_failed' "Failed to create output dir: $($_.Exception.Message)" }
}

try {
    Expand-Archive -Path $input -DestinationPath $output -Force:($overwrite -eq 'true') -ErrorAction Stop
} catch {
    # Expand-Archive throws on overwrite collision when -Force is false. Surface a clean error.
    if ($_.Exception.Message -match 'already exists') {
        Fail 'collision' "One or more files already exist at $output. Pass overwrite=true to replace."
    }
    Fail 'expand_failed' "Expand-Archive: $($_.Exception.Message)"
}

$count = (Get-ChildItem -Path $output -Recurse -File -ErrorAction SilentlyContinue).Count
Out-Result @{
    ok = $true
    dir = $output
    items = [int]$count
}
