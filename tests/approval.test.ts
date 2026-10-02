import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import {
  requestApproval, resolveApproval, cancelAllApprovals, summarizeArgs,
  markApproved, wasApproved, APPROVAL_TIMEOUT_MS,
} from '../src/main/approval';

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
    expect(send).toHaveBeenCalledWith('approval-request', expect.objectContaining({ tool: 'shell_exec', summary: 'Run `ls`' }));
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
    expect(summarizeArgs('http_request', { method: 'post', url: 'https://api.example.com/path?x=1' })).toBe('POST api.example.com/path');
    expect(summarizeArgs('write_file', { path: '~/x.txt', content: 'a'.repeat(1234) })).toBe('Write 1,234 chars to ~/x.txt');
    expect(summarizeArgs('outlook_send_email', { to: 'X', subject: 'Y', body: 'secret' })).toBe('Email to X, subject Y');
    expect(summarizeArgs('install_skill', { slug: 'twitter-poster' })).toBe('Install skill twitter-poster');
    expect(summarizeArgs('skill__foo', {})).toBe('Run skill foo');
  });

  it('falls back to redacted args and never leaks secrets', () => {
    const out = summarizeArgs('some_tool', { token: 'abc', text: 'hello' });
    expect(out).toContain('some_tool');
    expect(out).not.toContain('abc');
    expect(out).not.toContain('hello');
  });
});
