# _path-guard.ps1
# v0.12.3 — Shared filesystem guard for read-side tools (list-files, search-files,
# read-file). Per security audit finding #3: list-files / search-files had no
# path restriction, letting the model enumerate ~/.ssh, ~/.aws, browser profile
# dirs, jump lists, etc. This helper blocks the same prefixes write-file blocks
# plus a tighter set of user-secret dirs.
#
# Usage from a script:
#   . "$PSScriptRoot\_path-guard.ps1"
#   $check = Test-PathAllowedForRead $userPath
#   if (-not $check.allowed) { ... emit JSON failure ... }
#
# Returns: @{ allowed=$bool; resolved=<full-path>; reason=<string-on-deny> }

function Test-PathAllowedForRead {
    param([Parameter(Mandatory=$true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return @{ allowed = $false; resolved = ''; reason = 'empty_path' }
    }

    $resolved = $null
    try {
        $resolved = [System.IO.Path]::GetFullPath($Path)
    } catch {
        return @{ allowed = $false; resolved = ''; reason = "resolve_failed: $($_.Exception.Message)" }
    }

    # System directories — same set as com-write-file.ps1 blockedPrefixes.
    $blockedSystemPrefixes = @(
        "$env:SystemRoot\",            # C:\Windows\
        "$env:ProgramFiles\",          # C:\Program Files\
        "${env:ProgramFiles(x86)}\",   # C:\Program Files (x86)\
        "$env:SystemDrive\Windows\",
        "$env:SystemDrive\ProgramData\Microsoft\"
    )
    foreach ($p in $blockedSystemPrefixes) {
        if ($p -and $resolved.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)) {
            return @{ allowed = $false; resolved = $resolved; reason = "system_dir: $p" }
        }
    }

    # User-secret dirs — common locations for credentials, tokens, keys.
    # Read enumeration alone leaks names that aid attackers; reading content
    # is worse (read_file blocks via _binary-and-size, list-files needs this
    # explicit deny).
    $userHome = [Environment]::GetFolderPath('UserProfile')
    $blockedUserPaths = @(
        "$userHome\.ssh",
        "$userHome\.aws",
        "$userHome\.azure",
        "$userHome\.config\gh",
        "$userHome\.gnupg",
        "$userHome\.kube",
        "$userHome\.git-credentials",
        "$userHome\.docker\config.json",
        "$userHome\AppData\Local\Microsoft\Credentials",
        "$userHome\AppData\Roaming\Microsoft\Credentials",
        "$userHome\AppData\Local\Microsoft\Vault",
        "$userHome\AppData\Local\Google\Chrome\User Data\Default\Login Data",
        "$userHome\AppData\Local\Google\Chrome\User Data\Default\Cookies",
        "$userHome\AppData\Roaming\Mozilla\Firefox\Profiles",
        "$userHome\AppData\Local\Microsoft\Edge\User Data\Default\Login Data",
        "$userHome\AppData\Local\Microsoft\Edge\User Data\Default\Cookies",
        "$userHome\AppData\Roaming\Microsoft\Windows\Recent\CustomDestinations",
        "$userHome\.clawdcursor",
        "$userHome\.clippyai"
    )
    foreach ($p in $blockedUserPaths) {
        if ($resolved.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)) {
            return @{ allowed = $false; resolved = $resolved; reason = "user_secret_path: $p" }
        }
    }

    # Block anything starting with `\\` (UNC paths) — risk of unintended
    # network share enumeration. Local paths only by default.
    if ($resolved.StartsWith('\\')) {
        return @{ allowed = $false; resolved = $resolved; reason = 'unc_path_blocked' }
    }

    return @{ allowed = $true; resolved = $resolved; reason = 'ok' }
}
