# com-speak-text.ps1
# Speaks text via Windows SAPI text-to-speech.
# Args: -text (required), -rate (optional, -10..10, default 0)
# Outputs JSON on the last line.

param(
    [string]$text    = "",
    [string]$textB64 = "",
    [int]$rate       = 0
)

# v0.11.25 — base64 variant. Spoken text is often a verbatim quote of
# user input or model output, which routinely contains punctuation that
# breaks the PS tokenizer.
if ($textB64) {
    try { $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($textB64)) }
    catch { }
}

# Add COM cleanup that the previous version was missing — SAPI in async
# mode keeps speaking after the COM object is released, so this is
# safe to do immediately.
$voice = $null

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($text)) { Fail "text is required" }
if ($text.Length -gt 1000) { $text = $text.Substring(0, 1000) }
if ($rate -lt -10) { $rate = -10 }
if ($rate -gt 10) { $rate = 10 }

try {
    $voice = New-Object -ComObject SAPI.SpVoice
    $voice.Rate = $rate
    # 1 = SVSFlagsAsync — return immediately, don't block tool call
    $voice.Speak($text, 1) | Out-Null
    Out-Result @{ ok = $true; spoken = $text.Substring(0, [Math]::Min(80, $text.Length)); chars = $text.Length }
} catch {
    Fail "speak_text failed: $($_.Exception.Message)"
} finally {
    if ($voice) { try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($voice) | Out-Null } catch {} }
}
