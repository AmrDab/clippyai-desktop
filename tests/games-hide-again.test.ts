import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  ipcMain: { handle: () => {}, on: () => {} },
}));
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));
vi.mock('../src/main/telemetry', () => ({ track: () => {} }));
vi.mock('../src/main/follow-me', () => ({ stop: () => {} }));
vi.mock('../src/main/window-follow', () => ({ noteManualMove: () => {} }));

import * as games from '../src/main/games';

function fakeWin() {
  let b = { x: 1600, y: 800, width: 200, height: 200 };
  const sent: Array<[string, any]> = [];
  return {
    sent,
    isDestroyed: () => false,
    getBounds: () => ({ ...b }),
    getSize: () => [b.width, b.height],
    setBounds: (r: typeof b) => { b = { ...r }; },
    webContents: {
      send: (ch: string, p: unknown) => { sent.push([ch, p]); },
      executeJavaScript: async () => false,
    },
  };
}

const prompts = (w: ReturnType<typeof fakeWin>) => w.sent.filter(([ch]) => ch === 'game-prompt');

describe('hide-and-seek', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { games.stop('test'); vi.useRealTimers(); });

  it('clicking him still counts as found after "Hide again"', async () => {
    const w = fakeWin();
    games.setMainWindow(w as any);
    games.start('hide', 'test');
    await vi.advanceTimersByTimeAsync(3000); // hidden
    games.handleAction('found');
    await vi.advanceTimersByTimeAsync(5000); // glided home → "Again?" prompt
    expect(prompts(w)).toHaveLength(1);

    games.handleAction('again');
    await vi.advanceTimersByTimeAsync(3000); // hidden again
    games.handleAction('found');
    await vi.advanceTimersByTimeAsync(5000);
    expect(prompts(w)).toHaveLength(2);
  });
});
