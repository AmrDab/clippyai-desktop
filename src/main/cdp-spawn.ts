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
export async function spawnCdpBrowser(): Promise<{ ok: boolean; error?: string }> {
  const candidates: Array<{ exe: string; args: string[] }> = [
    {
      exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      args: [`--remote-debugging-port=${DEFAULT_CDP_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'clippy-cdp-edge')}`],
    },
    {
      exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [`--remote-debugging-port=${DEFAULT_CDP_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), 'clippy-cdp-chrome')}`],
    },
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c.exe)) continue;
    try {
      const child = spawn(c.exe, c.args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      // Give the browser ~1.5s to bind the debug port
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true };
    } catch (err) {
      log.warn('CDP browser spawn failed', serializeErr(err));
    }
  }
  return { ok: false, error: 'Neither Edge nor Chrome was found in their default install paths.' };
}
