# com-run-powershell.ps1
# Args: $script (PS code to run)
# Outputs JSON on the last line.

param(
    [string]$script    = "",
    [string]$scriptB64 = ""
)

# v0.11.25 — base64 variant for the script body. Multi-line scripts
# (which are virtually all non-trivial scripts the model emits) were
# previously silently truncated by the PS command-line tokenizer to
# their first line — the job ran just the first line and reported
# success. Subagent A flagged this as a latent P1. The B64 path
# preserves the entire script verbatim.
if ($scriptB64) {
    try { $script = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($scriptB64)) }
    catch { }
}

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg, $output = "") {
    Out-Result @{ ok = $false; error = $msg; output = $output }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($script)) { Fail "script is required" }

# --- Safety block list (case-insensitive) ---
$blockedPatterns = @(
    'Remove-Item',
    'rm ',
    'del ',
    'rd ',
    'rmdir',
    'format ',
    'reg delete',
    'reg add',
    'Stop-Process',
    '\bKill\b',
    'Invoke-WebRequest',
    'iwr ',
    'curl ',
    'wget ',
    'Set-ExecutionPolicy',
    'New-LocalUser',
    'net user',
    'net localgroup',
    'Disable-',
    'Enable-WindowsOptionalFeature',
    'Clear-EventLog',
    '\[System\.Net\.WebClient\]',
    'DownloadFile',
    'DownloadString'
)

foreach ($pattern in $blockedPatterns) {
    if ($script -imatch $pattern) {
        Fail "Script contains blocked pattern '$pattern'. This operation is not allowed for safety reasons."
    }
}

# --- Run in a sandboxed job with 15-second timeout ---
$scriptBlock = [scriptblock]::Create($script)

try {
    $job = Start-Job -ScriptBlock {
        param($code)
        # Restrict language mode inside the job
        $ExecutionContext.SessionState.LanguageMode = 'RestrictedLanguage'
        $sb = [scriptblock]::Create($code)
        & $sb
    } -ArgumentList $script

    $completed = Wait-Job -Job $job -Timeout 15

    if ($null -eq $completed) {
        Stop-Job  -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        Fail "Script timed out after 15 seconds"
    }

    $jobOutput = Receive-Job -Job $job -ErrorVariable jobErrors 2>&1
    $exitCode  = if ($job.State -eq 'Failed') { 1 } else { 0 }
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

    # Combine stdout and stderr into a single string
    $outputLines = @()
    if ($jobOutput)  { $outputLines += $jobOutput  | ForEach-Object { "$_" } }
    if ($jobErrors)  { $outputLines += $jobErrors  | ForEach-Object { "ERROR: $_" } }
    $outputStr = $outputLines -join "`n"

    if ($exitCode -ne 0 -or $job.State -eq 'Failed') {
        Out-Result @{
            ok       = $false
            error    = "Script execution failed (state: $($job.State))"
            output   = $outputStr
            exitCode = $exitCode
        }
    } else {
        Out-Result @{
            ok       = $true
            output   = $outputStr
            exitCode = $exitCode
        }
    }
} catch {
    Fail "Unexpected error running script: $($_.Exception.Message)"
}
