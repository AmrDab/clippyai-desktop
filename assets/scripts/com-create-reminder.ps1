# com-create-reminder.ps1
#
# Args:
#   -title         (or -titleB64)  required
#   -datetime                        required, ISO 8601
#   -notes         (or -notesB64)  optional
#
# Outputs JSON on the last line.
#
# v0.11.25 — security fix: the previous implementation embedded user-
# supplied $title and $notes directly into a -Command string via single-
# quote escaping (`''` doubling). That escaping was insufficient — a
# notes string of `''); calc.exe; #` would close the quoted argument
# and execute the trailing command. Per Subagent A audit (May 7) this
# was a P0 cmd-injection vector. The fix: write title + notes to a
# JSON sidecar file in temp; schedule the task to invoke a separate
# helper script (show-reminder.ps1) that reads the JSON. Arguments now
# contain only paths we control.
#
# Also accepts -titleB64 / -notesB64 (base64 UTF-8) for callers that
# need to pass arbitrary text containing newlines or special chars
# without going through the OS command line tokenizer.

param(
    [string]$title    = "",
    [string]$titleB64 = "",
    [string]$datetime = "",
    [string]$notes    = "",
    [string]$notesB64 = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

# Decode base64 inputs if provided
if ($titleB64) {
    try { $title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($titleB64)) }
    catch { Fail "titleB64 decode failed: $($_.Exception.Message)" }
}
if ($notesB64) {
    try { $notes = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($notesB64)) }
    catch { Fail "notesB64 decode failed: $($_.Exception.Message)" }
}

if ([string]::IsNullOrWhiteSpace($title))    { Fail "title is required (or titleB64)" }
if ([string]::IsNullOrWhiteSpace($datetime)) { Fail "datetime is required" }

try {
    $triggerTime = [datetime]::Parse($datetime, [System.Globalization.CultureInfo]::InvariantCulture)
} catch {
    Fail "Invalid datetime format '$datetime'. Expected ISO 8601 e.g. 2026-05-01T15:00:00"
}

if ($triggerTime -lt [datetime]::Now) {
    Fail "datetime '$datetime' is in the past"
}

# Sidecar JSON: title + notes go here, never into a re-parsed command line.
$dataFile = Join-Path $env:TEMP ("clippy-reminder-" + [System.Guid]::NewGuid().ToString('N') + ".json")
try {
    @{ title = $title; notes = $notes } | ConvertTo-Json -Compress | Set-Content -LiteralPath $dataFile -Encoding UTF8
} catch {
    Fail "failed to write reminder sidecar: $($_.Exception.Message)"
}

# Locate the helper script next to this one.
$showScript = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'show-reminder.ps1'
if (-not (Test-Path -LiteralPath $showScript)) {
    Fail "show-reminder.ps1 not found alongside com-create-reminder.ps1"
}

$taskName = "ClippyReminder_$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

$svc = $null
try {
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()

    $folder = $svc.GetFolder("\")
    $taskDef = $svc.NewTask(0)

    # Principal: run when interactive user logged on
    $taskDef.Principal.LogonType = 3  # TASK_LOGON_INTERACTIVE_TOKEN

    $settings = $taskDef.Settings
    $settings.Enabled             = $true
    $settings.Hidden              = $false
    $settings.ExecutionTimeLimit  = "PT5M"
    $settings.StartWhenAvailable  = $true

    $trigger = $taskDef.Triggers.Create(1)  # TASK_TRIGGER_TIME
    $trigger.StartBoundary = $triggerTime.ToString("yyyy-MM-ddTHH:mm:ss")
    $trigger.EndBoundary   = $triggerTime.AddHours(1).ToString("yyyy-MM-ddTHH:mm:ss")
    $trigger.Enabled       = $true

    $settings.DeleteExpiredTaskAfter = "PT1H"

    # Action: invoke the helper script. Arguments are quoted paths only —
    # no user input is interpolated into a command-line string. The
    # helper reads title + notes from the JSON sidecar.
    $action = $taskDef.Actions.Create(0)  # TASK_ACTION_EXEC
    $action.Path      = "powershell.exe"
    $action.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$showScript`" -DataFile `"$dataFile`""

    # 6 = TASK_CREATE_OR_UPDATE
    $folder.RegisterTaskDefinition($taskName, $taskDef, 6, $null, $null, 3) | Out-Null

    Out-Result @{
        ok           = $true
        taskName     = $taskName
        scheduledFor = $triggerTime.ToString("o")
    }
} catch {
    # Clean up sidecar on registration failure
    try { Remove-Item -LiteralPath $dataFile -Force -ErrorAction SilentlyContinue } catch {}
    Fail "Failed to create scheduled task: $($_.Exception.Message)"
} finally {
    if ($svc) { try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($svc) | Out-Null } catch {} }
}
