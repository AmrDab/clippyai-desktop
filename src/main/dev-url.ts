/**
 * dev-url.ts — the electron-vite dev server URL, in a dev run only.
 *
 * electron-vite sets ELECTRON_RENDERER_URL for `npm run dev`, and every
 * window then loads its page from that server; nav-guard.ts also trusts its
 * origin. A packaged build must never do either: anyone who can start the
 * app with an environment variable (a launcher, a login item, another local
 * process) could point every window, each holding the preload bridge, at a
 * page of their own, and the navigation guard would let it stay (2026-11
 * scan). Every reader of the variable goes through here.
 */

import * as electron from 'electron';

/** `env.ELECTRON_RENDERER_URL` when not packaged; undefined otherwise. */
export function devRendererUrl(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isPackaged) return undefined;
  const url = env.ELECTRON_RENDERER_URL;
  return url ? url : undefined;
}

/** The dev server URL for this run. Undefined in a packaged build, and when that can't be told. */
export function rendererDevUrl(): string | undefined {
  let packaged = true;
  try { packaged = electron.app.isPackaged !== false; } catch { /* no app (tests, a child process): fail closed */ }
  return devRendererUrl(packaged);
}
