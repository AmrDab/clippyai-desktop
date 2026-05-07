# _outlook-com-precheck.ps1
# v0.11.29 — shared pre-flight check for the four com-outlook-*.ps1 scripts.
# Discriminates "Outlook entirely absent" from "user has the new Outlook (olk.exe)
# which doesn't expose the legacy Outlook.Application COM ProgID". Without this,
# every COM call fails with the all-zero CLSID 0x80040154 and the surfaced error
# "Outlook may not be installed or signed in" is FALSE for olk.exe users — they
# DO have Outlook, just not a COM-capable build.
#
# Dot-source from the top of each com-outlook-*.ps1:
#   . "$PSScriptRoot\_outlook-com-precheck.ps1"
#   $check = Test-OutlookComAvailable
#   if (-not $check.available) { Fail-Outlook $check }
#
# Returns: @{ available=$bool; reason=<string>; remediation=<string> }
# Reasons emitted:
#   - "ok"                          — classic Outlook COM is registered
#   - "new_outlook_no_com"          — olk.exe present but no COM ProgID (Store/PWA)
#   - "outlook_not_installed"       — neither classic nor new Outlook detected

function Test-OutlookComAvailable {
    $hasComProgId = $false
    foreach ($root in @('HKLM:\SOFTWARE\Classes\Outlook.Application', 'HKCU:\SOFTWARE\Classes\Outlook.Application')) {
        try {
            if (Test-Path $root) {
                $hasComProgId = $true
                break
            }
        } catch { }
    }

    $hasOlkProcess = $false
    try {
        $olk = Get-Process -Name 'olk' -ErrorAction SilentlyContinue
        if ($olk) { $hasOlkProcess = $true }
    } catch { }

    $hasOlkInstalled = $false
    try {
        # New Outlook ships as MSIX from the Store. AppxPackage check is the
        # most reliable presence signal even when olk.exe isn't running.
        $pkg = Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue
        if ($pkg) { $hasOlkInstalled = $true }
    } catch { }

    if ($hasComProgId) {
        return @{ available = $true; reason = 'ok'; remediation = '' }
    }
    if ($hasOlkProcess -or $hasOlkInstalled) {
        return @{
            available   = $false
            reason      = 'new_outlook_no_com'
            remediation = 'New Outlook (olk.exe) does not expose the legacy Outlook.Application COM. Use mailto: link via the shell, or open outlook.live.com in the browser and drive Send through CDP/smart_click.'
        }
    }
    return @{
        available   = $false
        reason      = 'outlook_not_installed'
        remediation = 'No Outlook installation detected. Install classic Outlook (Microsoft 365 Desktop) for COM automation, or use a webmail provider via the browser.'
    }
}

function Fail-Outlook {
    param([Parameter(Mandatory=$true)] $check)
    Write-Output (@{
        ok          = $false
        error       = $check.reason
        message     = $check.remediation
    } | ConvertTo-Json -Compress -Depth 3)
    exit 1
}
