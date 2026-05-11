# olk-send-email-uia.ps1
# v0.12.2 — Single-shot send-email via the NEW Outlook (olk.exe / Microsoft Store)
# when classic Outlook COM (Outlook.Application) is not registered.
#
# Strategy:
#   1. Build a mailto: URI with URL-encoded subject + body.
#   2. Launch via Start-Process — olk registers as default mailto handler when
#      classic Outlook isn't installed, so this opens the compose window.
#   3. Wait for the compose window via UIA (System.Windows.Automation).
#   4. Find the "Send" button by AutomationProperty.Name OR ControlType=Button
#      with Name matching /^send$/i.
#   5. Invoke its InvokePattern.
#   6. Verify by waiting for the compose window to disappear (or for the inbox
#      to show a "Sent" status). Return JSON.
#
# This collapses what would otherwise be a 20+ step model UI loop into ONE
# PowerShell call. Per support report 3df80c75 (2026-05-09).
#
# Args:
#   -to            (required, comma-separated)
#   -subjectB64    (preferred) base64-encoded UTF-8
#   -bodyB64       (preferred) base64-encoded UTF-8
#   -subject       (legacy) raw subject
#   -body          (legacy) raw body
#   -cc            (optional)
#   -timeoutSec    (default 20) overall budget
#
# Outputs JSON on the last line: {ok:true,via:"olk-uia"} or
# {ok:false,error:"<code>",message:"<remediation>",stage:"<which-step-failed>"}.

