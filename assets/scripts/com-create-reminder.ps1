# com-create-reminder.ps1
# Args: $title, $datetime (ISO 8601), $notes (optional)
# Outputs JSON on the last line.

param(
    [string]$title    = "",
    [string]$datetime = "",
    [string]$notes    = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

# Validate required args
if ([string]::IsNullOrWhiteSpace($title))    { Fail "title is required" }
if ([string]::IsNullOrWhiteSpace($datetime)) { Fail "datetime is required" }

# Parse and validate datetime
try {
    $triggerTime = [datetime]::Parse($datetime, [System.Globalization.CultureInfo]::InvariantCulture)
} catch {
    Fail "Invalid datetime format '$datetime'. Expected ISO 8601 e.g. 2026-05-01T15:00:00"
}

if ($triggerTime -lt [datetime]::Now) {
    Fail "datetime '$datetime' is in the past"
}

# Sanitise strings to avoid COM injection via single-quote in embedded PS command
$safeTitle = $title -replace "'", "``'"
$safeNotes = $notes -replace "'", "``'"

$taskName = "ClippyReminder_$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

try {
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()

    $folder = $svc.GetFolder("\")

    $taskDef = $svc.NewTask(0)

    # --- Principal (run only when logged on, interactive) ---
    $taskDef.Principal.LogonType = 3   # TASK_LOGON_INTERACTIVE_TOKEN

    # --- Settings ---
    $settings = $taskDef.Settings
    $settings.Enabled             = $true
    $settings.Hidden              = $false
    $settings.ExecutionTimeLimit  = "PT1M"
    $settings.StartWhenAvailable  = $true
    # DeleteExpiredTaskAfter requires an EndBoundary on the trigger; set after trigger is created.

    # --- Trigger: time-based (type 1) ---
    $trigger = $taskDef.Triggers.Create(1)   # TASK_TRIGGER_TIME
    $trigger.StartBoundary = $triggerTime.ToString("yyyy-MM-ddTHH:mm:ss")
    $trigger.EndBoundary   = $triggerTime.AddHours(1).ToString("yyyy-MM-ddTHH:mm:ss")
    $trigger.Enabled       = $true

    # Now safe to set DeleteExpiredTaskAfter
    $settings.DeleteExpiredTaskAfter = "PT1H"

    # --- Action: show a MessageBox via PowerShell ---
    $action = $taskDef.Actions.Create(0)     # TASK_ACTION_EXEC
    $action.Path      = "powershell.exe"
    $action.Arguments = "-WindowStyle Hidden -Command `"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('$safeNotes', '$safeTitle')`""

    # --- Register ---
    # 6 = TASK_CREATE_OR_UPDATE, 3 = TASK_LOGON_INTERACTIVE_TOKEN
    $folder.RegisterTaskDefinition($taskName, $taskDef, 6, $null, $null, 3) | Out-Null

    Out-Result @{
        ok           = $true
        taskName     = $taskName
        scheduledFor = $triggerTime.ToString("o")
    }
} catch {
    Fail "Failed to create scheduled task: $($_.Exception.Message)"
}
