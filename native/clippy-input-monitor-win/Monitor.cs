// clippy-input-monitor (Windows) — listen-only keyboard monitor for the
// "hey clippy" wake phrase. Same NDJSON protocol as the macOS helper
// (native/clippy-input-monitor), wake-only mode.
//
// Privacy contract
// ────────────────
//   • Starts DISABLED: no hook is installed until the parent sends
//     `enable-wake`, and `disable` removes it again.
//   • Only A-Z (mapped from the virtual-key code, never ToUnicodeEx, which
//     would corrupt dead-key input in other apps), space, backspace and a few
//     clearing keys leave this process. Nothing is logged or written to disk.
//   • Keys injected by a process (LLKHF_INJECTED: Clippy's own typing) and
//     keys pressed with Ctrl, Alt or Win held are dropped.
//   • Password fields: on every focus change a worker thread asks UI
//     Automation whether the focused element IsPassword; keys are dropped
//     while it is. A failed or slow check counts as "not a password field",
//     and the hook thread never waits on it.
//   • Listen-only: every key is passed on with CallNextHookEx.
//
// Protocol
// ────────
//   stdout (NDJSON, one object per line):
//     {"t":"ready","listen":true}
//     {"t":"key","ch":"a"}                     a-z or " "
//     {"t":"special","key":"backspace"}        backspace | return | tab | escape | left | right | up | down
//     {"t":"reset"}                            foreground window or focus changed
//   stdin (one command per line): enable-wake | disable | quit
//   Exits when stdin closes (the parent is gone).
//
// Built by scripts/build-native.js with the .NET Framework 4.x csc.exe
// (C# 5: no string interpolation, no ?. operator).