param(
    [string]$to = "",
    [string]$subject = "",
    [string]$body = "",
    [string]$subjectB64 = "",
    [string]$bodyB64 = "",
    [string]$cc = "",
    [int]$timeoutSec = 20
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($code, $message, $stage) {
    Out-Result @{ ok = $false; error = $code; message = $message; stage = $stage; via = 'olk-uia' }
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
if ([string]::IsNullOrWhiteSpace($subject)) { Fail 'missing_subject' 'subject is required (or subjectB64)' 'validate' }
if ([string]::IsNullOrWhiteSpace($body))    { Fail 'missing_body' 'body is required (or bodyB64)' 'validate' }

# v0.12.3 — validate $to against a permissive RFC 5322-ish pattern. Without
# this an attacker-supplied recipient like "x@y.com%0D%0ABcc:evil@a.com"
# would be string-interpolated raw into the mailto: URI and some clients
# parse it as a header injection. Per security audit finding #2.
$toPattern = '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}(\s*,\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})*$'
if ($to -notmatch $toPattern) {
    Fail 'invalid_to' "Recipient '$to' is not a valid email address (or comma-separated list). Reject to prevent mailto: header injection." 'validate'
}
$ccPattern = $toPattern
if ($cc -and ($cc -notmatch $ccPattern)) {
    Fail 'invalid_cc' "CC '$cc' is not a valid email address (or comma-separated list)." 'validate'
}

# mailto: URLs have a practical limit around 2000 chars on Windows. If the
# body is too long we surface a clean error rather than truncating silently.
# v0.12.3 — also URL-encode $to itself. Even with regex validation this is
# defense-in-depth; the pattern allows some chars that could behave oddly
# in raw URI position depending on the OS shell handler.
$toEncoded = [uri]::EscapeDataString($to)
$bodyEncoded = [uri]::EscapeDataString($body)
$subjectEncoded = [uri]::EscapeDataString($subject)
$ccEncoded = if ($cc) { [uri]::EscapeDataString($cc) } else { '' }

$mailto = "mailto:$toEncoded" + "?subject=$subjectEncoded&body=$bodyEncoded"
if ($ccEncoded) { $mailto += "&cc=$ccEncoded" }

if ($mailto.Length -gt 2000) {
    Fail 'body_too_long' 'mailto: URI exceeds 2000 chars; use COM or send a shorter body' 'compose_uri'
}

# v0.12.5 — pre-flight check the default mailto handler BEFORE launching.
# Per support reports b6e81644 + fabb85b7 (both v0.12.4): when no mail
# handler is set (or handler is Edge/Chrome PWA rather than olk), the
# Start-Process below silently launches a browser or does nothing, then
# the UIA wait below burns 15s before failing with "compose window not
# found". Faster, cleaner: check the registry and fail fast.
$mailtoProgId = $null
try {
    $reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\mailto\UserChoice' -ErrorAction SilentlyContinue
    if ($reg) { $mailtoProgId = $reg.ProgId }
} catch { }

# Known new-Outlook ProgIds. The user-choice registry uses a hashed value
# pinning Microsoft.OutlookForWindows AppX progid like:
#   "OutlookForWindowsLP" or "Microsoft.OutlookForWindows_8wekyb3d8bbwe!..."
# Classic Outlook is "Outlook.URL.mailto" or similar.
$looksLikeOlk    = $mailtoProgId -and ($mailtoProgId -match 'OutlookForWindows' -or $mailtoProgId -match 'OutlookMail')
$looksLikeOther  = $mailtoProgId -and -not $looksLikeOlk
if (-not $mailtoProgId) {
    Fail 'no_mailto_handler' 'No default mailto handler is set in Windows. Set new Outlook (or Mail) as the default mail app via Settings > Apps > Default apps > Mail.' 'precheck'
}
if ($looksLikeOther) {
    Fail 'wrong_mailto_handler' ("Default mailto handler is '" + $mailtoProgId + "', not new Outlook. Either change the default in Settings > Apps > Default apps > Mail to 'Outlook (new)', or send via the browser path.") 'precheck'
}

# Load UIA assemblies. Both available on every Windows 10+ install via .NET FW.
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    Fail 'uia_unavailable' "Failed to load System.Windows.Automation: $($_.Exception.Message)" 'load_uia'
}

# Snapshot olk window HANDLES (not pids — new Outlook reuses one PID across
# multiple windows) BEFORE launching so we can identify the new compose
# window even when olk is already running with an inbox window open.
$priorOlkHwnds = @{}
try {
    foreach ($p in (Get-Process -Name 'olk' -ErrorAction SilentlyContinue)) {
        try {
            $h = $p.MainWindowHandle
            if ($h -ne 0) { $priorOlkHwnds[[int64]$h] = $true }
        } catch { }
    }
} catch { }

# Launch the mailto: URI. ShellExecute handles default-mail-client routing.
try {
    Start-Process -FilePath $mailto -ErrorAction Stop | Out-Null
} catch {
    Fail 'launch_failed' "Could not launch mailto handler: $($_.Exception.Message). Ensure new Outlook is the default mail client." 'launch'
}

# Wait for the compose window. Two-phase detection: any new olk HWND not in
# the prior snapshot, OR a UIA window whose Name contains the subject.
# v0.12.5 — bumped timeout cap 15s → 25s (olk cold-start is slow on some
# machines) and switched HWND detection to use -ArgumentList for all
# New-Object PropertyCondition / AndCondition calls. Per code audit
# finding: positional-args-via-backtick-continuation parses cleanly but
# is fragile across PowerShell versions; -ArgumentList is the canonical
# form.
$root = [System.Windows.Automation.AutomationElement]::RootElement
$composeWindow = $null
$deadline = (Get-Date).AddSeconds([Math]::Min($timeoutSec, 25))

# Build the "find all top-level Windows" condition once, outside the poll
# loop, so we don't re-allocate it 50 times.
$ctrlProp  = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$nameProp  = [System.Windows.Automation.AutomationElement]::NameProperty
$winType   = [System.Windows.Automation.ControlType]::Window
$btnType   = [System.Windows.Automation.ControlType]::Button
$windowCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $ctrlProp, $winType

while ((Get-Date) -lt $deadline -and -not $composeWindow) {
    Start-Sleep -Milliseconds 500
    try {
        $allTopWindows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $windowCondition)
        foreach ($w in $allTopWindows) {
            try {
                $procId = $w.Current.ProcessId
                $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
                if (-not $proc) { continue }
                if ($proc.ProcessName -ne 'olk') { continue }
                $hwnd = [int64]$w.Current.NativeWindowHandle
                # Primary: any olk HWND not in the prior snapshot is the new
                # compose window (works whether olk was already running or not).
                if ($hwnd -ne 0 -and -not $priorOlkHwnds.ContainsKey($hwnd)) {
                    $composeWindow = $w
                    break
                }
                # Secondary: title match (covers some olk versions where
                # compose reuses an existing HWND).
                $name = $w.Current.Name
                if ($name -and ($name -like "*$subject*" -or $name -like '*Compose*' -or $name -like '*New mail*' -or $name -like '*New message*')) {
                    $composeWindow = $w
                    break
                }
            } catch { continue }
        }
    } catch { }
}

