# com-outlook-send-email.ps1
# Sends an email via Outlook COM. Requires Outlook installed + signed in.
# Args: -to (required, comma-separated), -subject (required), -body (required), -cc (optional), -attachments (optional, comma-separated paths)
# Outputs JSON on the last line.

param(
    [string]$to = "",
    [string]$subject = "",
    [string]$body = "",
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

if ([string]::IsNullOrWhiteSpace($to)) { Fail "to is required" }
if ([string]::IsNullOrWhiteSpace($subject)) { Fail "subject is required" }
if ([string]::IsNullOrWhiteSpace($body)) { Fail "body is required" }

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
