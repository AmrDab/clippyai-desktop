<#
.SYNOPSIS
    Combined script: gets windows list + focused window UI tree in ONE call.
    Eliminates multiple PowerShell spawn overhead.
.PARAMETER FocusedProcessId
    If specified, includes the UI tree for this process's window. When 0
    (the default) the foreground window's process is used (v0.23).
.PARAMETER ExcludeProcessId
    Never build the tree for this process (the caller's own window). If the
    foreground window belongs to it, the next window down the Z-order is used.
.PARAMETER MaxDepth
    Maximum UI tree depth (default 4).
.PARAMETER MaxNodes
    Stop descending once this many nodes have been emitted (default 400).
#>
param(
    [int]$FocusedProcessId = 0,
    [int]$ExcludeProcessId = 0,
    [int]$MaxDepth = 4,
    [int]$MaxNodes = 400
)

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    public class ScreenCtxWin32 {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int value, int size);
        // Suspended UWP apps (Settings, Store...) keep "visible", titled but cloaked windows in the Z-order.
        public static bool IsCloaked(IntPtr hWnd) { int c; return DwmGetWindowAttribute(hWnd, 14 /*DWMWA_CLOAKED*/, out c, 4) == 0 && c != 0; }
        [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        public static uint PidOf(IntPtr hWnd) { uint pid = 0; GetWindowThreadProcessId(hWnd, out pid); return pid; }
        // Foreground PID, skipping `exclude` (the caller's own process) by
        // walking down the Z-order to the next visible, titled window.
        public static uint ForegroundPid(uint exclude) {
            IntPtr h = GetForegroundWindow();
            int guard = 0;
            while (h != IntPtr.Zero && guard++ < 200) {
                uint pid = PidOf(h);
                if (pid != 0 && pid != exclude && IsWindowVisible(h) && !IsIconic(h) && !IsCloaked(h) && GetWindowTextLength(h) > 0) return pid;
                h = GetWindow(h, 2); // GW_HWNDNEXT
            }
            return 0;
        }
    }
"@
} catch {
    [Console]::Out.Write((@{ error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'
$script:nodeCount = 0

# Interactive control types worth including
$interactiveTypes = @(
    'ControlType.Button', 'ControlType.Edit', 'ControlType.ComboBox',
    'ControlType.CheckBox', 'ControlType.RadioButton', 'ControlType.Hyperlink',
    'ControlType.MenuItem', 'ControlType.Menu', 'ControlType.Tab',
    'ControlType.TabItem', 'ControlType.ListItem', 'ControlType.TreeItem',
    'ControlType.Slider', 'ControlType.Document'
)

function ConvertTo-UINode {
    param(
        [System.Windows.Automation.AutomationElement]$Element,
        [int]$Depth = 0,
        [int]$TreeMaxDepth = 4
    )

    if ($null -eq $Element) { return $null }

    try { $cur = $Element.Current } catch { return $null }

    $typeName = $cur.ControlType.ProgrammaticName
    $hasName = $cur.Name -and $cur.Name.Trim().Length -gt 0
    $isInteractive = $interactiveTypes -contains $typeName

    # Skip non-interactive unnamed elements
    if (-not $isInteractive -and -not $hasName -and $Depth -gt 0) {
        if ($Depth -ge $TreeMaxDepth -or $script:nodeCount -ge $MaxNodes) { return $null }
        $childNodes = @()
        try {
            $kids = $Element.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($kid in $kids) {
                $childNode = ConvertTo-UINode -Element $kid -Depth ($Depth + 1) -TreeMaxDepth $TreeMaxDepth
                if ($null -ne $childNode) { $childNodes += $childNode }
            }
        } catch {}
        if ($childNodes.Count -eq 0) { return $null }
        return $childNodes
    }

    $rect = $cur.BoundingRectangle
    if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y)) {
        $bounds = @{ x = 0; y = 0; width = 0; height = 0 }
    } else {
        $bounds = @{
            x      = [int]$rect.X
            y      = [int]$rect.Y
            width  = [int]$rect.Width
            height = [int]$rect.Height
        }
    }

    $node = [ordered]@{
        name         = if ($cur.Name) { $cur.Name } else { "" }
        automationId = if ($cur.AutomationId) { $cur.AutomationId } else { "" }
        controlType  = $typeName
        bounds       = $bounds
        children     = @()
    }
    $script:nodeCount++

    if ($Depth -lt $TreeMaxDepth -and $script:nodeCount -lt $MaxNodes) {
        try {
            $kids = $Element.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            foreach ($kid in $kids) {
                $childNode = ConvertTo-UINode -Element $kid -Depth ($Depth + 1) -TreeMaxDepth $TreeMaxDepth
                if ($null -ne $childNode) {
                    if ($childNode -is [array]) { $node.children += $childNode }
                    else { $node.children += $childNode }
                }
            }
        } catch {}
    }

    return $node
}

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement

    # 1. Get all windows
    $windowCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window
    )
    $allWindows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $windowCondition
    )

    $windowList = @()
    foreach ($win in $allWindows) {
        try {
            $c = $win.Current
            if (-not $c.Name -or $c.Name.Trim().Length -eq 0) { continue }

            $processName = ""
            try {
                $proc = [System.Diagnostics.Process]::GetProcessById($c.ProcessId)
                $processName = $proc.ProcessName
            } catch { $processName = "unknown" }

            $rect = $c.BoundingRectangle
            if ([double]::IsInfinity($rect.X)) {
                $bounds = @{ x = 0; y = 0; width = 0; height = 0 }
            } else {
                $bounds = @{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
            }

            $isMinimized = $false
            try {
                $winPattern = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
                if ($winPattern.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) {
                    $isMinimized = $true
                }
            } catch {}

            $windowList += [ordered]@{
                handle      = $c.NativeWindowHandle
                title       = $c.Name
                processName = $processName
                processId   = $c.ProcessId
                bounds      = $bounds
                isMinimized = $isMinimized
            }
        } catch {}
    }

    # 2. Get focused window UI tree. v0.23 — default to the real foreground
    #    process (the caller used to pass nothing, so the tree never came back).
    $uiTree = $null
    if ($FocusedProcessId -le 0) {
        try { $FocusedProcessId = [int][ScreenCtxWin32]::ForegroundPid([uint32]$ExcludeProcessId) } catch { $FocusedProcessId = 0 }
    }
    if ($FocusedProcessId -gt 0) {
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
            $FocusedProcessId
        )
        $targetWindow = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Children,
            $condition
        )
        if ($null -ne $targetWindow) {
            $uiTree = ConvertTo-UINode -Element $targetWindow -Depth 0 -TreeMaxDepth $MaxDepth
        }
    }

    # 3. Return combined result
    $result = [ordered]@{
        windows          = $windowList
        focusedProcessId = $FocusedProcessId
        uiTree           = $uiTree
    }

    [Console]::Out.Write(($result | ConvertTo-Json -Depth 50 -Compress))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
