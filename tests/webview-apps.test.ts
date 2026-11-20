/** v0.24.12 — detect_webview_apps reads the process name from either window-list shape. */
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

import { matchWebviewApps } from '../src/main/tools';

describe('matchWebviewApps', () => {
  it('Windows window list: processName', () => {
    expect(matchWebviewApps([{ processName: 'slack', title: 'general' }, { processName: 'notepad', title: 'x' }]))
      .toEqual([{ name: 'Slack', processName: 'slack', title: 'general', flag: '--remote-debugging-port=9223' }]);
  });
  it('macOS bridge window list: app (was never matched)', () => {
    expect(matchWebviewApps([{ app: 'Slack', title: 'general' }, { app: 'Finder', title: 'Desktop' }]))
      .toEqual([{ name: 'Slack', processName: 'Slack', title: 'general', flag: '--remote-debugging-port=9223' }]);
  });
  it('processName wins when both are present; nothing matches an empty entry', () => {
    expect(matchWebviewApps([{ processName: 'discord', app: 'Something else', title: 't' }])[0].name).toBe('Discord');
    expect(matchWebviewApps([{}, { title: 'no process' }])).toEqual([]);
  });
});
