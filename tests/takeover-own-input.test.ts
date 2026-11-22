import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => require('os').tmpdir(), getVersion: () => '0.0.0' },
  powerMonitor: { getSystemIdleTime: () => 10 },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
}));

import { noteClippyInput, noteClippyInputFor, isDispatchingInput } from '../src/main/user-takeover';

describe('Clippy\'s own input does not count as the user taking over', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-22T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('a plain note covers 1.5 s', () => {
    noteClippyInput('smart_click');
    vi.advanceTimersByTime(1400);
    expect(isDispatchingInput()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(isDispatchingInput()).toBe(false);
  });

  it('noteClippyInputFor keeps the window open for a slow focus script (benchmark 2026-11-22)', () => {
    noteClippyInputFor('focus_window', 5000);
    vi.advanceTimersByTime(4900);
    expect(isDispatchingInput()).toBe(true);
    noteClippyInput('focus_window'); // the script returned
    vi.advanceTimersByTime(1400);
    expect(isDispatchingInput()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(isDispatchingInput()).toBe(false);
  });

  it('never shortens a window that is already open longer', () => {
    noteClippyInputFor('focus_window', 5000);
    noteClippyInputFor('focus_window', 100);
    vi.advanceTimersByTime(4000);
    expect(isDispatchingInput()).toBe(true);
  });
});
