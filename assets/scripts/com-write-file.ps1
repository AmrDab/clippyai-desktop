# com-write-file.ps1
# Args: $path, $content, $mode ("create" | "append" | "overwrite")
# Outputs JSON on the last line.

param(
    [string]$path    = "",
    [string]$content = "",
    [string]$mode    = "create"
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($path)) { Fail "path is required" }

$validModes = @('create','append','overwrite')
if ($validModes -notcontains $mode.ToLower()) {
    Fail "Invalid mode '$mode'. Must be one of: create, append, overwrite"
}
$mode = $mode.ToLower()

# Expand ~ and env vars
$path = $path.Trim('"').Trim("'")
if ($path.StartsWith('~')) {
    $path = $path -replace '^~', $env:USERPROFILE
}
$path = [System.Environment]::ExpandEnvironmentVariables($path)
$path = $path.Replace('/', '\')

try {
    $resolved = [System.IO.Path]::GetFullPath($path)
} catch {
    Fail "Cannot resolve path: $($_.Exception.Message)"
}

# Guard against system directories
$blockedPrefixes = @(
    "$env:SystemRoot\",            # C:\Windows\
    "$env:ProgramFiles\",          # C:\Program Files\
    "${env:ProgramFiles(x86)}\",   # C:\Program Files (x86)\
    "$env:SystemDrive\Windows\",
    "$env:SystemDrive\System32\"
)

foreach ($prefix in $blockedPrefixes) {
    if ($resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Fail "Writes to system directory '$prefix' are not allowed for safety reasons."
    }
}

# Block registry-adjacent paths (hive files sitting in Windows dir already caught above,
# but guard common root hive names explicitly)
$blockedNames = @('NTUSER.DAT','SAM','SECURITY','SOFTWARE','SYSTEM','DEFAULT','USRCLASS.DAT')
$fileName = [System.IO.Path]::GetFileName($resolved)
if ($blockedNames -contains $fileName.ToUpper()) {
    Fail "Writing to registry hive file '$fileName' is not allowed."
}

# Ensure parent directory exists
$parentDir = [System.IO.Path]::GetDirectoryName($resolved)
if (-not [System.IO.Directory]::Exists($parentDir)) {
    try {
        [System.IO.Directory]::CreateDirectory($parentDir) | Out-Null
    } catch {
        Fail "Cannot create directory '$parentDir': $($_.Exception.Message)"
    }
}

$encoding = [System.Text.Encoding]::UTF8

try {
    switch ($mode) {
        'create' {
            if ([System.IO.File]::Exists($resolved)) {
                Fail "File already exists at '$resolved'. Use mode=overwrite to replace it."
            }
            [System.IO.File]::WriteAllText($resolved, $content, $encoding)
        }
        'overwrite' {
            [System.IO.File]::WriteAllText($resolved, $content, $encoding)
        }
        'append' {
            # Add newline separator if file exists and is non-empty
            if ([System.IO.File]::Exists($resolved) -and (New-Object System.IO.FileInfo($resolved)).Length -gt 0) {
                [System.IO.File]::AppendAllText($resolved, "`n" + $content, $encoding)
            } else {
                [System.IO.File]::AppendAllText($resolved, $content, $encoding)
            }
        }
    }
} catch {
    Fail "Failed to write file: $($_.Exception.Message)"
}

$bytesWritten = (New-Object System.IO.FileInfo($resolved)).Length

Out-Result @{
    ok           = $true
    path         = $resolved
    bytesWritten = [int]$bytesWritten
    mode         = $mode
}
