import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { macifyKeys, loadGuide, getGuidePrompt } from '../src/main/guides';

describe('guides on macOS', () => {
  it('macifyKeys swaps Ctrl/Alt/mod for Cmd/Option', () => {
    expect(macifyKeys('send=Ctrl+Enter, find=mod+k, nav=Ctrl+Alt+Up')).toBe('send=Cmd+Enter, find=Cmd+k, nav=Cmd+Option+Up');
    expect(macifyKeys('Control panel Altitude')).toBe('Control panel Altitude');
  });

  it('Mac app names resolve to the shipped guides', () => {
    expect(loadGuide('Microsoft Excel')?.app).toBe('Excel');
    expect(loadGuide('Microsoft Outlook')).not.toBeNull();
    expect(loadGuide('Slack')).not.toBeNull();
    expect(loadGuide('Discord')).not.toBeNull();
    expect(loadGuide('Spotify')).not.toBeNull();
  });

  it('Windows process names still resolve and keep Ctrl on win32/linux', () => {
    expect(loadGuide('OUTLOOK.EXE')).not.toBeNull();
    expect(loadGuide('EXCEL.EXE')?.app).toBe('Excel');
    if (process.platform !== 'darwin') expect(getGuidePrompt('olk')).toContain('Ctrl+Enter');
  });
});
