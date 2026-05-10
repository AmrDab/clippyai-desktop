# zip-files.ps1
# v0.12.4 — Compress files/folders into a ZIP archive.
# Args:
#   -inputs    (required) comma-separated absolute paths to include
#   -output    (required) destination .zip path
#   -overwrite (optional, "true" to replace existing zip)
# Outputs JSON: {ok:true, zip:<path>, bytes:<n>, items:<n>} or {ok:false, error:<code>}

param(
    [string]$inputs = "",
    [string]$output = "",
    [string]$overwrite = "false"
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 3) }
function Fail($code, $msg) { Out-Result @{ ok = $false; error = $code; message = $msg }; exit 1 }

if ([string]::IsNullOrWhiteSpace($inputs)) { Fail 'missing_inputs' 'inputs is required (comma-separated paths)' }
if ([string]::IsNullOrWhiteSpace($output)) { Fail 'missing_output' 'output is required (.zip path)' }

# Path-guard the output destination so the model can't write into system dirs.
. "$PSScriptRoot\_path-guard.ps1"
$outGuard = Test-PathAllowedForRead (Split-Path -Path $output -Parent)
if (-not $outGuard.allowed) {
    Fail 'path_blocked' ("Output dir blocked: " + $outGuard.reason)
}

# Resolve inputs and reject any blocked paths
$inputList = @()
foreach ($p in $inputs.Split(',')) {
    $p = $p.Trim()
    if (-not $p) { continue }
    $g = Test-PathAllowedForRead $p
    if (-not $g.allowed) { Fail 'path_blocked' ("Input blocked: " + $g.reason) }
    if (-not (Test-Path $g.resolved)) { Fail 'input_not_found' ("Input not found: " + $g.resolved) }
    $inputList += $g.resolved
}
if ($inputList.Count -eq 0) { Fail 'missing_inputs' 'no valid inputs after parsing' }

if ((Test-Path $output) -and ($overwrite -ne 'true')) {
    Fail 'output_exists' "Output already exists; pass overwrite=true to replace"
}
if (Test-Path $output) { Remove-Item -Path $output -Force -ErrorAction SilentlyContinue }

try {
    Compress-Archive -Path $inputList -DestinationPath $output -Force -ErrorAction Stop
} catch {
    Fail 'compress_failed' ("Compress-Archive: " + $_.Exception.Message)
}

if (-not (Test-Path $output)) { Fail 'compress_failed' 'archive was not created' }
$info = Get-Item -Path $output
Out-Result @{
    ok = $true
    zip = $output
    bytes = [int64]$info.Length
    items = $inputList.Count
}
