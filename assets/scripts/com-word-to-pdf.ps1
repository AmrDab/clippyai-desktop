# com-word-to-pdf.ps1
# Converts a Word document to PDF via COM.
# Args: -input (required), -output (optional, default same dir + .pdf)
# Outputs JSON on the last line.

param(
    [string]$inputPath = "",
    [string]$outputPath = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($inputPath)) { Fail "input is required" }
if ($inputPath.StartsWith('~')) { $inputPath = $inputPath -replace '^~', $env:USERPROFILE }
$inputPath = [System.Environment]::ExpandEnvironmentVariables($inputPath)
$inputPath = $inputPath.Replace('/', '\')

# 0.24.12 - same read guard as read_file / list_files: no UNC path (opening one
# makes Windows authenticate to the server it names), no credential folders.
. "$PSScriptRoot\_path-guard.ps1"
$guard = Test-PathAllowedForRead $inputPath
if (-not $guard.allowed) { Fail "path not allowed: $($guard.reason)" }

if (-not (Test-Path $inputPath)) { Fail "input file not found: $inputPath" }
$ext = [System.IO.Path]::GetExtension($inputPath).ToLower()
if ($ext -notin @('.docx','.doc','.rtf','.txt','.odt')) { Fail "not a Word-compatible file: $ext" }

if ([string]::IsNullOrWhiteSpace($outputPath)) {
    $outputPath = [System.IO.Path]::ChangeExtension($inputPath, '.pdf')
}
if ($outputPath.StartsWith('~')) { $outputPath = $outputPath -replace '^~', $env:USERPROFILE }
$outputPath = [System.Environment]::ExpandEnvironmentVariables($outputPath)
$outputPath = $outputPath.Replace('/', '\')
$outGuard = Test-PathAllowedForRead $outputPath
if (-not $outGuard.allowed) { Fail "output path not allowed: $($outGuard.reason)" }

$word = $null
$doc = $null
try {
    $word = New-Object -ComObject Word.Application -ErrorAction Stop
    $word.Visible = $false
    # 3 = msoAutomationSecurityForceDisable: a workbook or document opened by
    # Clippy never runs its macros (Workbook_Open / AutoOpen), whatever the
    # user's own macro setting is.
    $word.AutomationSecurity = 3
    $doc = $word.Documents.Open($inputPath, $false, $true)  # ReadOnly=true
    $doc.SaveAs2($outputPath, 17)  # 17 = wdFormatPDF
    $size = (Get-Item $outputPath).Length
    Out-Result @{
        ok = $true
        input = $inputPath
        output = $outputPath
        bytes = [int]$size
    }
} catch {
    Fail "word_to_pdf failed: $($_.Exception.Message). Word may not be installed."
} finally {
    if ($doc) { $doc.Close($false) | Out-Null; [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null }
    if ($word) { $word.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
