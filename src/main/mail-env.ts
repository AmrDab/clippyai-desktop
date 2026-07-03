/**
 * Mail-environment probe — runs at app boot, results cached in memory and
 * sent to the server as prompt context so the model knows which email
 * backend will work without trial-and-error.
 *
 * v0.20 port note: unified cross-platform version. The mac fork rewrote
 * this file mac-only (dropping the Windows registry/AppX probes), which
 * would have crippled the win32 email dispatcher when the tree was
 * adopted back into the Windows repo. The interface is now the UNION of
 * both platforms' fields; each platform's probe fills its own fields and
 * leaves the other platform's fields false/null. Consumers gate on the
 * fields, not the platform, so a single dispatcher reads naturally.
 *
 * win32 probes:
 *   - classic_outlook_com: is Outlook.Application COM ProgID registered?
 *   - new_outlook_installed: is Microsoft.OutlookForWindows AppX present?
 *   - default_mailto_handler: HKCU\…\mailto\UserChoice ProgId
 *
 * darwin probes (M5):
 *   - apple_mail_installed: /Applications/Mail.app exists
 *   - outlook_mac_installed: /Applications/Microsoft Outlook.app exists
 *
 * NOT probed at boot (deferred to first use because it requires a browser):
 *   - outlook_web_signed_in / gmail_web_signed_in
 */

import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger, serializeErr } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('MailEnv');

export interface MailEnvironment {
  // ── win32 fields ──────────────────────────────────────────────
  classic_outlook_com: boolean;
  new_outlook_installed: boolean;
  default_is_olk: boolean;
  // ── darwin fields ─────────────────────────────────────────────
  apple_mail_installed: boolean;
  outlook_mac_installed: boolean;
  default_is_outlook: boolean;
  // ── shared ────────────────────────────────────────────────────
  default_mailto_handler: string | null;
  /** ISO timestamp the probe ran. */
  probed_at: string;
}

let cached: MailEnvironment | null = null;

function emptyEnv(): MailEnvironment {
  return {
    classic_outlook_com: false,
    new_outlook_installed: false,
    default_is_olk: false,
    apple_mail_installed: false,
    outlook_mac_installed: false,
    default_is_outlook: false,
    default_mailto_handler: null,
    probed_at: new Date().toISOString(),
  };
}

/**
 * Run a short PowerShell snippet and return stdout (win32 only). Used by
 * all 3 win32 probes — each is a tiny registry/AppX read.
 */
async function ps(snippet: string, timeoutMs = 5_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', snippet],
      { timeout: timeoutMs, windowsHide: true },
    );
    return String(stdout || '').trim();
  } catch (err) {
    log.debug('mail-env ps probe failed', serializeErr(err));
    return '';
  }
}

async function probeWin32(): Promise<MailEnvironment> {
  const [comReg, olkPkg, mailtoProgId] = await Promise.all([
    // 1. Classic Outlook COM ProgID — present iff classic Outlook is installed
    ps(`if (Test-Path 'HKLM:\\SOFTWARE\\Classes\\Outlook.Application' -or (Test-Path 'HKCU:\\SOFTWARE\\Classes\\Outlook.Application')) { 'yes' } else { 'no' }`),
    // 2. New Outlook AppX package presence
    ps(`if ((Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue)) { 'yes' } else { 'no' }`),
    // 3. Default mailto handler
    ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice' -ErrorAction SilentlyContinue).ProgId`),
  ]);

  const env = emptyEnv();
  env.classic_outlook_com = comReg.toLowerCase() === 'yes';
  env.new_outlook_installed = olkPkg.toLowerCase() === 'yes';
  env.default_mailto_handler = mailtoProgId || null;
  env.default_is_olk = !!env.default_mailto_handler && /OutlookForWindows|OutlookMail/i.test(env.default_mailto_handler);
  return env;
}

function probeDarwin(): MailEnvironment {
  const env = emptyEnv();
  env.apple_mail_installed = fs.existsSync('/Applications/Mail.app') || fs.existsSync('/System/Applications/Mail.app');
  env.outlook_mac_installed = fs.existsSync('/Applications/Microsoft Outlook.app');
  return env;
}

export async function probeMailEnvironment(): Promise<MailEnvironment> {
  const t0 = Date.now();
  const env = process.platform === 'win32' ? await probeWin32() : probeDarwin();
  cached = env;
  log.info('Mail environment probed', { ...env, elapsed_ms: Date.now() - t0 });
  return env;
}

export function getCachedMailEnvironment(): MailEnvironment | null {
  return cached;
}

/**
 * Format the mail environment as a one-paragraph context string suitable
 * for injection into the system prompt. The model uses this to pick the
 * right send-email path on its first call instead of trial-and-error.
 */
export function formatMailEnvForPrompt(env: MailEnvironment | null): string {
  if (!env) return '';
  const parts: string[] = [];
  // win32
  if (env.classic_outlook_com) parts.push('classic Outlook (COM available)');
  if (env.new_outlook_installed) parts.push('new Outlook (olk.exe)' + (env.default_is_olk ? ' as default' : ' but NOT the default mailto handler'));
  // darwin
  if (env.apple_mail_installed) parts.push('Apple Mail');
  if (env.outlook_mac_installed) parts.push('Outlook for Mac');
  if (parts.length === 0) parts.push('no local mail client detected');
  const handler = env.default_mailto_handler ? ` Default mailto handler: ${env.default_mailto_handler}.` : '';
  return `User's mail setup: ${parts.join(', ')}.${handler}`;
}
