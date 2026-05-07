# com-outlook-upcoming.ps1
# List upcoming Outlook calendar events.
# Args: -daysAhead (default 7), -count (default 20)
# Outputs JSON on the last line.

param(
    [int]$daysAhead = 7,
    [int]$count = 20
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ($daysAhead -lt 1) { $daysAhead = 1 }
if ($daysAhead -gt 90) { $daysAhead = 90 }
if ($count -lt 1) { $count = 1 }
if ($count -gt 100) { $count = 100 }

# v0.11.29 — pre-flight: distinguish absent-Outlook from new-Outlook (olk.exe).
. "$PSScriptRoot\_outlook-com-precheck.ps1"
$check = Test-OutlookComAvailable
if (-not $check.available) { Fail-Outlook $check }

$outlook = $null
$ns = $null
try {
    $outlook = New-Object -ComObject Outlook.Application -ErrorAction Stop
    $ns = $outlook.GetNamespace("MAPI")
    $cal = $ns.GetDefaultFolder(9)  # 9 = olFolderCalendar
    $items = $cal.Items
    $items.IncludeRecurrences = $true
    $items.Sort("[Start]")

    $now = Get-Date
    $end = $now.AddDays($daysAhead)
    # Format dates with quotes — Outlook DASL filter syntax requires this exact format.
    $filter = "[Start] >= '" + $now.ToString("g") + "' AND [Start] <= '" + $end.ToString("g") + "'"
    $filtered = $items.Restrict($filter)

    $events = @()
    $i = 0
    foreach ($item in $filtered) {
        if ($events.Count -ge $count) { break }
        $i++
        if ($i -gt 200) { break }
        try {
            $events += @{
                subject = "$($item.Subject)"
                start = $item.Start.ToString("o")
                end = $item.End.ToString("o")
                durationMin = [int]$item.Duration
                location = "$($item.Location)"
                organizer = "$($item.Organizer)"
                isMeeting = ($item.MeetingStatus -ne 0)
            }
        } catch { continue }
    }

    Out-Result @{
        ok = $true
        daysAhead = $daysAhead
        count = $events.Count
        events = $events
    }
} catch {
    Fail "outlook_upcoming failed: $($_.Exception.Message). Outlook may not be installed."
} finally {
    if ($ns) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ns) | Out-Null }
    if ($outlook) { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($outlook) | Out-Null }
}
