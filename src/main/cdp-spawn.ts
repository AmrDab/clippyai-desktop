import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULT_CDP_PORT } from './cdp-client';
import { createLogger, serializeErr } from './logger';

const log = createLogger('CdpSpawn');

/**
 * Spawn Edge or Chrome with --remote-debugging-port enabled, then return
 * once the launch was issued (caller is responsible for retrying the
 * connect). Tries Edge first (default on Windows), falls back to Chrome.
 *
 * Why this is its own module:
 *   v0.16.2 — previously this function lived in tools.ts and the web-send
 *   skills (outlook-web-send.ts, gmail-web-send.ts) reached back to it via
 *   `require('../tools')` at runtime to avoid a circular dep at import
 *   time. That `require` works in `npm run dev` (where files exist on
 *   disk) but FAILS in the packaged app.asar because vite/esbuild flatten
 *   everything into a single index.js and there is no '../tools.js' next
 *   to it. Result, per support report e8f2fb63: outlook_web/gmail_web both
 *   threw `MODULE_NOT_FOUND` in production and the email fallback chain
 *   silently lost two tiers.
 *
 *   Now spawnCdpBrowser lives in its own zero-dep file (no cycle with
 *   tools.ts), and both tools.ts and the skills import it statically.
 *   The bundler resolves everything at build time, no runtime require.
 */
export interface SpawnOptions {
  /**
   * v0.17.4 — spawn the browser in headless mode (no visible window).
   *
   * Use case: the email-send dispatcher's web-fallback path
   * (outlook_web_send_email / gmail_web_send_email) drives the page
   * programmatically via CDP — fills the form, clicks Send, verifies
   * post-send state. The user never needed to SEE this browser; we
   * only ever spawned it visibly out of inertia. Per support report
   * f6c85a04: "clippy sent email well, though opened a browser tab
   * for no reason." The browser stayed visible because outlook-web-
   * send.ts never closed it after success — and there was nothing
   * to close anyway, it was the whole Edge window.
   *
   * Headless trade-off: the user-data-dir is preserved across spawns
   * regardless of headless/headed, so cookies and signed-in sessions
   * are stable. The ONLY downside is the user can't intervene if
   * sign-in expires — they'll see a NOT_SIGNED_IN error instead of
   * a sign-in prompt. The recipe surfaces that error with clear
   * recovery guidance.
   */
  headless?: boolean;
}

export async function spawnCdpBrowser(opts: SpawnOptions = {}): Promise<{ ok: boolean; error?: string }> {
  const headless = opts.headless === true;
  // --headless=new is Chrome's modern headless mode (Chromium 109+).
  // Edge picked it up around the same release. Both fall back gracefully
  // if the flag isn't recognized (older browsers just ignore unknown
  // flags), so this is safe to pass unconditionally when headless=true.
  const headlessArgs = headless ? ['--headless=new', '--disable-gpu'] : [];

  const candidates: Array<{ exe: string; args: string[] }> = [
    {
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      args: [
        `--remote-debugging-port=${DEFAULT_CDP_PORT}`,
        `--user-data-dir=${path.join(os.tmpdir(), 'clippy-cdp-edge')}`,
        ...headlessArgs,
      ],
    },
    {
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        `--remote-debugging-port=${DEFAULT_CDP_PORT}`,
        `--user-data-dir=${path.join(os.tmpdir(), 'clippy-cdp-chrome')}`,
        ...headlessArgs,
      ],
    },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.exe)) continue;
    try {
      const child = spawn(c.exe, c.args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      // Headless takes a beat longer to bind the debug port because the
      // browser doesn't have a window-init shortcut. Give it ~2s when
      // headless, ~1.5s otherwise — both are conservative.
      await new Promise((r) => setTimeout(r, headless ? 2000 : 1500));
      return { ok: true };
    } catch (err) {
      log.warn('CDP browser spawn failed', serializeErr(err));
    }
  }
  return { ok: false, error: 'Neither Edge nor Chrome was found in their default install paths.' };
}
