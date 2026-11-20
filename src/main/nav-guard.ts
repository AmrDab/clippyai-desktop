/**
 * nav-guard.ts — Clippy's windows only ever show Clippy's own pages.
 *
 * Every window has the preload bridge (window.clippy). If a window were ever
 * navigated to a web page, or opened a child window on one, that page would
 * hold the bridge. So, for every webContents the app creates (0.24.12 audit
 * #20): navigation away from the app's own pages is cancelled, and no page
 * can open an in-app window. An https link opens in the user's browser
 * instead.
 */

import path from 'path';
import { fileURLToPath } from 'url';

export interface NavGuardEnv {
  /** electron-vite dev server origin (ELECTRON_RENDERER_URL), when running in dev. */
  devUrl?: string;
  /** Folder that holds the packaged renderer pages. */
  rendererDir: string;
}

/** True for one of the app's own pages: the dev server, or a file in the renderer folder. */
export function isAppUrl(url: string, env: NavGuardEnv): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (env.devUrl) {
    try { if (u.origin === new URL(env.devUrl).origin) return true; } catch { /* bad dev URL: fall through */ }
  }
  if (u.protocol !== 'file:' || u.host) return false; // file://server/share is a network path
  let file: string;
  try { file = path.resolve(fileURLToPath(u)); } catch { return false; }
  const root = path.resolve(env.rendererDir);
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return norm(file).startsWith(norm(root) + path.sep);
}

interface ContentsLike {
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}
interface AppLike {
  on(event: 'web-contents-created', listener: (event: unknown, contents: ContentsLike) => void): unknown;
}

/** Install the guards on every webContents created from now on. */
export function installNavigationGuards(
  app: AppLike,
  openExternal: (url: string) => unknown,
  env: NavGuardEnv,
  onBlocked: (kind: 'navigate' | 'window', url: string) => void = () => {},
): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url, env)) return;
      event.preventDefault();
      onBlocked('navigate', url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      // Never an in-app window. A plain https link goes to the user's browser.
      if (/^https:\/\//i.test(url)) {
        try { void openExternal(url); } catch { /* ignore */ }
      } else {
        onBlocked('window', url);
      }
      return { action: 'deny' };
    });
  });
}
