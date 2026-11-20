/**
 * v0.24.12 — the tools use the picked window (never an overlay): the active
 * window, the screen read, the OCR frame. execFile is mocked, as in
 * smart-click-win.
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
const calls: string[][] = [];
const execFileMock = vi.fn((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
  calls.push(args);
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

import { executeTool, readForegroundText } from '../src/main/tools';
import { extractProcessName } from '../src/main/screen-context';

const script = (name: string) => (args: string[]) => args.some((a) => a.endsWith(name));
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const win = (handle: number, processName: string, processId: number, exStyle: number, style: number, b: [number, number, number, number], title: string) =>
  ({ handle, processName, processId, exStyle, style, minimized: false, title, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] } });
// Clippy in front (the user is typing in the bubble), then a notch overlay, then the mail app.
const SNAPSHOT = {
  foreground: 2,
  candidates: [
    win(2, 'ClippyAI', process.pid, 0x00080008, 0x14030000, [2720, 999, 855, 945], 'ClippyAI'),
    win(4, 'NotchBar', 21540, 0x08280028, 0x14020000, [1112, 0, 1620, 990], 'NotchBar'),
    win(5, 'olk', 700, 0x00200100, 0x17cf0000, [100, 50, 1600, 1000], 'Inbox - Outlook'),
  ],
  success: true,
};
const fgReply = (a: string[]) => (script('get-foreground-window.ps1')(a) ? { stdout: JSON.stringify(SNAPSHOT) } : undefined);

const originalPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
beforeEach(() => { replies = []; calls.length = 0; execFileMock.mockClear(); });

describe('foreground window on win32 skips overlays', () => {
  it('get_active_window: the mail app, in the shape it always had', async () => {
    replies = [fgReply];
    const r = await executeTool('get_active_window', {});
    expect(JSON.parse(r.text)).toEqual({ handle: 5, processId: 700, processName: 'olk', title: 'Inbox - Outlook', bounds: { x: 100, y: 50, width: 1600, height: 1000 }, success: true });
    expect(extractProcessName(r.text)).toBe('olk'); // what Task.start logs as activeProcessAtStart
  });

  it('get_active_window: only Clippy and overlays on screen → no active window', async () => {
    replies = [(a) => (script('get-foreground-window.ps1')(a) ? { stdout: JSON.stringify({ ...SNAPSHOT, candidates: SNAPSHOT.candidates.slice(0, 2) }) } : undefined)];
    expect((await executeTool('get_active_window', {})).text).toBe('(no active window)');
  });

  it('get_active_window: an older script shape passes through unchanged', async () => {
    const old = '{"handle":4242,"processId":777,"processName":"msedge","title":"Inbox","bounds":null,"success":true}';
    replies = [(a) => (script('get-foreground-window.ps1')(a) ? { stdout: old } : undefined)];
    expect((await executeTool('get_active_window', {})).text).toBe(old);
  });

  it('read_screen reads the picked window by handle', async () => {
    replies = [fgReply, (a) => (script('get-screen-context.ps1')(a) ? { stdout: '{"focusedProcessId":700,"focusedHandle":5,"focusedTitle":"Inbox - Outlook","focusedProcess":"olk","nodes":[],"seen":0,"truncated":false,"windows":[]}' } : undefined)];
    const r = await executeTool('read_screen', {});
    expect(argAfter(calls.find(script('get-screen-context.ps1'))!, '-WindowHandle')).toBe('5');
    expect(r.text).toMatch(/^Foreground window: "Inbox - Outlook" \(olk\)/);
  });

  it('read_screen with the handle already known (per-turn context) does not ask again', async () => {
    replies = [(a) => (script('get-screen-context.ps1')(a) ? { stdout: '{"focusedHandle":9,"focusedTitle":"T","focusedProcess":"p","nodes":[],"windows":[]}' } : undefined)];
    await executeTool('read_screen', { windowHandle: 9 });
    expect(calls.some(script('get-foreground-window.ps1'))).toBe(false);
    expect(argAfter(calls.find(script('get-screen-context.ps1'))!, '-WindowHandle')).toBe('9');
  });

  it('OCR of the foreground window captures the picked window frame', async () => {
    replies = [fgReply, (a) => (script('ocr-screen.ps1')(a) ? { stdout: JSON.stringify({ region: { x: 100, y: 50, width: 1600, height: 1000, source: 'foreground' }, words: [{ text: 'Hello', x: 0, y: 0, width: 50, height: 20, line: 0 }], fullText: 'Hello' }) } : undefined)];
    expect(await readForegroundText(5000)).toBe('Hello');
    const c = calls.find(script('ocr-screen.ps1'))!;
    expect([argAfter(c, '-Region'), argAfter(c, '-X'), argAfter(c, '-Y'), argAfter(c, '-Width'), argAfter(c, '-Height')]).toEqual(['foreground', '100', '50', '1600', '1000']);
  });
});
