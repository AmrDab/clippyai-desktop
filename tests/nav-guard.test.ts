/**
 * 0.24.12 audit #20: windows cannot be navigated to a web page and cannot
 * open in-app child windows.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { isAppUrl, installNavigationGuards } from '../src/main/nav-guard';

const rendererDir = path.resolve(__dirname, '..', 'out', 'renderer');
const page = (name: string, suffix = '') => pathToFileURL(path.join(rendererDir, name)).toString() + suffix;
const packaged = { rendererDir };
const dev = { rendererDir, devUrl: 'http://localhost:5173' };

describe('isAppUrl', () => {
  it.each([
    page('index.html'),
    page('settings.html'),
    page('onboarding.html', '?step=2'),
    page('logs.html', '#report'),
    page(path.join('assets', 'chunk.js')),
  ])('the app\'s own page: %s', (url) => expect(isAppUrl(url, packaged)).toBe(true));

  it.each([
    'http://localhost:5173/',
    'http://localhost:5173/settings.html',
    'http://localhost:5173/onboarding.html?step=2',
  ])('the dev server page: %s', (url) => expect(isAppUrl(url, dev)).toBe(true));

  it.each([
    'https://example.com/',
    'https://mail.google.com/',
    'http://localhost:5173.attacker.example/',
    'http://localhost:9999/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'file:///C:/Users/me/Downloads/evil.html',
    'file://attacker.example/share/index.html',
    pathToFileURL(path.join(rendererDir, '..', 'main', 'index.js')).toString(),
    pathToFileURL(path.join(rendererDir, '..', 'renderer-evil', 'index.html')).toString(),
    'not a url',
    '',
  ])('not the app: %s', (url) => {
    expect(isAppUrl(url, packaged)).toBe(false);
    expect(isAppUrl(url, dev)).toBe(false);
  });

  it('the dev server origin is not trusted in a packaged build', () => {
    expect(isAppUrl('http://localhost:5173/', packaged)).toBe(false);
  });
});

describe('installNavigationGuards', () => {
  function setup() {
    let created: ((e: unknown, c: unknown) => void) | undefined;
    const app = { on: (_ev: 'web-contents-created', l: (e: unknown, c: never) => void) => { created = l as never; } };
    const openExternal = vi.fn();
    const blocked = vi.fn();
    installNavigationGuards(app, openExternal, packaged, blocked);
    let navigate: ((e: { preventDefault(): void }, url: string) => void) | undefined;
    let open: ((d: { url: string }) => { action: string }) | undefined;
    const contents = {
      on: (_ev: string, l: typeof navigate) => { navigate = l; },
      setWindowOpenHandler: (h: typeof open) => { open = h; },
    };
    created!({}, contents);
    return { navigate: navigate!, open: open!, openExternal, blocked };
  }

  it('cancels navigation to a web page and lets the app\'s own pages load', () => {
    const { navigate, blocked } = setup();
    const ev = { preventDefault: vi.fn() };
    navigate(ev, 'https://attacker.example/steal');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(blocked).toHaveBeenCalledWith('navigate', 'https://attacker.example/steal');
    const ok = { preventDefault: vi.fn() };
    navigate(ok, page('settings.html'));
    expect(ok.preventDefault).not.toHaveBeenCalled();
  });

  it('never opens an in-app window; an https link goes to the browser', () => {
    const { open, openExternal, blocked } = setup();
    expect(open({ url: 'https://clippyai.app/changelog' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://clippyai.app/changelog');
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'http://a.example/', 'ms-settings:privacy', 'about:blank']) {
      expect(open({ url })).toEqual({ action: 'deny' });
      expect(blocked).toHaveBeenCalledWith('window', url);
    }
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('index.ts installs the guards before any window is created', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
    const install = src.indexOf('installNavigationGuards(app,');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(src.indexOf('app.whenReady()'));
  });
});
