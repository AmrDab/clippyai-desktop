<#
.SYNOPSIS
    v0.23 — paste text into the focused window, honestly.
.DESCRIPTION
    1. Refuses when the foreground window belongs to -OwnPid (Clippy itself),
       so the model is told to focus the target app instead of pasting into
       Clippy's own bubble.
    2. Puts the file's contents on the clipboard and sends Ctrl+V (same
       mechanism as before — byte-exact, emoji/RTL safe).
    3. Reads the focused element back through UIA (ValuePattern, then
       TextPattern) and returns the tail so the caller can compare it with
       what it meant to type. Apps without either pattern return no readback
       and the caller reports 'unverified'.
.PARAMETER File
    UTF-8 file holding the text to paste (nothing model-supplied touches the
    command line).
.PARAMETER OwnPid
    The caller's own process id; pasting is refused when it is foreground.
#>
param(
    [string]$File,
    [int]$OwnPid = 0
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class TypeTextWin32 {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        public static uint ForegroundPid() { uint pid = 0; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
    }
"@
    $fgPid = [int][TypeTextWin32]::ForegroundPid()
    $processName = ""
    try { $processName = [System.Diagnostics.Process]::GetProcessById($fgPid).ProcessName } catch {}

    if ($OwnPid -gt 0 -and $fgPid -eq $OwnPid) {
        [Console]::Out.Write((@{ success = $false; error = "own_window"; foregroundProcessId = $fgPid } | ConvertTo-Json -Compress))
        exit 0
    }

    $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $File
    Set-Clipboard -Value $text
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 150

    # Readback — logic from ps-bridge.ps1 Cmd-GetFocusedElement.
    $readback = $null
    try {
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused) {
            try {
                $vp = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $readback = [string]$vp.Current.Value
            } catch {
                try {
                    $tp = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                    $readback = [string]$tp.DocumentRange.GetText(-1)
                } catch {}
            }
        }
    } catch {}
    if ($null -ne $readback -and $readback.Length -gt 300) { $readback = $readback.Substring($readback.Length - 300) }

    [Console]::Out.Write(([ordered]@{
        success             = $true
        foregroundProcessId = $fgPid
        processName         = $processName
        hasReadback         = ($null -ne $readback)
        readback            = $readback
    } | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.Write((@{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