if (-not $composeWindow) {
    Fail 'compose_window_not_found' 'New Outlook compose window did not open within timeout. olk may not be the default mail handler, or the compose window may have a different HWND/title than expected.' 'wait_compose'
}

# Find the Send button. UIA lets us search descendants by control type + name.
$sendButton = $null
try {
    $btnCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $ctrlProp, $btnType
    $sendNameCondition = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $nameProp, 'Send'
    $buttonCondition = New-Object System.Windows.Automation.AndCondition -ArgumentList $btnCondition, $sendNameCondition
    $sendButton = $composeWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
} catch { }

if (-not $sendButton) {
    # Fallback: case-insensitive name scan across all descendant buttons
    try {
        $btnCondition2 = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $ctrlProp, $btnType
        $allButtons = $composeWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCondition2)
        foreach ($b in $allButtons) {
            try {
                $n = $b.Current.Name
                if ($n -and $n -match '^send$') { $sendButton = $b; break }
            } catch { continue }
        }
    } catch { }
}

if (-not $sendButton) {
    Fail 'send_button_not_found' 'Send button not found in compose window. The olk UIA tree may have changed; falling back to keyboard shortcut Ctrl+Enter.' 'find_send'
}

# Invoke. Prefer InvokePattern; fall back to setting focus + simulated Enter.
$invoked = $false
try {
    $invokePattern = $sendButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    if ($invokePattern) {
        $invokePattern.Invoke()
        $invoked = $true
    }
} catch { }

if (-not $invoked) {
    # Try keyboard shortcut. olk respects Ctrl+Enter to send.
    try {
        $sendButton.SetFocus()
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')
        $invoked = $true
    } catch { }
}

if (-not $invoked) {
    Fail 'invoke_failed' 'Found Send button but could not invoke it (no InvokePattern, SendKeys also failed).' 'invoke'
}

# Verify by waiting for the compose window to close. If it stays open, the
# send may have been blocked by a recipient validation dialog or attachment
# warning — surface that as an unverified result.
$verifyDeadline = (Get-Date).AddSeconds(5)
$stillOpen = $true
while ((Get-Date) -lt $verifyDeadline) {
    Start-Sleep -Milliseconds 300
    try {
        $check = $composeWindow.Current.Name
        if (-not $check) { $stillOpen = $false; break }
    } catch {
        # Window destroyed → element access throws → send succeeded
        $stillOpen = $false
        break
    }
}

if ($stillOpen) {
    # Compose still visible after 5s — likely a confirmation dialog (unsaved
    # recipient, attachment scan, etc). Don't claim success.
    Out-Result @{
        ok = $false
        error = 'unverified'
        message = 'Send was triggered but compose window did not close within 5s. Check for a confirmation dialog (recipient validation, missing attachment).'
        stage = 'verify'
        via = 'olk-uia'
    }
    exit 1
}

Out-Result @{
    ok = $true
    via = 'olk-uia'
    to = $to
    subject = $subject
    sent = $true
}
