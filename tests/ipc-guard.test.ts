/**
 * 0.24.12 audit #7: user-message only from the main window, guardrails / byok
 * only from the Settings window, and purchases can't be set to 'allow' over IPC.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-ipc-guard-'));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp } }));

import { senderIsWindow, isAllowedExternalUrl } from '../src/main/ipc-guard';
import { isSafeCheckoutUrl } from '../src/main/account-api';
import { setPolicy, getPolicy, decide } from '../src/main/permission-policy';

describe('senderIsWindow', () => {
  const mainWc = { id: 1 };
  const settingsWc = { id: 2 };
  const main = { webContents: mainWc, isDestroyed: () => false };
  const settings = { webContents: settingsWc, isDestroyed: () => false };

  it('accepts the window\'s own page', () => {
    expect(senderIsWindow({ sender: mainWc }, main)).toBe(true);
    expect(senderIsWindow({ sender: settingsWc }, settings)).toBe(true);
  });
  it('refuses another window\'s page', () => {
    expect(senderIsWindow({ sender: settingsWc }, main)).toBe(false);
    expect(senderIsWindow({ sender: mainWc }, settings)).toBe(false);
    expect(senderIsWindow({ sender: { id: 3 } }, main)).toBe(false);
  });
  it('refuses when the window is closed, destroyed or missing', () => {
    expect(senderIsWindow({ sender: settingsWc }, null)).toBe(false);
    expect(senderIsWindow({ sender: settingsWc }, undefined)).toBe(false);
    expect(senderIsWindow({ sender: settingsWc }, { webContents: settingsWc, isDestroyed: () => true })).toBe(false);
  });
});

describe('ipc.ts wires the sender checks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8');
  const handler = (channel: string) => {
    const start = src.indexOf(`ipcMain.handle('${channel}'`);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, start + 320);
  };
  it('user-message checks for the main window before anything else', () => {
    expect(handler('user-message')).toMatch(/if \(!senderIsWindow\(event, mainWindow\)\) return '';/);
  });
  it.each(['guardrails:get-policy', 'guardrails:set-policy', 'guardrails:get-history', 'guardrails:clear-history', 'action-undo', 'byok:status', 'byok:save', 'byok:clear-key', 'byok:test', 'get-mic-device', 'set-mic-device'])(
    '%s checks for the Settings window', (channel) => {
      expect(handler(channel)).toMatch(/fromSettings\(event\)/);
    });
});

describe('ipc.ts: sender checks on the license, skills, agent and first-win channels (2026-11 scan)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.ts'), 'utf8');
  const handler = (channel: string) => {
    const start = src.indexOf(`ipcMain.handle('${channel}'`);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, start + 400);
  };
  it.each(['skills-install', 'agent:status', 'agent:set-enabled', 'agent:regenerate-token'])('%s checks for the Settings window first', (channel) => {
    expect(handler(channel)).toMatch(/async \(event[,)][^\n]*\n\s+if \(!fromSettings\(event\)\) return /);
  });
  it('save-license only from the onboarding window', () => {
    expect(handler('save-license')).toMatch(/if \(!senderIsWindow\(event, getOnboardingWindow\(\)\)\) return false;\n\s+saveLicense\(/);
  });
  it('first-win-chip only from the onboarding window or the bubble', () => {
    expect(handler('first-win-chip')).toMatch(/if \(!senderIsWindow\(event, getOnboardingWindow\(\)\) && !senderIsWindow\(event, mainWindow\)\) return false;/);
  });
  it('open-external-url opens only what isAllowedExternalUrl / isSafeInboxUrl accept', () => {
    expect(handler('open-external-url')).toMatch(/isSafeInboxUrl\(url\) \|\| isAllowedExternalUrl\(url\)/);
  });
  it('open-subscription-portal checks the server\'s URL like the checkout link', () => {
    const start = src.indexOf("ipcMain.handle('open-subscription-portal'");
    const body = src.slice(start, src.indexOf('shell.openExternal(url)', start));
    expect(body).toMatch(/if \(!url \|\| !isSafeCheckoutUrl\(url\)\)/);
  });
});

describe('isAllowedExternalUrl (open-external-url)', () => {
  it.each([
    'https://clippyai.app',
    'https://clippyai.app/privacy',
    'https://api.clippyai.app/x',
    'https://github.com/AmrDab/clippyai-desktop/issues',
    'mailto:hello@clippyai.app',
  ])('opens %s', (url) => expect(isAllowedExternalUrl(url)).toBe(true));
  it.each([
    'http://clippyai.app/',
    'http://github.com/x',
    'ftp://github.com/x',
    'file://github.com/C:/Windows/System32/calc.exe',
    'smb://github.com/share',
    'ms-msdt://github.com/x',
    'javascript://github.com/%0aalert(1)',
    'https://user:pw@github.com/',
    'https://github.com.attacker.example/',
    'https://example.com/',
    'not a url',
    '',
    42,
    undefined,
  ])('refuses %s', (url) => expect(isAllowedExternalUrl(url)).toBe(false));
});

describe('isSafeCheckoutUrl (open-subscription-portal)', () => {
  it.each(['https://billing.stripe.com/p/session/x', 'https://checkout.stripe.com/c/pay/x'])('opens %s', (url) => expect(isSafeCheckoutUrl(url)).toBe(true));
  it.each(['http://billing.stripe.com/p/session/x', 'https://billing.stripe.com.attacker.example/', 'file:///C:/x.exe', 'javascript:alert(1)'])('refuses %s', (url) => expect(isSafeCheckoutUrl(url)).toBe(false));
});

describe('setPolicy over IPC', () => {
  beforeEach(() => { setPolicy({ mode: 'standard', classOverrides: { destructive_purchase: 'approve', destructive_file: 'approve' } }); });

  it("refuses 'allow' for destructive_purchase", () => {
    const p = setPolicy({ mode: 'trusted', classOverrides: { destructive_purchase: 'allow' } });
    expect(p.classOverrides.destructive_purchase).toBe('approve');
    expect(getPolicy().classOverrides.destructive_purchase).not.toBe('allow');
    expect(decide('smart_click', {}, 'destructive_purchase')).toBe('approve');
  });
  it("still accepts 'block' and 'approve' for purchases, and 'allow' for other classes", () => {
    expect(setPolicy({ classOverrides: { destructive_purchase: 'block' } }).classOverrides.destructive_purchase).toBe('block');
    expect(setPolicy({ classOverrides: { destructive_purchase: 'approve' } }).classOverrides.destructive_purchase).toBe('approve');
    expect(setPolicy({ classOverrides: { destructive_file: 'allow' } }).classOverrides.destructive_file).toBe('allow');
  });
  it('the mode change in the same message still applies', () => {
    expect(setPolicy({ mode: 'cautious', classOverrides: { destructive_purchase: 'allow' } }).mode).toBe('cautious');
  });
});
