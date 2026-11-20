/** v0.24.12 — key_press on Windows: combo → SendKeys, and the tool end to end (execFile mocked). */
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
const calls: string[][] = [];
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    execFile: (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
      calls.push(args);
      cb(null, { stdout: '', stderr: '' });
    },
  };
});

import { toSendKeys } from '../src/main/sendkeys';
import { executeTool } from '../src/main/tools';

const keys = (raw: string) => { const r = toSendKeys(raw); return r.ok ? r.keys : `ERR: ${r.error}`; };

describe('toSendKeys', () => {
  it('the two reported bugs: ctrl+enter and alt+f4', () => {
    expect(keys('ctrl+enter')).toBe('^{ENTER}');   // was "^enter": Ctrl+E, then "nter" typed
    expect(keys('alt+f4')).toBe('%{F4}');          // was "%f4": Alt+F, then "4" typed
  });

  it('names are case-insensitive, alone or in a combo', () => {
    expect(keys('Enter')).toBe('{ENTER}');
    expect(keys('RETURN')).toBe('{ENTER}');
    expect(keys('Ctrl+Shift+Esc')).toBe('^+{ESC}');
    expect(keys('shift+tab')).toBe('+{TAB}');
    expect(keys('Ctrl + Enter')).toBe('^{ENTER}');
    expect(keys('alt+tab')).toBe('%{TAB}');
    expect(keys('ctrl+Home')).toBe('^{HOME}');
    expect(keys('Page_Down')).toBe('{PGDN}');
    expect(keys('pageup')).toBe('{PGUP}');
    expect(keys('escape')).toBe('{ESC}');
    expect(keys('Backspace')).toBe('{BACKSPACE}');
    expect(keys('delete')).toBe('{DELETE}');
  });

  it('F1-F12, Space and Insert', () => {
    for (let i = 1; i <= 12; i++) expect(keys(`f${i}`)).toBe(`{F${i}}`);
    expect(keys('F11')).toBe('{F11}');
    expect(keys('ctrl+f12')).toBe('^{F12}');
    expect(keys('space')).toBe(' ');
    expect(keys('ctrl+Space')).toBe('^ ');
    expect(keys('insert')).toBe('{INSERT}');
    expect(keys('shift+Insert')).toBe('+{INSERT}');
    expect(keys('f13')).toMatch(/^ERR: unknown key "f13"/);
  });

  it('letters, digits and punctuation', () => {
    expect(keys('ctrl+s')).toBe('^s');
    expect(keys('ctrl+S')).toBe('^s');          // the s key, not Ctrl+Shift+S
    expect(keys('ctrl+shift+s')).toBe('^+s');
    expect(keys('a')).toBe('a');
    expect(keys('A')).toBe('A');
    expect(keys('ctrl+/')).toBe('^/');
    expect(keys('ctrl+1')).toBe('^1');
    expect(keys('ctrl++')).toBe('^{+}');        // SendKeys special characters go in braces
    expect(keys('+')).toBe('{+}');
    expect(keys('ctrl+[')).toBe('^{[}');
    expect(keys('ctrl+ctrl+a')).toBe('^a');
  });

  it('an unknown multi-character key is an error, never typed out', () => {
    expect(keys('ctrl+entr')).toMatch(/^ERR: unknown key "entr"/);
    expect(keys('hello')).toMatch(/^ERR: unknown key "hello".*type_text/);
    expect(keys('ctrl+k ctrl+c')).toMatch(/^ERR: unknown modifier "k ctrl"/); // one combo per call
    expect(keys('hyper+a')).toMatch(/^ERR: unknown modifier "hyper"/);
    expect(keys('ctrl+')).toMatch(/^ERR: .*not a key combo/);
    expect(keys('')).toBe('ERR: no key given');
  });

  it('raw SendKeys syntax is refused', () => {
    for (const raw of ['%{F4}', '^{ENTER}', '{ENTER}', '^s', '%f', '+{TAB}', '~', '{TAB 3}']) {
      expect(keys(raw), raw).toMatch(/^ERR: /);
    }
    expect(keys('%{F4}')).toContain('raw SendKeys syntax');
    expect(keys('~')).toContain('Use "enter"');
  });

  it('the Windows key: alone opens Start; in a combo it is refused, with what to use instead', () => {
    expect(keys('win')).toBe('^{ESC}');
    expect(keys('win+d')).toMatch(/^ERR: .*Windows key cannot be sent in a combo/);
    expect(keys('cmd+s')).toMatch(/^ERR: .*ctrl\+s/);
  });

  it('nothing that could end the PowerShell string gets through', () => {
    expect(keys("'")).toMatch(/^ERR: /);
    expect(keys("ctrl+'")).toMatch(/^ERR: /);
    expect(keys('’')).toMatch(/^ERR: /);
    expect(keys('é')).toMatch(/^ERR: /);
    for (const raw of ['ctrl+enter', 'alt+f4', 'ctrl+/', 'ctrl++', 'space', '\\', '"']) {
      const r = toSendKeys(raw);
      expect(r.ok && /^[\x20-\x26\x28-\x7e]+$/.test(r.keys), raw).toBe(true);
    }
  });
});

const originalPlatform = process.platform;
describe('key_press tool (win32)', () => {
  beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
  afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
  beforeEach(() => { calls.length = 0; });
  const sent = () => calls.map((a) => /SendWait\('(.*)'\)/.exec(a.join(' '))?.[1]).filter((x) => x !== undefined);

  it('ctrl+enter sends ^{ENTER}', async () => {
    expect((await executeTool('key_press', { key: 'ctrl+enter' })).text).toBe('Pressed: ctrl+enter');
    expect(sent()).toEqual(['^{ENTER}']);
  });

  it('alt+f4 sends %{F4}', async () => {
    await executeTool('key_press', { key: 'alt+f4' });
    expect(sent()).toEqual(['%{F4}']);
  });

  it('an unknown key or raw SendKeys sends nothing and says why', async () => {
    const a = await executeTool('key_press', { key: 'ctrl+entr' });
    const b = await executeTool('key_press', { key: '%{F4}' });
    expect(a.text).toMatch(/^\(error:INVALID_KEY\) key_press: unknown key "entr"/);
    expect(b.text).toMatch(/^\(error:INVALID_KEY\) key_press: "%\{F4\}" is raw SendKeys syntax/);
    expect(sent()).toEqual([]);
  });
});
