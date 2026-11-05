/**
 * v0.24 — script-level harness for the persistent PowerShell host.
 *
 * Opt-in (spawns real powershell.exe and a real window):
 *   CLIPPY_PS_HARNESS=1 npx vitest run tests/win-host.harness.test.ts
 *
 * Everything acts ONLY on a WinForms window this test creates
 * (tests/harness/harness-form.ps1). That window is WS_EX_NOACTIVATE and is
 * shown without activation, and nothing here moves the mouse, sends keys
 * or changes focus: clicks go through UIA patterns with -NoCoordinateClick,
 * and the "mouse"/"keyboard" latency probes load the same types the real
 * tools load but only READ the cursor position. After every acting step the
 * test checks the harness window did not become the foreground window.
 *
 * Prints a latency table (one-shot spawn vs host) for the report.
 *
 * The three ACTING cases (Invoke / Toggle / SetValue on the harness window)
 * need CLIPPY_PS_HARNESS_ACT=1 as well — run them on a VM, not on a desktop
 * someone is using: on Win11 26100 a UIA Toggle on a Win32/WinForms checkbox
 * (the client-side proxy sends BM_CLICK) activated the harness window even
 * though it is WS_EX_NOACTIVATE, i.e. it took the foreground.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { configurePsHost, psScript, psCommand, shutdownPsHost, oneShotScriptArgs, getPsHost } from '../src/main/win-host';
import { layoutFromRegion, matchOcrTarget } from '../src/main/ocr-match';

const RUN = process.env.CLIPPY_PS_HARNESS === '1' && process.platform === 'win32';
const ACT = RUN && process.env.CLIPPY_PS_HARNESS_ACT === '1';
const execFileAsync = promisify(execFile);
const SCRIPTS = path.resolve(__dirname, '..', 'assets', 'scripts');
const FORM = path.resolve(__dirname, 'harness', 'harness-form.ps1');
const PS_WIN32 =
  `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name Win32 -Namespace API; ` +
  '[void][API.Win32]::SetProcessDPIAware(); ';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface FormInfo { pid: number; hwnd: number }
let form: ChildProcess | null = null;
let info: FormInfo = { pid: 0, hwnd: 0 };
const events: string[] = [];
const results: Array<{ op: string; oneShot: number[]; host: number[] }> = [];

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };

async function timeIt(fn: () => Promise<unknown>, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(); out.push(Math.round(performance.now() - t)); }
  return out;
}
const oneShotScript = (script: string, args: Record<string, string | number | boolean | undefined>) =>
  execFileAsync('powershell.exe', oneShotScriptArgs(path.join(SCRIPTS, script), args), { timeout: 30000, windowsHide: true });
const oneShotCommand = (code: string) =>
  execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { timeout: 30000, windowsHide: true });

async function foreground(): Promise<number> {
  const { stdout } = await psCommand(
    `if (-not ('HarnessFg' -as [type])) { Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' -Name HarnessFg -Namespace H }; [H.HarnessFg]::GetForegroundWindow().ToInt64()`,
    { timeoutMs: 5000 });
  return Number(stdout.trim());
}
async function waitEvent(prefix: string, ms = 3000): Promise<string | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = events.find((x) => x.startsWith(prefix));
    if (e) return e;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

describe.skipIf(!RUN)('Windows PowerShell host harness (own WinForms window)', () => {
  beforeAll(async () => {
    configurePsHost({ scriptsDir: () => SCRIPTS });
    form = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FORM, '-Seconds', '240'], { windowsHide: false });
    let buf = '';
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('harness form never became ready')), 40000);
      form!.stdout!.setEncoding('utf8');
      form!.stdout!.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          events.push(line);
          const m = /^ready (\d+) (\d+)/.exec(line);
          if (m) { info = { pid: Number(m[1]), hwnd: Number(m[2]) }; clearTimeout(t); resolve(); }
        }
      });
    });
  }, 60000);

  afterAll(() => {
    try { form?.kill(); } catch { /* gone */ }
    shutdownPsHost();
    if (results.length) {
      const rows = results.map((r) => `| ${r.op} | ${median(r.oneShot)} | ${p95(r.oneShot)} | ${median(r.host)} | ${p95(r.host)} | ${(median(r.oneShot) / Math.max(1, median(r.host))).toFixed(0)}x |`);
      const table = ['| op | one-shot median ms | one-shot p95 | host median ms | host p95 | speed-up |', '|---|---|---|---|---|---|', ...rows].join('\n');
      console.log(`\n${table}\n`);
      try { fs.writeFileSync(path.join(os.tmpdir(), 'clippy-host-bench.md'), table); } catch { /* best effort */ }
    }
  });

  it('cold start: first request spawns the host, ready line reports DPI + helper', async () => {
    const t = performance.now();
    const r = await psCommand('1+1', { timeoutMs: 30000 });
    const cold = Math.round(performance.now() - t);
    console.log(`host cold start + first request: ${cold} ms; ready=${JSON.stringify(getPsHost()?.readyInfo)}`);
    expect(r.via).toBe('host');
    expect(r.stdout.trim()).toBe('2');
    expect(getPsHost()?.readyInfo).toMatchObject({ native: 'compiled', uia: 'warm' });
    expect(String(getPsHost()?.readyInfo.dpi)).toMatch(/thread/);
  }, 40000);

  it('latency: one-shot spawn vs persistent host', async () => {
    const ops: Array<{ op: string; one: () => Promise<unknown>; host: () => Promise<unknown> }> = [
      { op: 'get_active_window', one: () => oneShotScript('get-foreground-window.ps1', {}), host: () => psScript('get-foreground-window.ps1', {}, { timeoutMs: 10000 }) },
      { op: 'read_screen (UIA tree of own form)', one: () => oneShotScript('get-screen-context.ps1', { ExcludeProcessId: process.pid, FocusedProcessId: info.pid }), host: () => psScript('get-screen-context.ps1', { ExcludeProcessId: process.pid, FocusedProcessId: info.pid }, { timeoutMs: 15000 }) },
      { op: 'mouse_* path (types loaded, cursor read only)', one: () => oneShotCommand(`${PS_WIN32}Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position.X`), host: () => psCommand(`${PS_WIN32}Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position.X`, { timeoutMs: 10000 }) },
      { op: 'key_press path (SendKeys loaded, nothing sent)', one: () => oneShotCommand(`Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.SendKeys]`), host: () => psCommand(`Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.SendKeys]`, { timeoutMs: 10000 }) },
      { op: 'smart_click UIA find "Send" (old find-element vs smart-find)', one: () => oneShotScript('find-element.ps1', { Name: 'Send', ProcessId: info.pid }), host: () => psScript('smart-find.ps1', { NameB64: b64('Send'), WindowHandle: info.hwnd, Action: 'find' }, { timeoutMs: 15000 }) },
    ];
    for (const o of ops) {
      await o.host(); // warm the type cache once, as a real session would
      const oneShot = await timeIt(o.one, 5);
      const host = await timeIt(o.host, 20);
      results.push({ op: o.op, oneShot, host });
      expect(median(host)).toBeLessThan(median(oneShot));
    }
  }, 240000);

  it('smart-find: exact FindFirst hit with physical (per-monitor-v2) bounds inside the form', async () => {
    const r = JSON.parse((await psScript('smart-find.ps1', { NameB64: b64('Send'), WindowHandle: info.hwnd, Action: 'find' }, { timeoutMs: 15000 })).stdout);
    expect(r).toMatchObject({ found: true, name: 'Send', controlType: 'Button', stage: 'exact' });
    const win = JSON.parse((await psCommand(`$r = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${info.hwnd}).Current.BoundingRectangle; '{"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}'`, { timeoutMs: 5000 })).stdout);
    expect(r.bounds.x).toBeGreaterThanOrEqual(win.x);
    expect(r.bounds.x + r.bounds.width).toBeLessThanOrEqual(win.x + win.w);
    // the form's client is 560 logical px wide; physical width / 576 ≈ display scale
    console.log(`own form physical rect ${JSON.stringify(win)}; Send button ${JSON.stringify(r.bounds)}`);
  }, 30000);

  it('smart-find: fuzzy TreeWalker pass finds a multi-word button from one word', async () => {
    const r = JSON.parse((await psScript('smart-find.ps1', { NameB64: b64('message'), WindowHandle: info.hwnd, Action: 'find' }, { timeoutMs: 15000 })).stdout);
    expect(r).toMatchObject({ found: true, name: 'New message', stage: 'walk', timedOut: false });
    expect(r.nodesVisited).toBeGreaterThan(0);
  }, 30000);

  it.skipIf(!ACT)('smart-find click → InvokePattern on own button; harness window never takes the foreground', async () => {
    const r = JSON.parse((await psScript('smart-find.ps1', { NameB64: b64('Send'), WindowHandle: info.hwnd, Action: 'click', NoCoordinateClick: true }, { timeoutMs: 15000 })).stdout);
    expect(r).toMatchObject({ found: true, method: 'uia-invoke' });
    expect(await waitEvent('click Send')).toBeTruthy();
    expect(await foreground()).not.toBe(info.hwnd);
  }, 30000);

  it.skipIf(!ACT)('smart-find click on a checkbox → Toggle (or Invoke) and the state flips (may activate the window)', async () => {
    const r = JSON.parse((await psScript('smart-find.ps1', { NameB64: b64('Remember me'), WindowHandle: info.hwnd, Action: 'click', NoCoordinateClick: true }, { timeoutMs: 15000 })).stdout);
    expect(['uia-toggle', 'uia-invoke']).toContain(r.method);
    expect(await waitEvent('check True')).toBeTruthy();
    // (no foreground assertion: the Win32 checkbox proxy's BM_CLICK activates the window)
  }, 30000);

  it.skipIf(!ACT)('smart-find set-value → ValuePattern.SetValue with verified read-back (unicode intact)', async () => {
    const text = 'Quarterly — numbers ✓ 你好';
    const r = JSON.parse((await psScript('smart-find.ps1', { NameB64: b64('Subject'), WindowHandle: info.hwnd, Action: 'set-value', ValueB64: b64(text), NoCoordinateClick: true }, { timeoutMs: 15000 })).stdout);
    expect(r).toMatchObject({ found: true, method: 'uia-setvalue', setValue: true, readback: 'match' });
    // the harness form's stdout is OEM-encoded, so only compare the ASCII head
    expect(await waitEvent('text Quarterly')).toBeTruthy();
    expect(await foreground()).not.toBe(info.hwnd);
  }, 30000);

  it('OCR resident in the host: own-form crop, multi-word line match, warm calls faster than cold', async () => {
    const win = JSON.parse((await psCommand(`$r = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${info.hwnd}).Current.BoundingRectangle; '{"x":' + [int]$r.X + ',"y":' + [int]$r.Y + ',"w":' + [int]$r.Width + ',"h":' + [int]$r.Height + '}'`, { timeoutMs: 5000 })).stdout);
    const args = { Region: 'rect', X: win.x, Y: win.y, Width: win.w, Height: win.h };
    const runHost = async () => layoutFromRegion(JSON.parse((await psScript('ocr-screen.ps1', args, { timeoutMs: 20000 })).stdout));
    const t0 = performance.now();
    const first = await runHost();
    const cold = Math.round(performance.now() - t0);
    const warm = await timeIt(runHost, 10);
    const layout = await runHost();
    expect(layout.region?.source).toBe('rect');
    const send = matchOcrTarget('Send', layout.elements);
    expect(send).not.toBeNull();
    // absolute screen coordinates: the match lies inside the form's rect
    expect(send!.element.x).toBeGreaterThanOrEqual(win.x);
    const status = matchOcrTarget('Inbox status', layout.elements);
    expect(status?.kind).toBe('span');
    // old path: capture to %TEMP% PNG (spawn 1) + ocr-recognize.ps1 (spawn 2)
    const png = path.join(os.tmpdir(), `clippy-harness-${Date.now()}.png`);
    const old = await timeIt(async () => {
      await oneShotCommand(`${PS_WIN32}Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $bmp = New-Object System.Drawing.Bitmap(${win.w},${win.h}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${win.x},${win.y},0,0,(New-Object System.Drawing.Size(${win.w},${win.h}))); $bmp.Save('${png}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`);
      await oneShotScript('ocr-recognize.ps1', { ImagePath: png });
    }, 3);
    try { fs.unlinkSync(png); } catch { /* gone */ }
    results.push({ op: 'OCR own-form rect (old 2-spawn PNG path vs resident host)', oneShot: old, host: warm });
    console.log(`OCR host cold ${cold} ms (engine created), warm median ${median(warm)} ms; words=${first.elements.length}`);
    expect(median(warm)).toBeLessThan(median(old));
  }, 120000);

  it('host crash → HOST_DIED, the next call restarts it transparently', async () => {
    const before = getPsHost()!.starts;
    await expect(psCommand('[Environment]::Exit(3)', { timeoutMs: 5000 })).rejects.toThrow(/died/);
    const r = await psCommand('"alive"', { timeoutMs: 30000 });
    expect(r).toMatchObject({ via: 'host' });
    expect(r.stdout.trim()).toBe('alive');
    expect(getPsHost()!.starts).toBe(before + 1);
  }, 40000);
});
