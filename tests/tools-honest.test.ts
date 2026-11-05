/**
 * v0.23 — honest focus_window / open_app / type_text on Windows (plan §1.1).
 * powershell.exe is never spawned: child_process.execFile is mocked and
 * answers per command, so each receipt path is exercised deterministically.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import os from 'os';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  clipboard: { availableFormats: () => [], readText: () => '', writeText: () => {} },
  BrowserWindow: class {}, screen: {}, shell: {}, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));

type Reply = { stdout: string } | Error;
let replies: Array<(args: string[]) => Reply | undefined> = [];
const execFileMock = vi.fn((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
  for (const r of replies) {
    const reply = r(args);
    if (reply === undefined) continue;
    if (reply instanceof Error) { cb(reply); return; }
    cb(null, { stdout: reply.stdout, stderr: '' });
    return;
  }
  cb(new Error(`unexpected execFile: ${args.join(' ')}`));
});
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, execFile: (...a: unknown[]) => (execFileMock as unknown as (...x: unknown[]) => void)(...a) };
});

import { executeTool } from '../src/main/tools';

const script = (name: string) => (args: string[]) => args.some((a) => a.endsWith(name));
const hasCmd = (needle: string) => (args: string[]) => args.some((a) => a.includes(needle));

const originalPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
beforeEach(() => { replies = []; execFileMock.mockClear(); });

describe('focus_window', () => {
  it('verified receipt when the script saw the target in the foreground', async () => {
    replies = [(a) => script('focus-window.ps1')(a) ? { stdout: '{"success":true,"title":"Untitled - Notepad","processId":10380,"foregroundProcessId":10380}' } : undefined];
    const r = await executeTool('focus_window', { title: 'Notepad' });
    expect(r.text).toMatch(/^Focused "Untitled - Notepad"/);
    expect(r.receipt).toMatchObject({ tool: 'focus_window', status: 'verified', executed: true });
  });

  it('FOCUS_FAILED error receipt when the foreground PID did not change', async () => {
    replies = [(a) => script('focus-window.ps1')(a) ? { stdout: '{"success":false,"error":"SetForegroundWindow did not take: foreground is pid 4192, wanted 10380","processId":10380,"foregroundProcessId":4192}' } : undefined];
    const r = await executeTool('focus_window', { title: 'Notepad' });
    expect(r.text).toMatch(/^\(error:FOCUS_FAILED\)/);
    expect(r.receipt).toMatchObject({ status: 'error', executed: true });
    expect(r.receipt?.evidence).toMatchObject({ foregroundProcessId: 4192 });
  });

  it('UI_NOT_FOUND when no window matches', async () => {
    replies = [(a) => script('focus-window.ps1')(a) ? { stdout: '{"success":false,"error":"Window not found matching Title=\'zzz\' ProcessId=0"}' } : undefined];
    const r = await executeTool('focus_window', { title: 'zzz' });
    expect(r.text).toMatch(/^\(error:UI_NOT_FOUND\)/);
    expect(r.receipt).toMatchObject({ status: 'error', executed: false });
  });

  it('a PowerShell failure is reported as an error — no blind Alt+Tab "success" any more', async () => {
    replies = [(a) => script('focus-window.ps1')(a) ? new Error('powershell.exe exited with code 1') : undefined];
    const r = await executeTool('focus_window', { title: 'Notepad' });
    expect(r.text).toMatch(/^\(error:FOCUS_FAILED\)/);
    expect(r.text).not.toMatch(/alt\+tab/i);
    expect(r.receipt).toMatchObject({ status: 'error', executed: null });
    // key_press (SendKeys alt+tab) was never dispatched
    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).some((x) => /SendWait/.test(x)))).toBe(false);
  });
});

describe('open_app', () => {
  it('verified when a window of the launched process appears within the poll', async () => {
    replies = [
      (a) => hasCmd('Get-Process -Name')(a) && !hasCmd('Start-Process')(a) ? { stdout: '' } : undefined,
      (a) => hasCmd('Start-Process')(a) ? { stdout: '4242\r\n' } : undefined,
    ];
    const r = await executeTool('open_app', { name: 'notepad' });
    expect(r.text).toBe('Launched notepad (pid 4242, window up)');
    expect(r.receipt).toMatchObject({ tool: 'open_app', status: 'verified', executed: true, evidence: { pid: 4242 } });
  });

  it('unverified when no window shows up within 3 s', async () => {
    replies = [
      (a) => hasCmd('Get-Process -Name')(a) && !hasCmd('Start-Process')(a) ? { stdout: '' } : undefined,
      (a) => hasCmd('Start-Process')(a) ? { stdout: '0' } : undefined,
    ];
    const r = await executeTool('open_app', { name: 'notepad' });
    expect(r.text).toMatch(/no window seen within 3 s \(unverified/);
    expect(r.receipt).toMatchObject({ status: 'unverified', executed: true });
  });

  it('already running: passes the focus verdict through instead of assuming it took', async () => {
    replies = [
      (a) => hasCmd('Get-Process -Name')(a) && hasCmd('MainWindowHandle')(a) ? { stdout: '777' } : undefined,
      (a) => script('focus-window.ps1')(a) ? { stdout: '{"success":false,"error":"SetForegroundWindow did not take: foreground is pid 1, wanted 777","processId":777,"foregroundProcessId":1}' } : undefined,
    ];
    const r = await executeTool('open_app', { name: 'notepad' });
    expect(r.text).toMatch(/already running \(pid 777\) but could not be brought to front/);
    expect(r.receipt).toMatchObject({ status: 'unverified' });
  });
});

describe('type_text', () => {
  const typeScript = script('type-text.ps1');

  it("refuses with an error receipt when Clippy's own window is in the foreground", async () => {
    replies = [(a) => typeScript(a) ? { stdout: '{"success":false,"error":"own_window","foregroundProcessId":123}' } : undefined];
    const r = await executeTool('type_text', { text: 'hello' });
    expect(r.text).toMatch(/^\(error:FOCUS_FAILED\) type_text refused/);
    expect(r.receipt).toMatchObject({ tool: 'type_text', status: 'error', executed: false, evidence: { reason: 'own_window' } });
  });

  it('passes its own pid to the script so the refusal is about THIS process', async () => {
    replies = [(a) => typeScript(a) ? { stdout: '{"success":true,"hasReadback":false,"readback":null}' } : undefined];
    await executeTool('type_text', { text: 'hello' });
    const call = execFileMock.mock.calls.find(([, args]) => typeScript(args as string[]))!;
    const args = call[1] as string[];
    expect(args[args.indexOf('-OwnPid') + 1]).toBe(String(process.pid));
  });

  it('verified receipt when the focused field reads back what was pasted', async () => {
    replies = [(a) => typeScript(a) ? { stdout: '{"success":true,"foregroundProcessId":10380,"processName":"Notepad","hasReadback":true,"readback":"old text\\r\\nhello world"}' } : undefined];
    const r = await executeTool('type_text', { text: 'hello world' });
    expect(r.text).toMatch(/Pasted 11 chars into Notepad: "hello world" \(verified/);
    expect(r.receipt).toMatchObject({ status: 'verified', executed: true, evidence: { readback: 'match', processName: 'Notepad' } });
  });

  it('unverified (honest) receipt when the field exposes no readback', async () => {
    replies = [(a) => typeScript(a) ? { stdout: '{"success":true,"foregroundProcessId":55552,"processName":"powershell","hasReadback":false,"readback":null}' } : undefined];
    const r = await executeTool('type_text', { text: 'hello' });
    expect(r.text).toMatch(/NOT verified/);
    expect(r.receipt).toMatchObject({ status: 'unverified', executed: true, evidence: { readback: 'unavailable' } });
  });

  it('unverified with readback:mismatch when the field reads back something else', async () => {
    replies = [(a) => typeScript(a) ? { stdout: '{"success":true,"hasReadback":true,"readback":"something else"}' } : undefined];
    const r = await executeTool('type_text', { text: 'hello' });
    expect(r.receipt).toMatchObject({ status: 'unverified', evidence: { readback: 'mismatch' } });
  });

  it('script failure → error receipt with executed:null (dispatched, outcome lost)', async () => {
    replies = [(a) => typeScript(a) ? new Error('timeout') : undefined];
    const r = await executeTool('type_text', { text: 'hello' });
    expect(r.text).toMatch(/^\(type_text error: timeout\)/);
    expect(r.receipt).toMatchObject({ status: 'error', executed: null });
  });
});
