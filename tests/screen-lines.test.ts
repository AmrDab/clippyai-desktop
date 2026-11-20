/**
 * v0.24.12 — read_screen as lines: the pure formatter, and the tool on win32
 * (powershell.exe is never spawned: execFile is mocked, as in smart-click-win).
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
import { nodeLine, renderScreenLines, formatWinScreen, formatMacScreen, axTreeToNodes, type ScreenNode } from '../src/main/screen-lines';
import { formatScreenDump } from '../src/main/screen-context';
import { READ_RESULT_BUDGET } from '../src/main/result-budget';

const script = (name: string) => (args: string[]) => args.some((a) => a.endsWith(name));
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

const DUMP = {
  focusedProcessId: 7,
  focusedHandle: 200,
  focusedTitle: 'Priority - Form',
  focusedProcess: 'TaskApp',
  nodes: [
    { d: 0, role: 'ComboBox', name: 'Priority', value: 'Low', state: 'collapsed', actions: 'setvalue,expand' },
    { d: 1, role: 'ListItem', name: 'High', actions: 'select' },
    { d: 0, role: 'CheckBox', name: 'Remember me', state: 'unchecked', actions: 'toggle' },
    { d: 0, role: 'Edit', name: '', value: 'draft', state: 'focused', actions: 'setvalue' },
    { d: 0, role: 'Button', name: 'Send', state: 'disabled', actions: 'invoke' },
  ] as ScreenNode[],
  seen: 5,
  truncated: false,
  windows: [
    { handle: 100, title: 'ClippyAI', processName: 'ClippyAI', processId: 1, isMinimized: false },
    { handle: 200, title: 'Priority - Form', processName: 'TaskApp', processId: 7, isMinimized: false },
    { handle: 300, title: 'Inbox - Mail', processName: 'OUTLOOK', processId: 9, isMinimized: false },
    { handle: 400, title: 'notes.txt - Notepad', processName: 'Notepad', processId: 11, isMinimized: true },
  ],
};

describe('nodeLine', () => {
  it('id, role, name, value, state, actions', () => {
    expect(nodeLine('e1', DUMP.nodes[0])).toBe('e1 ComboBox "Priority" = "Low" collapsed (setvalue, expand)');
    expect(nodeLine('e3', DUMP.nodes[2])).toBe('e3 CheckBox "Remember me" unchecked (toggle)');
  });
  it('indents by depth, omits an empty name, flattens whitespace', () => {
    expect(nodeLine('e2', DUMP.nodes[1])).toBe(' e2 ListItem "High" (select)');
    expect(nodeLine('e4', DUMP.nodes[3])).toBe('e4 Edit = "draft" focused (setvalue)');
    expect(nodeLine('e9', { d: 0, role: 'Text', name: 'two\r\n  lines' })).toBe('e9 Text "two lines"');
  });
});

describe('find adds the rectangle, for a click by position', () => {
  const found = { ...DUMP, nodes: [{ d: 0, role: 'Pane', name: 'Canvas', rect: [120, 340, 1600, 900] as [number, number, number, number] }] };
  it('each line ends with @x,y WxH and the result says what it is', () => {
    const out = formatWinScreen(JSON.stringify(found), { find: 'canvas' })!.text.split('\n');
    expect(out[1]).toBe('e1 Pane "Canvas" @120,340 1600x900');
    expect(out[2]).toBe("[@x,y WxH is each control's rectangle on screen: its centre (x+W/2, y+H/2) can go straight to mouse_click]");
  });
  it('a plain read has no rectangles (they would eat the budget)', () => {
    expect(formatWinScreen(JSON.stringify(DUMP))!.text).not.toContain('@');
  });
  it('macOS: the AX bounds, only with find', () => {
    const tree = { app: 'Paint', windows: [{ title: 'W', elements: [{ role: 'AXButton', title: 'Brush', value: null, bounds: { x: 10.4, y: 20, width: 30, height: 40 } }] }] };
    expect(formatMacScreen(tree, { find: 'brush' }).text).toContain(' e2 Button "Brush" @10,20 30x40');
    expect(formatMacScreen(tree).text).not.toContain('@');
  });
});

describe('formatWinScreen', () => {
  it('foreground window first, one line per control, the other windows last and in brief', () => {
    const out = formatWinScreen(JSON.stringify(DUMP), { ownProcessNames: new Set(['ClippyAI']) })!;
    expect(out.text.split('\n')).toEqual([
      'Foreground window: "Priority - Form" (TaskApp)',
      'e1 ComboBox "Priority" = "Low" collapsed (setvalue, expand)',
      ' e2 ListItem "High" (select)',
      'e3 CheckBox "Remember me" unchecked (toggle)',
      'e4 Edit = "draft" focused (setvalue)',
      'e5 Button "Send" disabled (invoke)',
      'Other windows: "Inbox - Mail" (OUTLOOK); "notes.txt - Notepad" (Notepad, minimized)',
    ]);
    expect(out.ids.get('e2')).toBe('High');
    expect(out.ids.has('e4')).toBe(false); // unnamed: nothing to resolve to
  });

  it('caps at 150 lines and says how to narrow down', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({ d: 0, role: 'Button', name: `B${i}` }));
    const out = formatWinScreen(JSON.stringify({ ...DUMP, nodes, truncated: true }))!;
    const lines = out.text.split('\n');
    expect(lines.filter((l) => /^e\d+ /.test(l))).toHaveLength(150);
    expect(lines[151]).toMatch(/^\[only the first 150 controls are shown: call read_screen with find:/);
    expect(lines[152]).toMatch(/^Other windows: /);
  });

  it('always fits the read budget, even with long names', () => {
    const nodes = Array.from({ length: 150 }, (_, i) => ({ d: 3, role: 'ListItem', name: `${i} ${'long name '.repeat(30)}`, actions: 'invoke,select' }));
    const windows = Array.from({ length: 40 }, (_, i) => ({ handle: 1000 + i, title: 'T'.repeat(200), processName: 'proc', processId: i, isMinimized: false }));
    const out = formatWinScreen(JSON.stringify({ ...DUMP, nodes, windows }))!;
    expect(out.text.length).toBeLessThanOrEqual(READ_RESULT_BUDGET);
    expect(out.text).toContain('[only the first ');
    expect(out.text).toContain('Other windows: ');
  });

  it('an empty tree and an empty search say so', () => {
    expect(formatWinScreen(JSON.stringify({ ...DUMP, nodes: [] }))!.text).toContain('(this window exposes no controls: use ocr_read_screen or desktop_screenshot)');
    expect(formatWinScreen(JSON.stringify({ ...DUMP, nodes: [] }), { find: 'Zed' })!.text).toContain('(no control with "Zed" in its name in this window)');
    expect(formatWinScreen(JSON.stringify({ ...DUMP, focusedHandle: 0, focusedTitle: '', nodes: [] }))!.text).toMatch(/^Foreground window: \(none\)/);
  });

  it('is null for an error or any other text, so the caller passes it on', () => {
    expect(formatWinScreen('{"error":"boom"}')).toBeNull();
    expect(formatWinScreen('not json')).toBeNull();
    expect(formatWinScreen('{"windows":[]}')).toBeNull();
  });
});

describe('macOS tree', () => {
  const tree = {
    app: 'Mail', pid: 5,
    windows: [{
      title: 'Inbox',
      elements: [{
        role: 'AXGroup', title: '', value: null, enabled: true, focused: false, children: [{
          role: 'AXSplitGroup', title: '', value: null, enabled: true, focused: false, children: [
            { role: 'AXButton', title: 'Send', value: null, enabled: false, focused: false },
            { role: 'AXTextField', title: 'Subject', value: 'Hello', enabled: true, focused: true },
            { role: 'AXStaticText', title: '', value: 'Draft saved', enabled: true, focused: false },
            { role: 'AXSecureTextField', title: 'Password', value: 'hunter2', enabled: true, focused: false },
            { role: 'AXImage', title: '', value: null, enabled: true, focused: false },
          ],
        }],
      }],
    }],
  };

  it('unnamed layout nodes are left out and use up no depth', () => {
    expect(axTreeToNodes(tree)).toEqual([
      { d: 0, role: 'Window', name: 'Inbox' },
      { d: 1, role: 'Button', name: 'Send', state: 'disabled' },
      { d: 1, role: 'TextField', name: 'Subject', value: 'Hello', state: 'focused' },
      { d: 1, role: 'StaticText', name: 'Draft saved' },
      { d: 1, role: 'SecureTextField', name: 'Password', state: 'password' },
    ]);
  });

  it('formats like Windows and never shows a password', () => {
    const out = formatMacScreen(tree).text;
    expect(out.split('\n')).toEqual([
      'Foreground app: Mail',
      'e1 Window "Inbox"',
      ' e2 Button "Send" disabled',
      ' e3 TextField "Subject" = "Hello" focused',
      ' e4 StaticText "Draft saved"',
      ' e5 SecureTextField "Password" password',
    ]);
    expect(out).not.toContain('hunter2');
  });

  it('find keeps only matching controls', () => {
    expect(formatMacScreen(tree, { find: 'subj' }).text.split('\n')).toEqual([
      'Foreground app: Mail', 'e1 Window "Inbox"', ' e2 TextField "Subject" = "Hello" focused',
    ]);
    expect(formatMacScreen(tree, { find: 'nope' }).text).toContain('(no control with "nope" in its name in this window)');
  });
});

describe('renderScreenLines', () => {
  it('a walk that stopped early is marked even under the line cap', () => {
    const out = renderScreenLines({ header: 'H', nodes: [{ d: 0, role: 'Button', name: 'A' }], truncated: true });
    expect(out.text).toBe('H\ne1 Button "A"\n[only the first 1 controls are shown: call read_screen with find:"<part of a name>" to list the ones you need]');
  });
});

describe('formatScreenDump (per-turn context) reads the flat nodes', () => {
  it('names and values of the focused window', () => {
    expect(formatScreenDump(JSON.stringify(DUMP), 5000)).toContain('In TaskApp: Priority · Low · High · Remember me · draft · Send');
  });
});

const originalPlatform = process.platform;
describe('read_screen tool (win32)', () => {
  beforeAll(() => { Object.defineProperty(process, 'platform', { value: 'win32' }); });
  afterAll(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); });
  beforeEach(() => { replies = []; calls.length = 0; execFileMock.mockClear(); });
  const ctxReply = (a: string[]) => (script('get-screen-context.ps1')(a) ? { stdout: JSON.stringify(DUMP) } : undefined);

  it('returns lines, tree before the window list, without Clippy among the other windows', async () => {
    replies = [ctxReply];
    const r = await executeTool('read_screen', {});
    expect(r.text.startsWith('Foreground window: "Priority - Form" (TaskApp)\ne1 ComboBox "Priority"')).toBe(true);
    expect(r.text).toContain('Other windows: "Inbox - Mail" (OUTLOOK)');
    expect(r.text).not.toContain('ClippyAI');
    expect(r.text).not.toContain('"handle"');
  });

  it('find is passed to the script (base64) and smart_read is the same tool', async () => {
    replies = [ctxReply];
    await executeTool('smart_read', { find: 'Prio' });
    const c = calls.find(script('get-screen-context.ps1'))!;
    expect(Buffer.from(argAfter(c, '-FindB64'), 'base64').toString()).toBe('Prio');
  });

  it('format:"json" (internal, the per-turn context) still gets the JSON', async () => {
    replies = [ctxReply];
    const r = await executeTool('read_screen', { format: 'json' });
    expect(JSON.parse(r.text).nodes).toHaveLength(5);
  });

  it('a script error comes through as is', async () => {
    replies = [(a) => (script('get-screen-context.ps1')(a) ? { stdout: '{"error":"UIA unavailable"}' } : undefined)];
    expect((await executeTool('read_screen', {})).text).toBe('{"error":"UIA unavailable"}');
  });

  it('smart_click takes an id from the last read_screen', async () => {
    replies = [
      ctxReply,
      (a) => (script('get-foreground-window.ps1')(a) ? { stdout: '{"handle":200,"processId":7,"processName":"TaskApp","title":"Priority - Form","bounds":{"x":0,"y":0,"width":800,"height":600},"success":true}' } : undefined),
      (a) => (script('smart-find.ps1')(a) ? { stdout: '{"found":true,"name":"Send","controlType":"Button","bounds":{"x":10,"y":10,"width":80,"height":30},"score":1.1,"stage":"exact","method":"uia-invoke","pending":false,"setValue":null,"readback":"none","nodesVisited":1,"elapsedMs":5,"timedOut":false}' } : undefined),
    ];
    await executeTool('read_screen', {});
    await executeTool('smart_click', { target: 'e5' });
    const sf = calls.find(script('smart-find.ps1'))!;
    expect(Buffer.from(argAfter(sf, '-NameB64'), 'base64').toString()).toBe('Send');
  });
});
