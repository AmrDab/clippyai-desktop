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

if (-not (Test-Path $inputPath)) { Fail "input file not found: $inputPath" }
$ext = [System.IO.Path]::GetExtension($inputPath).ToLower()
if ($ext -notin @('.docx','.doc','.rtf','.txt','.odt')) { Fail "not a Word-compatible file: $ext" }

if ([string]::IsNullOrWhiteSpace($outputPath)) {
    $outputPath = [System.IO.Path]::ChangeExtension($inputPath, '.pdf')
}
if ($outputPath.StartsWith('~')) { $outputPath = $outputPath -replace '^~', $env:USERPROFILE }
$outputPath = [System.Environment]::ExpandEnvironmentVariables($outputPath)
$outputPath = $outputPath.Replace('/', '\')

$word = $null
$doc = $null
try {
    $word = New-Object -ComObject Word.Application -ErrorAction Stop
    $word.Visible = $false
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
