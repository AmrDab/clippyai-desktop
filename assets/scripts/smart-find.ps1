<#
.SYNOPSIS
    v0.24 - find a UI element by name and act on it (plan sec. 3.2).
.DESCRIPTION
    Built for Chromium / Electron trees (Gmail, Slack, Outlook web) where the
    old find-element.ps1 materialised every node with FindAll(TrueCondition)
    and timed out.

    Search (inside -TimeBudgetMs, on a worker thread so a stuck provider
    cannot hold the caller):
      1. FindFirst(AndCondition(Name == target (ignore case),
                                ControlType in {Button, Hyperlink, MenuItem,
                                TabItem, ListItem, Edit, CheckBox,
                                RadioButton, Text, ...},
                                IsOffscreen == false))
      2. If that is not a clean interactive hit: breadth-first ControlView
         TreeWalker pass with fuzzy scoring, at most -NodeBudget nodes,
         returning the best partial result when the budget runs out.
      Both passes use a CacheRequest (Name, ControlType, BoundingRectangle,
      IsOffscreen, IsEnabled, Invoke/Value availability).

    Action on a hit:
      click     : InvokePattern -> TogglePattern -> SelectionItemPattern ->
                  LegacyIAccessible DoDefaultAction (MSAA, only when the
                  point really is on the target window) -> coordinate click
                  (skipped with -NoCoordinateClick).
                  v0.24.12: a Win32 / WinForms list item, combo box or menu
                  item gets a real click and no pattern (classic=true): the
                  pattern call returns fine there and the app records
                  nothing (a WinForms combo box kept its old value).
      set-value : ValuePattern.SetValue + read-back; when the element has no
                  writable ValuePattern, falls back to the click cascade and
                  reports setValue=false so the caller pastes instead. The
                  edit inside a Win32 combo box (a file dialog's File name)
                  is clicked and reported comboEdit=true: SetValue reads
                  back fine but its owner is never told, so it is typed.
      find      : nothing.

    After a click the element's state is read back (before / after:
    checked|unchecked|mixed, selected, expanded|collapsed, = "value") and
    what changed around it is listed (changed: windows and popups opened or
    closed, a new window title, the focused element, the element's state).

    Output: one JSON object
      {found, name, controlType, bounds, score, stage, method, pending,
       setValue, readback, classic, comboEdit, before, after, gone, changed,
       nodesVisited, elapsedMs, timedOut, error}
    method is the receipt execution_path: uia-invoke | uia-toggle |
    uia-select | uia-legacy | uia-coords | uia-setvalue.
#>
param(
    [string]$NameB64 = "",
    [long]$WindowHandle = 0,
    [int]$ProcessId = 0,
    [string]$Action = "find",
    [string]$ValueB64 = "",
    [int]$NodeBudget = 3000,
    [int]$TimeBudgetMs = 4000,
    [switch]$NoCoordinateClick
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName Accessibility
    if (-not ('ClippySmartFind' -as [type])) {
        $refs = @(
            [System.Windows.Automation.AutomationElement].Assembly.Location,
            [System.Windows.Automation.ControlType].Assembly.Location,
            [System.Windows.Rect].Assembly.Location,
            [Accessibility.IAccessible].Assembly.Location
        )
        Add-Type -ReferencedAssemblies $refs -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

public static class ClippySmartFind {
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(int f, int dx, int dy, int d, int e);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromPoint(POINT p, [MarshalAs(UnmanagedType.Interface)] out Accessibility.IAccessible acc, [MarshalAs(UnmanagedType.Struct)] out object child);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }

    static readonly ControlType[] Clickable = {
        ControlType.Button, ControlType.Hyperlink, ControlType.MenuItem, ControlType.TabItem,
        ControlType.ListItem, ControlType.Edit, ControlType.CheckBox, ControlType.RadioButton,
        ControlType.Text, ControlType.SplitButton, ControlType.ComboBox, ControlType.TreeItem,
        ControlType.Document
    };

    class Cand { public AutomationElement El; public double Score; public string Name; public ControlType Type; public Rect R; public string Stage; }
    class State { public Cand Best; public int Nodes; public string Err; public bool Done; }

    static void PerMonitorV2() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } }

    public static string Norm(string s) {
        if (s == null) return "";
        int t = s.IndexOf('\t');
        if (t >= 0) s = s.Substring(0, t);
        return Regex.Replace(s, @"\s+", " ").Trim().ToLowerInvariant();
    }

    // Same ladder as the OCR matcher (src/main/ocr-match.ts).
    public static double Score(string target, string name) {
        if (target.Length == 0 || name.Length == 0) return 0;
        if (name == target) return 1.0;
        if (Regex.IsMatch(name, @"(^|\W)" + Regex.Escape(target) + @"($|\W)")) return 0.9;
        if (name.Contains(target)) return 0.7 * target.Length / name.Length;
        if (target.Contains(name) && name.Length >= 3) return 0.6 * name.Length / target.Length;
        return 0;
    }

    static bool IsIn(ControlType ct, ControlType[] set) { foreach (var c in set) if (c == ct) return true; return false; }

    static Cand MakeCand(AutomationElement el, string t, string action, string stage) {
        try {
            string name = (string)el.GetCachedPropertyValue(AutomationElement.NameProperty);
            var ct = (ControlType)el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
            if ((bool)el.GetCachedPropertyValue(AutomationElement.IsOffscreenProperty)) return null;
            var r = (Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
            if (r.IsEmpty || r.Width <= 0 || r.Height <= 0 || double.IsInfinity(r.X)) return null;
            double s = Score(t, Norm(name));
            if (s <= 0) return null;
            bool enabled = (bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty);
            bool inv = (bool)el.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty);
            bool val = (bool)el.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty);
            if (IsIn(ct, Clickable) && ct != ControlType.Text) s += 0.05;
            if (action == "click" && inv) s += 0.05;
            if (action == "set-value") { if (val) s += 0.15; else if (ct == ControlType.Edit || ct == ControlType.Document) s += 0.1; }
            if (!enabled) s -= 0.2;
            return new Cand { El = el, Score = s, Name = name, Type = ct, R = r, Stage = stage };
        } catch { return null; }
    }

    static AutomationElement ResolveRoot(long hwnd, int pid) {
        if (hwnd != 0) {
            try { var e = AutomationElement.FromHandle(new IntPtr(hwnd)); if (e != null) return e; } catch { }
        }
        if (pid > 0) {
            var c = new PropertyCondition(AutomationElement.ProcessIdProperty, pid);
            return AutomationElement.RootElement.FindFirst(TreeScope.Children, c);
        }
        return null;
    }

    static void Offer(State st, Cand c) {
        if (c == null) return;
        lock (st) { if (st.Best == null || c.Score > st.Best.Score) st.Best = c; }
    }

    static void Search(long hwnd, int pid, string target, string t, string action, int budget, int timeMs, Stopwatch sw, State st) {
        PerMonitorV2();
        try {
            var root = ResolveRoot(hwnd, pid);
            if (root == null) { st.Err = "target window not found"; return; }
            var cr = new CacheRequest();
            cr.Add(AutomationElement.NameProperty);
            cr.Add(AutomationElement.ControlTypeProperty);
            cr.Add(AutomationElement.BoundingRectangleProperty);
            cr.Add(AutomationElement.IsOffscreenProperty);
            cr.Add(AutomationElement.IsEnabledProperty);
            cr.Add(AutomationElement.IsInvokePatternAvailableProperty);
            cr.Add(AutomationElement.IsValuePatternAvailableProperty);
            cr.TreeScope = TreeScope.Element;
            using (cr.Activate()) {
                // 1. exact, condition-driven (the provider filters, not us)
                var types = new List<Condition>();
                foreach (var ct in Clickable) types.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ct));
                var cond = new AndCondition(
                    new PropertyCondition(AutomationElement.NameProperty, target.Trim(), PropertyConditionFlags.IgnoreCase),
                    new OrCondition(types.ToArray()),
                    new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
                var hit = root.FindFirst(TreeScope.Descendants, cond);
                if (hit != null) {
                    var c = MakeCand(hit, t, action, "exact");
                    Offer(st, c);
                    if (c != null && c.Score >= 1.05) return;
                }
                // 2. budgeted fuzzy walk
                var walker = TreeWalker.ControlViewWalker;
                var q = new Queue<AutomationElement>();
                q.Enqueue(root);
                while (q.Count > 0) {
                    if (st.Nodes >= budget || sw.ElapsedMilliseconds >= timeMs) return;
                    var el = q.Dequeue();
                    AutomationElement child = null;
                    try { child = walker.GetFirstChild(el, cr); } catch { continue; }
                    while (child != null) {
                        lock (st) st.Nodes++;
                        var c = MakeCand(child, t, action, "walk");
                        Offer(st, c);
                        if (c != null && c.Score >= 1.05 + (action == "set-value" ? 0.1 : 0.0)) return;
                        bool off = false;
                        try { off = (bool)child.GetCachedPropertyValue(AutomationElement.IsOffscreenProperty); } catch { }
                        if (!off) q.Enqueue(child);
                        if (st.Nodes >= budget || sw.ElapsedMilliseconds >= timeMs) return;
                        try { child = walker.GetNextSibling(child, cr); } catch { child = null; }
                    }
                }
            }
        } catch (Exception e) { st.Err = e.Message; }
        finally { st.Done = true; }
    }

    // Run a pattern call with a bound: InvokePattern.Invoke blocks while a
    // modal dialog it opened is up. 1 = done, 0 = threw, 2 = still running (pending).
    // Invoke on UWP/WinUI apps (Calculator) routinely takes 2-3 s to return; a
    // 1.5 s bound reported every press as "pending" and the one-shot script
    // then exited and killed the call before it ran (VM test, v0.24). Wait
    // longer, and never let process exit abort an in-flight pattern call.
    const int PatternWaitMs = 6000;
    static int Bounded(Action a, int ms) {
        Exception err = null;
        var th = new Thread(() => { PerMonitorV2(); try { a(); } catch (Exception e) { err = e; } });
        th.IsBackground = false;
        th.Start();
        if (!th.Join(ms)) return 2;
        return err == null ? 1 : 0;
    }

    static string Q(string s) {
        if (s == null) return "null";
        var b = new StringBuilder("\"");
        foreach (char c in s) {
            if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
            else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
            else b.Append(c);
        }
        return b.Append('"').ToString();
    }

    // A read that a stuck provider cannot hold: null when it did not answer in time.
    static string BoundedRead(Func<string> f, int ms) {
        string res = null;
        var th = new Thread(() => { PerMonitorV2(); try { res = f(); } catch { } });
        th.IsBackground = true;
        th.Start();
        return th.Join(ms) ? res : null;
    }

    static string Cut(string s, int max) { return s != null && s.Length > max ? s.Substring(0, max) : s; }

    // The element's own state, as read_screen words it. "" when it has none,
    // Gone when the element is no longer there, null when it did not answer.
    const string Gone = "(gone)";
    static string ElState(AutomationElement el) {
        return BoundedRead(() => {
            var parts = new List<string>();
            object p;
            bool password = false;
            try { password = el.Current.IsPassword; } catch (ElementNotAvailableException) { return Gone; }
            try {
                if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) {
                    var ts = ((TogglePattern)p).Current.ToggleState;
                    parts.Add(ts == ToggleState.On ? "checked" : ts == ToggleState.Off ? "unchecked" : "mixed");
                }
            } catch { }
            try {
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p) && ((SelectionItemPattern)p).Current.IsSelected) parts.Add("selected");
            } catch { }
            try {
                if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
                    var es = ((ExpandCollapsePattern)p).Current.ExpandCollapseState;
                    if (es != ExpandCollapseState.LeafNode) parts.Add(es == ExpandCollapseState.Collapsed ? "collapsed" : "expanded");
                }
            } catch { }
            try {
                if (!password && el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
                    string v = ((ValuePattern)p).Current.Value;
                    if (v != null) parts.Add("= \"" + Cut(v, 80) + "\"");
                }
            } catch { }
            return string.Join(" ", parts.ToArray());
        }, 800);
    }

    // The element that has the keyboard: Role "Name" = "value" (never a password's value).
    static string FocusDesc() {
        return BoundedRead(() => {
            var f = AutomationElement.FocusedElement;
            if (f == null) return "";
            var c = f.Current;
            string s = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
            if (!string.IsNullOrEmpty(c.Name)) s += " \"" + Cut(c.Name, 80) + "\"";
            object p;
            if (!c.IsPassword && f.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
                string v = ((ValuePattern)p).Current.Value;
                if (!string.IsNullOrEmpty(v)) s += " = \"" + Cut(v, 80) + "\"";
            }
            return s;
        }, 800);
    }

    // Visible top-level windows (popups and menus included; a cloaked UWP shell is not): handle -> title.
    static Dictionary<long, string> TopWindows() {
        var d = new Dictionary<long, string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            int cloaked;
            if (!IsWindowVisible(h) || (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0)) return true;
            var b = new StringBuilder(256);
            GetWindowText(h, b, b.Capacity);
            d[h.ToInt64()] = b.ToString();
            return true;
        }, IntPtr.Zero);
        return d;
    }

    static string Win(string title) { return title.Trim().Length > 0 ? "window \"" + Cut(title.Trim(), 80) + "\"" : "a popup"; }

    // What is different after the click, at most 6 lines.
    static List<string> Changes(Dictionary<long, string> w0, Dictionary<long, string> w1, string f0, string f1, string name, string s0, string s1) {
        var c = new List<string>();
        foreach (var kv in w1) {
            string old;
            if (!w0.TryGetValue(kv.Key, out old)) c.Add(Win(kv.Value) + " opened");
            else if (old != kv.Value && kv.Value.Trim().Length > 0) c.Add("window title is now \"" + Cut(kv.Value.Trim(), 80) + "\"");
        }
        foreach (var kv in w0) if (!w1.ContainsKey(kv.Key)) c.Add(Win(kv.Value) + " closed");
        if (f1 != null && f0 != null && f1 != f0 && f1.Length > 0) c.Add("focus: " + f1);
        if (s1 == Gone && s0 != Gone) c.Add("\"" + Cut(name, 60) + "\" is gone");
        else if (s1 != null && s0 != null && s1 != s0) c.Add("\"" + Cut(name, 60) + "\": " + (s0.Length > 0 ? s0 : "(no state)") + " -> " + (s1.Length > 0 ? s1 : "(no state)"));
        if (c.Count > 6) c.RemoveRange(6, c.Count - 6);
        return c;
    }

    // Windows works a classic (Win32, WinForms) list item, combo box or menu
    // through real input: the UIA pattern returns fine and the control's
    // owner is never told (Blob's desk-bridge, Test-NeedsFront).
    static bool Classic(AutomationElement el, ControlType ct) {
        if (ct != ControlType.ListItem && ct != ControlType.ComboBox && ct != ControlType.MenuItem && ct != ControlType.Menu) return false;
        try { string fw = el.Current.FrameworkId; return fw == "Win32" || fw == "WinForm"; } catch { return false; }
    }

    // The edit inside a Win32 combo box (Blob's Do-Set).
    static bool ComboEdit(AutomationElement el) {
        try {
            var dad = TreeWalker.ControlViewWalker.GetParent(el);
            return dad != null && dad.Current.ControlType == ControlType.ComboBox && el.Current.NativeWindowHandle != 0;
        } catch { return false; }
    }

    static string RealClick(Rect r, bool combo) {
        // A combo box opens from its arrow, at the right end; its middle is the edit.
        double x = combo ? r.X + r.Width - Math.Min(r.Height, r.Width) / 2 : r.X + r.Width / 2;
        SetCursorPos((int)Math.Round(x), (int)Math.Round(r.Y + r.Height / 2));
        mouse_event(2, 0, 0, 0, 0);
        mouse_event(4, 0, 0, 0, 0);
        return "uia-coords";
    }

    static string ClickCascade(AutomationElement el, Rect r, long rootHwnd, bool noCoords, out bool pending) {
        pending = false;
        object p;
        int rc;
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) {
            var ip = (InvokePattern)p;
            rc = Bounded(() => ip.Invoke(), PatternWaitMs);
            if (rc != 0) { pending = rc == 2; return "uia-invoke"; }
        }
        if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) {
            var tp = (TogglePattern)p;
            rc = Bounded(() => tp.Toggle(), PatternWaitMs);
            if (rc != 0) { pending = rc == 2; return "uia-toggle"; }
        }
        if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) {
            var sp = (SelectionItemPattern)p;
            rc = Bounded(() => sp.Select(), PatternWaitMs);
            if (rc != 0) { pending = rc == 2; return "uia-select"; }
        }
        var pt = new POINT { X = (int)Math.Round(r.X + r.Width / 2), Y = (int)Math.Round(r.Y + r.Height / 2) };
        // LegacyIAccessible.DoDefaultAction via MSAA — only when the point is
        // really on the target window (never act on whatever covers it).
        try {
            IntPtr under = GetAncestor(WindowFromPoint(pt), 2);
            IntPtr target = rootHwnd != 0 ? GetAncestor(new IntPtr(rootHwnd), 2) : IntPtr.Zero;
            if (target != IntPtr.Zero && under == target) {
                Accessibility.IAccessible acc; object child;
                if (AccessibleObjectFromPoint(pt, out acc, out child) == 0 && acc != null) {
                    string an = "";
                    try { an = acc.get_accName(child) ?? ""; } catch { }
                    string en = Norm(el.Cached.Name);
                    string anorm = Norm(an);
                    if (anorm.Length > 0 && (anorm == en || anorm.Contains(en) || en.Contains(anorm))) {
                        var a2 = acc; var c2 = child;
                        rc = Bounded(() => a2.accDoDefaultAction(c2), PatternWaitMs);
                        if (rc != 0) { pending = rc == 2; return "uia-legacy"; }
                    }
                }
            }
        } catch { }
        if (noCoords) return null;
        SetCursorPos(pt.X, pt.Y);
        mouse_event(2, 0, 0, 0, 0);
        mouse_event(4, 0, 0, 0, 0);
        return "uia-coords";
    }

    public static string Run(long hwnd, int pid, string target, string action, string value, int budget, int timeMs, bool noCoords) {
        PerMonitorV2();
        var sw = Stopwatch.StartNew();
        string t = Norm(target);
        var st = new State();
        var th = new Thread(() => Search(hwnd, pid, target, t, action, budget, timeMs, sw, st));
        th.IsBackground = true;
        th.Start();
        bool finished = th.Join(timeMs + 250);
        Cand best; int nodes; string err;
        lock (st) { best = st.Best; nodes = st.Nodes; err = st.Err; }
        bool timedOut = !finished || sw.ElapsedMilliseconds >= timeMs || nodes >= budget;
        var o = new StringBuilder("{");
        if (best == null || best.Score < 0.5) {
            o.Append("\"found\":false,\"nodesVisited\":").Append(nodes)
             .Append(",\"elapsedMs\":").Append(sw.ElapsedMilliseconds)
             .Append(",\"timedOut\":").Append(timedOut ? "true" : "false");
            if (err != null) o.Append(",\"error\":").Append(Q(err));
            return o.Append("}").ToString();
        }
        long rootHwnd = hwnd;
        if (rootHwnd == 0) { try { var rr = ResolveRoot(0, pid); if (rr != null) rootHwnd = rr.Current.NativeWindowHandle; } catch { } }
        string method = null; bool pending = false; string setValue = "null"; string readback = "none";
        bool classic = action == "click" && Classic(best.El, best.Type);
        bool comboEdit = action == "set-value" && ComboEdit(best.El);
        string s0 = null, f0 = null; Dictionary<long, string> w0 = null;
        if (action == "click") { s0 = ElState(best.El); f0 = FocusDesc(); w0 = TopWindows(); }
        if (action == "set-value") {
            object p;
            bool done = false;
            if (!comboEdit && best.El.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
                var vp = (ValuePattern)p;
                bool ro = true;
                try { ro = vp.Current.IsReadOnly; } catch { }
                if (!ro) {
                    int rc = Bounded(() => vp.SetValue(value), PatternWaitMs);
                    if (rc != 0) {
                        done = true; method = "uia-setvalue"; pending = rc == 2;
                        string back = null;
                        try { back = vp.Current.Value; } catch { }
                        if (back != null) readback = (back.Replace("\r\n", "\n").TrimEnd() == value.Replace("\r\n", "\n").TrimEnd()) ? "match" : "mismatch";
                    }
                }
            }
            setValue = done ? "true" : "false";
            if (!done) method = ClickCascade(best.El, best.R, rootHwnd, noCoords, out pending);
        } else if (action == "click") {
            if (classic) method = noCoords ? null : RealClick(best.R, best.Type == ControlType.ComboBox);
            else method = ClickCascade(best.El, best.R, rootHwnd, noCoords, out pending);
        }
        // Read back: the element's state, and what changed around it. Chromium
        // updates its tree after the call returns, so a toggle or a select
        // that reads unchanged is read again for up to 500 ms.
        string s1 = null; List<string> changed = null;
        if (action == "click" && method != null) {
            if (!pending) Thread.Sleep(250);
            s1 = ElState(best.El);
            if (!pending && (method == "uia-toggle" || method == "uia-select")) {
                var wait = Stopwatch.StartNew();
                while (s1 != null && s1 != Gone && s1 == s0 && wait.ElapsedMilliseconds < 500) { Thread.Sleep(50); s1 = ElState(best.El); }
            }
            changed = Changes(w0, TopWindows(), f0, FocusDesc(), best.Name, s0, s1);
        }
        o.Append("\"found\":true,\"name\":").Append(Q(best.Name))
         .Append(",\"controlType\":").Append(Q(best.Type.ProgrammaticName.Replace("ControlType.", "")))
         .Append(",\"bounds\":{\"x\":").Append((int)best.R.X).Append(",\"y\":").Append((int)best.R.Y)
         .Append(",\"width\":").Append((int)best.R.Width).Append(",\"height\":").Append((int)best.R.Height).Append("}")
         .Append(",\"score\":").Append(Math.Round(best.Score, 3).ToString(System.Globalization.CultureInfo.InvariantCulture))
         .Append(",\"stage\":").Append(Q(best.Stage))
         .Append(",\"method\":").Append(method == null ? "null" : Q(method))
         .Append(",\"pending\":").Append(pending ? "true" : "false")
         .Append(",\"setValue\":").Append(setValue)
         .Append(",\"readback\":").Append(Q(readback))
         .Append(",\"classic\":").Append(classic ? "true" : "false")
         .Append(",\"comboEdit\":").Append(comboEdit ? "true" : "false");
        if (changed != null) {
            o.Append(",\"before\":").Append(Q(s0)).Append(",\"after\":").Append(Q(s1))
             .Append(",\"gone\":").Append(s1 == Gone ? "true" : "false")
             .Append(",\"changed\":[");
            for (int i = 0; i < changed.Count; i++) { if (i > 0) o.Append(","); o.Append(Q(changed[i])); }
            o.Append("]");
        }
        o
         .Append(",\"nodesVisited\":").Append(nodes)
         .Append(",\"elapsedMs\":").Append(sw.ElapsedMilliseconds)
         .Append(",\"timedOut\":").Append(timedOut ? "true" : "false");
        return o.Append("}").ToString();
    }
}
"@
    }
} catch {
    [Console]::Out.Write((@{ found = $false; error = "smart-find init failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress))
    exit 1
}

try {
    $utf8 = [System.Text.Encoding]::UTF8
    $name = if ($NameB64) { $utf8.GetString([Convert]::FromBase64String($NameB64)) } else { "" }
    $value = if ($ValueB64) { $utf8.GetString([Convert]::FromBase64String($ValueB64)) } else { "" }
    if ([string]::IsNullOrWhiteSpace($name)) { throw "NameB64 is required" }
    if ($Action -notin @('find', 'click', 'set-value')) { throw "unknown action: $Action" }
    [Console]::Out.Write([ClippySmartFind]::Run($WindowHandle, $ProcessId, $name, $Action, $value, $NodeBudget, $TimeBudgetMs, [bool]$NoCoordinateClick))
} catch {
    [Console]::Out.Write((@{ found = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
