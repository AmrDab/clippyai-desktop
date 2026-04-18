<#
.SYNOPSIS
    Focuses (brings to front) a window by title substring or process ID.
    Uses UI Automation WindowPattern.SetWindowVisualState + SetFocus.
.PARAMETER Title
    Substring match against window titles (case-insensitive).
.PARAMETER ProcessId
    Exact process ID to focus.
.PARAMETER Restore
    If true, restore from minimized state before focusing.
#>
param(
    [string]$Title = "",
    [int]$ProcessId = 0,
    [switch]$Restore
)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
} catch {
    [Console]::Out.Write((@{ success = $false; error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWindows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $windowCondition
    )

    $targetWindow = $null

    if ($ProcessId -gt 0) {
        foreach ($win in $allWindows) {
            try {
                if ($win.Current.ProcessId -eq $ProcessId) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
    } elseif ($Title -ne "") {
        $titleLower = $Title.ToLower()
        foreach ($win in $allWindows) {
            try {
                $winTitle = $win.Current.Name
                if ($winTitle -and $winTitle.ToLower().Contains($titleLower)) {
                    $targetWindow = $win
                    break
                }
            } catch {}
        }
    } else {
        [Console]::Out.Write((@{ success = $false; error = "Must specify -Title or -ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    if ($null -eq $targetWindow) {
        [Console]::Out.Write((@{ success = $false; error = "Window not found matching Title='$Title' ProcessId=$ProcessId" } | ConvertTo-Json -Compress))
        exit 0
    }

    # Restore from minimized if needed
    try {
        $winPattern = $targetWindow.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        $state = $winPattern.Current.WindowVisualState
        if ($state -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
            $winPattern.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal)
            Start-Sleep -Milliseconds 200
        }
    } catch {
        # WindowPattern may not be available
    }

    # Set focus — uses the Alt-key workaround to bypass Windows' restriction
    # on SetForegroundWindow from background processes. Without this, Windows
    # silently blocks the call and the target window stays behind ClippyAI.
    # This is THE fix for the "typed hello world but nothing appeared" bug.
    Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class ForceFocus {
            [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
            [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
            [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
            [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

            public static bool ForceForeground(IntPtr hwnd) {
                IntPtr foreWnd = GetForegroundWindow();
                uint foreThread = GetWindowThreadProcessId(foreWnd, IntPtr.Zero);
                uint curThread = GetCurrentThreadId();

                // Attach to foreground thread so Windows allows us to set foreground
                if (foreThread != curThread) {
                    AttachThreadInput(foreThread, curThread, true);
                }

                // Simulate Alt key to bypass foreground lock
                keybd_event(0x12, 0, 0, 0);   // VK_MENU (Alt) down

                ShowWindow(hwnd, 9);           // SW_RESTORE
                bool result = SetForegroundWindow(hwnd);

                keybd_event(0x12, 0, 2, 0);   // VK_MENU up (KEYEVENTF_KEYUP)

                if (foreThread != curThread) {
                    AttachThreadInput(foreThread, curThread, false);
                }

                return result;
            }
        }
"@
    $hwnd = [IntPtr]$targetWindow.Current.NativeWindowHandle
    $result = [ForceFocus]::ForceForeground($hwnd)

    if (-not $result) {
        # Last resort: UIA SetFocus
        try { $targetWindow.SetFocus() } catch {}
    }

    Start-Sleep -Milliseconds 200

    $c = $targetWindow.Current
    [Console]::Out.Write((@{
        success     = $true
        title       = $c.Name
        processId   = $c.ProcessId
        handle      = $c.NativeWindowHandle
    } | ConvertTo-Json -Compress))

} catch {
    [Console]::Out.Write((@{ success = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
