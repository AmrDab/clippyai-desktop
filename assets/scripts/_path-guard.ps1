# _path-guard.ps1
# v0.12.3 - Shared filesystem guard for read-side tools (list-files, search-files,
# read-file). Per security audit finding #3: list-files / search-files had no
# path restriction, letting the model enumerate ~/.ssh, ~/.aws, browser profile
# dirs, jump lists, etc. This helper blocks the same prefixes write-file blocks
# plus a tighter set of user-secret dirs.
#
# v0.24.12 - the check runs on the REAL path. Before, "C:\Users\me\APPDAT~1\..."
# (8.3 short name) or a junction / symlink pointing at ~/.ssh passed, because
# only the path as written was compared. Now every segment is expanded to its
# long name and every link is followed first. UNC paths are refused before any
# filesystem call (touching one makes Windows authenticate to that server).
# The whole browser "User Data" tree is blocked, not two named files in it.
# The TypeScript port is src/main/security/path-guard.ts: keep the lists in step.
#
# Usage from a script:
#   . "$PSScriptRoot\_path-guard.ps1"
#   $check = Test-PathAllowedForRead $userPath
#   if (-not $check.allowed) { ... emit JSON failure ... }
#
# Returns: @{ allowed=$bool; resolved=<full-path>; reason=<string-on-deny> }

