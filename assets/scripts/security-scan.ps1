# security-scan.ps1
# v0.1.0 â€” "Security Sweep": a read-only, plain-English second opinion that
# runs alongside Windows Defender. It enumerates the places software can
# auto-start or hide (Run keys, startup folders, scheduled tasks, services,
# running processes, Winlogon/IFEO/AppInit hooks, WMI subscriptions, hosts
# file) and explains WHY an entry looks suspicious: how it auto-starts, where
# it lives, and who signed it. It never modifies, deletes or quarantines
# anything. It is NOT a Defender replacement.
#
# Args:
#   -sections       comma-separated subset of: autoruns, tasks, services,
#                   processes, system, defender   (default: all)
#   -includeTrusted "true" to also list entries that were checked and judged
#                   trusted (default "false": only findings are listed)
#   -maxFindings    cap on returned findings, highest severity first (default 50)
#   -fixture        path to a JSON file of synthetic entries. When given, the
#                   live collectors are skipped and ONLY the fixture entries are
#                   analyzed (used by the test harness). Format:
#                   { "entries":[{source,location,name,command,enabled}], "defender":{...} }
#
# Outputs JSON on the last line:
#   { ok:true, scannedAt, durationMs, sections:[...], summary:{high,medium,low,checked,trusted},
#     findings:[{ id, severity, score, title, plainEnglish, source, location, name,
#                 command, path, signer, signatureStatus, signals:[{code,why}], recommendation }],
#     trusted:[...only with -includeTrusted...], defender:{...}, notes:[...] }
#   or { ok:false, error:<code>, message:<text> }
#
# False-positive policy: a validly signed program in a normal install location
# (Windows, Program Files, WindowsApps, per-user app folders, ProgramData
# vendor folders) with no other red flag is "trusted" and not reported.

param(
    [string]$sections = "",
    [string]$includeTrusted = "false",
    [int]$maxFindings = 50,
    [string]$fixture = ""
)

function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 6) }
function Fail($code, $msg) { Out-Result @{ ok = $false; error = $code; message = $msg }; exit 1 }

$ErrorActionPreference = 'SilentlyContinue'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($maxFindings -lt 1) { $maxFindings = 1 }
if ($maxFindings -gt 500) { $maxFindings = 500 }
$showTrusted = ($includeTrusted -eq 'true')

$allSections = @('autoruns','tasks','services','processes','system','defender')
$wanted = @()
if (-not [string]::IsNullOrWhiteSpace($sections)) {
    $wanted = $sections.Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
    $bad = $wanted | Where-Object { $allSections -notcontains $_ }
    if ($bad) { Fail 'invalid_section' ("Unknown section(s): " + ($bad -join ', ') + ". Allowed: " + ($allSections -join ', ')) }
}
function Want($name) { return ($wanted.Count -eq 0 -or $wanted -contains $name) }

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Environment facts
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$userHome   = [Environment]::GetFolderPath('UserProfile')
$sysRoot    = $env:SystemRoot
$progFiles  = $env:ProgramFiles
$progFiles86 = ${env:ProgramFiles(x86)}
$progData   = $env:ProgramData
$localApp   = $env:LOCALAPPDATA
$roamApp    = $env:APPDATA

$notes = @()
$sigCache = @{}
$findings = @()
$trusted = @()
$checked = 0
$findingSeq = 0

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Helpers
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function StartsWithCI($s, $prefix) {
    if (-not $s -or -not $prefix) { return $false }
    return $s.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}
