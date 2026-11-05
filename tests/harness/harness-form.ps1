# Test window for the Windows host harness (tests/win-host.harness.test.ts).
# A small WinForms form that NEVER takes focus (WS_EX_NOACTIVATE, shown
# without activation) so driving it through UIA does not disturb whoever is
# using the desktop. Prints one line per event on stdout:
#   ready <pid> <hwnd> <x> <y> <w> <h>
#   click <button text>
#   check <state>
#   text <value>
# Closes itself after -Seconds.
param([int]$Seconds = 60, [int]$X = 60, [int]$Y = 60)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Windows.Forms;
public class HarnessForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 /*NOACTIVATE*/ | 0x00000008 /*TOPMOST*/; return cp; }
    }
    public static void Emit(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
    public HarnessForm(int seconds, int x, int y) {
        Text = "Clippy Harness " + System.Diagnostics.Process.GetCurrentProcess().Id;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(x, y);
        ClientSize = new Size(560, 240);
        BackColor = Color.White;
        Font = new Font("Segoe UI", 14f);
        var send = new Button { Text = "Send", Location = new Point(20, 20), Size = new Size(140, 48) };
        var compose = new Button { Text = "New message", Location = new Point(180, 20), Size = new Size(200, 48) };
        var remember = new CheckBox { Text = "Remember me", Location = new Point(20, 90), Size = new Size(220, 40) };
        var subject = new TextBox { Location = new Point(260, 92), Size = new Size(280, 40), AccessibleName = "Subject" };
        var status = new Label { Text = "Inbox status ready", Location = new Point(20, 160), Size = new Size(400, 40) };
        send.Click += (s, e) => Emit("click Send");
        compose.Click += (s, e) => Emit("click New message");
        remember.CheckedChanged += (s, e) => Emit("check " + remember.Checked);
        subject.TextChanged += (s, e) => Emit("text " + subject.Text);
        Controls.AddRange(new Control[] { send, compose, remember, subject, status });
        var t = new Timer { Interval = seconds * 1000 };
        t.Tick += (s, e) => Close();
        t.Start();
        Shown += (s, e) => Emit(string.Format("ready {0} {1} {2} {3} {4} {5}",
            System.Diagnostics.Process.GetCurrentProcess().Id, Handle.ToInt64(), Bounds.X, Bounds.Y, Bounds.Width, Bounds.Height));
    }
}
"@
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run((New-Object HarnessForm($Seconds, $X, $Y)))
