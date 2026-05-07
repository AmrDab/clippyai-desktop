# com-outlook-create-event.ps1
# Create a calendar event via Outlook COM. Requires Outlook installed.
# Args: -subject (required), -start (ISO 8601, required), -durationMin (default 30), -attendees (optional, comma-separated emails), -location (optional), -body (optional)
# Outputs JSON on the last line.

param(
    [string]$subject     = "",
    [string]$subjectB64  = "",
    [string]$start       = "",
    [int]$durationMin    = 30,
    [string]$attendees   = "",
    [string]$location    = "",
    [string]$locationB64 = "",
    [string]$body        = "",
    [string]$bodyB64     = ""
)

# v0.11.25 — accept base64-encoded variants for any string param that
# might contain newlines or special chars. PowerShell command-line
# tokenizer splits on embedded newlines and breaks on special quotes.
if ($subjectB64)  { try { $subject  = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($subjectB64))  } catch { } }
if ($locationB64) { try { $location = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($locationB64)) } catch { } }
if ($bodyB64)     { try { $body     = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($bodyB64))     } catch { } }

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($subject)) { Fail "subject is required" }
if ([string]::IsNullOrWhiteSpace($start)) { Fail "start is required (ISO 8601)" }
if ($durationMin -lt 1) { $durationMin = 30 }

try {
    $startTime = [datetime]::Parse($start, [System.Globalization.CultureInfo]::InvariantCulture)
} catch {
    Fail "Invalid start datetime '$start'"
}

# v0.11.29 — pre-flight: distinguish absent-Outlook from new-Outlook (olk.exe).
. "$PSScriptRoot\_outlook-com-precheck.ps1"
$check = Test-OutlookComAvailable
if (-not $check.available) { Fail-Outlook $check }

$outlook = $null
$item = $null
try {
    $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop
    $item = $outlook.CreateItem(1)  # 1 = olAppointmentItem
    $item.Subject = $subject
    $item.Start = $startTime
    $item.Duration = $durationMin
    if (-not [string]::IsNullOrWhiteSpace($location)) { $item.Location = $location }
    if (-not [string]::IsNullOrWhiteSpace($body)) { $item.Body = $body }

    if (-not [string]::IsNullOrWhiteSpace($attendees)) {
        $item.MeetingStatus = 1  # olMeeting
        foreach ($addr in $attendees.Split(',')) {
            $clean = $addr.Trim()
            if ($clean) {
                $recip = $item.Recipients.Add($clean)
                $recip.Type = 1  # olRequired
            }
        }
        $item.Recipients.ResolveAll() | Out-Null
    }
    $item.Save()

    Out-Result @{
        ok = $true
        subject = $subject
        start = $startTime.ToString("o")
        durationMin = $durationMin
        location = $location
        attendees = $attendees
        sentInvite = (-not [string]::IsNullOrWhiteSpace($attendees))
    }
} catch {
    Fail "outlook_create_event failed: $($_.Exception.Message). Outlook may not be installed."
} finally {
    if ($item) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($item) | Out-Null }
    if ($outlook) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($outlook) | Out-Null }
}
