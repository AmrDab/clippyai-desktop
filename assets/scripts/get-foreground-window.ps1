<#
.SYNOPSIS
    Gets the currently focused/foreground window.
.DESCRIPTION
    Returns JSON with info about the foreground window using Win32 GetForegroundWindow.
#>

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    # Add Win32 API for GetForegroundWindow
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    }
"@
} catch {
    [Console]::Out.Write((@{ error = "Failed to load assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    # Get foreground window handle
    $fgWindow = [Win32]::GetForegroundWindow()
    
    if ($fgWindow -eq [IntPtr]::Zero) {
        [Console]::Out.Write((@{ error = "No foreground window found" } | ConvertTo-Json -Compress))
        exit 1
    }

    # Get process ID
    $processId = 0
    [void][Win32]::GetWindowThreadProcessId($fgWindow, [ref]$processId)

    # Get process name
    $processName = "unknown"
    try {
        $proc = [System.Diagnostics.Process]::GetProcessById($processId)
        $processName = $proc.ProcessName
    } catch { }

    # Get window title + bounds via UI Automation. v0.23 — bounds were
    # missing, so smart_click's foreground-window OCR filter never activated.
    $title = ""
    $bounds = $null
    try {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($fgWindow)
        if ($element) {
            $title = $element.Current.Name
            $rect = $element.Current.BoundingRectangle
            if (-not [double]::IsInfinity($rect.X) -and -not [double]::IsInfinity($rect.Y)) {
                $bounds = [ordered]@{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
            }
        }
    } catch { }

    $result = [ordered]@{
        handle    = [int]$fgWindow
        processId = $processId
        processName = $processName
        title     = $title
        bounds    = $bounds
        success   = $true
    }

    [Console]::Out.Write(($result | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
