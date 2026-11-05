/**
 * v0.24 — win32 smart_click / smart_type routing (plan §3.2 / §3.4).
 * powershell.exe is never spawned: child_process.execFile is mocked and
 * answers per script, so each tier and receipt path is deterministic.
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

import { executeTool } from '../src/main/tools';

const script = (name: string) => (args: string[]) => args.some((a) => a.endsWith(name));
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const FG = { stdout: '{"handle":4242,"processId":777,"processName":"msedge","title":"Inbox","bounds":{"x":0,"y":0,"width":1600,"height":1000},"success":true}' };
const fgReply = (a: string[]) => (script('get-foreground-window.ps1')(a) ? FG : undefined);
const clickReply = (a: string[]) => (a.some((x) => x.includes('mouse_event(2,0,0,0,0)')) ? { stdout: '' } : undefined);
const ocrWords = (words: Array<[string, number, number]>, region = 'foreground') => ({
  stdout: JSON.stringify({ region: { x: 100, y: 50, width: 1600, height: 1000, source: region }, words: words.map(([text, x, line]) => ({ text, x, y: 20, width: text.length * 10, height: 20, line })), fullText: words.map((w) => w[0]).join(' ') }),
});

const originalPlatform = process.platform;
beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
beforeEach(() => { replies = []; calls.length = 0; execFileMock.mockClear(); });

describe('smart_click (win32)', () => {
  it('UIA hit acted on by InvokePattern → receipt execution_path uia-invoke, no OCR, no coordinate click', async () => {
    replies = [fgReply, (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":true,"name":"Send","controlType":"Button","bounds":{"x":10,"y":10,"width":80,"height":30},"score":1.1,"stage":"exact","method":"uia-invoke","pending":false,"setValue":null,"readback":"none","nodesVisited":0,"elapsedMs":42,"timedOut":false}' } : undefined)];
    const r = await executeTool('smart_click', { target: 'Send' });
    expect(r.text).toMatch(/^Clicked "Send" via UIA Invoke \(Button "Send"\)/);
    expect(r.receipt).toMatchObject({ tool: 'smart_click', status: 'unverified', executed: true, execution_path: 'uia-invoke' });
    expect(r.receipt?.evidence).toMatchObject({ stage: 'exact', elapsedMs: 42 });
    const sf = calls.find(script('smart-find.ps1'))!;
    expect(Buffer.from(argAfter(sf, '-NameB64'), 'base64').toString()).toBe('Send');
    expect(argAfter(sf, '-WindowHandle')).toBe('4242');
    expect(argAfter(sf, '-Action')).toBe('click');
    expect(calls.some(script('ocr-screen.ps1'))).toBe(false);
  });

  it('UIA budget spent → falls through to OCR (not skipped) and matches a multi-word label', async () => {
    replies = [
      fgReply,
      (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":false,"nodesVisited":3000,"elapsedMs":4001,"timedOut":true}' } : undefined),
      (a) => (script('ocr-screen.ps1')(a) ? ocrWords([['Home', 0, 0], ['New', 60, 0], ['message', 100, 0]]) : undefined),
      clickReply,
    ];
    const r = await executeTool('smart_click', { target: 'New message' });
    // span "New message" = x 60..170 (+100 region origin) → centre 215; y 20..40 (+50) → 80
    expect(r.text).toMatch(/^Clicked "New message" at \(215,80\) via OCR \(matched "New message"/);
    expect(r.receipt).toMatchObject({ execution_path: 'ocr' });
    expect(r.receipt?.evidence).toMatchObject({ kind: 'span', region: 'foreground' });
    expect(argAfter(calls.find(script('ocr-screen.ps1'))!, '-Region')).toBe('foreground');
  });

  it('foreground OCR miss → second pass over the whole screen', async () => {
    replies = [
      fgReply,
      (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":false,"nodesVisited":12,"elapsedMs":30,"timedOut":false}' } : undefined),
      (a) => (script('ocr-screen.ps1')(a) && argAfter(a, '-Region') === 'foreground' ? ocrWords([['Nothing', 0, 0]]) : undefined),
      (a) => (script('ocr-screen.ps1')(a) && argAfter(a, '-Region') === 'screen' ? ocrWords([['Allow', 0, 0]], 'screen') : undefined),
      clickReply,
    ];
    const r = await executeTool('smart_click', { target: 'Allow' });
    expect(r.text).toMatch(/via OCR \(matched "Allow"/);
    expect(r.receipt?.evidence).toMatchObject({ region: 'screen' });
  });

  it('a host/UIA timeout is TIMEOUT with executed=null — never a second click via OCR', async () => {
    replies = [fgReply, (a) => (script('smart-find.ps1')(a) ? Object.assign(new Error('Command failed: powershell.exe -NoProfile -File smart-find.ps1'), { killed: true, signal: 'SIGTERM' }) : undefined)];
    const r = await executeTool('smart_click', { target: 'Place order' });
    expect(r.text).toMatch(/^\(error:TIMEOUT\)/);
    expect(r.receipt).toMatchObject({ status: 'error', executed: null });
    expect(calls.some(script('ocr-screen.ps1'))).toBe(false);
  });

  it('not found anywhere → UI_NOT_FOUND (Tier-5 eligible)', async () => {
    replies = [
      fgReply,
      (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":false,"nodesVisited":5,"elapsedMs":9,"timedOut":false}' } : undefined),
      (a) => (script('ocr-screen.ps1')(a) ? ocrWords([['Hello', 0, 0]]) : undefined),
    ];
    const r = await executeTool('smart_click', { target: 'Missing' });
    expect(r.text).toMatch(/^\(error:UI_NOT_FOUND\) smart_click "Missing" — not found via UIA or OCR/);
  });
});

describe('smart_type (win32)', () => {
  it('ValuePattern.SetValue with matching read-back → verified receipt, no clipboard paste', async () => {
    replies = [fgReply, (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":true,"name":"Subject","controlType":"Edit","bounds":{"x":1,"y":1,"width":100,"height":20},"score":1.2,"stage":"walk","method":"uia-setvalue","pending":false,"setValue":true,"readback":"match","nodesVisited":40,"elapsedMs":80,"timedOut":false}' } : undefined)];
    const r = await executeTool('smart_type', { target: 'Subject', text: 'Quarterly — numbers ✓' });
    expect(r.text).toMatch(/via UIA ValuePattern.*\(verified/);
    expect(r.receipt).toMatchObject({ tool: 'smart_type', status: 'verified', execution_path: 'uia-setvalue' });
    const sf = calls.find(script('smart-find.ps1'))!;
    expect(argAfter(sf, '-Action')).toBe('set-value');
    expect(Buffer.from(argAfter(sf, '-ValueB64'), 'base64').toString()).toBe('Quarterly — numbers ✓');
    expect(calls.some(script('type-text.ps1'))).toBe(false);
  });

  it('no writable ValuePattern → smart-find already clicked the field, so paste (once, no second click)', async () => {
    replies = [
      fgReply,
      (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":true,"name":"Message body","controlType":"Document","bounds":{"x":1,"y":1,"width":100,"height":20},"score":1.1,"stage":"walk","method":"uia-invoke","pending":false,"setValue":false,"readback":"none","nodesVisited":40,"elapsedMs":80,"timedOut":false}' } : undefined),
      (a) => (script('type-text.ps1')(a) ? { stdout: '{"success":true,"foregroundProcessId":777,"processName":"msedge","hasReadback":true,"readback":"hi there"}' } : undefined),
    ];
    const r = await executeTool('smart_type', { target: 'Message body', text: 'hi there' });
    expect(r.text).toMatch(/^Pasted 8 chars into msedge/);
    expect(calls.filter(script('smart-find.ps1'))).toHaveLength(1);
  });
});
