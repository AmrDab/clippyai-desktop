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

import { guideNameFor } from '../src/main/guides';

describe('web-app guides on macOS browsers', () => {
  it('Gmail and YouTube tabs in Chrome/Safari get their guide (darwin only)', () => {
    expect(guideNameFor('Google Chrome', 'Inbox (3) - amy@example.com - Gmail', 'darwin')).toBe('gmail');
    expect(guideNameFor('Safari', 'Funny cats - YouTube', 'darwin')).toBe('youtube');
    expect(guideNameFor('Arc', 'mail.google.com', 'darwin')).toBe('gmail');
  });
  it('other tabs, other apps and Windows are untouched', () => {
    expect(guideNameFor('Google Chrome', 'Wikipedia', 'darwin')).toBeNull();
    expect(guideNameFor('Slack', 'Gmail notes', 'darwin')).toBeNull();
    expect(guideNameFor('chrome', 'Inbox - Gmail', 'win32')).toBeNull();
  });
  it('the guides they point at exist and get Cmd keys in the prompt', () => {
    expect(loadGuide('gmail')).not.toBeNull();
    expect(loadGuide('youtube')).not.toBeNull();
    expect(macifyKeys('send=mod+Return')).toBe('send=Cmd+Return');
  });
  it('maps every Mac app name the bridge reports for the shipped native guides', () => {
    for (const n of ['Slack', 'Discord', 'Spotify', 'Figma', 'Microsoft Excel', 'Microsoft Outlook']) expect(loadGuide(n), n).not.toBeNull();
    expect(loadGuide('Microsoft Paint')).toBeNull();
  });
});
