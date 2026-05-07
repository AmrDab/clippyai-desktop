# com-outlook-read-inbox.ps1
# Reads recent emails from Outlook inbox.
# Args: -count (default 10, max 50), -unreadOnly (default false)
# Outputs JSON on the last line.

param(
    [int]$count = 10,
    [string]$unreadOnly = "false"
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ($count -lt 1) { $count = 1 }
if ($count -gt 50) { $count = 50 }
$onlyUnread = ($unreadOnly -eq "true" -or $unreadOnly -eq "1")

# v0.11.29 — pre-flight: distinguish absent-Outlook from new-Outlook (olk.exe).
. "$PSScriptRoot\_outlook-com-precheck.ps1"
$check = Test-OutlookComAvailable
if (-not $check.available) { Fail-Outlook $check }

$outlook = $null
$ns = $null
try {
    $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop
    $ns = $outlook.GetNamespace("MAPI")
    $inbox = $ns.GetDefaultFolder(6)  # 6 = olFolderInbox
    $items = $inbox.Items
    $items.Sort("[ReceivedTime]", $true)  # descending

    $emails = @()
    $i = 0
    foreach ($item in $items) {
        if ($emails.Count -ge $count) { break }
        $i++
        if ($i -gt 200) { break }  # safety cap
        if ($onlyUnread -and -not $item.UnRead) { continue }
        try {
            $emails += @{
                from = "$($item.SenderName) <$($item.SenderEmailAddress)>"
                subject = "$($item.Subject)"
                received = $item.ReceivedTime.ToString("yyyy-MM-ddTHH:mm:ss")
                unread = [bool]$item.UnRead
                preview = if ($item.Body) { $item.Body.Substring(0, [Math]::Min(200, $item.Body.Length)) -replace "`r`n", " " } else { "" }
            }
        } catch { continue }
    }

    Out-Result @{
        ok = $true
        count = $emails.Count
        unreadOnly = $onlyUnread
        emails = $emails
    }
} catch {
    Fail "outlook_read_inbox failed: $($_.Exception.Message). Outlook may not be installed or signed in."
} finally {
    if ($ns) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ns) | Out-Null }
    if ($outlook) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($outlook) | Out-Null }
}
