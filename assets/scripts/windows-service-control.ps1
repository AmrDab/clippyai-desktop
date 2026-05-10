# windows-service-control.ps1
# v0.12.4 — Query / start / stop / restart a Windows service by name.
# Args:
#   -name    (required) service short name (e.g. "Spooler", "MSSQLSERVER")
#   -action  (required) one of: status | start | stop | restart
#
# Outputs JSON: {ok:true, name, action, status:"Running"|"Stopped"|...}
#               or {ok:false, error:<code>, message}
#
# Notes:
# - start / stop / restart require admin elevation. The script attempts the
#   action regardless and surfaces the exact error if elevation is missing
#   so the model can tell the user.
# - "status" is read-only and works without elevation.

param(
    [string]$name = "",
    [string]$action = "status"
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 3) }
function Fail($code, $msg) { Out-Result @{ ok = $false; error = $code; message = $msg }; exit 1 }

if ([string]::IsNullOrWhiteSpace($name))   { Fail 'missing_name' 'name is required' }
if ([string]::IsNullOrWhiteSpace($action)) { Fail 'missing_action' 'action is required' }

# Validate service name (alphanumeric + underscore + dash + dot, 1-256 chars)
# to prevent injection through Get-Service / Start-Service argument.
if ($name -notmatch '^[A-Za-z0-9_\-\.\$ ]{1,256}$') {
    Fail 'invalid_name' "Service name must be alphanumeric/underscore/dash/dot/space; got: $name"
}

$action = $action.ToLower()
$validActions = @('status','start','stop','restart')
if ($validActions -notcontains $action) {
    Fail 'invalid_action' "action must be one of: $($validActions -join ', ')"
}

$svc = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $svc) {
    Fail 'not_found' "Service '$name' not found. Use list_processes or check exact name in services.msc."
}

try {
    switch ($action) {
        'status'  { }   # already have $svc
        'start'   { Start-Service   -Name $name -ErrorAction Stop; $svc.Refresh() }
        'stop'    { Stop-Service    -Name $name -Force -ErrorAction Stop; $svc.Refresh() }
        'restart' { Restart-Service -Name $name -Force -ErrorAction Stop; $svc.Refresh() }
    }
} catch {
    $msg = $_.Exception.Message
    if ($msg -match 'Access is denied|UnauthorizedAccessException|requires elevation') {
        Fail 'elevation_required' "Action '$action' on service '$name' requires admin. Restart Clippy as administrator or change the service manually via services.msc."
    }
    Fail 'action_failed' "Service action failed: $msg"
}

Out-Result @{
    ok = $true
    name = $name
    action = $action
    status = $svc.Status.ToString()
    startType = $svc.StartType.ToString()
    displayName = $svc.DisplayName
}
