# com-outlook-send-email.ps1
# Sends an email via Outlook COM. Requires Outlook installed + signed in.
#
# v0.11.22 — Accepts subject + body as base64-encoded UTF-8 to bypass
# PowerShell's command-line tokenizer. Multi-line bodies (\n\n), em-dashes,
# smart quotes, and other Unicode were previously truncated when passed as
# raw -body args because the OS-level command line splits on newlines.
# Old -subject/-body params kept for back-compat in case any caller hasn't
# updated; they trigger a deprecation warning to stderr.
#
# Args:
#   -to            (required, comma-separated)
#   -subjectB64    (preferred) base64-encoded UTF-8 subject
#   -bodyB64       (preferred) base64-encoded UTF-8 body
#   -subject       (deprecated) raw subject
#   -body          (deprecated) raw body
#   -cc            (optional, comma-separated)
#   -attachments   (optional, comma-separated absolute paths)
#
# Outputs JSON on the last line. Always emits {ok:true,...} or {ok:false,error:...}.

param(
    [string]$to = "",
    [string]$subject = "",
    [string]$body = "",
    [string]$subjectB64 = "",
    [string]$bodyB64 = "",
    [string]$cc = "",
    [string]$attachments = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

# Decode base64 inputs if provided (preferred path)
if ($subjectB64) {
    try {
        $subject = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($subjectB64))
    } catch {
        Fail "subjectB64 decode failed: $($_.Exception.Message)"
    }
}
if ($bodyB64) {
    try {
        $body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($bodyB64))
    } catch {
        Fail "bodyB64 decode failed: $($_.Exception.Message)"
    }
}

if ([string]::IsNullOrWhiteSpace($to)) { Fail "to is required" }
if ([string]::IsNullOrWhiteSpace($subject)) { Fail "subject is required (or subjectB64)" }
if ([string]::IsNullOrWhiteSpace($body)) { Fail "body is required (or bodyB64)" }

# v0.11.29 — pre-flight: distinguish absent-Outlook from new-Outlook (olk.exe)
# so the model gets an actionable error instead of "Outlook may not be installed"
# when the user clearly has Outlook just not the COM-capable build.
. "$PSScriptRoot\_outlook-com-precheck.ps1"
$check = Test-OutlookComAvailable
if (-not $check.available) { Fail-Outlook $check }

$outlook = $null
$mail = $null
try {
    $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop
    $mail = $outlook.CreateItem(0)  # 0 = olMailItem
    $mail.To = $to
    $mail.Subject = $subject
    $mail.Body = $body
    if (-not [string]::IsNullOrWhiteSpace($cc)) { $mail.CC = $cc }
    if (-not [string]::IsNullOrWhiteSpace($attachments)) {
        foreach ($p in $attachments.Split(',')) {
            $ap = $p.Trim()
            if ($ap -and (Test-Path $ap)) { $mail.Attachments.Add($ap) | Out-Null }
        }
    }
    $mail.Send()
    Out-Result @{
        ok = $true
        to = $to
        subject = $subject
        sent = $true
    }
} catch {
    Fail "outlook_send_email failed: $($_.Exception.Message). Outlook may not be installed or signed in."
} finally {
    if ($mail) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($mail) | Out-Null }
    if ($outlook) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($outlook) | Out-Null }
}
