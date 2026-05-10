# hash-file.ps1
# v0.12.4 — Return a cryptographic hash of a file on disk.
# Args:
#   -path  (required)
#   -algo  (optional, default SHA256). Allowed: SHA256, SHA1, MD5, SHA384, SHA512
# Outputs JSON: {ok:true, path:<p>, algo:<n>, hash:<hex>, bytes:<n>}
#               or {ok:false, error:<code>}

param(
    [string]$path = "",
    [string]$algo = "SHA256"
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 3) }
function Fail($code, $msg) { Out-Result @{ ok = $false; error = $code; message = $msg }; exit 1 }

if ([string]::IsNullOrWhiteSpace($path)) { Fail 'missing_path' 'path is required' }

$allowedAlgos = @('SHA256','SHA1','MD5','SHA384','SHA512')
$algo = $algo.ToUpper()
if ($allowedAlgos -notcontains $algo) {
    Fail 'invalid_algo' "algo must be one of: $($allowedAlgos -join ', ')"
}

. "$PSScriptRoot\_path-guard.ps1"
$g = Test-PathAllowedForRead $path
if (-not $g.allowed) { Fail 'path_blocked' ("Path blocked: " + $g.reason) }
$path = $g.resolved

if (-not (Test-Path $path -PathType Leaf)) { Fail 'not_found' "File not found: $path" }

try {
    $h = Get-FileHash -Path $path -Algorithm $algo -ErrorAction Stop
    $info = Get-Item -Path $path
    Out-Result @{
        ok = $true
        path = $path
        algo = $algo
        hash = $h.Hash.ToLower()
        bytes = [int64]$info.Length
    }
} catch {
    Fail 'hash_failed' "Get-FileHash: $($_.Exception.Message)"
}
