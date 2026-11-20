/** v0.24.12 — Stop ends a wait(30) at once (abortAllInFlightTools). */
import { describe, it, expect, vi } from 'vitest';
import os from 'os';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  clipboard: {}, BrowserWindow: class {}, screen: {}, shell: {}, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));

import { executeTool, abortAllInFlightTools } from '../src/main/tools';

describe('wait tool', () => {
  it('is cancelled by abortAllInFlightTools instead of running out its 30 s', async () => {
    const p = executeTool('wait', { seconds: 30 });
    const started = Date.now();
    // The wait registers on a later tick: abort until it is there.
    let aborted = 0;
    while (aborted === 0 && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 10));
      aborted = abortAllInFlightTools();
    }
    expect(aborted).toBeGreaterThanOrEqual(1);
    expect((await p).text).toBe('(wait cancelled)');
    expect(Date.now() - started).toBeLessThan(6000);
  }, 20000);

  it('runs its time when nothing cancels', async () => {
    expect((await executeTool('wait', { seconds: 0.1 })).text).toBe('Waited 0.1s');
  });
});
