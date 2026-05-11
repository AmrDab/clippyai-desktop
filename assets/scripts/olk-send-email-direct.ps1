# olk-send-email-direct.ps1
# v0.13.0 — Launch new Outlook (olk.exe) DIRECTLY via shell:AppsFolder,
# bypassing the mailto: default-handler protocol entirely. Per support
# report acbe3aee+543ff234: user has olk installed but the default mailto
# handler is some other AppX. The mailto-based olk-send-email-uia.ps1
# can't reach olk in that state. This script reaches olk regardless.
#
# Strategy:
#   1. Confirm olk AppX is installed (Microsoft.OutlookForWindows package).
#   2. Launch via `Start-Process shell:AppsFolder\Microsoft.OutlookForWindows_8wekyb3d8bbwe!olk`.
#   3. Wait for compose window via UIA (re-using the same HWND-set
#      detection pattern from olk-send-email-uia.ps1).
#   4. Drive To / Subject / Body fields via UIA SetValuePattern + SendKeys.
#   5. Click Send button via UIA InvokePattern.
#   6. Verify by waiting for compose to close.
#
# Args: same shape as olk-send-email-uia.ps1: -to, -subjectB64, -bodyB64.
# Output: same JSON shape: {ok, via:"olk-direct", error?, message?, stage?}.

param(
    [string]$to = "",
    [string]$subject = "",
    [string]$body = "",
    [string]$subjectB64 = "",
    [string]$bodyB64 = "",
    [string]$cc = "",
    [int]$timeoutSec = 30
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 3) }
function Fail($code, $msg, $stage) {
    Out-Result @{ ok = $false; error = $code; message = $msg; stage = $stage; via = 'olk-direct' }
    exit 1
}

# Decode base64 inputs
if ($subjectB64) {
    try { $subject = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($subjectB64)) }
    catch { Fail 'decode_failed' "subjectB64 decode failed: $($_.Exception.Message)" 'decode' }
}
if ($bodyB64) {
    try { $body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($bodyB64)) }
    catch { Fail 'decode_failed' "bodyB64 decode failed: $($_.Exception.Message)" 'decode' }
}

if ([string]::IsNullOrWhiteSpace($to))      { Fail 'missing_to' 'to is required' 'validate' }
if ([string]::IsNullOrWhiteSpace($subject)) { Fail 'missing_subject' 'subject is required' 'validate' }
if ([string]::IsNullOrWhiteSpace($body))    { Fail 'missing_body' 'body is required' 'validate' }

# Validate $to (RFC 5322-ish, comma-separated allowed)
$toPattern = '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}(\s*,\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})*$'
if ($to -notmatch $toPattern) {
    Fail 'invalid_to' "Recipient '$to' is not a valid email address (or comma-separated list)." 'validate'
}

# Confirm olk AppX is installed before we try to launch it
$olkPkg = $null
try {
    $olkPkg = Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue
} catch { }
if (-not $olkPkg) {
    Fail 'olk_not_installed' 'New Outlook (Microsoft.OutlookForWindows AppX) is not installed. Install from the Microsoft Store, or use the classic Outlook COM path.' 'precheck'
}

# Load UIA
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
} catch {
    Fail 'uia_unavailable' "Failed to load UIA: $($_.Exception.Message)" 'load_uia'
}

# Snapshot existing olk windows so we can detect the new compose window
$priorOlkHwnds = @{}
try {
    foreach ($p in (Get-Process -Name 'olk' -ErrorAction SilentlyContinue)) {
        try {
            $h = $p.MainWindowHandle
            if ($h -ne 0) { $priorOlkHwnds[[int64]$h] = $true }
        } catch { }
    }
} catch { }

# Launch olk directly via AppsFolder shortcut
$olkLauncher = 'shell:AppsFolder\Microsoft.OutlookForWindows_8wekyb3d8bbwe!olk'
try {
    Start-Process -FilePath $olkLauncher -ErrorAction Stop | Out-Null
} catch {
    Fail 'launch_failed' "Could not launch olk via AppsFolder: $($_.Exception.Message)" 'launch'
}

# UIA element-finding helpers
$root = [System.Windows.Automation.AutomationElement]::RootElement
$ctrlProp  = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$nameProp  = [System.Windows.Automation.AutomationElement]::NameProperty
$winType   = [System.Windows.Automation.ControlType]::Window
$btnType   = [System.Windows.Automation.ControlType]::Button
$editType  = [System.Windows.Automation.ControlType]::Edit
$windowCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $ctrlProp, $winType

