# ocr-from-image.ps1
# v0.12.4 — Run Windows OCR on an image file from disk and return extracted text.
# Uses the Windows.Media.Ocr WinRT API (same engine as Snipping Tool / Snip & Sketch).
#
# Args:
#   -path  (required) absolute path to .png / .jpg / .bmp / .tiff
#   -lang  (optional) language tag like "en-US"; defaults to first available OCR language
# Outputs JSON: {ok:true, text:<full>, lines:[{text,bbox:{x,y,w,h}}], language:<tag>}
#               or {ok:false, error:<code>}

param(
    [string]$path = "",
    [string]$lang = ""
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 4) }
function Fail($code, $msg) { Out-Result @{ ok = $false; error = $code; message = $msg }; exit 1 }

if ([string]::IsNullOrWhiteSpace($path)) { Fail 'missing_path' 'path is required' }

. "$PSScriptRoot\_path-guard.ps1"
$g = Test-PathAllowedForRead $path
if (-not $g.allowed) { Fail 'path_blocked' ("Path blocked: " + $g.reason) }
$path = $g.resolved

if (-not (Test-Path $path -PathType Leaf)) { Fail 'not_found' "File not found: $path" }
$ext = [System.IO.Path]::GetExtension($path).ToLower()
$allowedExt = @('.png','.jpg','.jpeg','.bmp','.tif','.tiff')
if ($allowedExt -notcontains $ext) {
    Fail 'unsupported_format' "Only image files supported ($($allowedExt -join ', ')); got $ext"
}

# Load WinRT projections. WindowsRuntimeSystemExtensions provides Async->Task helpers.
try {
    [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
    Fail 'winrt_load_failed' "Failed to load WinRT OCR types: $($_.Exception.Message)"
}

# Helper: await a WinRT IAsyncOperation<T> from PowerShell.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
    $method = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $method.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

# Pick OCR engine (specific language if requested + available; else first available).
$engine = $null
try {
    if ($lang) {
        $langObj = New-Object Windows.Globalization.Language($lang)
        if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($langObj)) {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
        }
    }
    if (-not $engine) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
} catch {
    Fail 'engine_init_failed' "OcrEngine init failed: $($_.Exception.Message)"
}
if (-not $engine) {
    Fail 'no_ocr_language' 'No OCR language pack installed. Add one via Windows Settings > Time & language > Language > [Language] > Options > Optional language features > Add features > "Optical character recognition".'
}

# Read file → BitmapDecoder → SoftwareBitmap → engine.RecognizeAsync
try {
    $sfOp = [Windows.Storage.StorageFile]::GetFileFromPathAsync($path)
    $sf   = Await $sfOp ([Windows.Storage.StorageFile])
    $stream = Await ($sf.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} catch {
    Fail 'ocr_failed' "RecognizeAsync threw: $($_.Exception.Message)"
}

# Pack result. Cap line count to keep payload sane (~500 lines max).
$lines = @()
$count = 0
foreach ($line in $result.Lines) {
    if ($count -ge 500) { break }
    $minX = [double]::PositiveInfinity; $minY = [double]::PositiveInfinity
    $maxX = [double]::NegativeInfinity; $maxY = [double]::NegativeInfinity
    foreach ($w in $line.Words) {
        $b = $w.BoundingRect
        if ($b.X -lt $minX) { $minX = $b.X }
        if ($b.Y -lt $minY) { $minY = $b.Y }
        if ($b.X + $b.Width  -gt $maxX) { $maxX = $b.X + $b.Width }
        if ($b.Y + $b.Height -gt $maxY) { $maxY = $b.Y + $b.Height }
    }
    $bbox = if ([double]::IsInfinity($minX)) { $null } else {
        @{ x = [int]$minX; y = [int]$minY; w = [int]($maxX - $minX); h = [int]($maxY - $minY) }
    }
    $lines += @{ text = $line.Text; bbox = $bbox }
    $count++
}

Out-Result @{
    ok = $true
    text = $result.Text
    lines = $lines
    language = $engine.RecognizerLanguage.LanguageTag
    line_count = $count
}
