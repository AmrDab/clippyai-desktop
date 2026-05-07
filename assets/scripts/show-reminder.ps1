# show-reminder.ps1
#
# v0.11.25 — security: this is the helper invoked by scheduled tasks
# created by com-create-reminder.ps1. Reading from a JSON sidecar file
# eliminates the cmd-injection vector that existed in the previous
# implementation, which embedded user-supplied $title and $notes into
# a single-quote PowerShell string passed via -Command. Per Subagent A
# audit (May 7), `''` doubling alone was insufficient — a notes string
# of `''); calc.exe; #` would escape the quote AND execute the trailing
# command. Now: scheduled task arguments contain only paths we control
# (the helper script + a per-task JSON sidecar). No user input is
# re-parsed by PowerShell.
#
# Args:
#   -DataFile  path to the per-task JSON sidecar containing { title, notes }

param(
    [string]$DataFile = ""
)

if ([string]::IsNullOrWhiteSpace($DataFile) -or -not (Test-Path -LiteralPath $DataFile)) {
    # Reminder fired but the sidecar is missing — nothing useful to display.
    exit 1
}

try {
    $raw = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8
    $data = $raw | ConvertFrom-Json
    $title = if ($data.title) { [string]$data.title } else { 'Clippy reminder' }
    $notes = if ($data.notes) { [string]$data.notes } else { '' }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($notes, $title) | Out-Null
} catch {
    # Best effort — the reminder fired but display failed. Silent.
} finally {
    # Clean up the sidecar regardless of display outcome.
    try { Remove-Item -LiteralPath $DataFile -Force -ErrorAction SilentlyContinue } catch {}
}

exit 0