# Step 1: wait for olk to be ready (main window appears).
# We'll detect this and then need to manually trigger the "New mail" action
# because the launcher opens to inbox, not compose.
$olkMainWindow = $null
$deadline = (Get-Date).AddSeconds([Math]::Min($timeoutSec, 30))
while ((Get-Date) -lt $deadline -and -not $olkMainWindow) {
    Start-Sleep -Milliseconds 500
    try {
        $allWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)
        foreach ($w in $allWindows) {
            try {
                $procId = $w.Current.ProcessId
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if (-not $proc -or $proc.ProcessName -ne 'olk') { continue }
                $hwnd = [int64]$w.Current.NativeWindowHandle
                if ($hwnd -eq 0) { continue }
                # Take any olk window that appears post-launch — could be brand
                # new (cold start) or an existing inbox window brought to front.
                $olkMainWindow = $w
                break
            } catch { continue }
        }
    } catch { }
}
if (-not $olkMainWindow) {
    Fail 'olk_window_not_found' 'New Outlook main window did not appear within timeout.' 'wait_main'
}

# Step 2: focus the olk window so Ctrl+N triggers a new compose.
try { $olkMainWindow.SetFocus() } catch { }
Start-Sleep -Milliseconds 300

# Step 3: Send Ctrl+N (new mail shortcut in olk).
try {
    [System.Windows.Forms.SendKeys]::SendWait('^n')
} catch {
    Fail 'newmail_keypress_failed' "Could not send Ctrl+N to olk: $($_.Exception.Message)" 'open_compose'
}

# Step 4: wait for a NEW olk window (the compose) — same HWND-snapshot trick.
$composeWindow = $null
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not $composeWindow) {
    Start-Sleep -Milliseconds 500
    try {
        $allWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)
        foreach ($w in $allWindows) {
            try {
                $procId = $w.Current.ProcessId
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if (-not $proc -or $proc.ProcessName -ne 'olk') { continue }
                $hwnd = [int64]$w.Current.NativeWindowHandle
                if ($hwnd -eq 0) { continue }
                if (-not $priorOlkHwnds.ContainsKey($hwnd)) {
                    # Also check it's not the main window we already grabbed.
                    if ($hwnd -ne [int64]$olkMainWindow.Current.NativeWindowHandle) {
                        $composeWindow = $w
                        break
                    }
                }
            } catch { continue }
        }
    } catch { }
}
if (-not $composeWindow) {
    Fail 'compose_window_not_found' 'olk did not open a compose window after Ctrl+N. The keyboard shortcut may differ on this olk build.' 'wait_compose'
}

# Step 5: fill To / Subject / Body. Use SendKeys with TAB navigation since
# UIA AutomationId on olk's compose changes between versions.
try { $composeWindow.SetFocus() } catch { }
Start-Sleep -Milliseconds 300

# The compose window typically opens with focus already on the To field.
# Send: to[Tab]subject[Tab][Tab]body — the double-tab past cc/bcc varies.
# Use clipboard + Ctrl+V for body so multi-line content survives.

# Type To
[System.Windows.Forms.SendKeys]::SendWait($to.Replace('+', '{+}').Replace('^', '{^}').Replace('%', '{%}').Replace('~', '{~}').Replace('(', '{(}').Replace(')', '{)}'))
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('{TAB}')
Start-Sleep -Milliseconds 200

# Type Subject (escape SendKeys special chars)
$escapedSubject = $subject.Replace('+', '{+}').Replace('^', '{^}').Replace('%', '{%}').Replace('~', '{~}').Replace('(', '{(}').Replace(')', '{)}')
[System.Windows.Forms.SendKeys]::SendWait($escapedSubject)
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('{TAB}')
Start-Sleep -Milliseconds 400

# Paste body via clipboard (handles newlines + emoji reliably)
$priorClip = $null
try { $priorClip = [System.Windows.Forms.Clipboard]::GetText() } catch { }
try {
    [System.Windows.Forms.Clipboard]::SetText($body)
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 300
} catch {
    Fail 'body_paste_failed' "Could not paste body into compose: $($_.Exception.Message)" 'fill_body'
}
# Restore prior clipboard
try { if ($priorClip) { [System.Windows.Forms.Clipboard]::SetText($priorClip) } } catch { }

# Step 6: send via Ctrl+Enter (olk standard).
[System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')

# Step 7: verify compose closed within 5s.
$verifyDeadline = (Get-Date).AddSeconds(5)
$stillOpen = $true
while ((Get-Date) -lt $verifyDeadline) {
    Start-Sleep -Milliseconds 300
    try {
        $name = $composeWindow.Current.Name
        if (-not $name) { $stillOpen = $false; break }
    } catch {
        # Window destroyed — send succeeded
        $stillOpen = $false
        break
    }
}

if ($stillOpen) {
    Out-Result @{
        ok = $false
        error = 'unverified'
        message = 'Send triggered but compose did not close in 5s. Possible recipient validation dialog.'
        stage = 'verify'
        via = 'olk-direct'
    }
    exit 1
}

Out-Result @{
    ok = $true
    via = 'olk-direct'
    to = $to
    subject = $subject
    sent = $true
}
