/** Proactive Mode off also silences the scheduler's time-based pings (greeting, wrap-up, stretch). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ proactiveEnabled: true }));
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../src/main/brain', () => ({
  brainSettingsStore: { get: (k: string) => (store as Record<string, unknown>)[k] },
}));
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock('../src/main/approval', () => ({ afterApprovals: (fn: () => void) => fn() }));

import { startScheduler, stopScheduler } from '../src/main/scheduler';
import type { Brain } from '../src/main/brain';
import type { BrowserWindow } from 'electron';

function setup() {
  const sends: string[] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (ch: string) => sends.push(ch) },
  };
  const brain = { getMode: () => 'awake' };
  startScheduler(win as unknown as BrowserWindow, brain as unknown as Brain);
  return sends;
}

describe('scheduler respects Proactive Mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 23, 9, 5)); // a Monday, 09:05: greeting window
  });
  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
  });

  it('stays quiet at 09:05 when Proactive Mode is off, and reads the setting live', () => {
    store.proactiveEnabled = false;
    const sends = setup();
    vi.advanceTimersByTime(31_000);
    expect(sends).toEqual([]);
    store.proactiveEnabled = true; // turned back on: the next tick greets
    vi.advanceTimersByTime(60_000);
    expect(sends).toEqual(['clippy-speak']);
  });
});
