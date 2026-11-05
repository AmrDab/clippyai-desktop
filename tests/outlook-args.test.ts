/**
 * v0.24 — Outlook / Excel automation honesty (plan §3.6): base64 subject +
 * body on every send path, Sent Items verification drives the receipt, and
 * a workbook open in Excel is its own error. execFile is mocked.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';

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
vi.mock('../src/main/mail-env', () => ({
  getCachedMailEnvironment: () => ({ classic_outlook_com: true, new_outlook_installed: true }),
  probeMailEnvironment: async () => ({ classic_outlook_com: true, new_outlook_installed: true }),
}));

type Reply = { stdout: string } | (Error & { stdout?: string });
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

import { outlookSendArgs, toB64 } from '../src/main/outlook-args';
import { executeTool } from '../src/main/tools';

const script = (name: string) => (args: string[]) => args.some((a) => a.endsWith(name));
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const fromB64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const BODY = 'Hi Sam,\n\nNumbers attached — Q3 ✓.\r\n\nThanks,\n"Amr"';

const originalPlatform = process.platform;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  // getScriptsDir() prefers <resourcesPath>/scripts — point it at the real .ps1 dir
  (process as unknown as { resourcesPath: string }).resourcesPath = path.join(process.cwd(), 'assets');
});
afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
beforeEach(() => { replies = []; calls.length = 0; execFileMock.mockClear(); });

describe('outlookSendArgs', () => {
  it('never passes subject/body raw; base64 round-trips multi-line unicode', () => {
    const a = outlookSendArgs({ to: 'sam@x.com', subject: 'Q3 — numbers', body: BODY, cc: 'b@x.com', attachments: 'C:\\a.pdf' }, true);
    expect(a).not.toContain('-subject');
    expect(a).not.toContain('-body');
    expect(fromB64(after(a, '-subjectB64'))).toBe('Q3 — numbers');
    expect(fromB64(after(a, '-bodyB64'))).toBe(BODY);
    expect(after(a, '-cc')).toBe('b@x.com');
    expect(after(a, '-attachments')).toBe('C:\\a.pdf');
    // base64 is a single argv token with no whitespace/newlines/quotes
    expect(after(a, '-bodyB64')).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
  it('olk paths drop attachments', () => {
    const a = outlookSendArgs({ to: 't', subject: 's', body: 'b', attachments: 'C:\\a.pdf' }, false);
    expect(a).not.toContain('-attachments');
    expect(toB64('é')).toBe('w6k=');
  });
});

describe('outlook_send_email (win32 COM)', () => {
  it('sends base64 args and returns a VERIFIED receipt when the item is in Sent Items', async () => {
    replies = [(a) => (script('com-outlook-send-email.ps1')(a) ? { stdout: '{"ok":true,"sent":true,"verified":true,"verifiedVia":"sent_items","to":"sam@x.com","subject":"Q3"}' } : undefined)];
    const r = await executeTool('outlook_send_email', { to: 'sam@x.com', subject: 'Q3', body: BODY });
    const a = calls.find(script('com-outlook-send-email.ps1'))!;
    expect(fromB64(after(a, '-bodyB64'))).toBe(BODY);
    expect(a).not.toContain('-body');
    expect(r.receipt).toMatchObject({ tool: 'outlook_send_email', status: 'verified', execution_path: 'com' });
    expect(r.text).not.toMatch(/Outbox/);
  });

  it('not in Sent Items yet → unverified receipt and the text says so', async () => {
    replies = [(a) => (script('com-outlook-send-email.ps1')(a) ? { stdout: '{"ok":true,"sent":true,"verified":false,"verifiedVia":"not_in_sent_items"}' } : undefined)];
    const r = await executeTool('outlook_send_email', { to: 'sam@x.com', subject: 'Q3', body: 'b' });
    expect(r.receipt).toMatchObject({ status: 'unverified' });
    expect(r.text).toMatch(/Outbox/);
  });

  it('new Outlook (no COM) → olk path gets base64 args without attachments (no receipt: no Sent Items check possible)', async () => {
    replies = [
      (a) => (script('com-outlook-send-email.ps1')(a) ? Object.assign(new Error('Command failed'), { stdout: '{"ok":false,"error":"new_outlook_no_com"}' }) : undefined),
      (a) => (script('olk-send-email-uia.ps1')(a) ? { stdout: '{"ok":true,"via":"olk-uia","sent":true,"verified":false,"verifiedVia":"compose_closed"}' } : undefined),
    ];
    const r = await executeTool('outlook_send_email', { to: 'sam@x.com', subject: 'Q3', body: BODY, attachments: 'C:\\a.pdf' });
    const a = calls.find(script('olk-send-email-uia.ps1'))!;
    expect(fromB64(after(a, '-bodyB64'))).toBe(BODY);
    expect(a).not.toContain('-attachments');
    expect(r.receipt).toBeUndefined();
    expect(r.text).toMatch(/attachments not sent/);
  });
});

describe('excel_write — workbook open in Excel', () => {
  it('surfaces WORKBOOK_OPEN, distinct from a generic COM error', async () => {
    replies = [(a) => (script('com-excel-write.ps1')(a) ? Object.assign(new Error('Command failed'), { stdout: '{"ok":false,"error":"workbook_open","message":"\'Budget.xlsx\' is open in Excel. Save and close it there first."}' }) : undefined)];
    const r = await executeTool('excel_write', { path: 'C:\\Users\\me\\Budget.xlsx', data: [[1, 2]] });
    expect(r.text).toMatch(/^\(error:WORKBOOK_OPEN\)/);
    expect(r.text).toMatch(/Budget\.xlsx/);
  });
  it('a lock held by something else is FILE_LOCKED', async () => {
    replies = [(a) => (script('com-excel-write.ps1')(a) ? Object.assign(new Error('Command failed'), { stdout: '{"ok":false,"error":"file_locked","message":"locked"}' }) : undefined)];
    const r = await executeTool('excel_write', { path: 'C:\\x.xlsx', data: [[1]] });
    expect(r.text).toMatch(/^\(error:FILE_LOCKED\)/);
  });
});
