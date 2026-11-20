<#
.SYNOPSIS
    One call: the foreground window's controls (flat, one node per control)
    plus the list of open windows.
.DESCRIPTION
    v0.24.12 - the walk is Blob's Walk-Window, compiled: a CacheRequest brings
    every property of an element and of its children in one fetch (one fetch
    for every two levels), an unnamed layout node (Pane, Group, Custom...) is
    left out and uses up no depth, and the walk stops at -MaxNodes controls or
    -BudgetMs, whichever comes first (truncated). It runs on a worker thread,
    so a stuck provider cannot hold the caller: what was read so far is returned.

    Output: one JSON object
      {focusedProcessId, focusedHandle, focusedTitle, focusedProcess,
       nodes:[{d, role, name, value?, state?, actions?, rect?}], seen, truncated,
       elapsedMs, windows:[{handle, title, processName, processId, isMinimized}]}
    d       depth among the shown nodes
    value   fields only, never a password
    state   checked/unchecked/mixed, selected, expanded/collapsed, disabled,
            focused, offscreen, password (space separated)
    actions invoke, setvalue, toggle, select, expand (comma separated)
    rect    [x, y, width, height] in physical screen pixels; only with
            -FindB64 (a few lines), for a caller that needs to click by position
.PARAMETER WindowHandle
    The window to read. The caller picks it (foreground-pick.ts).
.PARAMETER FocusedProcessId
    Without -WindowHandle: read the first visible window of this process.
