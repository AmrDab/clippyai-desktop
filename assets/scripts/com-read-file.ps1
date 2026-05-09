# com-read-file.ps1
# Args: $path
# Outputs JSON on the last line.

param(
    [string]$path = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($path)) { Fail "path is required" }

# Allowed text extensions
$allowedExts = @('.txt','.md','.csv','.log','.json','.ps1','.py','.js','.ts','.html','.xml','.ini','.cfg','.bat')

# Binary/disallowed extensions with friendly message
$binaryExts = @('.exe','.dll','.pdf','.jpg','.jpeg','.png','.gif','.bmp','.zip','.tar','.gz','.7z','.rar','.mp3','.mp4','.mov','.docx','.xlsx','.pptx')

# Expand ~ and environment variables
$path = $path.Trim('"').Trim("'")
if ($path.StartsWith('~')) {
    $path = $path -replace '^~', $env:USERPROFILE
}
$path = [System.Environment]::ExpandEnvironmentVariables($path)

# Normalise separators
$path = $path.Replace('/', '\')

# v0.12.3 — block reads from system + secret dirs even when extension passes.
# Per security audit finding #3: extension allowlist alone didn't stop
# `read_file path=~/.ssh/id_rsa` (no extension → falls through ext check).
. "$PSScriptRoot\_path-guard.ps1"
$guard = Test-PathAllowedForRead $path
if (-not $guard.allowed) {
    Out-Result @{ ok = $false; error = 'path_blocked'; reason = $guard.reason; resolved = $guard.resolved }
    exit 1
}
$resolved = $guard.resolved

if (-not [System.IO.File]::Exists($resolved)) {
    Fail "File not found: $resolved"
}

$ext = [System.IO.Path]::GetExtension($resolved).ToLower()

if ($binaryExts -contains $ext) {
    Fail "Cannot read binary/document file type '$ext'. Only text files are supported."
}

if ($allowedExts -notcontains $ext -and $ext -ne '') {
    Fail "File type '$ext' is not in the allowed list: $($allowedExts -join ', ')"
}

$fileInfo = [System.IO.FileInfo]::new($resolved)
$sizeBytes = $fileInfo.Length
$maxBytes  = 100 * 1024   # 100 KB

if ($sizeBytes -gt $maxBytes) {
    Fail "File is too large ($sizeBytes bytes). Maximum allowed size is 100 KB (102400 bytes)."
}

try {
    $content = [System.IO.File]::ReadAllText($resolved, [System.Text.Encoding]::UTF8)
} catch {
    Fail "Failed to read file: $($_.Exception.Message)"
}

$lineCount = ($content -split "`n").Count

Out-Result @{
    ok        = $true
    content   = $content
    lines     = $lineCount
    sizeBytes = [int]$sizeBytes
}
