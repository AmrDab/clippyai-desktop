<#
.SYNOPSIS
    Gets the currently focused/foreground window.
.DESCRIPTION
    Returns JSON with info about the foreground window using Win32 GetForegroundWindow.
.PARAMETER ExcludeProcessId
    The caller's own process (Clippy). The user is typing in Clippy's bubble, so
    it is nearly always the true foreground window; when it is, report the next
    visible titled window down the Z-order instead (same walk as
    get-screen-context.ps1) so the model learns what app the user is really on.
#>
param([int]$ExcludeProcessId = 0)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    # Unique class name: scripts share one PowerShell host, where a type name
    # re-registered with a different definition makes Add-Type throw.
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class ClippyFgWin {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        public static uint PidOf(IntPtr hWnd) { uint pid = 0; GetWindowThreadProcessId(hWnd, out pid); return pid; }
        // Foreground window, skipping `exclude` by walking down the Z-order to
        // the next visible, titled window of another process.
        public static IntPtr Foreground(uint exclude) {
            IntPtr h = GetForegroundWindow();
            if (exclude == 0 || h == IntPtr.Zero || PidOf(h) != exclude) return h;
            int guard = 0;
            while (h != IntPtr.Zero && guard++ < 200) {
                uint pid = PidOf(h);
                if (pid != 0 && pid != exclude && IsWindowVisible(h) && GetWindowTextLength(h) > 0) return h;
                h = GetWindow(h, 2); // GW_HWNDNEXT
            }
            return IntPtr.Zero;
        }
    }
"@
} catch {
    [Console]::Out.Write((@{ error = "Failed to load assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    # Get foreground window handle
    $fgWindow = [ClippyFgWin]::Foreground([uint32]$ExcludeProcessId)
    
    if ($fgWindow -eq [IntPtr]::Zero) {
        [Console]::Out.Write((@{ error = "No foreground window found" } | ConvertTo-Json -Compress))
        exit 1
    }

    # Get process ID
    $processId = 0
    [void][ClippyFgWin]::GetWindowThreadProcessId($fgWindow, [ref]$processId)

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