# Expand 8.3 short names and follow junctions / symlinks, segment by segment.
# A segment that does not exist yet is kept as written. Never throws.
function Resolve-RealPath {
    param([Parameter(Mandatory=$true)][string]$FullPath)

    $root = [System.IO.Path]::GetPathRoot($FullPath)
    if ([string]::IsNullOrEmpty($root)) { return $FullPath }
    $rest = $FullPath.Substring($root.Length)
    $queue = New-Object System.Collections.Generic.List[string]
    foreach ($s in $rest.Split('\')) { if ($s) { $queue.Add($s) } }
    $cur = $root
    $hops = 0

    while ($queue.Count -gt 0) {
        $seg = $queue[0]
        $queue.RemoveAt(0)
        $name = $seg
        # 8.3 short name ("APPDAT~1"): a -Filter lookup matches short names and
        # returns the entry under its long name.
        if ($seg.Contains('~')) {
            try {
                $hit = Get-ChildItem -LiteralPath $cur -Force -Filter $seg -ErrorAction Stop | Select-Object -First 1
                if ($hit) { $name = $hit.Name }
            } catch { }
        }
        $next = Join-Path $cur $name

        # Junction / symlink: continue from where it points.
        $item = $null
        try { $item = Get-Item -LiteralPath $next -Force -ErrorAction Stop } catch { }
        if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $hops -lt 16) {
            $target = $null
            try { $target = @($item.Target)[0] } catch { }
            if ($target) {
                $hops++
                if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path $cur $target }
                try { $target = [System.IO.Path]::GetFullPath($target) } catch { }
                if ($target.StartsWith('\\')) { return $target }   # points at a network share
                $tRoot = [System.IO.Path]::GetPathRoot($target)
                $tail = $queue.ToArray()
                $queue.Clear()
                foreach ($s in $target.Substring($tRoot.Length).Split('\')) { if ($s) { $queue.Add($s) } }
                foreach ($s in $tail) { $queue.Add($s) }
                $cur = $tRoot
                continue
            }
        }
        $cur = $next
    }
    return $cur
}

function Test-PathAllowedForRead {
    param([Parameter(Mandatory=$true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return @{ allowed = $false; resolved = ''; reason = 'empty_path' }
    }

    # \\?\C:\x and \\.\C:\x are local paths with a device prefix: drop it.
    $Path = $Path.Trim() -replace '^[\\/]{2}[?.][\\/](?=[A-Za-z]:)', ''

    # Block anything starting with `\\` (UNC paths) - risk of unintended
    # network share enumeration. Checked BEFORE any filesystem call.
    if ($Path -match '^[\\/]{2}') {
        return @{ allowed = $false; resolved = $Path; reason = 'unc_path_blocked' }
    }

    $resolved = $null
    try {
        $resolved = [System.IO.Path]::GetFullPath($Path)
    } catch {
        return @{ allowed = $false; resolved = ''; reason = "resolve_failed: $($_.Exception.Message)" }
    }
    if ($resolved.StartsWith('\\')) {
        return @{ allowed = $false; resolved = $resolved; reason = 'unc_path_blocked' }
    }

    # Judge the path as written AND the real path behind it.
    $real = $resolved
    try { $real = Resolve-RealPath $resolved } catch { $real = $resolved }
    if ($real.StartsWith('\\')) {
        return @{ allowed = $false; resolved = $real; reason = 'unc_path_blocked' }
    }
    $candidates = @($resolved)
    if ($real -ne $resolved) { $candidates += $real }

    # System directories - same set as com-write-file.ps1 blockedPrefixes.
    $blockedSystemPrefixes = @(
        "$env:SystemRoot\",            # C:\Windows\
        "$env:ProgramFiles\",          # C:\Program Files\
        "${env:ProgramFiles(x86)}\",   # C:\Program Files (x86)\
        "$env:SystemDrive\Windows\",
        "$env:SystemDrive\ProgramData\Microsoft\"
    )

    # User-secret dirs - common locations for credentials, tokens, keys.
    # Read enumeration alone leaks names that aid attackers; reading content
    # is worse (read_file blocks via _binary-and-size, list-files needs this
    # explicit deny).
    $userHome = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = [Environment]::GetFolderPath('UserProfile') }
    $userHome = $userHome.TrimEnd('\')
    # The profile folder is resolved the same way as the path (long name, link
    # target) and both forms are guarded. Otherwise the two sides can name the
    # same folder differently and never match: on a CI runner USERPROFILE is
    # C:\Users\runneradmin while TEMP is C:\Users\RUNNER~1\..., and GetFullPath
    # above already expands a short name when the path exists.
    $homes = @($userHome)
    try {
        $realHome = (Resolve-RealPath ([System.IO.Path]::GetFullPath($userHome))).TrimEnd('\')
        if ($realHome -and -not $realHome.Equals($userHome, [System.StringComparison]::OrdinalIgnoreCase)) { $homes += $realHome }
    } catch { }
    $userSecretRel = @(
        '.ssh',
        '.aws',
        '.azure',
        '.config\gh',
        '.config\gcloud',
        '.gnupg',
        '.kube',
        '.git-credentials',
        '.netrc',
        '.docker\config.json',
        'AppData\Local\Microsoft\Credentials',
        'AppData\Roaming\Microsoft\Credentials',
        'AppData\Local\Microsoft\Vault',
        'AppData\Roaming\Microsoft\Vault',
        'AppData\Roaming\Microsoft\Protect',
        'AppData\Roaming\Mozilla\Firefox\Profiles',
        'AppData\Roaming\Opera Software',
        'AppData\Roaming\Microsoft\Windows\Recent\CustomDestinations',
        'AppData\Roaming\ClippyAI',
        '.clawdcursor',
        '.clippyai'
    )
    $blockedUserPaths = @()
    foreach ($h in $homes) { foreach ($rel in $userSecretRel) { $blockedUserPaths += ($h + '\' + $rel) } }

    foreach ($c in $candidates) {
        foreach ($p in $blockedSystemPrefixes) {
            if ($p -and $p -ne '\' -and $c.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)) {
                return @{ allowed = $false; resolved = $c; reason = "system_dir: $p" }
            }
        }
        foreach ($p in $blockedUserPaths) {
            # The folder itself or anything below it ("\.ssh" must not match "\.sshnotes").
            if ($c.Equals($p, [System.StringComparison]::OrdinalIgnoreCase) -or
                $c.StartsWith("$p\", [System.StringComparison]::OrdinalIgnoreCase)) {
                return @{ allowed = $false; resolved = $c; reason = "user_secret_path: $p" }
            }
        }
        # Every Chromium browser (Chrome, Edge, Brave, Vivaldi, Arc...) keeps all of
        # its profiles - cookies, saved logins, session tokens - under a folder
        # named "User Data" inside AppData. Block the whole tree.
        if ($c -match '(?i)\\AppData\\.*\\User Data(\\|$)') {
            return @{ allowed = $false; resolved = $c; reason = 'browser_profile: User Data' }
        }
    }

    return @{ allowed = $true; resolved = $real; reason = 'ok' }
}
