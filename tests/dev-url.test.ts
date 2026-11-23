/**
 * 2026-11 scan: ELECTRON_RENDERER_URL (the electron-vite dev server) is never
 * honoured in a packaged build, for page loads or for the navigation guard.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const app = vi.hoisted(() => ({ isPackaged: true }));
vi.mock('electron', () => ({ app }));

import { devRendererUrl, rendererDevUrl } from '../src/main/dev-url';

const DEV = 'http://localhost:5173';

afterEach(() => { vi.unstubAllEnvs(); app.isPackaged = true; });

describe('devRendererUrl', () => {
  it('returns the dev server only when not packaged', () => {
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: DEV })).toBe(DEV);
    expect(devRendererUrl(true, { ELECTRON_RENDERER_URL: DEV })).toBeUndefined();
    expect(devRendererUrl(true, { ELECTRON_RENDERER_URL: 'https://attacker.example' })).toBeUndefined();
    expect(devRendererUrl(false, {})).toBeUndefined();
    expect(devRendererUrl(false, { ELECTRON_RENDERER_URL: '' })).toBeUndefined();
  });
});

describe('rendererDevUrl', () => {
  it('a packaged build ignores the variable', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example');
    app.isPackaged = true;
    expect(rendererDevUrl()).toBeUndefined();
  });
  it('a dev run uses it', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', DEV);
    app.isPackaged = false;
    expect(rendererDevUrl()).toBe(DEV);
  });
});

describe('every reader goes through dev-url.ts', () => {
  it('no other main-process file reads process.env.ELECTRON_RENDERER_URL', () => {
    const dir = path.join(__dirname, '..', 'src', 'main');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && e.name !== 'dev-url.ts' && /process\.env\.ELECTRON_RENDERER_URL|process\.env\[['"]ELECTRON_RENDERER_URL/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(dir, p));
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
  it('window.ts, games.ts and the navigation guard use it', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
    expect(read('window.ts').match(/const devUrl = rendererDevUrl\(\);/g)).toHaveLength(6);
    expect(read('games.ts')).toMatch(/const devUrl = rendererDevUrl\(\);/);
    expect(read('index.ts')).toMatch(/devUrl: rendererDevUrl\(\)/);
  });
});