.PARAMETER ExcludeProcessId
    Without either: the foreground window, or the next one down the Z-order
    when the foreground belongs to this process (the caller's own window).
.PARAMETER FindB64
    Base64 UTF-8. Keep only controls whose name or automation id contains it
    (offscreen ones included, flagged).
#>
param(
    [long]$WindowHandle = 0,
    [int]$FocusedProcessId = 0,
    [int]$ExcludeProcessId = 0,
    [int]$MaxNodes = 150,
    [int]$BudgetMs = 3000,
    [string]$FindB64 = ""
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    # Unique class name: scripts share one PowerShell host, where a type name
    # re-registered with a different definition makes Add-Type throw.
    if (-not ('ClippyScreenCtx' -as [type])) {
        $refs = @(
            [System.Windows.Automation.AutomationElement].Assembly.Location,
            [System.Windows.Automation.ControlType].Assembly.Location,
            [System.Windows.Rect].Assembly.Location
        )
        Add-Type -ReferencedAssemblies $refs -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class ClippyScreenCtx {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    delegate bool EnumProc(IntPtr h, IntPtr l);

    // Suspended UWP apps (Settings, Store...) keep "visible", titled but cloaked windows in the Z-order.
    static bool IsCloaked(IntPtr h) { int c; return DwmGetWindowAttribute(h, 14 /*DWMWA_CLOAKED*/, out c, 4) == 0 && c != 0; }
    static uint PidOf(IntPtr h) { uint pid = 0; GetWindowThreadProcessId(h, out pid); return pid; }
    static string TitleOf(IntPtr h) { var b = new StringBuilder(512); GetWindowText(h, b, b.Capacity); return b.ToString(); }
    static bool Listed(IntPtr h) { return IsWindowVisible(h) && !IsCloaked(h) && GetWindowTextLength(h) > 0; }

    // Foreground window, skipping `exclude` (the caller's own process) by
    // walking down the Z-order to the next visible, titled window.
    static IntPtr ForegroundHwnd(uint exclude) {
        IntPtr h = GetForegroundWindow();
        int guard = 0;
        while (h != IntPtr.Zero && guard++ < 200) {
            uint pid = PidOf(h);
            if (pid != 0 && pid != exclude && Listed(h) && !IsIconic(h)) return h;
            h = GetWindow(h, 2); // GW_HWNDNEXT
        }
        return IntPtr.Zero;
    }

    static List<IntPtr> TopWindows() {
        var all = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) { all.Add(h); return true; }, IntPtr.Zero);
        return all;
    }

    static readonly Dictionary<uint, string> Names = new Dictionary<uint, string>();
    static string ProcName(uint pid) {
        string n;
        if (Names.TryGetValue(pid, out n)) return n;
        try { n = Process.GetProcessById((int)pid).ProcessName; } catch { n = "unknown"; }
        Names[pid] = n;
        return n;
    }

    // Kept even when unnamed: a control the model can act on. Anything else
    // without a name is layout only: its children take its place.
    static readonly HashSet<string> Shown = new HashSet<string> {
        "Button", "Edit", "ComboBox", "CheckBox", "RadioButton", "Hyperlink", "MenuItem", "TabItem",
        "ListItem", "TreeItem", "Slider", "Spinner", "Document", "DataItem", "SplitButton"
    };
    static readonly HashSet<string> Valued = new HashSet<string> { "Edit", "Document", "ComboBox", "Spinner", "Slider", "ProgressBar" };

    // What one fetch brings back for each element: one call per parent, not one per property.
    static readonly AutomationProperty[] CachedProps = {
        AutomationElement.NameProperty, AutomationElement.AutomationIdProperty, AutomationElement.ControlTypeProperty,
        AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty, AutomationElement.IsPasswordProperty,
        AutomationElement.HasKeyboardFocusProperty, AutomationElement.BoundingRectangleProperty,
        AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
        AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsSelectionItemPatternAvailableProperty,
        AutomationElement.IsExpandCollapsePatternAvailableProperty, AutomationElement.IsRangeValuePatternAvailableProperty,
        ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, RangeValuePattern.ValueProperty,
        RangeValuePattern.IsReadOnlyProperty, TogglePattern.ToggleStateProperty,
        ExpandCollapsePattern.ExpandCollapseStateProperty, SelectionItemPattern.IsSelectedProperty
    };

    class Walk {
        public List<string> Nodes = new List<string>();
        public int Seen; public bool Truncated;
        public int Max; public string Find; public Stopwatch Sw; public int BudgetMs;
    }

    static string Q(string s) {
        if (s == null) return "null";
        var b = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }
    static string Cut(string s, int max) { return s.Length > max ? s.Substring(0, max) : s; }
    static bool B(AutomationElement el, AutomationProperty p) { object o = el.GetCachedPropertyValue(p); return o is bool && (bool)o; }

    static string Node(AutomationElement el, string role, string name, int depth, bool off, bool withRect) {
        var acts = new List<string>();
        var state = new List<string>();
        bool password = B(el, AutomationElement.IsPasswordProperty);
        if (B(el, AutomationElement.IsInvokePatternAvailableProperty)) acts.Add("invoke");
        bool set = B(el, AutomationElement.IsValuePatternAvailableProperty) && !B(el, ValuePattern.IsReadOnlyProperty);
        if (!set && B(el, AutomationElement.IsRangeValuePatternAvailableProperty)) set = !B(el, RangeValuePattern.IsReadOnlyProperty);
        if (set) acts.Add("setvalue");
        if (B(el, AutomationElement.IsTogglePatternAvailableProperty)) {
            acts.Add("toggle");
            object ts = el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty);
            if (ts is ToggleState) state.Add((ToggleState)ts == ToggleState.On ? "checked" : (ToggleState)ts == ToggleState.Off ? "unchecked" : "mixed");
        }
        if (B(el, AutomationElement.IsSelectionItemPatternAvailableProperty)) {
            acts.Add("select");
            if (B(el, SelectionItemPattern.IsSelectedProperty)) state.Add("selected");
        }
        if (B(el, AutomationElement.IsExpandCollapsePatternAvailableProperty)) {
            object es = el.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty);
            if (es is ExpandCollapseState && (ExpandCollapseState)es != ExpandCollapseState.LeafNode) {   // a leaf has nothing to open
                acts.Add("expand");
                state.Add((ExpandCollapseState)es == ExpandCollapseState.Collapsed ? "collapsed" : "expanded");
            }
        }
        if (!B(el, AutomationElement.IsEnabledProperty)) state.Add("disabled");
        if (B(el, AutomationElement.HasKeyboardFocusProperty)) state.Add("focused");
        if (off) state.Add("offscreen");
        if (password) state.Add("password");

        // The value a node shows: fields only, never a password. A Document's
        // ValuePattern is always "" (Windows 11 Notepad): its text comes from TextPattern.
        string v = null;
        if (!password && Valued.Contains(role)) {
            v = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true) as string;
            if (v == null) {
                object rv = el.GetCachedPropertyValue(RangeValuePattern.ValueProperty, true);
                if (rv is double) v = ((double)rv).ToString(CultureInfo.InvariantCulture);
            }
            if (role == "Document" && string.IsNullOrEmpty(v)) {
                try {
                    object tp;
                    if (el.TryGetCurrentPattern(TextPattern.Pattern, out tp)) { string t = ((TextPattern)tp).DocumentRange.GetText(200); if (!string.IsNullOrEmpty(t)) v = t; }
                } catch { }
            }
            if (v != null) v = Cut(v, role == "Document" ? 200 : 120);
        }

        var o = new StringBuilder("{\"d\":").Append(depth).Append(",\"role\":").Append(Q(role)).Append(",\"name\":").Append(Q(Cut(name, 200)));
        if (v != null) o.Append(",\"value\":").Append(Q(v));
        if (state.Count > 0) o.Append(",\"state\":").Append(Q(string.Join(" ", state.ToArray())));
        if (acts.Count > 0) o.Append(",\"actions\":").Append(Q(string.Join(",", acts.ToArray())));
        if (withRect) {
            object br = el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (br is System.Windows.Rect) {
                var r = (System.Windows.Rect)br;
                if (!r.IsEmpty && !double.IsInfinity(r.X) && r.Width > 0 && r.Height > 0)
                    o.Append(",\"rect\":[").Append((int)r.X).Append(",").Append((int)r.Y).Append(",").Append((int)r.Width).Append(",").Append((int)r.Height).Append("]");
            }
        }
        return o.Append("}").ToString();
    }

    // One element of the walk. `deep`: its children came with it (it was
    // fetched by a search); a child that came that way has none of its own
    // yet and is searched in turn, so there is one fetch for every two levels.
    static void WalkNode(Walk w, AutomationElement el, int depth, int raw, bool deep) {
        if (raw > 60) return;
        lock (w) { if (w.Nodes.Count >= w.Max || w.Sw.ElapsedMilliseconds > w.BudgetMs) { w.Truncated = true; return; } }
        if (raw > 0) {                                               // the window itself is the header line
            string role, name, aid; bool off;
            try {
                role = ((ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty)).ProgrammaticName.Replace("ControlType.", "");
                name = (el.GetCachedPropertyValue(AutomationElement.NameProperty) as string) ?? "";
                aid = (el.GetCachedPropertyValue(AutomationElement.AutomationIdProperty) as string) ?? "";
                off = B(el, AutomationElement.IsOffscreenProperty);
            } catch { return; }
            // Offscreen (scrolled away, the items of a closed menu): skipped
            // with its subtree, unless the caller is searching by name.
            if (off && w.Find.Length == 0) return;
            if (name.Trim().Length > 0 || Shown.Contains(role)) {
                string node;
                try { node = Node(el, role, name, depth, off, w.Find.Length > 0); } catch { return; }
                lock (w) {
                    w.Seen++;
                    if (w.Find.Length == 0 || name.IndexOf(w.Find, StringComparison.OrdinalIgnoreCase) >= 0 || aid.IndexOf(w.Find, StringComparison.OrdinalIgnoreCase) >= 0) w.Nodes.Add(node);
                }
                depth++;
            }
        }
        if (depth >= 8) return;
        AutomationElementCollection kids = null;
        if (deep) { try { kids = el.CachedChildren; } catch { deep = false; } }
        if (!deep) { try { kids = el.FindAll(TreeScope.Children, Condition.TrueCondition); } catch { return; } }
        if (kids == null) return;
        foreach (AutomationElement k in kids) WalkNode(w, k, depth, raw + 1, !deep);
    }

    static void WalkWindow(Walk w, IntPtr h) {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // rects in physical pixels (per-monitor v2)
        try {
            var cr = new CacheRequest();
            cr.AutomationElementMode = AutomationElementMode.Full;
            cr.TreeScope = TreeScope.Element | TreeScope.Children;
            foreach (var p in CachedProps) cr.Add(p);
            using (cr.Activate()) { WalkNode(w, AutomationElement.FromHandle(h), 0, 0, true); }
        } catch { }
    }

    public static string Run(long hwnd, int pid, int exclude, int maxNodes, int budgetMs, string find) {
        var sw = Stopwatch.StartNew();
        var tops = TopWindows();
        IntPtr target = IntPtr.Zero;
        if (hwnd != 0) target = new IntPtr(hwnd);
        else if (pid > 0) {
            foreach (var h in tops) if (PidOf(h) == (uint)pid && Listed(h)) { target = h; break; }
        }
        else target = ForegroundHwnd((uint)exclude);

        // 1. The window's controls first: they are what the caller came for.
        var w = new Walk { Max = maxNodes, Find = (find ?? "").Trim(), Sw = sw, BudgetMs = budgetMs };
        string[] nodes = new string[0];
        int seen = 0; bool truncated = false;
        if (target != IntPtr.Zero) {
            var th = new Thread(() => WalkWindow(w, target));
            th.IsBackground = true;
            th.Start();
            bool finished = th.Join(budgetMs + 500);
            lock (w) { nodes = w.Nodes.ToArray(); seen = w.Seen; truncated = w.Truncated || !finished; w.Max = 0; }
        }

        var o = new StringBuilder("{");
        o.Append("\"focusedProcessId\":").Append(target != IntPtr.Zero ? PidOf(target) : 0)
         .Append(",\"focusedHandle\":").Append(target.ToInt64())
         .Append(",\"focusedTitle\":").Append(Q(target != IntPtr.Zero ? TitleOf(target) : ""))
         .Append(",\"focusedProcess\":").Append(Q(target != IntPtr.Zero ? ProcName(PidOf(target)) : ""))
         .Append(",\"nodes\":[").Append(string.Join(",", nodes)).Append("]")
         .Append(",\"seen\":").Append(seen)
         .Append(",\"truncated\":").Append(truncated ? "true" : "false")
         .Append(",\"elapsedMs\":").Append(sw.ElapsedMilliseconds);

        // 2. The open windows, in Z-order (front first): visible, titled, not
        //    a tool window (WS_EX_TOOLWINDOW), as Alt+Tab lists them.
        o.Append(",\"windows\":[");
        int count = 0;
        foreach (var h in tops) {
            if (!Listed(h) || (GetWindowLong(h, -20 /*GWL_EXSTYLE*/) & 0x80) != 0) continue;
            uint wp = PidOf(h);
            if (count++ > 0) o.Append(",");
            o.Append("{\"handle\":").Append(h.ToInt64())
             .Append(",\"title\":").Append(Q(Cut(TitleOf(h), 200)))
             .Append(",\"processName\":").Append(Q(ProcName(wp)))
             .Append(",\"processId\":").Append(wp)
             .Append(",\"isMinimized\":").Append(IsIconic(h) ? "true" : "false").Append("}");
            if (count >= 40) break;
        }
        return o.Append("]}").ToString();
    }
}
"@
    }
} catch {
    [Console]::Out.Write((@{ error = "Failed to load UI Automation assemblies: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

try {
    $find = if ($FindB64) { [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($FindB64)) } else { '' }
    [Console]::Out.Write([ClippyScreenCtx]::Run($WindowHandle, $FocusedProcessId, $ExcludeProcessId, $MaxNodes, $BudgetMs, $find))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