function ContainsCI($s, $needle) {
    if (-not $s -or -not $needle) { return $false }
    return ($s.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# Known "living-off-the-land" launchers. When the auto-start command is one of
# these, the interesting thing is the script/DLL they are told to run.
$launchers = @('powershell','pwsh','cmd','wscript','cscript','mshta','rundll32','regsvr32','certutil','bitsadmin','msiexec','forfiles','conhost','explorer','schtasks','wmic','msbuild','installutil','regasm','regsvcs','cmstp')
$scriptExts = @('.ps1','.vbs','.vbe','.js','.jse','.bat','.cmd','.hta','.wsf','.wsh','.scr','.pif','.com')
$mimicNames = @('svchost','csrss','lsass','winlogon','wininit','services','smss','spoolsv','dwm','explorer','taskhostw','runtimebroker','conhost','dllhost','sihost','ctfmon','fontdrvhost')
$knownIfeoDebuggers = @('vsjitdebugger.exe','drwtsn32.exe','ntsd.exe','windbg.exe','procdump.exe')

function Expand-Env($s) {
    if (-not $s) { return $s }
    try { return [Environment]::ExpandEnvironmentVariables($s) } catch { return $s }
}

# Splits a raw command line into exe + argument string.
function Split-CommandLine($cmd) {
    $cmd = (Expand-Env $cmd).Trim()
    if (-not $cmd) { return @{ exe = ''; args = '' } }
    if ($cmd.StartsWith('"')) {
        $end = $cmd.IndexOf('"', 1)
        if ($end -gt 0) {
            return @{ exe = $cmd.Substring(1, $end - 1); args = $cmd.Substring($end + 1).Trim() }
        }
        return @{ exe = $cmd.Trim('"'); args = '' }
    }
    # Unquoted: paths with spaces are common ("C:\Program Files (x86)\x\y.exe -a").
    # Prefer the first ".exe" (or other executable ext) boundary, else first space.
    $m = [regex]::Match($cmd, '(?i)^(.+?\.(exe|com|bat|cmd|ps1|vbs|js|hta|scr|dll|msi|lnk|pif|wsf))(\s+(.*))?$')
    if ($m.Success) {
        return @{ exe = $m.Groups[1].Value; args = $m.Groups[4].Value }
    }
    $sp = $cmd.IndexOf(' ')
    if ($sp -gt 0) { return @{ exe = $cmd.Substring(0, $sp); args = $cmd.Substring($sp + 1).Trim() } }
    return @{ exe = $cmd; args = '' }
}

# Finds a bare executable name (e.g. "rundll32.exe", "explorer.exe") on disk.
function Resolve-BareExe($name) {
    if (-not $name) { return $null }
    if ([System.IO.Path]::IsPathRooted($name)) { return $name }
    if (-not [System.IO.Path]::HasExtension($name)) { $name = "$name.exe" }
    foreach ($d in @("$sysRoot\System32", $sysRoot, "$sysRoot\SysWOW64")) {
        $p = Join-Path $d $name
        if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    }
    $c = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c -and $c.Source) { return $c.Source }
    return $name
}

# Pulls a script/DLL path out of a launcher's arguments.
function Extract-ScriptArg($launcher, $argStr) {
    if (-not $argStr) { return '' }
    $a = Expand-Env $argStr
    if ($launcher -eq 'rundll32') {
        # rundll32 [/flags] <dll>,<entry> args
        $a = $a -replace '^\s*(/\w+\s+)+', ''
        $m = [regex]::Match($a, '^\s*"?([^",]+?\.dll)"?\s*,')
        if ($m.Success) { return $m.Groups[1].Value }
        $m = [regex]::Match($a, '^\s*"?([^"\s,]+)')
        if ($m.Success) { return $m.Groups[1].Value }
        return ''
    }
    # quoted path to a script
    $m = [regex]::Match($a, '(?i)"([^"]+\.(ps1|vbs|vbe|js|jse|bat|cmd|hta|wsf|wsh|dll|exe|scr))"')
    if ($m.Success) { return $m.Groups[1].Value }
    $m = [regex]::Match($a, '(?i)(?<![\w\\])((?:[a-z]:\\|\\\\)[^\s"]+?\.(ps1|vbs|vbe|js|jse|bat|cmd|hta|wsf|wsh|dll|exe|scr))(?=\s|$)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Resolve-Lnk($lnkPath) {
    try {
        $sh = New-Object -ComObject WScript.Shell
        $sc = $sh.CreateShortcut($lnkPath)
        return @{ target = $sc.TargetPath; args = $sc.Arguments }
    } catch { return @{ target = ''; args = '' } }
}

# Signature lookup, cached per path. Get-AuthenticodeSignature consults the
# Windows catalog, so OS files that carry no embedded signature still verify.
function Get-SigInfo($path) {
    if (-not $path) { return @{ status = 'NoFile'; signer = ''; isMicrosoft = $false; valid = $false } }
    $key = $path.ToLowerInvariant()
    if ($sigCache.ContainsKey($key)) { return $sigCache[$key] }
    $info = @{ status = 'NoFile'; signer = ''; isMicrosoft = $false; valid = $false }
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try {
            $s = Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop
            $info.status = [string]$s.Status
            if ($s.SignerCertificate) {
                $subj = $s.SignerCertificate.Subject
                $m = [regex]::Match($subj, '(?:^|,\s*)(?:CN|O)=("[^"]+"|[^,]+)')
                if ($m.Success) { $info.signer = $m.Groups[1].Value.Trim('"') } else { $info.signer = $subj }
                $info.isMicrosoft = ($subj -match 'O=Microsoft Corporation')
            }
            $info.valid = ($s.Status -eq 'Valid')
        } catch { $info.status = 'Error' }
    }
    $sigCache[$key] = $info
    return $info
}

# Where does this file live? Returns a class + a plain-English description.
function Get-LocationClass($path) {
    if (-not $path) { return @{ class = 'unknown'; label = 'an unknown location' } }
    $p = $path
    # Developer toolchains ship many unsigned native binaries (esbuild, workerd,
    # cargo/go/pip tooling) and npm/npx stage them under Temp too. Flagging them
    # would bury real findings on a dev PC. (Auto-start entries pointing here
    # still get a penalty in Analyze-Entry — only running processes get a pass.)
    if ($p -match '(?i)\\(node_modules|npm-cache|\.npm|\.cargo|\.rustup|\.pyenv|site-packages|\.vscode\\extensions|\.vscode-server|go\\pkg|\.nuget|\.gradle|\.m2|\.bun|\.deno|\.pnpm|\.yarn)\\') { return @{ class = 'devtools'; label = 'a developer tool cache (node_modules, cargo, pip and similar). These tools are usually unsigned and come from package registries, not from a vendor installer' } }
    if (StartsWithCI $p "$localApp\Temp\")                     { return @{ class = 'suspicious'; label = 'your Temp folder (programs are not normally installed there; malware often runs from it)' } }
    if (StartsWithCI $p "$sysRoot\Temp\")                        { return @{ class = 'suspicious'; label = "the Windows Temp folder (programs are not normally installed there)" } }
    if (ContainsCI $p '\$Recycle.Bin\')                          { return @{ class = 'suspicious'; label = 'the Recycle Bin (a classic hiding place)' } }
    if (StartsWithCI $p "$userHome\Downloads\")                  { return @{ class = 'suspicious'; label = 'your Downloads folder (installed software does not normally run from there)' } }
    if (StartsWithCI $p "$env:PUBLIC\")                          { return @{ class = 'suspicious'; label = 'the Public user folder (shared, writable by everyone)' } }
    if (StartsWithCI $p "$sysRoot\Tasks\" -or (StartsWithCI $p "$sysRoot\System32\Tasks\")) { return @{ class = 'suspicious'; label = 'the Windows Tasks folder (not a place programs are installed)' } }
    if (StartsWithCI $p "$sysRoot\")                             { return @{ class = 'system'; label = 'the Windows system folder' } }
    if (StartsWithCI $p "$progFiles\WindowsApps\")               { return @{ class = 'store'; label = 'the Microsoft Store apps folder' } }
    if (StartsWithCI $p "$progFiles\")                           { return @{ class = 'programfiles'; label = 'Program Files' } }
    if ($progFiles86 -and (StartsWithCI $p "$progFiles86\"))     { return @{ class = 'programfiles'; label = 'Program Files (x86)' } }
    if (StartsWithCI $p "$localApp\Microsoft\WindowsApps\")      { return @{ class = 'store'; label = 'the Microsoft Store apps folder' } }
    if (StartsWithCI $p "$localApp\Programs\")                   { return @{ class = 'userapps'; label = 'your per-user Programs folder (normal for apps like VS Code, Notion, Slack)' } }
    if (StartsWithCI $p "$localApp\")                            { return @{ class = 'userapps'; label = 'your AppData\Local folder (normal for per-user apps such as Discord or Teams)' } }
    if (StartsWithCI $p "$roamApp\")                             { return @{ class = 'userapps'; label = 'your AppData\Roaming folder (used by some per-user apps, but also a common hiding place)' } }
    if (StartsWithCI $p "$progData\")                            { return @{ class = 'programdata'; label = 'ProgramData (shared app data; vendors such as Lenovo or NVIDIA use it)' } }
    if (StartsWithCI $p "$userHome\")                            { return @{ class = 'profile'; label = 'your user profile folder (outside the normal app folders)' } }
    # Root of a drive, e.g. C:\foo.exe or D:\tools\x.exe
    if ($p -match '^[A-Za-z]:\\[^\\]+$')                         { return @{ class = 'suspicious'; label = 'the root of a drive (installed programs do not live there)' } }
    return @{ class = 'other'; label = 'a folder outside the usual program locations' }
}

function Test-SuspiciousLauncherArgs($argStr) {
    if (-not $argStr) { return $null }
    $a = $argStr
    $pats = @(
        @{ re = '(?i)(^|\s)-(e|ec|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}'; why = 'the command is base64-encoded, which hides what it actually does' },
        @{ re = '(?i)-w(indowstyle)?\s*hidden';                         why = 'it is told to run with a hidden window so you never see it' },
        @{ re = '(?i)-(ep|executionpolicy)\s*bypass';                   why = 'it bypasses the PowerShell safety policy' },
        @{ re = '(?i)downloadstring|downloadfile|invoke-webrequest|iwr\s|curl\s|wget\s|bitstransfer'; why = 'it downloads something from the internet when it runs' },
        @{ re = '(?i)\biex\b|invoke-expression';                        why = 'it builds and runs code on the fly (Invoke-Expression)' },
        @{ re = '(?i)frombase64string';                                  why = 'it decodes hidden base64 content at run time' },
        @{ re = '(?i)https?://';                                         why = 'it contains a web address' },
        @{ re = '(?i)-nop\b|-noprofile';                                 why = 'it uses a flag commonly seen in attack scripts (-NoProfile with other red flags)' }
    )
    $hits = @()
    foreach ($p in $pats) { if ($a -match $p.re) { $hits += $p.why } }
    # -NoProfile on its own is benign; only count it alongside other hits.
    if ($hits.Count -eq 1 -and $hits[0] -like '*-NoProfile*') { return $null }
    if ($hits.Count -eq 0) { return $null }
    return $hits
}

function New-Finding($entry, $score, $title, $signals, $target, $sig, $recommendation) {
    $script:findingSeq++
    $sev = 'low'
    if ($score -ge 60) { $sev = 'high' } elseif ($score -ge 30) { $sev = 'medium' }
    $why = ($signals | ForEach-Object { $_.why }) -join ' '
    $sigStatus = ''
    $signer = ''
    if ($sig) { $sigStatus = $sig.status; $signer = $sig.signer }
    return @{
        id = ('f' + $script:findingSeq)
        severity = $sev
        score = [int]$score
        title = $title
        plainEnglish = $why
        source = $entry.source
        location = $entry.location
        name = $entry.name
        command = $entry.command
        path = $target
        signer = $signer
        signatureStatus = $sigStatus
        signals = $signals
        recommendation = $recommendation
    }
}

$rankMap = @{ high = 3; medium = 2; low = 1 }

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Core analyzer: one auto-start / process entry â†’ trusted or finding
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Analyze-Entry($entry) {
    $script:checked++
    $cmd = [string]$entry.command
    if ([string]::IsNullOrWhiteSpace($cmd)) { return }

    $parts = Split-CommandLine $cmd
    $exe = $parts.exe
    $argStr = $parts.args

    # .lnk shortcuts (startup folder) â†’ resolve to the real target
    if ($exe -and $exe.ToLower().EndsWith('.lnk') -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
        $l = Resolve-Lnk $exe
        if ($l.target) { $exe = Expand-Env $l.target; $argStr = $l.args }
    }

    $exe = Resolve-BareExe $exe
    $base = ''
    try { $base = [System.IO.Path]::GetFileNameWithoutExtension($exe).ToLower() } catch { $base = '' }
    $ext = ''
    try { $ext = [System.IO.Path]::GetExtension($exe).ToLower() } catch { $ext = '' }

    $signals = @()
    $score = 0
    $target = $exe
    $launcherName = ''

    # â”€â”€ Launcher / LOLBin handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if ($launchers -contains $base) {
        $launcherName = $base
        $sa = Extract-ScriptArg $base $argStr
        if ($sa) {
            $sa = Resolve-BareExe (Expand-Env $sa)
            $target = $sa
            try { $ext = [System.IO.Path]::GetExtension($sa).ToLower() } catch { $ext = '' }
        }
        $susp = Test-SuspiciousLauncherArgs $argStr
        if ($susp) {
            # 50 for the first red flag, +10 for each additional one (max 70).
            $score += [math]::Min(70, 50 + 10 * ($susp.Count - 1))
            $signals += @{ code = 'launcher_suspicious_args'; why = ("It starts through $base.exe with warning signs: " + ($susp -join '; ') + ".") }
        }
        if (-not $sa -and $base -in @('powershell','pwsh','cmd','mshta','wscript','cscript') -and -not $susp) {
            # A launcher with inline arguments but no script file â€” show what it runs.
            $inline = $argStr
            if ($inline.Length -gt 160) { $inline = $inline.Substring(0, 160) + '...' }
            if ($inline -match '(?i)-c(ommand)?\s|/c\s|/k\s') {
                $score += 20
                $signals += @{ code = 'launcher_inline_command'; why = "It runs an inline $base command rather than an installed program: `"$inline`"." }
            }
        }
    }

    # â”€â”€ Does the target exist? â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $exists = $false
    if ($target) { $exists = Test-Path -LiteralPath $target -PathType Leaf }
    if (-not $exists) {
        if ($entry.source -eq 'process') {
            $score += 40
            $signals += @{ code = 'process_file_missing'; why = 'The program is running but its file is no longer on disk. Legitimate software rarely deletes itself while running; malware does this to avoid being scanned.' }
        } else {
            # Orphan: harmless clutter, but worth knowing (something used to be here).
            if (-not $target) { $target = [string]$entry.command }
            $signals += @{ code = 'target_missing'; why = "The entry points to `"$target`", which does not exist any more. This is usually a leftover from an uninstalled program, not an active threat, but it shows something was set to auto-start from there." }
            $f = New-Finding $entry 10 'Auto-start entry points to a file that no longer exists' $signals $target $null 'Nothing is running from this entry. If you no longer use the program it refers to, you can remove the leftover entry via Task Manager > Startup apps or Task Scheduler.'
            $script:findings += $f
            return
        }
    }

    $loc = Get-LocationClass $target
    $sig = $null
    if ($exists) { $sig = Get-SigInfo $target }
    $isScript = ($scriptExts -contains $ext)
    # "vouched": somebody we trust stands behind the file (valid signature, or a
    # Microsoft Store package). Used to soften age/location heuristics.
    $vouched = (($sig -and $sig.valid) -or ($loc.class -eq 'store'))

    # â”€â”€ Name tricks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $tbase = ''
    $tname = ''
    try { $tbase = [System.IO.Path]::GetFileNameWithoutExtension($target).ToLower(); $tname = [System.IO.Path]::GetFileName($target) } catch {}
    if (($mimicNames -contains $tbase) -and ($loc.class -ne 'system')) {
        $score += 50
        $signals += @{ code = 'name_mimics_windows'; why = "It is named `"$tname`", which is the name of a core Windows component, but it is not in the Windows folder. Malware often borrows these names to blend in." }
    }
    if ($tname -match '(?i)\.(pdf|doc|docx|xls|xlsx|jpg|jpeg|png|txt|mp3|mp4|zip)\.(exe|scr|com|pif|bat|cmd|vbs|js)$') {
        $score += 40
        $signals += @{ code = 'double_extension'; why = "Its file name `"$tname`" pretends to be a document or picture but is actually a program (double extension)." }
    }
    if ($ext -in @('.scr','.pif','.com') -and $loc.class -ne 'system') {
        $score += 15
        $signals += @{ code = 'odd_executable_type'; why = "It is a `"$ext`" file, an old executable type that modern software almost never uses." }
    }

    # â”€â”€ Signature â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if ($exists) {
        if ($sig.status -eq 'HashMismatch') {
            $score += 60
            $signals += @{ code = 'signature_tampered'; why = "The file carries a digital signature from `"$($sig.signer)`" but its contents no longer match it. The file was modified after it was signed." }
        } elseif ($sig.valid) {
            $signals += @{ code = 'signed_valid'; why = "It is digitally signed by `"$($sig.signer)`" and the signature checks out." }
        } elseif ($isScript) {
            # Scripts are almost never signed; judge them by where they live and what launches them.
            $signals += @{ code = 'script_file'; why = "It is a script ($ext) rather than an installed program, so there is no publisher signature to check." }
            if ($loc.class -ne 'system') { $score += 15 }
        } elseif ($loc.class -eq 'store') {
            # Microsoft Store packages are verified as a whole; the individual exe
            # inside often has no embedded signature, and app-execution aliases
            # cannot be opened at all. Neither is a red flag.
            $signals += @{ code = 'store_app'; why = 'It is a Microsoft Store app. Store packages are verified by Microsoft as a whole, so the individual file does not need its own signature.' }
        } elseif ($sig.status -eq 'NotSigned' -or -not $sig.signer) {
            # NotSigned, or a status such as UnknownError with no certificate at
            # all (non-PE / truncated files): either way nobody vouches for it.
            if ($loc.class -eq 'programfiles') {
                $score += 15
                $signals += @{ code = 'unsigned_programfiles'; why = 'It is installed in Program Files, which is normal, but the file itself has no digital signature, so Windows cannot confirm who made it. Smaller vendors sometimes skip signing; it is worth a glance, not alarm.' }
            } elseif ($loc.class -eq 'devtools') {
                $score += 10
                $signals += @{ code = 'unsigned_devtool'; why = 'It has no digital signature, which is common for developer tools installed from package registries.' }
            } elseif ($loc.class -ne 'system') {
                $score += 25
                $signals += @{ code = 'unsigned'; why = 'It has no digital signature, so Windows cannot tell who made it. Reputable vendors sign their software.' }
            }
        } else {
            $score += 30
            $signals += @{ code = 'signature_invalid'; why = "Its digital signature could not be trusted (status: $($sig.status), signer: `"$($sig.signer)`")." }
        }
    }

    # â”€â”€ Location â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    switch ($loc.class) {
        'suspicious' { $score += 30; $signals += @{ code = 'location_suspicious'; why = "It lives in $($loc.label)." } }
        'profile'    { $score += 15; $signals += @{ code = 'location_profile';    why = "It lives in $($loc.label)." } }
        'other'      { $score += 10; $signals += @{ code = 'location_other';      why = "It lives in $($loc.label): $target." } }
        'devtools'   {
            if ($entry.source -eq 'process') { $signals += @{ code = 'location_devtools'; why = "It lives in $($loc.label)." } }
            else { $score += 20; $signals += @{ code = 'autostart_from_devtools'; why = "It is set to auto-start from $($loc.label). Developer tools normally run only while you use them; one that auto-starts is unusual." } }
        }
        'userapps'   { if (-not $sig -or -not $sig.valid) { $score += 10; $signals += @{ code = 'location_userapps_unsigned'; why = "It lives in $($loc.label), and because it is unsigned there is no publisher to vouch for it." } } }
        default      { }
    }
    # A validly signed program in Temp/Downloads is less alarming (often an installer / updater).
    if ($loc.class -eq 'suspicious' -and $sig -and $sig.valid) { $score -= 15 }

    # â”€â”€ File attributes / age â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if ($exists) {
        try {
            $fi = Get-Item -LiteralPath $target -Force
            if ($fi.Attributes -band [System.IO.FileAttributes]::Hidden) {
                $score += 15
                $signals += @{ code = 'hidden_file'; why = 'The file is marked hidden, so it does not show up in normal folder views.' }
            }
            $ageDays = ((Get-Date) - $fi.CreationTime).TotalDays
            if ($ageDays -lt 14 -and -not $vouched) {
                $score += 10
                $signals += @{ code = 'recent_unsigned'; why = ("It appeared on this PC only " + [int][math]::Max(0, $ageDays) + " day(s) ago.") }
            }
        } catch {}
    }

    # â”€â”€ Decide â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    $sigOk = ($sig -and $sig.valid)
    $normalPlace = ($loc.class -in @('system','programfiles','store','userapps','programdata','devtools'))
    if ($score -lt 10) {
        if ($script:showTrusted) {
            $script:trusted += @{
                source = $entry.source; location = $entry.location; name = $entry.name; path = $target
                signer = $(if ($sig) { $sig.signer } else { '' }); signatureStatus = $(if ($sig) { $sig.status } else { '' })
                reason = $(if ($sigOk -and $normalPlace) { "Signed by $($sig.signer), installed in $($loc.label)." } else { 'No warning signs found.' })
            }
        }
        return
    }

    # Title + recommendation in plain English
    $how = switch ($entry.source) {
        'run_key'      { 'starts automatically when you sign in (registry Run key)' }
        'startup_folder' { 'starts automatically when you sign in (Startup folder)' }
        'scheduled_task' { 'is launched on a schedule or trigger by Task Scheduler' }
        'service'      { 'runs in the background as a Windows service' }
        'process'      { 'is running right now' }
        'winlogon'     { 'hooks into the Windows sign-in process' }
        'ifeo'         { 'hijacks another program through Image File Execution Options' }
        'appinit'      { 'is injected into every program that uses the Windows UI (AppInit_DLLs)' }
        'wmi'          { 'is triggered by a WMI event subscription (an unusual, hard-to-spot persistence method)' }
        default        { 'auto-starts' }
    }
    $what = 'An unsigned program'
    if ($sigOk) { $what = "A program signed by `"$($sig.signer)`"" }
    if ($loc.class -eq 'store') { $what = 'A Microsoft Store app' }
    if ($isScript) { $what = "A $ext script" }
    if ($launcherName -and ($signals | Where-Object { $_.code -eq 'launcher_suspicious_args' })) { $what = "A hidden $launcherName command" }
    $title = "$what $how"
    if ($loc.class -eq 'suspicious') { $title += " from " + ($loc.label -replace '\s*\(.*\)$','') }

    $rec = 'If you recognise this program, no action is needed. If you do not, right-click the file in Explorer and choose "Scan with Microsoft Defender", and consider disabling the auto-start entry (Task Manager > Startup apps, or Task Scheduler) until you know what it is.'
    if ($score -ge 60) {
        $rec = 'Treat this as a priority: run a full Microsoft Defender scan, look up the file name and path, and if nothing explains it, disable the entry and consider uploading the file to VirusTotal for a second opinion. This tool has not changed anything.'
    }
    $signals = @($signals | Where-Object { $_.code -ne 'signed_valid' -or $score -ge 10 })
    $script:findings += New-Finding $entry $score $title $signals $target $sig $rec
}

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Collectors (all read-only)
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Collect-RunKeys {
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run'
    )
    $out = @()
    foreach ($k in $keys) {
        $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        foreach ($prop in $p.PSObject.Properties) {
            if ($prop.Name -like 'PS*') { continue }
            $out += @{ source = 'run_key'; location = $k; name = $prop.Name; command = [string]$prop.Value; enabled = $true }
        }
    }
    return $out
}

function Collect-StartupFolders {
    $dirs = @("$roamApp\Microsoft\Windows\Start Menu\Programs\Startup", "$progData\Microsoft\Windows\Start Menu\Programs\StartUp")
    $out = @()
    foreach ($d in $dirs) {
        if (-not (Test-Path -LiteralPath $d)) { continue }
        Get-ChildItem -LiteralPath $d -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -eq 'desktop.ini') { return }
            $out += @{ source = 'startup_folder'; location = $d; name = $_.Name; command = $_.FullName; enabled = $true }
        }
    }
    return $out
}

function Collect-ScheduledTasks {
    $out = @()
    $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue
    foreach ($t in $tasks) {
        if ($t.State -eq 'Disabled') { continue }
        foreach ($a in $t.Actions) {
            if (-not $a.Execute) { continue }   # COM-handler actions have no command line
            $exe = $a.Execute.Trim().Trim('"')
            $cmd = "`"$exe`""
            if ($a.Arguments) { $cmd = "`"$exe`" $($a.Arguments)" }
            $out += @{ source = 'scheduled_task'; location = $t.TaskPath; name = $t.TaskName; command = $cmd; enabled = $true }
        }
    }
    return $out
}

function Collect-Services {
    $out = @()
    Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.StartMode -eq 'Disabled') { return }
        if (-not $_.PathName) { return }
        $out += @{ source = 'service'; location = ("service:" + $_.Name); name = $_.DisplayName; command = $_.PathName; enabled = ($_.StartMode -ne 'Disabled') }
    }
    return $out
}

function Collect-Processes {
    $out = @()
    $seen = @{}
    Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $_.Path) { return }
        $k = $_.Path.ToLower()
        if ($seen.ContainsKey($k)) { return }
        $seen[$k] = $true
        $out += @{ source = 'process'; location = ("pid:" + $_.Id); name = $_.ProcessName; command = ('"' + $_.Path + '"'); enabled = $true }
    }
    return $out
}

function Collect-SystemHooks {
    $out = @()
    # Winlogon Shell / Userinit
    $wl = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue
    if ($wl) {
        $shell = [string]$wl.Shell
        if ($shell -and $shell.Trim().ToLower() -ne 'explorer.exe') {
            $out += @{ source = 'winlogon'; location = 'Winlogon\Shell'; name = 'Shell'; command = $shell; enabled = $true; forceScore = 60; forceWhy = "The Windows shell is set to `"$shell`" instead of the default explorer.exe. Whatever is listed here runs instead of (or before) your desktop." }
        }
        $ui = [string]$wl.Userinit
        if ($ui) {
            $extra = @($ui.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and ($_ -notmatch '(?i)^[a-z]:\\windows\\system32\\userinit\.exe$') })
            foreach ($e in $extra) {
                $out += @{ source = 'winlogon'; location = 'Winlogon\Userinit'; name = 'Userinit'; command = $e; enabled = $true; forceScore = 60; forceWhy = "An extra program `"$e`" has been added to the Winlogon Userinit list, so it runs every time anyone signs in, before the desktop appears." }
            }
        }
    }
    # Image File Execution Options debuggers
    $ifeoRoot = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options'
    $subs = Get-ChildItem -Path $ifeoRoot -ErrorAction SilentlyContinue
    foreach ($s in $subs) {
        $dbg = $null
        try { $dbg = (Get-ItemProperty -Path $s.PSPath -ErrorAction Stop).Debugger } catch { continue }
        if (-not $dbg) { continue }
        $dparts = Split-CommandLine $dbg
        $dbase = ''
        try { $dbase = [System.IO.Path]::GetFileName($dparts.exe).ToLower() } catch {}
        if ($knownIfeoDebuggers -contains $dbase) { continue }
        $out += @{ source = 'ifeo'; location = ($ifeoRoot + '\' + $s.PSChildName); name = $s.PSChildName; command = $dbg; enabled = $true; forceScore = 50; forceWhy = "Whenever `"$($s.PSChildName)`" is launched, Windows silently runs `"$dbg`" instead. This 'debugger' setting is a well-known way to hijack or disable programs (for example, security tools)." }
    }
    # AppInit_DLLs
    foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Windows')) {
        $w = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
        if ($w -and $w.AppInit_DLLs -and ([string]$w.AppInit_DLLs).Trim()) {
            $enabled = ($w.LoadAppInit_DLLs -eq 1)
            $out += @{ source = 'appinit'; location = $k; name = 'AppInit_DLLs'; command = [string]$w.AppInit_DLLs; enabled = $enabled; forceScore = $(if ($enabled) { 50 } else { 20 }); forceWhy = "A DLL is listed in AppInit_DLLs, which makes Windows load it into almost every program you open." + $(if (-not $enabled) { ' (Loading is currently switched off, so it is dormant.)' } else { '' }) }
        }
    }
    # WMI permanent event subscriptions
    $consumers = Get-CimInstance -Namespace root\subscription -ClassName __EventConsumer -ErrorAction SilentlyContinue
    foreach ($c in $consumers) {
        $cls = $c.CimClass.CimClassName
        if ($cls -eq 'CommandLineEventConsumer') {
            $out += @{ source = 'wmi'; location = 'root\subscription'; name = $c.Name; command = [string]$c.CommandLineTemplate; enabled = $true; forceScore = 45; forceWhy = "A WMI event subscription named `"$($c.Name)`" runs a command whenever a system event fires. Almost no consumer software uses this; it is a favourite of fileless malware because it survives reboots and does not appear in Startup apps." }
        } elseif ($cls -eq 'ActiveScriptEventConsumer') {
            $snippet = [string]$c.ScriptText
            if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) + '...' }
            $out += @{ source = 'wmi'; location = 'root\subscription'; name = $c.Name; command = ("<inline script> " + $snippet); enabled = $true; forceScore = 60; forceWhy = "A WMI event subscription named `"$($c.Name)`" runs an embedded script whenever a system event fires. This is a classic fileless-malware technique and is very rarely legitimate." }
        }
        # NTEventLogEventConsumer ("SCM Event Log Consumer") is a stock Windows entry â€” ignored.
    }
    return $out
}

function Collect-HostsFile {
    $hosts = "$sysRoot\System32\drivers\etc\hosts"
    $out = @()
    if (-not (Test-Path -LiteralPath $hosts)) { return $out }
    $lines = Get-Content -LiteralPath $hosts -ErrorAction SilentlyContinue
    $entries = @()
    foreach ($ln in $lines) {
        $clean = ($ln -replace "`0", '').Trim()
        if (-not $clean -or $clean.StartsWith('#')) { continue }
        if ($clean -match '^(127\.0\.0\.1|::1|0\.0\.0\.0)\s+(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback|broadcasthost)$') { continue }
        $entries += $clean
    }
    if ($entries.Count -eq 0) { return $out }
    $sensitive = @('microsoft.com','windowsupdate.com','windows.com','update.microsoft','defender','google.com','apple.com','mozilla.org','avast','avg.com','kaspersky','bitdefender','malwarebytes','norton','mcafee','eset.com','sophos','virustotal','paypal','bank')
    $redirected = @()
    foreach ($e in $entries) { foreach ($s in $sensitive) { if (ContainsCI $e $s) { $redirected += $e; break } } }
    if ($redirected.Count -gt 0) {
        $out += @{ source = 'hosts'; location = $hosts; name = 'hosts file'; command = ($redirected -join ' | '); enabled = $true; forceScore = 50; forceWhy = ("Your hosts file redirects or blocks " + $redirected.Count + " important address(es) (for example Windows Update, security vendors, or banks). Malware edits this file to stop security updates or to send you to fake sites. Entries: " + (($redirected | Select-Object -First 5) -join '; ')) }
    } elseif ($entries.Count -gt 25) {
        $out += @{ source = 'hosts'; location = $hosts; name = 'hosts file'; command = ("$($entries.Count) custom entries"); enabled = $true; forceScore = 10; forceWhy = ("Your hosts file has " + $entries.Count + " custom entries. Ad-blockers and developers do this legitimately, but it is worth knowing about.") }
    }
    return $out
}

function Collect-Defender() {
    $d = @{ available = $false }
    $mp = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if (-not $mp) {
        $d.note = 'Microsoft Defender status could not be read (another antivirus may be in charge, or the Defender module is unavailable).'
        return $d
    }
    $d.available = $true
    $d.antivirusEnabled = [bool]$mp.AntivirusEnabled
    $d.realTimeProtection = [bool]$mp.RealTimeProtectionEnabled
    $d.tamperProtection = [bool]$mp.IsTamperProtected
    $d.signatureAgeDays = [int]$mp.AntivirusSignatureAge
    $d.lastQuickScan = $(if ($mp.QuickScanEndTime) { $mp.QuickScanEndTime.ToString('s') } else { '' })
    $d.lastFullScan = $(if ($mp.FullScanEndTime) { $mp.FullScanEndTime.ToString('s') } else { '' })
    return $d
}

function Add-DefenderFindings($d) {
    if (-not $d.available) { return }
    $e = @{ source = 'defender'; location = 'Microsoft Defender'; name = 'Defender'; command = ''; enabled = $true }
    if (-not $d.antivirusEnabled) {
        $script:findings += New-Finding $e 70 'Microsoft Defender antivirus is switched off' @(@{ code = 'defender_off'; why = 'Defender reports that antivirus protection is disabled. Unless another antivirus is installed and active, nothing is scanning new files.' }) '' $null 'Open Windows Security > Virus & threat protection and turn protection on, or confirm your third-party antivirus is active.'
    } elseif (-not $d.realTimeProtection) {
        $script:findings += New-Finding $e 60 'Defender real-time protection is off' @(@{ code = 'defender_rtp_off'; why = 'Real-time protection is disabled, so files are not checked as they arrive or run. Malware frequently turns this off first.' }) '' $null 'Open Windows Security > Virus & threat protection > Manage settings and switch Real-time protection on. If it turns itself off again, that is a strong sign of infection.'
    }
    if ($d.antivirusEnabled -and -not $d.tamperProtection) {
        $script:findings += New-Finding $e 30 'Defender tamper protection is off' @(@{ code = 'defender_tamper_off'; why = 'Tamper protection stops programs from silently changing Defender settings. It is currently off.' }) '' $null 'Open Windows Security > Virus & threat protection > Manage settings and turn Tamper Protection on.'
    }
    if ($d.antivirusEnabled -and $d.signatureAgeDays -gt 7) {
        $script:findings += New-Finding $e 30 'Defender virus definitions are out of date' @(@{ code = 'defender_sigs_old'; why = ("Defender's virus definitions are " + $d.signatureAgeDays + " days old. New threats are added daily, so stale definitions miss recent malware.") }) '' $null 'Open Windows Security > Virus & threat protection and click "Check for updates".'
    }
}

# Entries that come with a pre-decided score (system hooks, hosts) still get
# the file-level analysis for extra context, but never drop below forceScore.
function Analyze-Forced($entry) {
    $script:checked++
    $sig = $null
    $target = ''
    $extra = @()
    if ($entry.source -ne 'hosts') {
        $parts = Split-CommandLine ([string]$entry.command)
        $target = Resolve-BareExe $parts.exe
        if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
            $sig = Get-SigInfo $target
            $loc = Get-LocationClass $target
            if ($sig.valid) { $extra += @{ code = 'signed_valid'; why = "The file it runs is signed by `"$($sig.signer)`" and lives in $($loc.label)." } }
            else { $extra += @{ code = 'unsigned'; why = "The file it runs is not validly signed (status: $($sig.status)) and lives in $($loc.label)." } }
        }
    }
    $score = [int]$entry.forceScore
    # A Microsoft-signed *application* in a persistence hook is less alarming
    # (vendor tooling); a Microsoft-signed *launcher* (cmd, powershell, rundll32)
    # is exactly how these hooks are abused, so no discount for those.
    $tbase = ''
    try { $tbase = [System.IO.Path]::GetFileNameWithoutExtension($target).ToLower() } catch {}
    if ($sig -and $sig.valid -and $sig.isMicrosoft -and ($launchers -notcontains $tbase)) { $score = [math]::Max(10, $score - 30) }
    $signals = @(@{ code = ('persistence_' + $entry.source); why = $entry.forceWhy }) + $extra
    $titleMap = @{
        winlogon = 'Sign-in process has been modified (Winlogon)'
        ifeo     = 'A program launch is being hijacked (Image File Execution Options)'
        appinit  = 'A DLL is injected into every program (AppInit_DLLs)'
        wmi      = 'Hidden auto-start via WMI event subscription'
        hosts    = 'Hosts file has been modified'
    }
    $title = $titleMap[$entry.source]
    if (-not $title) { $title = 'Unusual persistence mechanism' }
    $rec = 'This mechanism is rarely used by normal software. If you did not set it up (or an IT department did not), run a full Microsoft Defender scan and consider removing the entry after backing up the registry key.'
    if ($entry.source -eq 'hosts') { $rec = 'Open C:\Windows\System32\drivers\etc\hosts in Notepad (as administrator) and review the entries. Remove any you did not add. Nothing has been changed by this scan.' }
    $script:findings += New-Finding $entry $score $title $signals $target $sig $rec
}

# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Main
# â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
try {
    $ran = @()
    $defender = $null

    if ($fixture) {
        if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) { Fail 'fixture_not_found' "Fixture file not found: $fixture" }
        $fx = $null
        try { $fx = Get-Content -LiteralPath $fixture -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop } catch { Fail 'fixture_invalid' "Fixture is not valid JSON: $($_.Exception.Message)" }
        $ran += 'fixture'
        $notes += "Fixture mode: analysing synthetic entries from $fixture; the live PC was not scanned."
        foreach ($fe in @($fx.entries)) {
            $entry = @{ source = [string]$fe.source; location = [string]$fe.location; name = [string]$fe.name; command = [string]$fe.command; enabled = $true }
            if ($fe.PSObject.Properties['forceScore']) { $entry.forceScore = [int]$fe.forceScore; $entry.forceWhy = [string]$fe.forceWhy; Analyze-Forced $entry }
            else { Analyze-Entry $entry }
        }
        if ($fx.PSObject.Properties['defender'] -and $fx.defender) {
            $defender = @{ available = $true }
            foreach ($p in $fx.defender.PSObject.Properties) { $defender[$p.Name] = $p.Value }
            if (-not $defender.ContainsKey('tamperProtection')) { $defender.tamperProtection = $true }
            if (-not $defender.ContainsKey('signatureAgeDays')) { $defender.signatureAgeDays = 0 }
            Add-DefenderFindings $defender
        }
    } else {
        if (Want 'autoruns') {
            $ran += 'autoruns'
            foreach ($e in (Collect-RunKeys)) { Analyze-Entry $e }
            foreach ($e in (Collect-StartupFolders)) { Analyze-Entry $e }
        }
        if (Want 'tasks') {
            $ran += 'tasks'
            foreach ($e in (Collect-ScheduledTasks)) { Analyze-Entry $e }
        }
        if (Want 'services') {
            $ran += 'services'
            foreach ($e in (Collect-Services)) { Analyze-Entry $e }
        }
        if (Want 'processes') {
            $ran += 'processes'
            foreach ($e in (Collect-Processes)) { Analyze-Entry $e }
        }
        if (Want 'system') {
            $ran += 'system'
            foreach ($e in (Collect-SystemHooks)) { Analyze-Forced $e }
            foreach ($e in (Collect-HostsFile)) { Analyze-Forced $e }
            $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            if (-not $isAdmin) { $notes += 'Not running as administrator: some protected registry keys and processes could not be inspected (this is normal and expected).' }
        }
        if (Want 'defender') {
            $ran += 'defender'
            $defender = Collect-Defender
            Add-DefenderFindings $defender
        }
    }

    # Sort: severity desc, then score desc; cap.
    $sorted = @($findings | Sort-Object -Property @{ Expression = { $rankMap[$_.severity] }; Descending = $true }, @{ Expression = { $_.score }; Descending = $true })
    $total = $sorted.Count
    if ($total -gt $maxFindings) { $sorted = @($sorted | Select-Object -First $maxFindings); $notes += "Showing $maxFindings of $total findings." }

    $summary = @{
        high   = @($findings | Where-Object { $_.severity -eq 'high' }).Count
        medium = @($findings | Where-Object { $_.severity -eq 'medium' }).Count
        low    = @($findings | Where-Object { $_.severity -eq 'low' }).Count
        checked = $checked
        trusted = ($checked - $findings.Count)
    }
    $verdict = 'No warning signs found. Everything that auto-starts is signed by a known publisher and lives where installed software belongs.'
    if ($summary.high -gt 0) { $verdict = "$($summary.high) item(s) need a closer look. Read the explanations below and run a Defender scan if you do not recognise them." }
    elseif ($summary.medium -gt 0) { $verdict = "$($summary.medium) item(s) are unusual but not necessarily harmful. Check whether you recognise them." }
    elseif ($summary.low -gt 0) { $verdict = "Only minor notes (leftover entries or informational items). Nothing looks harmful." }

    $result = @{
        ok = $true
        scannedAt = (Get-Date).ToString('s')
        durationMs = [int]$sw.ElapsedMilliseconds
        readOnly = $true
        sections = $ran
        verdict = $verdict
        summary = $summary
        findings = $sorted
        notes = $notes
    }
    if ($defender) { $result.defender = $defender }
    if ($showTrusted) { $result.trusted = $trusted }
    Out-Result $result
} catch {
    Fail 'scan_failed' "security-scan: $($_.Exception.Message)"
}