using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Monitor
{
    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x0100;
    const int WM_SYSKEYDOWN = 0x0104;
    const uint LLKHF_INJECTED = 0x10;
    const uint LLKHF_ALTDOWN = 0x20;
    const int VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
    const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    const uint EVENT_OBJECT_FOCUS = 0x8005;
    const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    const uint WM_APP = 0x8000;
    const uint CMD_ENABLE = WM_APP + 1;
    const uint CMD_DISABLE = WM_APP + 2;
    // A password check slower than this counts as "not a password field".
    const int PASSWORD_CHECK_TIMEOUT_MS = 300;

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc fn, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmod, WinEventProc fn, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

    // Delegates held in fields so the GC never collects a live callback.
    static readonly LowLevelKeyboardProc keyProc = OnKeyHook;
    static readonly WinEventProc winEventProc = OnWinEvent;
    static IntPtr keyHook = IntPtr.Zero, fgHook = IntPtr.Zero, focusHook = IntPtr.Zero;
    static bool enabled;
    static uint mainThreadId;

    // stdout is written by its own thread so the hook never blocks on a full pipe.
    static readonly BlockingCollection<string> outQueue = new BlockingCollection<string>();

    // Password-field state, shared with the UIA worker thread.
    static readonly object pwLock = new object();
    static readonly AutoResetEvent pwWake = new AutoResetEvent(false);
    static bool pwField, pwPending;
    static int pwSince, pwGen;

    static void Emit(string json) { outQueue.Add(json); }

    static void Main()
    {
        mainThreadId = GetCurrentThreadId();
        MSG msg;
        PeekMessage(out msg, IntPtr.Zero, 0, 0, 0); // create this thread's message queue

        Start(WriterLoop);
        Start(PasswordLoop);
        Start(StdinLoop);
        Emit("{\"t\":\"ready\",\"listen\":true}");

        // Hook callbacks run inside GetMessage on this thread.
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            if (msg.hwnd != IntPtr.Zero) continue;
            if (msg.message == CMD_ENABLE) SetEnabled(true);
            else if (msg.message == CMD_DISABLE) SetEnabled(false);
        }
    }

    static void Start(ThreadStart fn)
    {
        Thread t = new Thread(fn);
        t.IsBackground = true;
        t.Start();
    }

    static void StdinLoop()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            switch (line.Trim())
            {
                case "enable-wake": PostThreadMessage(mainThreadId, CMD_ENABLE, IntPtr.Zero, IntPtr.Zero); break;
                case "disable": PostThreadMessage(mainThreadId, CMD_DISABLE, IntPtr.Zero, IntPtr.Zero); break;
                case "quit": Environment.Exit(0); break;
            }
        }
        Environment.Exit(0); // stdin closed: the parent is gone
    }

    static void WriterLoop()
    {
        StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        try
        {
            foreach (string line in outQueue.GetConsumingEnumerable())
            {
                stdout.Write(line);
                stdout.Write('\n');
                stdout.Flush();
            }
        }
        catch (IOException) { Environment.Exit(0); } // the parent closed the pipe
    }

    static void SetEnabled(bool on)
    {
        if (on == enabled) return;
        enabled = on;
        if (on)
        {
            keyHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyProc, GetModuleHandle(null), 0);
            uint flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
            fgHook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, winEventProc, 0, 0, flags);
            focusHook = SetWinEventHook(EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS, IntPtr.Zero, winEventProc, 0, 0, flags);
            CheckPasswordField(); // the field already focused
        }
        else
        {
            if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
            if (fgHook != IntPtr.Zero) UnhookWinEvent(fgHook);
            if (focusHook != IntPtr.Zero) UnhookWinEvent(focusHook);
            keyHook = fgHook = focusHook = IntPtr.Zero;
        }
    }

    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (!enabled) return;
        Emit("{\"t\":\"reset\"}");
        CheckPasswordField();
    }

    static void CheckPasswordField()
    {
        lock (pwLock)
        {
            pwField = false;
            pwPending = true;
            pwSince = Environment.TickCount;
            pwGen++;
        }
        pwWake.Set();
    }

    // UI Automation can be slow or hang on a busy app, so it runs here and
    // never on the hook thread. Only the latest focus change is checked.
    static void PasswordLoop()
    {
        while (true)
        {
            pwWake.WaitOne();
            int gen;
            lock (pwLock) gen = pwGen;
            bool isPassword = false;
            try
            {
                AutomationElement el = AutomationElement.FocusedElement;
                isPassword = el != null && el.Current.IsPassword;
            }
            catch (Exception) { /* no answer: not a password field */ }
            lock (pwLock)
            {
                if (gen != pwGen) continue;
                pwField = isPassword;
                pwPending = false;
            }
        }
    }

    static bool InPasswordField()
    {
        lock (pwLock)
        {
            if (pwPending) return unchecked(Environment.TickCount - pwSince) < PASSWORD_CHECK_TIMEOUT_MS;
            return pwField;
        }
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    static IntPtr OnKeyHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && enabled)
        {
            int m = wParam.ToInt32();
            if (m == WM_KEYDOWN || m == WM_SYSKEYDOWN)
            {
                KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                OnKey(k.vkCode, k.flags, m == WM_SYSKEYDOWN);
            }
        }
        return CallNextHookEx(keyHook, nCode, wParam, lParam);
    }

    static void OnKey(uint vk, uint flags, bool sys)
    {
        if ((flags & LLKHF_INJECTED) != 0) return;
        if (sys || (flags & LLKHF_ALTDOWN) != 0) return;
        if (Down(VK_CONTROL) || Down(VK_MENU) || Down(VK_LWIN) || Down(VK_RWIN)) return;
        if (InPasswordField()) return;

        if (vk >= 0x41 && vk <= 0x5A) Emit("{\"t\":\"key\",\"ch\":\"" + (char)('a' + (vk - 0x41)) + "\"}");
        else if (vk == 0x20) Emit("{\"t\":\"key\",\"ch\":\" \"}");
        else
        {
            string name = null;
            switch (vk)
            {
                case 0x08: name = "backspace"; break;
                case 0x09: name = "tab"; break;
                case 0x0D: name = "return"; break;
                case 0x1B: name = "escape"; break;
                case 0x25: name = "left"; break;
                case 0x26: name = "up"; break;
                case 0x27: name = "right"; break;
                case 0x28: name = "down"; break;
            }
            if (name != null) Emit("{\"t\":\"special\",\"key\":\"" + name + "\"}");
        }
    }
}
