<#
.SYNOPSIS
    The foreground window and the visible top-level windows under it, in Z-order.
.DESCRIPTION
    v0.24.12 - the script no longer chooses "the window the user is on": it
    reports the facts and src/main/foreground-pick.ts chooses (unit-tested).
    The old walk took the first visible, titled window of another process,
    which on a PC with an always-on-top overlay (a notch bar, a HUD) was the
    overlay: every task started "in" the overlay instead of the user's app.

    Output: one JSON object
      {foreground, candidates:[{handle, processId, processName, title,
       exStyle, style, minimized, bounds:{x,y,width,height}}], success}
    candidates are visible, not cloaked, front to back, at most 60; the
    foreground window is always among them. bounds are physical pixels (the
    DWM extended frame, so without the invisible resize border).
.PARAMETER ExcludeProcessId
    Kept for callers that still pass it; the caller's own windows are listed
    like any other and left out by foreground-pick.ts.
#>
param([int]$ExcludeProcessId = 0)

try {
    # Unique class name: scripts share one PowerShell host, where a type name
    # re-registered with a different definition makes Add-Type throw.
    if (-not ('ClippyFgWin2' -as [type])) {
        Add-Type @"
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.Runtime.InteropServices;
    using System.Text;
    public class ClippyFgWin2 {
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
        delegate bool EnumProc(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeInt(IntPtr h, int attr, out int v, int size);
        // Suspended UWP apps (Settings, Store...) keep "visible", titled but cloaked windows in the Z-order.
        static bool IsCloaked(IntPtr h) { int c; return DwmGetWindowAttributeInt(h, 14 /*DWMWA_CLOAKED*/, out c, 4) == 0 && c != 0; }

        static readonly Dictionary<uint, string> Names = new Dictionary<uint, string>();
        static string ProcName(uint pid) {
            string n;
            if (Names.TryGetValue(pid, out n)) return n;
            try { n = Process.GetProcessById((int)pid).ProcessName; } catch { n = "unknown"; }
            Names[pid] = n;
            return n;
        }

        static string Q(string s) {
            var b = new StringBuilder("\"");
            foreach (char c in s) {
                if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }

        static void Describe(StringBuilder o, IntPtr h) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            var t = new StringBuilder(512);
            GetWindowText(h, t, t.Capacity);
            RECT r;
            if (DwmGetWindowAttribute(h, 9 /*EXTENDED_FRAME_BOUNDS*/, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
            o.Append("{\"handle\":").Append(h.ToInt64())
             .Append(",\"processId\":").Append(pid)
             .Append(",\"processName\":").Append(Q(ProcName(pid)))
             .Append(",\"title\":").Append(Q(t.ToString()))
             .Append(",\"exStyle\":").Append((uint)GetWindowLong(h, -20))
             .Append(",\"style\":").Append((uint)GetWindowLong(h, -16))
             .Append(",\"minimized\":").Append(IsIconic(h) ? "true" : "false")
             .Append(",\"bounds\":{\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top)
             .Append(",\"width\":").Append(r.Right - r.Left).Append(",\"height\":").Append(r.Bottom - r.Top).Append("}}");
        }

        public static string Snapshot(int max) {
            try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // GetWindowRect in physical pixels
            IntPtr fg = GetForegroundWindow();
            var all = new List<IntPtr>();
            EnumWindows(delegate(IntPtr h, IntPtr l) { all.Add(h); return true; }, IntPtr.Zero);
            var o = new StringBuilder("{\"foreground\":").Append(fg.ToInt64()).Append(",\"candidates\":[");
            int n = 0; bool sawFg = false;
            foreach (var h in all) {
                if (n >= max) break;
                if (!IsWindowVisible(h) || IsCloaked(h)) continue;
                if (h == fg) sawFg = true;
                if (n++ > 0) o.Append(",");
                Describe(o, h);
            }
            if (!sawFg && fg != IntPtr.Zero) { if (n > 0) o.Append(","); Describe(o, fg); }
            return o.Append("],\"success\":true}").ToString();
        }
    }
"@
    }
} catch {
    [Console]::Out.Write((@{ error = "Failed to load assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

$ErrorActionPreference = 'Stop'

try {
    [Console]::Out.Write([ClippyFgWin2]::Snapshot(60))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
